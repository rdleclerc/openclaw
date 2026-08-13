import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
// Covers startup delivery recovery, backoff, permanent failures, unknown-send
// reconciliation, commit hooks, and retry budget deferral.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { build } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { completeDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "./delivery-commit-hooks.js";
import {
  acquireGaiaSlackSendFence,
  admitGaiaAcceptance,
  admitGaiaKeyedOutput,
  completeDelivery,
  deriveGaiaAcceptanceId,
  deriveGaiaKeyedOutputOwnerId,
  inspectGaiaKeyedOutput,
  loadPendingDeliveries,
  moveToFailed,
  recoverGaiaAcceptance,
  resumeGaiaKeyedOutput,
} from "./delivery-queue-storage.js";
import {
  ackDelivery,
  enqueueDelivery,
  drainPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  recoverPendingDeliveries,
} from "./delivery-queue.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const RECOVERY_REPLAY_SPACING_MS = 250;
const MAX_RETRIES = 5;
const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
const messageSentHookMock = vi.hoisted(() => ({
  hasHooks: vi.fn(() => false),
  runMessageSent: vi.fn(async (_event: unknown, _ctx: unknown) => {}),
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => messageSentHookMock,
}));

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

function expectMockMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
  const messages = mock.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""));
  expect(messages.join("\n")).toContain(expected);
}

function readOutboundQueueStatus(tmpDir: string, id: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
  });
  const row = db
    .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?")
    .get(id) as { status?: string } | undefined;
  return row?.status;
}

const GAIA_ACCEPTANCE_OWNER_RACE_WORKER_SOURCE = `
  import { DatabaseSync } from "node:sqlite";
  import { pathToFileURL } from "node:url";
  import { parentPort, workerData } from "node:worker_threads";

  const state = await import(pathToFileURL(workerData.bundlePath).href);
  state.openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: workerData.stateDir },
  });
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (sql === "BEGIN IMMEDIATE") {
      parentPort.postMessage({ type: "begun" });
      Atomics.wait(new Int32Array(workerData.beginBarrier), 0, 0);
    }
    return result;
  };
  const storage = state;
  parentPort.postMessage({ type: "ready" });
  await new Promise((resolve) => parentPort.once("message", resolve));
  parentPort.postMessage({ type: "attempting" });
  try {
    const result = workerData.role === "refresh"
      ? storage.admitGaiaAcceptance(workerData.accepted, workerData.stateDir)
      : await storage.admitGaiaKeyedOutput(workerData.params, workerData.stateDir);
    parentPort.postMessage({ type: "settled", ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      type: "settled",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    state.closeOpenClawStateDatabaseForTest();
  }
`;

function waitForGaiaRaceWorkerMessage(
  worker: Worker,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: Record<string, unknown>) => {
      if (message?.type !== type) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
  });
}

describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const baseCfg = {};

  beforeEach(() => {
    resolveOutboundChannelMessageAdapterMock.mockReset();
    messageSentHookMock.hasHooks.mockReset();
    messageSentHookMock.hasHooks.mockReturnValue(false);
    messageSentHookMock.runMessageSent.mockReset();
    messageSentHookMock.runMessageSent.mockResolvedValue(undefined);
  });

  const enqueueCrashRecoveryEntries = async () => {
    await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    await enqueueDelivery(
      {
        channel: "demo-channel-b",
        to: "2",
        payloads: [{ text: "b" }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      },
      tmpDir(),
    );
  };

  const runRecovery = async ({
    deliver,
    log = createRecoveryLog(),
    maxRecoveryMs,
  }: {
    deliver: ReturnType<typeof vi.fn>;
    log?: ReturnType<typeof createRecoveryLog>;
    maxRecoveryMs?: number;
  }) => {
    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log,
      cfg: baseCfg,
      stateDir: tmpDir(),
      ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
    });
    return { result, log };
  };

  it("recovers entries from a simulated crash", async () => {
    await enqueueCrashRecoveryEntries();
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map(([params]) => params.queuePolicy)).toEqual([
      undefined,
      "required",
    ]);
    expect(deliver.mock.calls.map(([params]) => params.requireUnknownSendReconciliation)).toEqual([
      undefined,
      true,
    ]);
    expect(result).toEqual({
      recovered: 2,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("permanently rejects provider-blocked rows before backoff or reconciliation", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "slack",
        to: "C123",
        accountId: "enterprise",
        payloads: [{ text: "blocked" }],
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      lastAttemptAt: Date.now(),
      recoveryState: "unknown_after_send",
      platformSendStartedAt: Date.now(),
    });
    const admitDeferredDelivery = vi.fn(() => ({
      status: "permanent_rejection" as const,
      reason: "unsupported_enterprise_slack_delivery",
    }));
    const reconcileUnknownSend = vi.fn();
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: { admitDeferredDelivery, reconcileUnknownSend },
    });
    const deliver = vi.fn();

    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(admitDeferredDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "enterprise",
        channel: "slack",
        phase: "recovery",
        to: "C123",
      }),
    );
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expect(readQueuedEntry(tmpDir(), id).lastError).toBe("unsupported_enterprise_slack_delivery");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "unknown",
      outcome: "unknown",
      failureStage: "queue",
    });

    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: { admitDeferredDelivery: () => ({ status: "allowed" }) },
    });
    await runRecovery({ deliver });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("paces startup replay instead of draining eligible entries back-to-back", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      await enqueueCrashRecoveryEntries();
      let firstDelivered!: () => void;
      const firstDeliveredPromise = new Promise<void>((resolve) => {
        firstDelivered = resolve;
      });
      const deliveryTimes: number[] = [];
      const deliver = vi.fn(async () => {
        deliveryTimes.push(Date.now());
        if (deliveryTimes.length === 1) {
          firstDelivered();
        }
        return [];
      });

      const recovery = runRecovery({ deliver, maxRecoveryMs: 60_000 });
      await firstDeliveredPromise;
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RECOVERY_REPLAY_SPACING_MS - 1);
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const { result } = await recovery;

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliveryTimes[1]).toBe(startedAt.getTime() + RECOVERY_REPLAY_SPACING_MS);
      expect(result).toMatchObject({ recovered: 2, deferredBackoff: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts replay pacing against the recovery budget and defers the backlog tail", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      await enqueueCrashRecoveryEntries();
      await enqueueDelivery(
        { channel: "demo-channel-c", to: "#c", payloads: [{ text: "c" }] },
        tmpDir(),
      );
      let firstDelivered!: () => void;
      const firstDeliveredPromise = new Promise<void>((resolve) => {
        firstDelivered = resolve;
      });
      const deliveryTimes: number[] = [];
      const deliver = vi.fn(async () => {
        deliveryTimes.push(Date.now());
        if (deliveryTimes.length === 1) {
          firstDelivered();
        }
        return [];
      });

      const recovery = runRecovery({ deliver, maxRecoveryMs: 1 });
      await firstDeliveredPromise;

      await vi.advanceTimersByTimeAsync(1);
      const { result } = await recovery;

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliveryTimes).toEqual([startedAt.getTime()]);
      expect(result).toMatchObject({ recovered: 1, deferredBackoff: 0 });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves entries that exceeded max retries to failed/", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });

    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      outcome: "failed",
      failureStage: "queue",
    });
  });

  it("audits max-retry deadletters as unknown when platform send may have started", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });

    const { result } = await runRecovery({ deliver: vi.fn() });
    unsubscribe();

    expect(result.skippedMaxRetries).toBe(1);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      outcome: "unknown",
      failureStage: "queue",
    });
  });

  it("increments retryCount on failed recovery attempt", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);

    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
    expect(auditEvents).toEqual([]);
  });

  it("keeps a repeated pre-connect recovery failure replayable", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );
    const connectError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const deliver = vi.fn(async () => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      throw connectError;
    });

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("keeps a repeated provider-not-dispatched recovery failure replayable", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );
    const deliver = vi.fn(async () => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      throw new PlatformMessageNotDispatchedError("upload stopped before finalization", {
        cause: new Error("request timed out"),
      });
    });

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("does not replay a recovery batch that rejected after an earlier send succeeded", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }, { text: "second" }],
      },
      tmpDir(),
    );
    const partialFailure = new OutboundDeliveryError("second send failed", {
      cause: new Error("network down"),
      results: [{ channel: "demo-channel-c", messageId: "m1" }],
    });

    const { result } = await runRecovery({
      deliver: vi.fn().mockRejectedValue(partialFailure),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.retryCount).toBe(0);

    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
  });

  it("keeps a best-effort recovery failure retryable when no payload was sent", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new Error("network down"),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
  });

  it("clears send evidence for an all-pre-connect best-effort recovery failure", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
            code: "EAI_AGAIN",
            syscall: "getaddrinfo",
          }),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("clears send evidence for an all-not-dispatched best-effort recovery failure", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new PlatformMessageNotDispatchedError(
            "upload timed out before completion dispatch",
            { cause: new Error("request timed out") },
          ),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("preserves send evidence when a marked recovery batch has an ambiguous failure", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }, { text: "second" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new PlatformMessageNotDispatchedError(
            "upload timed out before completion dispatch",
            { cause: new Error("request timed out") },
          ),
          sentBeforeError: false,
          stage: "platform_send",
        });
        params.onPayloadDeliveryOutcome?.({
          index: 1,
          status: "failed",
          error: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
            syscall: "read",
          }),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBe("send_attempt_started");
    expect(typeof entries[0]?.platformSendStartedAt).toBe("number");
  });

  it("does not ack a partially sent best-effort recovery batch", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }, { text: "second" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        params.onPayloadDeliveryOutcome?.({
          index: 1,
          status: "failed",
          error: new Error("second send failed"),
          sentBeforeError: true,
          stage: "platform_send",
        });
        return [{ channel: "demo-channel-c", messageId: "m1" }];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.retryCount).toBe(0);

    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
  });

  it("moves entries abandoned after platform send may have started to failed without reconciliation", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "maybe sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "unknown_after_send");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "unknown",
      outcome: "unknown",
      failureStage: "queue",
    });
  });

  it("reports every payload unknown when a multi-payload send is crash-ambiguous", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "sent" }, { text: "hidden" }],
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });

    await runRecovery({ deliver: vi.fn() });
    unsubscribe();

    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "unknown",
      outcome: "unknown",
      resultCount: 0,
    });
    expect(auditEvents[1]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:1`,
      status: "unknown",
      outcome: "unknown",
      resultCount: 0,
    });
  });

  it("dead-letters an ordinary row after durable not-sent permanent failure", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "permanent" }] },
      tmpDir(),
    );
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
    });
    const error = "No conversation reference found for C123";
    const deliver = vi.fn(async () => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      throw new Error(error);
    });
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("replays started entries only after adapter proves they were not sent", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "not yet sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({ status: "not_sent" }),
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(resolveOutboundChannelMessageAdapterMock).toHaveBeenCalledWith({
      channel: "demo-channel-a",
      cfg: baseCfg,
      allowBootstrap: true,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    setQueuedEntryState(tmpDir(), id, { retryCount: 1, lastAttemptAt: Date.now() - 60_000 });
    expect((await runRecovery({ deliver })).result).toMatchObject({ recovered: 1, failed: 0 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("emits an awaited receipt before acking a reconciled Slack send", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        accountId: "acct-1",
        payloads: [{ text: "maybe sent" }],
        replyToId: "root-message",
        threadId: "thread-1",
        silent: true,
        replyPayloadSendingHook: {
          kind: "final",
          channel: "demo-channel-a",
          sessionKey: "agent:gaia:slack:channel:C123",
          runId: "request-1",
          messageSentReceiptPluginId: "gaia-workflow-preflight",
          context: {
            channelId: "demo-channel-a",
            accountId: "acct-1",
            conversationId: "+1",
            replyToId: "root-message",
          },
        },
        gaiaKeyedOutput: {
          version: "gaia-slack-output-v1",
          accepted: {
            runId: "request-1",
            sessionKey: "agent:gaia:slack:channel:C123",
            agentId: "gaia",
            acceptedAt: 1_700_000_000_000,
            receiptPluginId: "gaia-workflow-preflight",
          },
          fingerprint: "fingerprint-1",
        },
      },
      tmpDir(),
    );
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), {
      replyToId: "hooked-root-message",
    });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
    const order: string[] = [];
    let releaseReceipt: (() => void) | undefined;
    messageSentHookMock.hasHooks.mockReturnValue(true);
    messageSentHookMock.runMessageSent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push(`message_sent:${readOutboundQueueStatus(tmpDir(), id)}`);
          releaseReceipt = resolve;
        }),
    );
    const afterCommit = vi.fn(() => {
      order.push("afterCommit");
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "sent",
      messageId: "platform-1",
      receipt: {
        primaryPlatformMessageId: "platform-1",
        platformMessageIds: ["platform-1"],
        parts: [{ platformMessageId: "platform-1", kind: "text", index: 0 }],
        sentAt: 1,
      },
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
      send: {
        lifecycle: {
          afterCommit,
        },
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const recovery = runRecovery({ deliver });
    await vi.waitFor(() => expect(messageSentHookMock.runMessageSent).toHaveBeenCalledOnce());
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    releaseReceipt?.();
    const { result } = await recovery;
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    const reconcileInput = mockCallArg(reconcileUnknownSend) as {
      cfg?: unknown;
      queueId?: string;
      channel?: string;
      to?: string;
      accountId?: string;
      payloads?: unknown;
      replyToId?: string;
      effectiveReplyToId?: string;
      threadId?: string;
      silent?: boolean;
      retryCount?: number;
    };
    expect(reconcileInput.cfg).toBe(baseCfg);
    expect(reconcileInput.queueId).toBe(id);
    expect(reconcileInput.channel).toBe("demo-channel-a");
    expect(reconcileInput.to).toBe("+1");
    expect(reconcileInput.accountId).toBe("acct-1");
    expect(reconcileInput.payloads).toEqual([{ text: "maybe sent" }]);
    expect(reconcileInput.replyToId).toBe("root-message");
    expect(reconcileInput.effectiveReplyToId).toBe("hooked-root-message");
    expect(reconcileInput.threadId).toBe("thread-1");
    expect(reconcileInput.silent).toBe(true);
    expect(reconcileInput.retryCount).toBe(0);

    const afterCommitInput = mockCallArg(afterCommit) as {
      kind?: string;
      to?: string;
      accountId?: string;
      replyToId?: string;
      threadId?: string;
      silent?: boolean;
      result?: { messageId?: string };
    };
    expect(afterCommitInput.kind).toBe("text");
    expect(afterCommitInput.to).toBe("+1");
    expect(afterCommitInput.accountId).toBe("acct-1");
    expect(afterCommitInput.replyToId).toBe("hooked-root-message");
    expect(afterCommitInput.threadId).toBe("thread-1");
    expect(afterCommitInput.silent).toBe(true);
    expect(afterCommitInput.result?.messageId).toBe("platform-1");
    expect(messageSentHookMock.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "platform-1",
        runId: "request-1",
        replyToId: "hooked-root-message",
        threadId: "thread-1",
      }),
      expect.objectContaining({
        channelId: "demo-channel-a",
        accountId: "acct-1",
        conversationId: "+1",
        runId: "request-1",
      }),
      { requiredPluginId: "gaia-workflow-preflight" },
    );
    expect(order).toEqual(["message_sent:pending", "afterCommit"]);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("completed");
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "succeeded",
      outcome: "sent",
      messageId: "platform-1",
      resultCount: 1,
    });
  });

  it("moves unknown-after-send entries to failed when adapter reports not sent", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "not sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({ status: "not_sent" }),
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "refusing full replay after post-send evidence");
  });

  it("keeps retryable unresolved unknown-after-send entries on the queue without replaying", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "unknown" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({
          status: "unresolved",
          error: "provider lookup timed out",
          retryable: true,
        }),
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.lastError).toContain("provider lookup timed out");
  });

  it("does not reconcile unknown-after-send entries unless the adapter declares the capability", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "hidden method" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        reconcileUnknownSend,
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "refusing blind replay without adapter reconciliation");
  });

  it("moves entries to failed/ immediately on permanent delivery errors", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel", to: "user:abc", payloads: [{ text: "hi" }] },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(new Error("No conversation reference found for user:abc"));
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("treats Matrix 'User not in room' as a permanent error", async () => {
    const id = await enqueueDelivery(
      { channel: "matrix", to: "!lowercased:matrix.example.com", payloads: [{ text: "hi" }] },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "MatrixError: [403] User @bot:matrix.example.com not in room !lowercased:matrix.example.com",
        ),
      );
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    const deliverInput = mockCallArg(deliver) as { skipQueue?: boolean };
    expect(deliverInput.skipQueue).toBe(true);
  });

  it("moves unknown-after-send entries to failed without replaying", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "refusing blind replay without adapter reconciliation");
  });

  it("runs recovered send commit hooks only after the queue entry is acked", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    const order: string[] = [];
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        const pending = await loadPendingDeliveries(tmpDir());
        order.push(
          pending.some((entry) => entry.id === id) ? "commit-before-ack" : "commit-after-ack",
        );
      },
    );
    const deliver = vi.fn(async () => {
      order.push("deliver");
      return [result];
    });

    await runRecovery({ deliver });

    expect(order).toEqual(["deliver", "commit-after-ack"]);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });

  it("does not restore an acked entry when a recovered send commit hook fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        throw new Error("commit hook offline");
      },
    );
    const deliver = vi.fn().mockResolvedValue([result]);

    const { result: summary } = await runRecovery({ deliver });

    expect(summary).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });

  it("marks a recovered send unknown before ack so ack failure cannot make it replayable", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    let recoveryStateAtAck: string | undefined;
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        ackDelivery: vi.fn(async (entryId: string, stateDir?: string) => {
          recoveryStateAtAck = (await actual.loadPendingDelivery(entryId, stateDir))?.recoveryState;
          throw new Error("ack state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithAckFailure } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithAckFailure({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        log: createRecoveryLog(),
        cfg: baseCfg,
        stateDir: tmpDir(),
      });

      expect(summary).toEqual({
        recovered: 0,
        failed: 1,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(recoveryStateAtAck).toBe("unknown_after_send");
      const pending = await loadPendingDeliveries(tmpDir());
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(id);
      expect(pending[0]?.recoveryState).toBe("unknown_after_send");
      expect(pending[0]?.lastError).toContain("ack state db locked");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("keeps a recovered zero-result delivery retryable when ack fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        ackDelivery: vi.fn(async () => {
          throw new Error("ack state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithAckFailure } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithAckFailure({
        deliver: asDeliverFn(vi.fn().mockResolvedValue([])),
        log: createRecoveryLog(),
        cfg: baseCfg,
        stateDir: tmpDir(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      const pending = await loadPendingDeliveries(tmpDir());
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(id);
      expect(pending[0]?.recoveryState).toBeUndefined();
      expect(pending[0]?.retryCount).toBe(1);
      expect(pending[0]?.lastError).toContain("ack state db locked");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("directly acks a recovered send when its post-send marker fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithMarkFailure } =
        await import("./delivery-queue-recovery.js");
      const log = createRecoveryLog();
      const summary = await recoverWithMarkFailure({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log,
      });

      expect(summary).toEqual({
        recovered: 1,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      expectMockMessageContaining(log.warn, "falling back to direct ack");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("retains a recovered required-receipt send when its post-send marker fails", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        replyPayloadSendingHook: {
          kind: "final",
          runId: "run-1",
          messageSentReceiptPluginId: "gaia-workflow-preflight",
          context: { channelId: "demo-channel-a", runId: "run-1" },
        },
      },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithMarkFailure } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithMarkFailure({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      expect((await loadPendingDeliveries(tmpDir())).map((entry) => entry.id)).toContain(id);
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("owns the stable terminal when recovery fallback ack precedes provider rejection", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        queuePolicy: "best_effort",
        payloads: [{ text: "secret" }],
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await ackDelivery(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new Error("provider rejected send"),
          sentBeforeError: false,
          stage: "platform_send",
        });
        throw new Error("provider rejected send");
      },
    );

    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      outcome: "failed",
      failureStage: "platform_send",
    });
    expect(JSON.stringify(auditEvents)).not.toContain("secret");
    expect(JSON.stringify(auditEvents)).not.toContain("provider rejected send");
  });

  it("runs recovered commit hooks when marker fallback ack precedes a partial failure", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "first" }, { text: "second" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const afterCommit = vi.fn();
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithMarkFailure } =
        await import("./delivery-queue-recovery.js");
      const { attachOutboundDeliveryCommitHook: attachHookAfterReset } =
        await import("./delivery-commit-hooks.js");
      const result = attachHookAfterReset(
        { channel: "demo-channel-a", messageId: "m1" },
        afterCommit,
      );
      const summary = await recoverWithMarkFailure({
        deliver: asDeliverFn(
          vi.fn(
            async (params: {
              onDeliveryResult?: (deliveryResult: typeof result) => Promise<void> | void;
              onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
            }) => {
              await params.onDeliveryResult?.(result);
              params.onPayloadDeliveryOutcome?.({
                index: 1,
                status: "failed",
                error: new Error("second send failed"),
                sentBeforeError: false,
                stage: "platform_send",
              });
              return [result];
            },
          ),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("retains unknown-after-send when recovered-send marking and ack both fail", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
        ackDelivery: vi.fn(async () => {
          throw new Error("ack state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithStateFailures } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithStateFailures({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      const entries = await loadPendingDeliveries(tmpDir());
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe(id);
      expect(entries[0]?.recoveryState).toBe("unknown_after_send");
      expect(entries[0]?.retryCount).toBe(1);
      expect(entries[0]?.lastError).toContain("marker=post-send state db locked");
      expect(entries[0]?.lastError).toContain("ack=ack state db locked");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("replays stored delivery options during recovery", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        replyToId: "root-message",
        replyToMode: "first",
        formatting: {
          textLimit: 1234,
          maxLinesPerMessage: 7,
          tableMode: "off",
          chunkMode: "newline",
        },
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        replyPayloadSendingHook: {
          kind: "final",
          channel: "demo-channel-a",
          sessionKey: "agent:main:main",
          runId: "run-1",
          context: {
            channelId: "demo-channel-a",
            conversationId: "+1",
            sessionKey: "agent:main:main",
            runId: "run-1",
            messageId: "inbound-1",
          },
        },
        gatewayClientScopes: ["operator.write"],
        mirror: {
          sessionKey: "agent:main:main",
          text: "a",
          mediaUrls: ["https://example.com/a.png"],
        },
        session: {
          key: "agent:main:main",
          agentId: "agent-main",
          requesterAccountId: "acct-1",
          requesterSenderId: "sender-1",
          requesterSenderName: "Sender One",
          requesterSenderUsername: "sender.one",
          requesterSenderE164: "+15551234567",
        },
      },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    const deliverInput = mockCallArg(deliver) as {
      bestEffort?: boolean;
      gifPlayback?: boolean;
      silent?: boolean;
      replyToId?: string;
      replyToMode?: string;
      formatting?: unknown;
      gatewayClientScopes?: string[];
      replyPayloadSendingHook?: unknown;
      mirror?: unknown;
      session?: unknown;
    };
    expect(deliverInput.bestEffort).toBe(true);
    expect(deliverInput.gifPlayback).toBe(true);
    expect(deliverInput.silent).toBe(true);
    expect(deliverInput.replyToId).toBe("root-message");
    expect(deliverInput.replyToMode).toBe("first");
    expect(deliverInput.formatting).toEqual({
      textLimit: 1234,
      maxLinesPerMessage: 7,
      tableMode: "off",
      chunkMode: "newline",
    });
    expect(deliverInput.gatewayClientScopes).toEqual(["operator.write"]);
    expect(deliverInput.replyPayloadSendingHook).toEqual({
      kind: "final",
      channel: "demo-channel-a",
      sessionKey: "agent:main:main",
      runId: "run-1",
      context: {
        channelId: "demo-channel-a",
        conversationId: "+1",
        sessionKey: "agent:main:main",
        runId: "run-1",
        messageId: "inbound-1",
      },
    });
    expect(deliverInput.mirror).toEqual({
      sessionKey: "agent:main:main",
      text: "a",
      mediaUrls: ["https://example.com/a.png"],
    });
    expect(deliverInput.session).toEqual({
      key: "agent:main:main",
      agentId: "agent-main",
      requesterAccountId: "acct-1",
      requesterSenderId: "sender-1",
      requesterSenderName: "Sender One",
      requesterSenderUsername: "sender.one",
      requesterSenderE164: "+15551234567",
    });
  });

  it("respects maxRecoveryMs time budget without bumping deferred retries", async () => {
    await enqueueCrashRecoveryEntries();
    await enqueueDelivery(
      { channel: "demo-channel-c", to: "#c", payloads: [{ text: "c" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 0,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(3);
    expect(remaining.map((entry) => entry.retryCount)).toStrictEqual([0, 0, 0]);
    expectMockMessageContaining(log.warn, "deferred to next startup");
  });

  it("defers recovery when the recovery deadline would exceed the Date timestamp range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));
    try {
      await enqueueCrashRecoveryEntries();
      const deliver = vi.fn().mockResolvedValue([]);
      const { result, log } = await runRecovery({
        deliver,
        maxRecoveryMs: 1,
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(result).toEqual({
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
      expectMockMessageContaining(log.warn, "deferred to next startup");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers entries until backoff becomes eligible", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: Date.now() });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 60_000,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    expectMockMessageContaining(log.info, "not ready for retry yet");
  });

  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "blocked" }] },
      tmpDir(),
    );
    const readyId = await enqueueDelivery(
      { channel: "demo-channel-b", to: "2", payloads: [{ text: "ready" }] },
      tmpDir(),
    );

    setQueuedEntryState(tmpDir(), blockedId, {
      retryCount: 3,
      lastAttemptAt: now,
      enqueuedAt: now - 30_000,
    });
    setQueuedEntryState(tmpDir(), readyId, { retryCount: 0, enqueuedAt: now - 10_000 });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });

    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverInput = mockCallArg(deliver) as {
      channel?: string;
      to?: string;
      skipQueue?: boolean;
    };
    expect(deliverInput.channel).toBe("demo-channel-b");
    expect(deliverInput.to).toBe("2");
    expect(deliverInput.skipQueue).toBe(true);

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(blockedId);
  });

  it("recovers deferred entries on a later restart once backoff elapsed", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "later" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: start.getTime() });

    const firstDeliver = vi.fn().mockResolvedValue([]);
    const firstRun = await runRecovery({ deliver: firstDeliver, maxRecoveryMs: 60_000 });
    expect(firstRun.result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(firstDeliver).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(start.getTime() + 600_000 + 1));
    const secondDeliver = vi.fn().mockResolvedValue([]);
    const secondRun = await runRecovery({ deliver: secondDeliver, maxRecoveryMs: 60_000 });
    expect(secondRun.result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(secondDeliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);

    vi.useRealTimers();
  });

  it("returns zeros when queue is empty", async () => {
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  describe("Gaia keyed output ownership", () => {
    const accepted = (runId = "accepted-run-1") => ({
      runId,
      sessionKey: "agent:gaia:slack:channel:C123",
      agentId: "gaia",
      acceptedAt: 1_700_000_000_000,
      receiptPluginId: "gaia-workflow-preflight" as const,
    });
    const gaiaParams = (text: string, runId = "accepted-run-1") => ({
      accepted: accepted(runId),
      channel: "slack" as const,
      to: "C123",
      accountId: "acct-1",
      payloads: [{ text }],
      queuePolicy: "required" as const,
    });
    const persistAcceptance = (runId: string, stateDir = tmpDir()) => {
      const result = admitGaiaAcceptance(accepted(runId), stateDir);
      if (result.status !== "accepted") {
        throw new Error(`expected durable acceptance for ${runId}`);
      }
    };

    it("fails closed when durable acceptance is absent", async () => {
      const params = gaiaParams("absent", "absent-acceptance-run");

      await expect(admitGaiaKeyedOutput(params, tmpDir())).rejects.toThrow(
        "matching durable acceptance row",
      );
      expect(
        readOutboundQueueStatus(tmpDir(), deriveGaiaKeyedOutputOwnerId(params.accepted.runId)),
      ).toBeUndefined();
    });

    it("fails closed when durable acceptance evidence is corrupt", async () => {
      const stateDir = tmpDir();
      const envelope = accepted("corrupt-acceptance-run");
      const acceptanceId = deriveGaiaAcceptanceId(envelope.runId);
      persistAcceptance(envelope.runId, stateDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET entry_json = ? WHERE queue_name = 'gaia-acceptance' AND id = ?",
      ).run("{", acceptanceId);

      await expect(
        admitGaiaKeyedOutput(
          { ...gaiaParams("corrupt", envelope.runId), accepted: envelope },
          stateDir,
        ),
      ).rejects.toThrow("corrupt durable acceptance evidence");
      expect(
        recoverGaiaAcceptance(
          {
            runId: envelope.runId,
            sessionKey: envelope.sessionKey,
            agentId: envelope.agentId,
            receiptPluginId: envelope.receiptPluginId,
          },
          stateDir,
        ),
      ).toEqual({ status: "corrupt" });
      expect(readOutboundQueueStatus(stateDir, deriveGaiaKeyedOutputOwnerId(envelope.runId))).toBe(
        undefined,
      );
    });

    it("keeps mismatched durable acceptance evidence out of owner admission", async () => {
      const stateDir = tmpDir();
      const requested = accepted("mismatched-acceptance-run");
      const stored = { ...requested, sessionKey: "agent:gaia:slack:channel:OTHER" };
      expect(admitGaiaAcceptance(stored, stateDir)).toEqual({
        status: "accepted",
        accepted: stored,
      });

      await expect(
        admitGaiaKeyedOutput(
          { ...gaiaParams("mismatched", requested.runId), accepted: requested },
          stateDir,
        ),
      ).resolves.toMatchObject({
        status: "conflict",
        ownerId: deriveGaiaKeyedOutputOwnerId(requested.runId),
      });
      expect(readOutboundQueueStatus(stateDir, deriveGaiaKeyedOutputOwnerId(requested.runId))).toBe(
        undefined,
      );
    });

    it("persists exact acceptance tuples, refreshes before ownership, and retains authority", async () => {
      const initial = accepted("acceptance-run");
      const acceptanceId = deriveGaiaAcceptanceId(initial.runId);
      expect(acceptanceId).not.toBe(deriveGaiaKeyedOutputOwnerId(initial.runId));
      expect(admitGaiaAcceptance(initial, tmpDir())).toEqual({
        status: "accepted",
        accepted: initial,
      });

      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      const row = db
        .prepare("SELECT queue_name, status, entry_json FROM delivery_queue_entries WHERE id = ?")
        .get(acceptanceId) as { queue_name: string; status: string; entry_json: string };
      expect(row.queue_name).toBe("gaia-acceptance");
      expect(row.status).toBe("completed");
      const persisted = JSON.parse(row.entry_json) as {
        gaiaAcceptance: Record<string, unknown>;
      };
      expect(Object.keys(persisted.gaiaAcceptance).toSorted()).toEqual([
        "acceptedAt",
        "agentId",
        "receiptPluginId",
        "runId",
        "sessionKey",
      ]);
      expect(persisted.gaiaAcceptance).toEqual(initial);

      const refreshed = { ...initial, acceptedAt: initial.acceptedAt + 1 };
      expect(admitGaiaAcceptance(refreshed, tmpDir())).toEqual({
        status: "accepted",
        accepted: refreshed,
      });
      expect(
        recoverGaiaAcceptance(
          {
            runId: initial.runId,
            sessionKey: initial.sessionKey,
            agentId: initial.agentId,
            receiptPluginId: initial.receiptPluginId,
          },
          tmpDir(),
        ),
      ).toEqual({ status: "found", accepted: refreshed });
      expect(
        admitGaiaAcceptance(
          { ...refreshed, sessionKey: "agent:gaia:slack:channel:OTHER" },
          tmpDir(),
        ),
      ).toEqual(expect.objectContaining({ status: "conflict" }));
      expect(
        recoverGaiaAcceptance(
          {
            runId: initial.runId,
            sessionKey: "agent:gaia:slack:channel:OTHER",
            agentId: initial.agentId,
            receiptPluginId: initial.receiptPluginId,
          },
          tmpDir(),
        ),
      ).toEqual({ status: "mismatch" });
      expect(
        recoverGaiaAcceptance(
          {
            runId: "missing-acceptance-run",
            sessionKey: initial.sessionKey,
            agentId: initial.agentId,
            receiptPluginId: initial.receiptPluginId,
          },
          tmpDir(),
        ),
      ).toEqual({ status: "absent" });

      const owner = await admitGaiaKeyedOutput(
        { ...gaiaParams("owner", initial.runId), accepted: refreshed },
        tmpDir(),
      );
      expect(
        admitGaiaAcceptance({ ...refreshed, acceptedAt: refreshed.acceptedAt + 1 }, tmpDir()),
      ).toEqual(expect.objectContaining({ status: "conflict" }));

      db.prepare(
        "UPDATE delivery_queue_entries SET enqueued_at = ? WHERE queue_name = 'gaia-acceptance' AND id = ?",
      ).run(Date.now() - 31 * 24 * 60 * 60 * 1000, acceptanceId);
      completeDeliveryQueueEntry("gaia-acceptance", acceptanceId, tmpDir());
      expect(
        recoverGaiaAcceptance(
          {
            runId: initial.runId,
            sessionKey: initial.sessionKey,
            agentId: initial.agentId,
            receiptPluginId: initial.receiptPluginId,
          },
          tmpDir(),
        ),
      ).toEqual({ status: "found", accepted: refreshed });
      expect((await loadPendingDeliveries(tmpDir())).map((entry) => entry.id)).toEqual([
        owner.ownerId,
      ]);
    });

    it("serializes acceptance refresh and owner admission in both orderings", async () => {
      const repoRoot = process.cwd();
      const storageModulePath = path.resolve(
        repoRoot,
        "src/infra/outbound/delivery-queue-storage.ts",
      );
      const stateModulePath = path.resolve(repoRoot, "src/state/openclaw-state-db.ts");
      const workerBundle = await build({
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        write: false,
        stdin: {
          contents: [
            `export * from ${JSON.stringify(storageModulePath)};`,
            `export { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } from ${JSON.stringify(stateModulePath)};`,
          ].join("\n"),
          resolveDir: repoRoot,
          sourcefile: "gaia-acceptance-owner-race-entry.ts",
        },
        plugins: [
          {
            name: "openclaw-normalization-core-source",
            setup(esbuild) {
              esbuild.onResolve(
                { filter: /^@openclaw\/normalization-core(?:\/.*)?$/ },
                ({ path: importPath }) => {
                  const subpath =
                    importPath === "@openclaw/normalization-core"
                      ? "index"
                      : importPath.slice("@openclaw/normalization-core/".length);
                  return {
                    path: path.resolve(
                      repoRoot,
                      "packages/normalization-core/src",
                      `${subpath}.ts`,
                    ),
                  };
                },
              );
            },
          },
        ],
      });
      const bundlePath = path.join(tmpDir(), "gaia-acceptance-owner-race-worker.mjs");
      fs.writeFileSync(bundlePath, Buffer.from(workerBundle.outputFiles[0].contents));
      const orders = ["refresh-first", "owner-first"] as const;

      for (const order of orders) {
        const stateDir = path.join(tmpDir(), `gaia-acceptance-owner-${order}`);
        fs.mkdirSync(stateDir, { recursive: true });
        const initial = { ...accepted(`race-${order}`), acceptedAt: 1_700_000_000_100 };
        const refreshed = { ...initial, acceptedAt: initial.acceptedAt + 100 };
        expect(admitGaiaAcceptance(initial, stateDir)).toEqual({
          status: "accepted",
          accepted: initial,
        });

        const refreshBarrier = new SharedArrayBuffer(4);
        const ownerBarrier = new SharedArrayBuffer(4);
        const workerData = {
          bundlePath,
          stateDir,
        };
        const refreshWorker = new Worker(GAIA_ACCEPTANCE_OWNER_RACE_WORKER_SOURCE, {
          eval: true,
          workerData: {
            ...workerData,
            role: "refresh",
            accepted: refreshed,
            beginBarrier: refreshBarrier,
          },
        });
        const ownerWorker = new Worker(GAIA_ACCEPTANCE_OWNER_RACE_WORKER_SOURCE, {
          eval: true,
          workerData: {
            ...workerData,
            role: "owner",
            params: { ...gaiaParams("race-owner", initial.runId), accepted: initial },
            beginBarrier: ownerBarrier,
          },
        });

        const refreshReady = waitForGaiaRaceWorkerMessage(refreshWorker, "ready");
        const ownerReady = waitForGaiaRaceWorkerMessage(ownerWorker, "ready");
        const refreshAttempting = waitForGaiaRaceWorkerMessage(refreshWorker, "attempting");
        const ownerAttempting = waitForGaiaRaceWorkerMessage(ownerWorker, "attempting");
        const refreshBegun = waitForGaiaRaceWorkerMessage(refreshWorker, "begun");
        const ownerBegun = waitForGaiaRaceWorkerMessage(ownerWorker, "begun");
        const refreshSettled = waitForGaiaRaceWorkerMessage(refreshWorker, "settled");
        const ownerSettled = waitForGaiaRaceWorkerMessage(ownerWorker, "settled");
        const release = (barrier: SharedArrayBuffer): void => {
          const view = new Int32Array(barrier);
          Atomics.store(view, 0, 1);
          Atomics.notify(view, 0);
        };

        try {
          await Promise.all([refreshReady, ownerReady]);
          const firstWorker = order === "refresh-first" ? refreshWorker : ownerWorker;
          const secondWorker = order === "refresh-first" ? ownerWorker : refreshWorker;
          const firstBarrier = order === "refresh-first" ? refreshBarrier : ownerBarrier;
          const secondBarrier = order === "refresh-first" ? ownerBarrier : refreshBarrier;
          const firstAttempting = order === "refresh-first" ? refreshAttempting : ownerAttempting;
          const secondAttempting = order === "refresh-first" ? ownerAttempting : refreshAttempting;
          const firstBegun = order === "refresh-first" ? refreshBegun : ownerBegun;
          const secondBegun = order === "refresh-first" ? ownerBegun : refreshBegun;

          firstWorker.postMessage("go");
          await firstAttempting;
          await firstBegun;
          secondWorker.postMessage("go");
          await secondAttempting;
          release(firstBarrier);
          await secondBegun;
          release(secondBarrier);

          const [refreshMessage, ownerMessage] = await Promise.all([refreshSettled, ownerSettled]);
          expect(refreshMessage.ok).toBe(true);
          expect(ownerMessage.ok).toBe(true);
          const refreshResult = refreshMessage.result as { status: string };
          const ownerResult = ownerMessage.result as {
            status: string;
            entry: { gaiaKeyedOutput?: { accepted?: { acceptedAt?: number } } };
          };
          expect(refreshResult.status).toBe(order === "refresh-first" ? "accepted" : "conflict");
          expect(ownerResult.status).toBe("new");

          const persisted = recoverGaiaAcceptance(
            {
              runId: initial.runId,
              sessionKey: initial.sessionKey,
              agentId: initial.agentId,
              receiptPluginId: initial.receiptPluginId,
            },
            stateDir,
          );
          expect(persisted.status).toBe("found");
          if (persisted.status !== "found") {
            throw new Error("expected the acceptance row to persist");
          }
          expect(persisted.accepted).toEqual(order === "refresh-first" ? refreshed : initial);

          const owner = inspectGaiaKeyedOutput(initial, stateDir);
          expect(owner).not.toBeNull();
          if (!owner) {
            throw new Error("expected the keyed owner row to persist");
          }
          const persistedOwnerAcceptedAt = owner.entry.gaiaKeyedOutput?.accepted.acceptedAt;
          const reportedOwnerAcceptedAt = ownerResult.entry.gaiaKeyedOutput?.accepted?.acceptedAt;
          expect(reportedOwnerAcceptedAt).toBe(persistedOwnerAcceptedAt);
          expect(persistedOwnerAcceptedAt).toBe(persisted.accepted.acceptedAt);
          if (refreshResult.status === "accepted" && ownerResult.status === "new") {
            expect(persistedOwnerAcceptedAt).toBe(persisted.accepted.acceptedAt);
          }
        } finally {
          release(refreshBarrier);
          release(ownerBarrier);
          await Promise.all([refreshWorker.terminate(), ownerWorker.terminate()]);
        }
      }
    });

    it("atomically admits one owner and reports a two-payload race as conflict", async () => {
      persistAcceptance("accepted-run-1");
      const [first, second] = await Promise.all([
        admitGaiaKeyedOutput(gaiaParams("first"), tmpDir()),
        admitGaiaKeyedOutput(gaiaParams("second"), tmpDir()),
      ]);

      expect([first.status, second.status].toSorted()).toEqual(["conflict", "new"]);
      const owner = first.status === "new" ? first : second;
      const conflict = first.status === "conflict" ? first : second;
      expect(owner.ownerId).toBe(deriveGaiaKeyedOutputOwnerId("accepted-run-1"));
      expect(conflict.entry.payloads).toEqual(owner.entry.payloads);
      await expect(admitGaiaKeyedOutput(gaiaParams("first"), tmpDir())).resolves.toMatchObject({
        status: "duplicate",
        ownerId: owner.ownerId,
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    });

    it("sends a newly admitted owner through its exact durable queue row", async () => {
      persistAcceptance("accepted-run-1");
      const admitted = await admitGaiaKeyedOutput(gaiaParams("send"), tmpDir());
      const deliver = vi.fn().mockResolvedValue([]);

      await drainPendingDeliveries({
        drainKey: `gaia-test:${admitted.ownerId}`,
        logLabel: "Gaia test",
        cfg: baseCfg,
        log: createRecoveryLog(),
        stateDir: tmpDir(),
        deliver: asDeliverFn(deliver),
        selectEntry: (entry) => ({
          match: entry.id === admitted.ownerId,
          bypassBackoff: true,
        }),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(mockCallArg(deliver)).toMatchObject({
        deliveryQueueId: admitted.ownerId,
        payloads: [{ text: "send" }],
        skipQueue: true,
      });
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("completed");
    });

    it.each(["pending", "completed", "failed"] as const)(
      "does not mutate a %s Gaia winner when stale recovery loses the send fence",
      async (winnerStatus) => {
        const runId = `stale-loser-${winnerStatus}-run`;
        persistAcceptance(runId);
        const admitted = await admitGaiaKeyedOutput(gaiaParams("stale-loser", runId), tmpDir());
        let winnerEntry: ReturnType<typeof readQueuedEntry> | undefined;
        const deliver = vi.fn(async () => {
          expect(acquireGaiaSlackSendFence(admitted.ownerId, tmpDir()).status).toBe("acquired");
          if (winnerStatus === "completed") {
            await completeDelivery(admitted.ownerId, tmpDir());
          } else if (winnerStatus === "failed") {
            await moveToFailed(admitted.ownerId, tmpDir());
          }
          winnerEntry = readQueuedEntry(tmpDir(), admitted.ownerId);
          return [];
        });

        await drainPendingDeliveries({
          drainKey: `stale-loser:${admitted.ownerId}`,
          logLabel: "Gaia test",
          cfg: baseCfg,
          log: createRecoveryLog(),
          stateDir: tmpDir(),
          deliver: asDeliverFn(deliver),
          selectEntry: (entry) => ({ match: entry.id === admitted.ownerId, bypassBackoff: true }),
        });

        expect(deliver).toHaveBeenCalledOnce();
        expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe(winnerStatus);
        expect(readQueuedEntry(tmpDir(), admitted.ownerId)).toEqual(winnerEntry);
        expect(readQueuedEntry(tmpDir(), admitted.ownerId)).toMatchObject({
          retryCount: 0,
        });
        if (winnerStatus === "pending") {
          expect(readQueuedEntry(tmpDir(), admitted.ownerId)).toMatchObject({
            recoveryState: "send_attempt_started",
          });
        }
      },
    );

    it("reconciles durable send evidence before permanent owner failure", async () => {
      persistAcceptance("accepted-run-1");
      const admitted = await admitGaiaKeyedOutput(gaiaParams("marked"), tmpDir());
      const error = "No conversation reference found for C123";
      const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend,
        },
      });
      const deliver = vi.fn(async () => {
        await markDeliveryPlatformSendAttemptStarted(admitted.ownerId, tmpDir());
        throw new Error(error);
      });
      const { result } = await runRecovery({ deliver });
      const entry = readQueuedEntry(tmpDir(), admitted.ownerId);
      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("pending");
      expect(entry).toMatchObject({
        lastError: "Slack durable send readback returned not_sent after the permanent send fence",
        recoveryState: "unknown_after_send",
        reconciliationAttemptCount: 1,
      });
    });

    it("completes a fenced owner from exact sent readback without replay", async () => {
      persistAcceptance("fenced-sent-run");
      const admitted = await admitGaiaKeyedOutput(
        gaiaParams("fenced-sent", "fenced-sent-run"),
        tmpDir(),
      );
      expect(acquireGaiaSlackSendFence(admitted.ownerId, tmpDir()).status).toBe("acquired");
      const reconcileUnknownSend = vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "slack-sent-1",
        receipt: {
          primaryPlatformMessageId: "slack-sent-1",
          platformMessageIds: ["slack-sent-1"],
          parts: [{ platformMessageId: "slack-sent-1", kind: "text", index: 0 }],
          sentAt: Date.now(),
        },
      });
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: { capabilities: { reconcileUnknownSend: true }, reconcileUnknownSend },
      });
      const deliver = vi.fn();

      await runRecovery({ deliver });

      expect(reconcileUnknownSend).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("completed");
      expect(inspectGaiaKeyedOutput(accepted("fenced-sent-run"), tmpDir())?.status).toBe(
        "completed",
      );
    });

    it("serializes the SQLite Gaia fence across two child processes", async () => {
      const stateDir = tmpDir();
      const acceptedEnvelope = accepted("cross-process-fence-run");
      persistAcceptance(acceptedEnvelope.runId, stateDir);
      const admitted = await admitGaiaKeyedOutput(
        gaiaParams("cross-process-fence", acceptedEnvelope.runId),
        stateDir,
      );
      const bundle = await build({
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        write: false,
        stdin: {
          contents: `export * from ${JSON.stringify(
            path.resolve(process.cwd(), "src/infra/outbound/delivery-queue-storage.ts"),
          )};`,
          resolveDir: process.cwd(),
          sourcefile: "fence-storage-entry.ts",
        },
      });
      const bundlePath = path.join(stateDir, "fence-storage.mjs");
      fs.writeFileSync(bundlePath, bundle.outputFiles[0]!.contents);
      const childScript = `
        const { pathToFileURL } = await import('node:url');
        const storage = await import(pathToFileURL(process.env.BUNDLE_PATH).href);
        const result = storage.acquireGaiaSlackSendFence(process.env.OWNER_ID, process.env.STATE_DIR);
        console.log(JSON.stringify({ type: 'fenced', status: result.status }));
        await new Promise((resolve) => process.stdin.once('data', resolve));
        console.log(JSON.stringify({ type: 'adapterCalls', count: result.status === 'acquired' ? 1 : 0 }));
        storage.closeOpenClawStateDatabaseForTest();
      `;
      const launch = () =>
        spawn(process.execPath, ["--input-type=module", "-e", childScript], {
          env: {
            ...process.env,
            BUNDLE_PATH: bundlePath,
            OWNER_ID: admitted.ownerId,
            STATE_DIR: stateDir,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
      const readMessage = (child: ReturnType<typeof spawn>, type: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          let buffer = "";
          const onData = (chunk: Buffer | string) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              try {
                const message = JSON.parse(line) as Record<string, unknown>;
                if (message.type === type) {
                  child.stdout?.off("data", onData);
                  resolve(message);
                  return;
                }
              } catch {
                // Ignore child runtime warnings and wait for the protocol line.
              }
            }
          };
          child.stdout?.on("data", onData);
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0) reject(new Error(`fence child exited with ${code}`));
          });
        });
      const winner = launch();
      expect((await readMessage(winner, "fenced")).status).toBe("acquired");
      const loser = launch();
      expect((await readMessage(loser, "fenced")).status).toBe("owned");
      loser.stdin.end("release\n");
      expect((await readMessage(loser, "adapterCalls")).count).toBe(0);
      winner.stdin.end("release\n");
      expect((await readMessage(winner, "adapterCalls")).count).toBe(1);
      await Promise.all([
        new Promise<void>((resolve) => loser.once("exit", () => resolve())),
        new Promise<void>((resolve) => winner.once("exit", () => resolve())),
      ]);
    });

    it("converges repeated fenced unresolved and not_sent readback to ambiguous failure", async () => {
      persistAcceptance("fenced-ambiguous-run");
      const admitted = await admitGaiaKeyedOutput(
        gaiaParams("fenced-ambiguous", "fenced-ambiguous-run"),
        tmpDir(),
      );
      expect(acquireGaiaSlackSendFence(admitted.ownerId, tmpDir()).status).toBe("acquired");
      const reconcileUnknownSend = vi
        .fn()
        .mockResolvedValue({
          status: "unresolved",
          error: "Slack history contains no exact durable delivery marker",
          retryable: true,
        })
        .mockResolvedValueOnce({
          status: "unresolved",
          error: "Slack history contains no exact durable delivery marker",
          retryable: true,
        })
        .mockResolvedValueOnce({
          status: "unresolved",
          error: "Slack history contains no exact durable delivery marker",
          retryable: true,
        })
        .mockResolvedValueOnce({
          status: "unresolved",
          error: "Slack history contains no exact durable delivery marker",
          retryable: true,
        })
        .mockResolvedValueOnce({
          status: "unresolved",
          error: "Slack history contains no exact durable delivery marker",
          retryable: true,
        })
        .mockResolvedValueOnce({ status: "not_sent" });
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: { capabilities: { reconcileUnknownSend: true }, reconcileUnknownSend },
      });
      const deliver = vi.fn();

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        await drainPendingDeliveries({
          drainKey: `fenced-ambiguous:${admitted.ownerId}:${attempt}`,
          logLabel: "Gaia test",
          cfg: baseCfg,
          log: createRecoveryLog(),
          stateDir: tmpDir(),
          deliver: asDeliverFn(deliver),
          selectEntry: (entry) => ({ match: entry.id === admitted.ownerId, bypassBackoff: true }),
        });
      }

      expect(reconcileUnknownSend).toHaveBeenCalledTimes(MAX_RETRIES);
      expect(deliver).not.toHaveBeenCalled();
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), admitted.ownerId)).toMatchObject({
        reconciliationAttemptCount: MAX_RETRIES,
        recoveryState: "ambiguous_failure",
        lastError: "Slack durable send readback returned not_sent after the permanent send fence",
      });
      expect(inspectGaiaKeyedOutput(accepted("fenced-ambiguous-run"), tmpDir())?.status).toBe(
        "ambiguous_failure",
      );
      expect(resumeGaiaKeyedOutput(accepted("fenced-ambiguous-run"), tmpDir())?.status).toBe(
        "ambiguous_failure",
      );
    });

    it.each([
      { kind: "ordinary", isGaia: false },
      { kind: "Gaia", isGaia: true },
    ] as const)(
      "persists a permanent error through a delayed not_sent readback for $kind",
      async ({ kind, isGaia }) => {
        const error = "No conversation reference found for C123";
        const runId = `delayed-${kind.toLowerCase()}-run`;
        let id: string;
        if (isGaia) {
          persistAcceptance(runId);
          id = (await admitGaiaKeyedOutput(gaiaParams("delayed", runId), tmpDir())).ownerId;
        } else {
          id = await enqueueDelivery(
            { channel: "demo-channel-a", to: "+1", payloads: [{ text: "delayed" }] },
            tmpDir(),
          );
        }
        const reconcileUnknownSend = vi
          .fn()
          .mockResolvedValueOnce({
            status: "unresolved",
            error: "temporary readback gap",
            retryable: true,
          })
          .mockResolvedValueOnce({ status: "not_sent" });
        resolveOutboundChannelMessageAdapterMock.mockReturnValue({
          durableFinal: {
            capabilities: { reconcileUnknownSend: true },
            reconcileUnknownSend,
          },
        });
        const deliver = vi.fn(async () => {
          await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
          throw new Error(error);
        });

        const first = await runRecovery({ deliver });
        expect(first.result).toMatchObject({ recovered: 0, failed: 1 });
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
          pendingPermanentError: error,
          recoveryState: isGaia ? "unknown_after_send" : "send_attempt_started",
        });

        await drainPendingDeliveries({
          drainKey: `delayed-permanent:${id}`,
          logLabel: "Delayed permanent test",
          cfg: baseCfg,
          log: createRecoveryLog(),
          stateDir: tmpDir(),
          deliver: asDeliverFn(deliver),
          selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
        });

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(reconcileUnknownSend).toHaveBeenCalledTimes(2);
        if (isGaia) {
          expect(readOutboundQueueStatus(tmpDir(), id)).toBe("pending");
          expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
            lastError:
              "Slack durable send readback returned not_sent after the permanent send fence",
            pendingPermanentError: error,
            recoveryState: "unknown_after_send",
            reconciliationAttemptCount: 2,
          });
          expect(inspectGaiaKeyedOutput(accepted(runId), tmpDir())).toMatchObject({
            status: "pending",
            entry: { recoveryState: "unknown_after_send" },
          });
          expect(resumeGaiaKeyedOutput(accepted(runId), tmpDir())?.status).toBe("pending");
        } else {
          expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
          expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
            lastError: error,
            pendingPermanentError: error,
          });
        }
      },
    );

    it("keeps a keyed owner permanently failed after a pre-send permanent error", async () => {
      const acceptedEnvelope = accepted("permanent-pre-send-run");
      persistAcceptance(acceptedEnvelope.runId);
      const admitted = await admitGaiaKeyedOutput(
        { ...gaiaParams("permanent", acceptedEnvelope.runId), accepted: acceptedEnvelope },
        tmpDir(),
      );
      const error = "No conversation reference found for C123";
      const deliver = vi.fn().mockRejectedValue(new Error(error));

      const { result } = await runRecovery({ deliver });

      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), admitted.ownerId)).toMatchObject({
        lastError: error,
        recoveryState: "permanent_pre_send_failure",
      });
      expect(resumeGaiaKeyedOutput(acceptedEnvelope, tmpDir())?.status).toBe("permanent_failure");

      await drainPendingDeliveries({
        drainKey: `gaia-test:${admitted.ownerId}`,
        logLabel: "Gaia test",
        cfg: baseCfg,
        log: createRecoveryLog(),
        stateDir: tmpDir(),
        deliver,
        selectEntry: (entry) => ({ match: entry.id === admitted.ownerId, bypassBackoff: true }),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(inspectGaiaKeyedOutput(acceptedEnvelope, tmpDir())).toMatchObject({
        ownerId: admitted.ownerId,
        status: "permanent_failure",
        entry: { lastError: error, recoveryState: "permanent_pre_send_failure" },
      });
    });

    it("retries the exact pending and failed owner rows", async () => {
      persistAcceptance("pending-run");
      persistAcceptance("failed-run");
      const pending = await admitGaiaKeyedOutput(gaiaParams("pending", "pending-run"), tmpDir());
      const failed = await admitGaiaKeyedOutput(gaiaParams("failed", "failed-run"), tmpDir());
      await moveToFailed(failed.ownerId, tmpDir());

      expect(resumeGaiaKeyedOutput(accepted("pending-run"), tmpDir())?.status).toBe("pending");
      expect(resumeGaiaKeyedOutput(accepted("failed-run"), tmpDir())?.status).toBe("pending");

      const deliver = vi.fn().mockResolvedValue([]);
      for (const ownerId of [pending.ownerId, failed.ownerId]) {
        await drainPendingDeliveries({
          drainKey: `gaia-test:${ownerId}`,
          logLabel: "Gaia test",
          cfg: baseCfg,
          log: createRecoveryLog(),
          stateDir: tmpDir(),
          deliver: asDeliverFn(deliver),
          selectEntry: (entry) => ({
            match: entry.id === ownerId,
            bypassBackoff: true,
          }),
        });
      }

      expect(deliver.mock.calls.map(([params]) => params.deliveryQueueId)).toEqual([
        pending.ownerId,
        failed.ownerId,
      ]);
      expect(readOutboundQueueStatus(tmpDir(), pending.ownerId)).toBe("completed");
      expect(readOutboundQueueStatus(tmpDir(), failed.ownerId)).toBe("completed");
    });

    it("resets an exhausted pre-send retry budget without changing the owner", async () => {
      const acceptedEnvelope = accepted("retry-reset-run");
      persistAcceptance(acceptedEnvelope.runId);
      const admitted = await admitGaiaKeyedOutput(
        { ...gaiaParams("retry-reset", acceptedEnvelope.runId), accepted: acceptedEnvelope },
        tmpDir(),
      );
      const lastAttemptAt = Date.now() - 60_000;
      setQueuedEntryState(tmpDir(), admitted.ownerId, {
        retryCount: MAX_RETRIES,
        reconciliationAttemptCount: 4,
        lastAttemptAt,
        lastError: "pre-send retry budget exhausted",
      });

      const exhausted = vi.fn();
      const exhaustedRecovery = await runRecovery({ deliver: exhausted });
      expect(exhaustedRecovery.result).toMatchObject({ skippedMaxRetries: 1 });
      expect(exhausted).not.toHaveBeenCalled();
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("failed");

      const resumed = resumeGaiaKeyedOutput(acceptedEnvelope, tmpDir());
      expect(resumed).toMatchObject({
        ownerId: admitted.ownerId,
        status: "pending",
        entry: {
          retryCount: 0,
          reconciliationAttemptCount: 4,
          lastAttemptAt,
          lastError: "pre-send retry budget exhausted",
          payloads: [{ text: "retry-reset" }],
        },
      });
      expect(resumed?.entry.gaiaKeyedOutput).toEqual(admitted.entry.gaiaKeyedOutput);

      const receiptCommit = vi.fn();
      const receipt = attachOutboundDeliveryCommitHook(
        { channel: "slack", messageId: "retry-reset-receipt" },
        receiptCommit,
      );
      const deliver = vi.fn().mockResolvedValue([receipt]);
      const recovered = await runRecovery({ deliver });

      expect(recovered.result).toMatchObject({ recovered: 1, failed: 0 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(receiptCommit).toHaveBeenCalledOnce();
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("completed");

      const repeated = await runRecovery({ deliver });
      expect(repeated.result).toMatchObject({ recovered: 0, failed: 0 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(inspectGaiaKeyedOutput(acceptedEnvelope, tmpDir())?.status).toBe("completed");
    });

    it("does not double-send concurrent duplicate owner drains", async () => {
      persistAcceptance("accepted-run-1");
      const [first, duplicate] = await Promise.all([
        admitGaiaKeyedOutput(gaiaParams("same"), tmpDir()),
        admitGaiaKeyedOutput(gaiaParams("same"), tmpDir()),
      ]);
      expect([first.status, duplicate.status].toSorted()).toEqual(["duplicate", "new"]);
      const ownerId = first.ownerId;
      let release!: () => void;
      let startDelivery!: () => void;
      const started = new Promise<void>((resolve) => {
        startDelivery = resolve;
      });
      const deliver = vi.fn(async () => {
        startDelivery();
        await new Promise<void>((next) => {
          release = next;
        });
        return [];
      });
      const firstDrain = drainPendingDeliveries({
        drainKey: `gaia-test:${ownerId}`,
        logLabel: "Gaia test",
        cfg: baseCfg,
        log: createRecoveryLog(),
        stateDir: tmpDir(),
        deliver: asDeliverFn(deliver),
        selectEntry: (entry) => ({
          match: entry.id === ownerId,
          bypassBackoff: true,
        }),
      });
      await started;
      const duplicateDeliver = vi.fn().mockResolvedValue([]);
      const secondDrain = drainPendingDeliveries({
        drainKey: `gaia-test:${ownerId}`,
        logLabel: "Gaia test",
        cfg: baseCfg,
        log: createRecoveryLog(),
        stateDir: tmpDir(),
        deliver: asDeliverFn(duplicateDeliver),
        selectEntry: (entry) => ({
          match: entry.id === ownerId,
          bypassBackoff: true,
        }),
      });
      await secondDrain;
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(duplicateDeliver).not.toHaveBeenCalled();
      release();
      await firstDrain;
      expect(readOutboundQueueStatus(tmpDir(), ownerId)).toBe("completed");
    });

    it("restarts inspection and resume from the durable owner row", async () => {
      persistAcceptance("accepted-run-1");
      const admitted = await admitGaiaKeyedOutput(gaiaParams("restart"), tmpDir());
      expect(inspectGaiaKeyedOutput(accepted(), tmpDir())).toMatchObject({
        ownerId: admitted.ownerId,
        status: "pending",
      });
      expect(resumeGaiaKeyedOutput(accepted(), tmpDir())).toMatchObject({
        ownerId: admitted.ownerId,
        status: "pending",
        entry: { payloads: [{ text: "restart" }] },
      });

      await completeDelivery(admitted.ownerId, tmpDir());
      expect(resumeGaiaKeyedOutput(accepted(), tmpDir())).toMatchObject({
        ownerId: admitted.ownerId,
        status: "completed",
        entry: { gaiaKeyedOutput: { fingerprint: admitted.fingerprint } },
      });
    });

    it("does not overwrite an unreadable Gaia owner during completion", async () => {
      persistAcceptance("corrupt-owner-run");
      const admitted = await admitGaiaKeyedOutput(
        gaiaParams("corrupt-owner", "corrupt-owner-run"),
        tmpDir(),
      );
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET entry_json = ? WHERE queue_name = 'outbound' AND id = ?",
      ).run("{", admitted.ownerId);
      expect(() => completeDeliveryQueueEntry("outbound", admitted.ownerId, tmpDir())).toThrow(
        /No pending outbound delivery queue entry/,
      );
      const row = db
        .prepare(
          "SELECT status, entry_json, entry_kind FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?",
        )
        .get(admitted.ownerId) as { status: string; entry_json: string; entry_kind: string };
      expect(row).toEqual({ status: "pending", entry_json: "{", entry_kind: "outbound" });
    });

    it("terminalizes a non-retryable Slack readback gap as ambiguous failure", async () => {
      const acceptedEnvelope = accepted("readback-gap-run");
      persistAcceptance(acceptedEnvelope.runId);
      const admitted = await admitGaiaKeyedOutput(
        gaiaParams("readback-gap", acceptedEnvelope.runId),
        tmpDir(),
      );
      expect(acquireGaiaSlackSendFence(admitted.ownerId, tmpDir()).status).toBe("acquired");
      const reconcileUnknownSend = vi.fn().mockResolvedValue({
        status: "unresolved",
        error: "signed Slack readback gap",
        retryable: false,
      });
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend,
        },
      });

      const { result } = await runRecovery({ deliver: vi.fn() });

      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      expect(reconcileUnknownSend).toHaveBeenCalledOnce();
      expect(readOutboundQueueStatus(tmpDir(), admitted.ownerId)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), admitted.ownerId)).toMatchObject({
        reconciliationAttemptCount: 1,
        recoveryState: "ambiguous_failure",
        lastError: "signed Slack readback gap",
      });
      expect(inspectGaiaKeyedOutput(acceptedEnvelope, tmpDir())?.status).toBe("ambiguous_failure");
    });

    it("retains a Gaia completed-admission tombstone while another owner is live", async () => {
      persistAcceptance("completed-run");
      persistAcceptance("live-run");
      const completed = await admitGaiaKeyedOutput(gaiaParams("done", "completed-run"), tmpDir());
      const live = await admitGaiaKeyedOutput(gaiaParams("live", "live-run"), tmpDir());
      await completeDelivery(completed.ownerId, tmpDir());

      expect(inspectGaiaKeyedOutput(accepted("completed-run"), tmpDir())?.status).toBe("completed");
      expect(inspectGaiaKeyedOutput(accepted("live-run"), tmpDir())?.status).toBe("pending");
      expect(live.entry.gaiaKeyedOutput?.version).toBe("gaia-slack-output-v1");
    });

    it("retains keyed Gaia tombstones past a configured 31-day admission window", async () => {
      const gaiaRetentionMs = 31 * 24 * 60 * 60 * 1000;
      expect(gaiaRetentionMs).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
      persistAcceptance("retention-run");
      const completed = await admitGaiaKeyedOutput(
        gaiaParams("retention", "retention-run"),
        tmpDir(),
      );
      await completeDelivery(completed.ownerId, tmpDir());
      const oldEnqueuedAt = Date.now() - gaiaRetentionMs - 1;
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET enqueued_at = ? WHERE queue_name = 'outbound' AND id = ?",
      ).run(oldEnqueuedAt, completed.ownerId);

      const ordinary = await enqueueDelivery(
        { channel: "slack", to: "C123", payloads: [{ text: "ordinary" }] },
        tmpDir(),
      );
      await completeDelivery(ordinary, tmpDir());

      expect(inspectGaiaKeyedOutput(accepted("retention-run"), tmpDir())?.status).toBe("completed");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
