/** Proves that repeated gateway timeouts keep the original delivery owner. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { persistGatewaySessionLifecycleEvent } from "../gateway/session-lifecycle-state.js";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { agentCommand } from "./agent-command.js";
import type { runAgentAttempt } from "./command/attempt-execution.runtime.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import { recoverStartupOrphanedMainSessions } from "./main-session-restart-recovery.js";
import { scheduleTimedOutMainSessionRecovery } from "./main-session-timeout-recovery.js";

type RunAgentAttempt = typeof runAgentAttempt;

const state = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  sessionKey: undefined as string | undefined,
  storePath: undefined as string | undefined,
  runAgentAttemptMock: vi.fn<RunAgentAttempt>(),
  gatewayCallMock: vi.fn(),
  loadManifestModelCatalogMock: vi.fn(() => []),
  normalizeProviderModelIdWithRuntimeMock: vi.fn(() => undefined),
  runCliTurnCompactionLifecycleMock: vi.fn(
    async (params: { sessionEntry?: SessionEntry }) => params.sessionEntry,
  ),
  deliverAgentCommandResultMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  dispatchSources: [] as Array<string | undefined>,
  lifecyclePersistence: [] as Array<Promise<void>>,
  stopLifecycleProjection: undefined as (() => void) | undefined,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => state.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

vi.mock("./agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => ({
    loadedRaw: state.cfg,
    sourceConfig: state.cfg,
    cfg: state.cfg,
  }),
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentIds: () => ["main"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => state.agentDir ?? "/tmp/openclaw-agent",
    resolveDefaultAgentId: () => "main",
    resolveEffectiveModelFallbacks: () => undefined,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => state.workspaceDir ?? "/tmp/openclaw-workspace",
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({ plugins: [] }),
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (params: unknown) => state.loadManifestModelCatalogMock(params),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    state.normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store.js")>(
    "./auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: () => ({
    shouldRefresh: true,
    snapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    },
  }),
}));

vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("./command/attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.runtime.js")>(
    "./command/attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: Parameters<RunAgentAttempt>) => state.runAgentAttemptMock(...args),
  };
});

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (params: { sessionEntry?: SessionEntry }) =>
    state.runCliTurnCompactionLifecycleMock(params),
}));

vi.mock("../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/agent-events.js")>(
    "../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: (...args: Parameters<typeof actual.emitAgentEvent>) => {
      state.emitAgentEventMock(...args);
      return actual.emitAgentEvent(...args);
    },
  };
});

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: (params: {
    resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
  }) => state.deliverAgentCommandResultMock(params),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: Parameters<typeof callGateway>) => state.gatewayCallMock(...args),
}));

const sessionKey = "agent:main:slack:channel:c0bly1apgh5";
const sessionId = "repeated-timeout-session";
const sourceRunId = "accepted-run-A";
const channel = "slack";
const target = "C0BLY1APGH5";
const threadId = "1785613439.266819";

function timeoutError(): Error {
  const error = new Error("gateway run timed out");
  error.name = "TimeoutError";
  return error;
}

function makeTimeoutResult(): EmbeddedAgentRunResult {
  return {
    payloads: [],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: "embedded",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      agentMeta: {
        sessionId,
        provider: "openai",
        model: "gpt-5.5",
      },
    },
  };
}

async function writeInitialFixture(storePath: string): Promise<void> {
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      sessionId,
      updatedAt: Date.now() - 10_000,
      status: "timeout",
      abortedLastRun: false,
      deliveryContext: {
        channel,
        to: target,
        accountId: "main",
        threadId,
      },
    },
  );
  await appendTranscriptMessage(
    { sessionId, sessionKey, storePath },
    { cwd: path.dirname(storePath), message: { role: "user", content: "finish the request" } },
  );
  await appendTranscriptMessage(
    { sessionId, sessionKey, storePath },
    {
      cwd: path.dirname(storePath),
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
    },
  );
  await appendTranscriptMessage(
    { sessionId, sessionKey, storePath },
    { cwd: path.dirname(storePath), message: { role: "toolResult", content: "done" } },
  );
}

function currentEntry(): SessionEntry | undefined {
  const storePath = state.storePath;
  if (!storePath) {
    throw new Error("missing test session store path");
  }
  return loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
}

async function waitForLifecycleProjection(): Promise<void> {
  await Promise.all(state.lifecyclePersistence.splice(0));
}

describe("repeated timeout recovery ownership", () => {
  beforeAll(async () => {
    // Importing the command after the runtime mocks are registered keeps this
    // test on the same real command/finalizer spine as the live model tests.
    await import("./agent-command.js");
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    state.dispatchSources = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repeated-timeout-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    state.workspaceDir = path.join(tmpDir, "workspace");
    state.agentDir = path.join(tmpDir, "agent");
    state.storePath = path.join(tmpDir, "agents", "main", "sessions", "sessions.json");
    state.sessionKey = sessionKey;
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.mkdir(state.agentDir, { recursive: true });
    await fs.mkdir(path.dirname(state.storePath), { recursive: true });
    state.cfg = {
      session: { store: state.storePath },
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {} },
        },
      },
    } as OpenClawConfig;
    await writeInitialFixture(state.storePath);
    state.runCliTurnCompactionLifecycleMock.mockImplementation(
      async (params: { sessionEntry?: SessionEntry }) => params.sessionEntry,
    );
    state.deliverAgentCommandResultMock.mockImplementation(async () => ({
      deliverySucceeded: true,
    }));
    state.gatewayCallMock.mockImplementation(
      async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === "agent") {
          state.dispatchSources.push(currentEntry()?.restartRecoveryDeliverySourceRunId);
          return {
            runId:
              typeof request.params?.idempotencyKey === "string"
                ? request.params.idempotencyKey
                : "startup-recovery-run-C",
          };
        }
        if (request.method === "agent.wait") {
          return {
            runId: typeof request.params?.runId === "string" ? request.params.runId : "",
            status: "accepted",
          };
        }
        return { status: "accepted" };
      },
    );
    state.lifecyclePersistence = [];
    state.stopLifecycleProjection = onAgentEvent((event) => {
      if (event.stream !== "lifecycle" || !event.sessionKey) {
        return;
      }
      state.lifecyclePersistence.push(
        persistGatewaySessionLifecycleEvent({
          sessionKey: event.sessionKey,
          agentId: event.agentId,
          event,
        }),
      );
    });
  });

  afterEach(async () => {
    await Promise.all(state.lifecyclePersistence.splice(0));
    state.stopLifecycleProjection?.();
    state.stopLifecycleProjection = undefined;
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    vi.unstubAllEnvs();
    const storePath = state.storePath;
    state.cfg = undefined;
    state.workspaceDir = undefined;
    state.agentDir = undefined;
    state.storePath = undefined;
    state.sessionKey = undefined;
    if (storePath) {
      await fs.rm(path.dirname(storePath), { recursive: true, force: true });
    }
  });

  it("keeps source A through real A timeout, B timeout, and startup C recovery", async () => {
    const storePath = state.storePath;
    const cfg = state.cfg;
    const workspaceDir = state.workspaceDir;
    const agentDir = state.agentDir;
    if (!storePath || !cfg || !workspaceDir || !agentDir) {
      throw new Error("test fixture was not initialized");
    }

    const controllerA = new AbortController();
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      controllerA.abort(timeoutError());
      return makeTimeoutResult();
    });

    await agentCommand({
      message: "finish the request",
      sessionKey,
      channel,
      to: target,
      threadId,
      accountId: "main",
      deliver: true,
      runId: sourceRunId,
      abortSignal: controllerA.signal,
      cwd: workspaceDir,
      workspaceDir,
      agentId: "main",
    });
    await waitForLifecycleProjection();

    expect(currentEntry()?.restartRecoveryDeliveryRunId).toBe(sourceRunId);

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: sourceRunId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    const entryAfterRotation = currentEntry();
    const recoveryRunId = entryAfterRotation?.restartRecoveryDeliveryRunId;
    expect(recoveryRunId).toEqual(expect.any(String));
    expect(recoveryRunId).not.toBe(sourceRunId);
    expect(entryAfterRotation?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);

    const controllerB = new AbortController();
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      controllerB.abort(timeoutError());
      return makeTimeoutResult();
    });

    await agentCommand({
      message: "finish the request after recovery",
      sessionKey,
      channel,
      to: target,
      threadId,
      accountId: "main",
      deliver: true,
      runId: recoveryRunId,
      abortSignal: controllerB.signal,
      cwd: workspaceDir,
      workspaceDir,
      agentId: "main",
      preserveUserFacingSessionModelState: true,
    });
    await waitForLifecycleProjection();

    const entryAfterSecondTimeout = currentEntry();
    expect(entryAfterSecondTimeout?.restartRecoveryDeliveryRunId).toBe(recoveryRunId);
    expect(entryAfterSecondTimeout?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);

    await expect(
      recoverStartupOrphanedMainSessions({
        cfg,
        stateDir: path.dirname(storePath),
        activeSessionIds: [],
        activeSessionKeys: [],
      }),
    ).resolves.toMatchObject({ marked: 1, recovered: 1 });

    const entryAfterStartup = currentEntry();
    expect(state.dispatchSources).toContain(sourceRunId);
    expect(entryAfterStartup?.restartRecoveryDeliveryRunId).not.toBe(recoveryRunId);
    expect(entryAfterStartup?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);
  });
});
