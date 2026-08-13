import { describe, expect, it, vi } from "vitest";
import { clearAgentRunContext, getAgentRunContext } from "../../infra/agent-events.js";
import {
  admitGaiaAcceptance,
  recoverGaiaAcceptance,
} from "../../infra/outbound/delivery-queue-storage.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { createChatRunRegistry } from "../server-chat-state.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import {
  prepareAgentRunDispatch,
  type PreparedAgentRunDispatch,
} from "./agent-run-admission-phase.js";
import type { GatewayClient } from "./types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const GAIA_PLUGIN_ID = "gaia-workflow-preflight";
const SESSION_KEY = "agent:gaia:slack:channel:C123";
const SESSION_ID = "session-id";

type PhaseHarness = {
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  runId: string;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionId: string;
  acquiredScope?: string;
  admittedGatewayWork?: SessionWorkAdmissionLease;
  admittedRunAbort?: ReturnType<typeof import("../chat-abort.js").registerChatAbortController>;
  chatRunRegistry: ReturnType<typeof createChatRunRegistry>;
  markAccepted: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  registerPluginSubagentRun: ReturnType<typeof vi.fn>;
  buildParams: (overrides?: {
    admitGaiaAcceptance?: typeof admitGaiaAcceptance;
  }) => Parameters<typeof prepareAgentRunDispatch>[0];
};

function makeClient(pluginRuntimeOwnerId: string, trackSubagent: boolean): GatewayClient {
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      pluginRuntimeOwnerId,
      ...(trackSubagent ? { agentRunTracking: "plugin_subagent" as const } : {}),
    },
  };
}

function makeDelivery(): AgentDeliveryPhaseResult {
  return {
    activeSessionAgentId: "gaia",
    deliveryPlan: { resolvedThreadId: "thread-42" } as AgentDeliveryPhaseResult["deliveryPlan"],
    resolvedChannel: "slack",
    deliveryTargetMode: "explicit",
    resolvedAccountId: "default",
    resolvedTo: "C123",
    originMessageChannel: "slack",
    deliver: false,
  };
}

function makeHarness(runId: string, stateDir: string): PhaseHarness {
  const lifecycleGeneration = `generation-${runId}`;
  const chatRunRegistry = createChatRunRegistry();
  const chatAbortControllers = new Map();
  const dedupe = new Map();
  const context = {
    chatAbortControllers,
    dedupe,
    addChatRun: chatRunRegistry.add,
    removeChatRun: chatRunRegistry.remove,
    clearChatRunState: vi.fn(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
  const client = makeClient(GAIA_PLUGIN_ID, true);
  const markAccepted = vi.fn();
  const respond = vi.fn();
  const registerPluginSubagentRun = vi.fn(async () => {});
  let admittedRunAbort: PhaseHarness["admittedRunAbort"];
  let admittedGatewayWork: SessionWorkAdmissionLease | undefined;
  let acquiredScope: string | undefined;

  const buildParams: PhaseHarness["buildParams"] = (overrides = {}) => ({
    request: {
      message: "run the Gaia task",
      idempotencyKey: runId,
    },
    cfg: {},
    sessionEntry: undefined,
    resolvedSessionKey: SESSION_KEY,
    requestedSessionKey: SESSION_KEY,
    activeSessionAgentId: "gaia",
    delivery: makeDelivery(),
    allowModelOverride: false,
    lifecycleGeneration,
    getAdmittedSessionId: () => SESSION_ID,
    suppressVisibleSessionEffects: false,
    pendingChatRun: { sessionKey: SESSION_KEY, agentId: "gaia" },
    isOneShotModelRun: false,
    runId,
    agentDedupeKeys: [`agent:${runId}`],
    context,
    client,
    respond,
    abortForLifecycleRotation: () => false,
    acquireGatewayWorkAdmission: async (scope) => {
      acquiredScope = scope;
      admittedGatewayWork = await beginSessionWorkAdmission({
        scope,
        identities: [SESSION_KEY],
        assertAllowed: () => {},
        revalidateAllowed: () => {},
      });
    },
    assertGatewayWorkAdmissionAllowed: () => {},
    hasGatewayAdmissionOutcome: () => false,
    respondToGatewayAdmissionOutcome: () => false,
    admissionAgentId: () => "Gaia",
    getGatewayWorkAdmission: () => admittedGatewayWork,
    setAdmittedRunAbort: (value) => {
      admittedRunAbort = value;
    },
    getAdmittedRunAbort: () => admittedRunAbort,
    markAgentRunAccepted: markAccepted,
    gaiaAcceptanceStateDir: stateDir,
    registerPluginSubagentRun,
    ...overrides,
  });

  return {
    context,
    client,
    runId,
    lifecycleGeneration,
    sessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    get acquiredScope() {
      return acquiredScope;
    },
    get admittedGatewayWork() {
      return admittedGatewayWork;
    },
    get admittedRunAbort() {
      return admittedRunAbort;
    },
    chatRunRegistry,
    markAccepted,
    respond,
    registerPluginSubagentRun,
    buildParams,
  };
}

async function runInPluginRequest<T>(
  harness: PhaseHarness,
  pluginId: string,
  run: () => Promise<T>,
): Promise<T> {
  return await withPluginRuntimeGatewayRequestScope(
    {
      context: harness.context,
      client: harness.client,
      isWebchatConnect: () => false,
    },
    () => withPluginRuntimePluginScope({ pluginId }, run),
  );
}

async function cleanupHarness(harness: PhaseHarness, prepared?: PreparedAgentRunDispatch) {
  if (prepared?.activeRunAbort.registered) {
    prepared.activeRunAbort.controller.abort();
    prepared.activeRunAbort.cleanup({ force: true });
  }
  harness.context.removeChatRun(harness.runId, harness.runId, harness.sessionKey);
  clearAgentRunContext(harness.runId, harness.lifecycleGeneration);
  harness.admittedGatewayWork?.release();
}

async function withStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-agent-admission-" }, async (stateDir) => {
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      return await run(stateDir);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
    }
  });
}

