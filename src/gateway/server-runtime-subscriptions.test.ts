// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentAuditEvent,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { createTaskRecord } from "../tasks/task-registry.js";
import { getTaskRegistryObservers } from "../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";
import type { TaskEventPayload } from "./server-methods/task-summary.js";

const warn = vi.fn();
const mockLog: SubsystemLogger = {
  subsystem: "gateway-test",
  isEnabled: () => true,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => mockLog,
};

const auditTestState = vi.hoisted(() => ({
  enabled: true,
  messageMode: "off" as "off" | "direct" | "all",
  created: 0,
  recorded: 0,
  stopped: 0,
}));
const agentEventHandlerMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => auditTestState.enabled,
  resolveAuditMessageMode: () => auditTestState.messageMode,
}));

vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => {
    auditTestState.created += 1;
    return {
      record: vi.fn(() => {
        auditTestState.recorded += 1;
      }),
      recordTool: vi.fn(),
      recordMessage: vi.fn(),
      stop: vi.fn(async () => {
        auditTestState.stopped += 1;
      }),
    };
  },
}));

vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: (...args: unknown[]) => agentEventHandlerMocks.create(...args),
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: () => "agent:main:main",
}));

vi.mock("./server-session-events.js", () => ({
  createTranscriptUpdateBroadcastHandler: () => () => {
    throw new Error("transcript handler failure");
  },
  createLifecycleEventBroadcastHandler: () => () => {
    throw new Error("lifecycle handler failure");
  },
}));

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];

function createParams(): SubscriptionParams {
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState: createChatRunState(),
    toolEventRecipients: createToolEventRecipientRegistry(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
  };
}

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    auditTestState.enabled = true;
    auditTestState.messageMode = "off";
    auditTestState.created = 0;
    auditTestState.recorded = 0;
    auditTestState.stopped = 0;
    agentEventHandlerMocks.create.mockReset().mockImplementation(() => {
      throw new Error("server-chat lazy load failure");
    });
    installInMemoryTaskRegistryRuntime();
  });

  afterEach(async () => {
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    void unsubs?.taskUnsub();
    resetAgentEventsForTest();
    resetTaskRegistryForTests({ persist: false });
  });

  it("records audit events by default and stops the recorder on unsubscribe", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({ runId: "enabled-audit", stream: "lifecycle", data: { phase: "start" } });
    expect(auditTestState.recorded).toBe(1);
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("keeps retention maintenance but creates no producers when audit.enabled is false", async () => {
    auditTestState.enabled = false;
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "disabled-private",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emitAgentEvent({ runId: "disabled-public", stream: "lifecycle", data: { phase: "start" } });
    expect(auditTestState.recorded).toBe(0);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    warn.mockClear();
    // Disabled wiring must still unsubscribe cleanly.
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("logs lazy agent event handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "start" } });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Agent event dispatch failed",
      expect.objectContaining({ runId: "run-1", stream: "lifecycle" }),
    );
  });

  it("disposes a loaded agent event handler on unsubscribe", async () => {
    const dispose = vi.fn();
    const handler = Object.assign(vi.fn(), { dispose });
    agentEventHandlerMocks.create.mockReturnValue(handler);
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-dispose", stream: "lifecycle", data: { phase: "error" } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    await unsubs.agentUnsub();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("logs transcript handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Transcript update dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("logs lifecycle handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Lifecycle event dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("returns aborted when the real terminal subscriber attaches the exact fence", async () => {
    const params = createParams();
    const runId = "run-strict-subscriber";
    const sessionKey = "agent:main:main";
    const entry: ChatAbortControllerEntry = {
      controller: new AbortController(),
      sessionId: "session-strict-subscriber",
      sessionKey,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      agentId: "main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    params.chatAbortControllers.set(runId, entry);
    const persistence = new Promise<void>((resolve) => setImmediate(resolve));
    agentEventHandlerMocks.create.mockImplementation(
      (options) => (event: { runId: string; ts: number }) =>
        options.trackTrackedRunTerminalPersistence({
          runId: event.runId,
          clientRunId: event.runId,
          sessionId: entry.sessionId,
          observedAt: event.ts,
          persistence,
        }),
    );
    unsubs = startGatewayEventSubscriptions(params);

    const ops: ChatAbortOps = {
      chatAbortControllers: params.chatAbortControllers,
      chatRunBuffers: new Map(),
      chatAbortedRuns: new Map(),
      clearChatRunState: vi.fn(),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey, clientRunId: runId }),
      agentRunSeq: params.agentRunSeq,
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
    };
    const result = abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "rpc",
      exactTarget: {
        entry,
        matches: (candidate) => candidate.sessionKey === sessionKey && candidate.agentId === "main",
      },
    });

    expect(entry.projectSessionTerminalObservedAt).toEqual(expect.any(Number));
    expect(result).toEqual({ aborted: true });
    expect(params.chatAbortControllers.get(runId)).toBe(entry);
    await vi.waitFor(() => expect(entry.projectSessionTerminalPersistence).toBe(persistence));
    await vi.waitFor(() => expect(params.chatAbortControllers.has(runId)).toBe(false));
  });

  it("broadcasts bounded public task summaries with ledger statuses", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast });
    await vi.waitFor(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const completed = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Completed task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      terminalSummary: "x".repeat(10_000),
    });
    const lost = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Lost task",
      status: "lost",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    if (!completed || !lost) {
      throw new Error("expected task records to be created");
    }
    const taskUpsertsById = new Map(
      broadcast.mock.calls
        .filter(([event]) => event === "task")
        .map(([, payload]) => payload as TaskEventPayload)
        .filter(
          (payload): payload is Extract<TaskEventPayload, { action: "upserted" }> =>
            payload.action === "upserted",
        )
        .map((payload) => [payload.task.id, payload.task]),
    );
    expect(broadcast).toHaveBeenCalledWith("task", expect.anything(), { dropIfSlow: true });
    // Runtime registry statuses translate to the public ledger vocabulary.
    expect(taskUpsertsById.get(completed.taskId)?.status).toBe("completed");
    expect(taskUpsertsById.get(lost.taskId)?.status).toBe("failed");
    // Unbounded status text from providers/shells must be truncated on the wire.
    const wireTerminalSummary = taskUpsertsById.get(completed.taskId)?.terminalSummary;
    expect(wireTerminalSummary).toBeTruthy();
    expect(wireTerminalSummary?.length ?? 0).toBeLessThan(10_000);

    void unsubs?.taskUnsub();
    await vi.waitFor(() => expect(getTaskRegistryObservers()).toBeNull());
    broadcast.mockClear();
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("keeps a replacement gateway's task observer when a stale unsub runs late", async () => {
    const staleBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    const staleSubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast: staleBroadcast,
    });
    await vi.waitFor(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const staleObservers = getTaskRegistryObservers();

    const replacementBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast: replacementBroadcast,
    });
    await vi.waitFor(() => {
      const current = getTaskRegistryObservers();
      expect(current).not.toBeNull();
      expect(current).not.toBe(staleObservers);
    });

    // The stale dispose must not clear the replacement's observer slot.
    await staleSubs.taskUnsub();
    await staleSubs.agentUnsub();
    staleSubs.heartbeatUnsub();
    staleSubs.transcriptUnsub();
    staleSubs.lifecycleUnsub();
    expect(getTaskRegistryObservers()).not.toBeNull();

    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After stale dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(replacementBroadcast).toHaveBeenCalledWith("task", expect.anything(), {
      dropIfSlow: true,
    });
    expect(staleBroadcast).not.toHaveBeenCalledWith("task", expect.anything(), {
      dropIfSlow: true,
    });
  });
});