describe("gateway agent durable Gaia acceptance", () => {
  it("stores before markAccepted, response, and deferred subagent registration", async () => {
    await withStateDir(async (stateDir) => {
      const harness = makeHarness("gaia-accept-success", stateDir);
      const order: string[] = [];
      harness.markAccepted.mockImplementation(() => order.push("markAccepted"));
      harness.respond.mockImplementation(() => order.push("respond"));
      harness.registerPluginSubagentRun.mockImplementation(async () => {
        order.push("subagent");
      });
      const store = vi.fn((accepted, acceptedStateDir) => {
        order.push("store");
        expect(harness.markAccepted).not.toHaveBeenCalled();
        expect(harness.respond).not.toHaveBeenCalled();
        expect(harness.registerPluginSubagentRun).not.toHaveBeenCalled();
        return admitGaiaAcceptance(accepted, acceptedStateDir);
      });

      const prepared = await runInPluginRequest(harness, GAIA_PLUGIN_ID, () =>
        prepareAgentRunDispatch(harness.buildParams({ admitGaiaAcceptance: store })),
      );

      expect(prepared).toBeDefined();
      expect(order).toEqual(["store", "subagent", "markAccepted", "respond"]);
      expect(harness.markAccepted).toHaveBeenCalledWith(true);
      expect(harness.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          runId: harness.runId,
          sessionKey: harness.sessionKey,
          agentId: "gaia",
          receiptPluginId: GAIA_PLUGIN_ID,
          status: "accepted",
        }),
        undefined,
        { runId: harness.runId },
      );
      const response = harness.respond.mock.calls[0]?.[1] as { acceptedAt: number };
      expect(response.acceptedAt).toBe(
        recoverGaiaAcceptance(
          {
            runId: harness.runId,
            sessionKey: harness.sessionKey,
            agentId: "gaia",
            receiptPluginId: GAIA_PLUGIN_ID,
          },
          stateDir,
        ).accepted?.acceptedAt,
      );
      expect(harness.context.chatAbortControllers.has(harness.runId)).toBe(true);
      expect(harness.chatRunRegistry.peek(harness.runId)).toBeDefined();
      expect(getAgentRunContext(harness.runId)).toBeDefined();
      expect(isSessionWorkAdmissionActive(harness.acquiredScope!, [harness.sessionKey])).toBe(true);
      await cleanupHarness(harness, prepared);
    });
  });

  it("compensates every pre-checkpoint authority when storage throws", async () => {
    await withStateDir(async (stateDir) => {
      const harness = makeHarness("gaia-accept-throw", stateDir);
      const providerReach = vi.fn();
      const store = vi.fn(() => {
        throw new Error("acceptance store failed");
      });

      const prepared = await runInPluginRequest(harness, GAIA_PLUGIN_ID, () =>
        prepareAgentRunDispatch(harness.buildParams({ admitGaiaAcceptance: store })),
      );
      if (prepared) {
        providerReach();
      }

      expect(prepared).toBeUndefined();
      expect(providerReach).not.toHaveBeenCalled();
      expect(harness.markAccepted).not.toHaveBeenCalled();
      expect(harness.registerPluginSubagentRun).not.toHaveBeenCalled();
      expect(harness.context.chatAbortControllers.has(harness.runId)).toBe(false);
      expect(harness.chatRunRegistry.peek(harness.runId)).toBeUndefined();
      expect(getAgentRunContext(harness.runId)).toBeUndefined();
      expect(isSessionWorkAdmissionActive(harness.acquiredScope!, [harness.sessionKey])).toBe(
        false,
      );
      expect(harness.context.dedupe.size).toBe(0);
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("acceptance store failed") }),
      );
      expect(
        recoverGaiaAcceptance(
          {
            runId: harness.runId,
            sessionKey: harness.sessionKey,
            agentId: "gaia",
            receiptPluginId: GAIA_PLUGIN_ID,
          },
          stateDir,
        ),
      ).toEqual({ status: "absent" });
    });
  });

  it("rolls back registration persistence so a same-run retry has one authority", async () => {
    await withStateDir(async (stateDir) => {
      const runId = "gaia-accept-register-retry";
      const authorities = new Set<string>();
      let failPersistence = true;
      const register = async ({ runId: registeredRunId }: { runId: string }) => {
        authorities.add(registeredRunId);
        if (failPersistence) {
          failPersistence = false;
          authorities.delete(registeredRunId);
          throw new Error("registration persistence failed");
        }
      };
      const dispatch = (harness: PhaseHarness) =>
        runInPluginRequest(harness, GAIA_PLUGIN_ID, () =>
          prepareAgentRunDispatch(harness.buildParams()),
        );

      const firstHarness = makeHarness(runId, stateDir);
      firstHarness.registerPluginSubagentRun.mockImplementation(register);
      const first = await dispatch(firstHarness);
      expect(first).toBeUndefined();
      expect(authorities.size).toBe(0);
      expect(firstHarness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("registration persistence failed"),
        }),
      );
      await cleanupHarness(firstHarness, first);

      const retryHarness = makeHarness(runId, stateDir);
      retryHarness.registerPluginSubagentRun.mockImplementation(register);
      const retry = await dispatch(retryHarness);

      expect(retry).toBeDefined();
      expect(authorities.size).toBe(1);
      expect(authorities).toEqual(new Set([runId]));
      await cleanupHarness(retryHarness, retry);
    });
  });

  it("compensates every pre-checkpoint authority on a frozen or mismatched conflict", async () => {
    await withStateDir(async (stateDir) => {
      const harness = makeHarness("gaia-accept-conflict", stateDir);
      expect(
        admitGaiaAcceptance(
          {
            runId: harness.runId,
            sessionKey: "agent:other:slack:channel:C123",
            agentId: "other",
            acceptedAt: 1_700_000_000_000,
            receiptPluginId: GAIA_PLUGIN_ID,
          },
          stateDir,
        ).status,
      ).toBe("accepted");
      const providerReach = vi.fn();

      const prepared = await runInPluginRequest(harness, GAIA_PLUGIN_ID, () =>
        prepareAgentRunDispatch(harness.buildParams()),
      );
      if (prepared) {
        providerReach();
      }

      expect(prepared).toBeUndefined();
      expect(providerReach).not.toHaveBeenCalled();
      expect(harness.markAccepted).not.toHaveBeenCalled();
      expect(harness.registerPluginSubagentRun).not.toHaveBeenCalled();
      expect(harness.context.chatAbortControllers.has(harness.runId)).toBe(false);
      expect(harness.chatRunRegistry.peek(harness.runId)).toBeUndefined();
      expect(getAgentRunContext(harness.runId)).toBeUndefined();
      expect(isSessionWorkAdmissionActive(harness.acquiredScope!, [harness.sessionKey])).toBe(
        false,
      );
      expect(harness.context.dedupe.size).toBe(0);
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("durable acceptance exists") }),
      );
      expect(
        recoverGaiaAcceptance(
          {
            runId: harness.runId,
            sessionKey: harness.sessionKey,
            agentId: "gaia",
            receiptPluginId: GAIA_PLUGIN_ID,
          },
          stateDir,
        ),
      ).toEqual({ status: "mismatch" });
    });
  });

  it("does not write durable Gaia acceptance for a non-Gaia request", async () => {
    await withStateDir(async (stateDir) => {
      const harness = makeHarness("ordinary-acceptance", stateDir);
      const ordinaryClient = makeClient(GAIA_PLUGIN_ID, false);
      const store = vi.fn((accepted, acceptedStateDir) =>
        admitGaiaAcceptance(accepted, acceptedStateDir),
      );
      const prepared = await withPluginRuntimeGatewayRequestScope(
        {
          context: harness.context,
          client: ordinaryClient,
          isWebchatConnect: () => false,
        },
        () =>
          withPluginRuntimePluginScope({ pluginId: "other-plugin" }, () =>
            prepareAgentRunDispatch(harness.buildParams({ admitGaiaAcceptance: store })),
          ),
      );

      expect(prepared).toBeDefined();
      expect(store).not.toHaveBeenCalled();
      expect(harness.markAccepted).toHaveBeenCalledWith(true);
      expect(harness.respond).toHaveBeenCalledWith(
        true,
        expect.not.objectContaining({ receiptPluginId: GAIA_PLUGIN_ID }),
        undefined,
        { runId: harness.runId },
      );
      expect(
        recoverGaiaAcceptance(
          {
            runId: harness.runId,
            sessionKey: harness.sessionKey,
            agentId: "gaia",
            receiptPluginId: GAIA_PLUGIN_ID,
          },
          stateDir,
        ),
      ).toEqual({ status: "absent" });
      await cleanupHarness(harness, prepared);
    });
  });
});
