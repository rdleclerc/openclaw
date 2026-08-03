import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { ChannelMessageActionContext, ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createTestRegistry,
  mintMessageActionTurnCapabilityForTest,
  resetPluginRuntimeStateForTest,
  revokeMessageActionTurnCapabilityForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { createCodexDynamicToolExecutionRegistry } from "./run-attempt-tools.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

type AttemptIdentity = {
  agentId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
};

const DOSSIER_CHANNEL = "C-DOSSIERS";
const mintedTurnCapabilities: string[] = [];
function downloadFileResult(ctx: ChannelMessageActionContext) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, path: `/tmp/${String(ctx.params.fileId)}.pdf` }),
      },
    ],
    details: { ok: true, path: `/tmp/${String(ctx.params.fileId)}.pdf` },
  };
}
const handleDownloadFile = vi.fn(async (ctx: ChannelMessageActionContext) =>
  downloadFileResult(ctx),
);

const slackDownloadPlugin: ChannelPlugin = {
  id: "slack",
  meta: {
    id: "slack",
    label: "Slack",
    selectionLabel: "Slack",
    docsPath: "/channels/slack",
    blurb: "Test Slack download action",
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
  },
  messaging: {
    normalizeTarget: (raw) => raw,
    targetResolver: {
      looksLikeId: () => true,
      resolveTarget: async ({ normalized }) => ({
        to: normalized,
        kind: "group",
        source: "normalized",
      }),
    },
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
    sendText: async () => ({ channel: "slack", messageId: "unused" }),
    sendMedia: async () => ({ channel: "slack", messageId: "unused" }),
  },
  actions: {
    describeMessageTool: () => ({ actions: ["download-file"] }),
    supportsAction: ({ action }) => action === "download-file",
    requiresTrustedRequesterSender: ({ action }) => action === "download-file",
    handleAction: handleDownloadFile,
  },
};

function mintAttemptCapability(identity: AttemptIdentity, senderId: string): string {
  const token = mintMessageActionTurnCapabilityForTest({
    ...identity,
    requesterAccountId: "default",
    requesterSenderId: senderId,
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: DOSSIER_CHANNEL,
      currentMessagingTarget: DOSSIER_CHANNEL,
    },
  });
  mintedTurnCapabilities.push(token);
  return token;
}

function materializeMessageTool(identity: AttemptIdentity, constructorToken?: string) {
  const tools = createOpenClawCodingTools({
    ...identity,
    cwd: "/tmp/workspace",
    workspaceDir: "/tmp/workspace",
    config: {} as never,
    messageProvider: "slack",
    messageChannel: "slack",
    toolPolicyMessageProvider: "slack",
    agentAccountId: "default",
    currentChannelId: DOSSIER_CHANNEL,
    currentMessagingTarget: DOSSIER_CHANNEL,
    messageActionTurnCapability: constructorToken,
    modelProvider: "openai",
    modelId: "gpt-5.6-sol",
    modelApi: "openai-responses",
    suppressManagedWebSearch: false,
    runtimeToolAllowlist: ["message"],
    forceMessageTool: true,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const messageTool = tools.find((tool) => tool.name === "message");
  if (!messageTool) {
    throw new Error("Expected the production message tool to be materialized");
  }
  return messageTool;
}

function createControllerFixture(params: {
  requestIdentity: AttemptIdentity;
  attemptToken?: string;
  toolIdentity?: AttemptIdentity;
  constructorToken?: string;
}) {
  const runAbortController = new AbortController();
  const materializedTool = materializeMessageTool(
    params.toolIdentity ?? params.requestIdentity,
    params.constructorToken,
  );
  const toolBridge = createCodexDynamicToolBridge({
    tools: [materializedTool],
    signal: runAbortController.signal,
  });
  const handleToolCall = vi.fn(toolBridge.handleToolCall);
  toolBridge.handleToolCall = handleToolCall;
  const turnWatches = {
    clearCompletionIdleTimer: vi.fn(),
    disarmAssistantCompletionIdleWatch: vi.fn(),
    touchActivity: vi.fn(),
    armCompletionIdleWatch: vi.fn(),
    scheduleProgressWatches: vi.fn(),
  };
  const projector = {
    recordDynamicToolCall: vi.fn(),
    recordDynamicToolResult: vi.fn(),
  };
  const trajectoryRecorder = {
    recordEvent: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params: {
              ...params.requestIdentity,
              messageActionTurnCapability: params.attemptToken,
              timeoutMs: 1_000,
              provider: "openai",
              modelId: "gpt-5.6-sol",
            },
            computerUseConfig: { enabled: false },
            runAbortController,
            appServer: {},
            sessionAgentId: params.requestIdentity.agentId,
            sandboxSessionKey: params.requestIdentity.sessionKey,
          },
        },
        attemptTools: {
          toolBridge,
          toolOutcomeOrdinals: new Map(),
          suppressedDynamicToolOutcomeOrdinals: new Set(),
        },
      },
    },
    state: { thread: { threadId: "thread-1" } },
    projectorRef: { current: projector },
    trajectoryRecorder,
  } as unknown as CodexAttemptResources;
  const turnRuntime = {
    state: {
      activeAppServerTurnRequests: 0,
      turnCrossedToolHandoff: false,
      currentTurnHadNonTerminalDynamicToolResult: false,
    },
    turnIdRef: { current: "turn-1" },
    userInputBridgeRef: {},
    openClawDynamicToolExecutions: createCodexDynamicToolExecutionRegistry(),
    pendingOpenClawDynamicToolCompletionIds: new Set(),
    postToolRawAssistantCompletionIdleTimeoutMs: 5,
    turnWatches,
  } as unknown as CodexAttemptTurnState;
  const lifecycle = {
    emitExecutionPhaseOnce: vi.fn(),
    scheduleTurnReleaseAfterTerminalDynamicTool: vi.fn(),
    scheduleTerminalDynamicToolReleaseCheck: vi.fn(),
  } as unknown as CodexAttemptLifecycleController;
  return {
    controller: createCodexAttemptServerRequestController(resources, turnRuntime, lifecycle),
    handleToolCall,
    projector,
    trajectoryRecorder,
  };
}

function downloadRequest(callId: string, fileId = `F-${callId}`) {
  return {
    id: `request-${callId}`,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool: "message",
      arguments: {
        action: "download-file",
        channel: "slack",
        channelId: DOSSIER_CHANNEL,
        fileId,
      },
    },
  };
}

async function runDownload(fixture: ReturnType<typeof createControllerFixture>, callId: string) {
  return await fixture.controller.handleServerRequest(downloadRequest(callId), {
    threadId: "thread-1",
    turnId: "turn-1",
  });
}

function expectNoCapabilityLeak(value: unknown, tokens: Array<string | undefined>) {
  const serialized = JSON.stringify(value);
  for (const token of tokens) {
    if (token) {
      expect(serialized).not.toContain(token);
    }
  }
}

function expectNoCapabilityLeakAcrossSurfaces(params: {
  fixture: ReturnType<typeof createControllerFixture>;
  request: unknown;
  response: unknown;
  tokens: Array<string | undefined>;
}) {
  expectNoCapabilityLeak(
    {
      request: params.request,
      response: params.response,
      toolBridgeCalls: params.fixture.handleToolCall.mock.calls,
      bridgeCalls: handleDownloadFile.mock.calls,
      projectorCalls: [
        params.fixture.projector.recordDynamicToolCall.mock.calls,
        params.fixture.projector.recordDynamicToolResult.mock.calls,
      ],
      trajectoryRecords: params.fixture.trajectoryRecorder.recordEvent.mock.calls,
    },
    params.tokens,
  );
}

describe("Codex dynamic message download authority", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    handleDownloadFile.mockReset().mockImplementation(async (ctx) => downloadFileResult(ctx));
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", source: "test", origin: "bundled", plugin: slackDownloadPlugin },
      ]),
    );
  });

  afterEach(() => {
    for (const token of mintedTurnCapabilities.splice(0)) {
      revokeMessageActionTurnCapabilityForTest(token);
    }
    resetPluginRuntimeStateForTest();
  });

  it("downloads through the production-composed message path with current attempt authority", async () => {
    const identity = {
      agentId: "agent-a",
      runId: "run-a",
      sessionId: "session-a",
      sessionKey: "agent:agent-a:session-a",
    };
    const token = mintAttemptCapability(identity, "sender-a");
    const controller = createControllerFixture({ requestIdentity: identity, attemptToken: token });

    const request = downloadRequest("positive");
    const response = await controller.controller.handleServerRequest(request, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(response).toMatchObject({ success: true });
    expect(handleDownloadFile).toHaveBeenCalledOnce();
    expect(handleDownloadFile.mock.calls[0]?.[0]).toMatchObject({
      action: "download-file",
      accountId: "default",
      requesterAccountId: "default",
      requesterSenderId: "sender-a",
      params: {
        channel: "slack",
        channelId: DOSSIER_CHANNEL,
        fileId: "F-positive",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: DOSSIER_CHANNEL,
      },
    });
    expectNoCapabilityLeakAcrossSurfaces({
      fixture: controller,
      request,
      response,
      tokens: [token],
    });
  });

  it("keeps revoked pre-materialized constructor authority fail-closed", async () => {
    const identity = {
      agentId: "agent-a",
      runId: "run-revoked",
      sessionId: "session-revoked",
      sessionKey: "agent:agent-a:session-revoked",
    };
    const token = mintAttemptCapability(identity, "sender-revoked");
    const controller = createControllerFixture({
      requestIdentity: identity,
      attemptToken: token,
      constructorToken: token,
    });
    revokeMessageActionTurnCapabilityForTest(token);

    const response = await runDownload(controller, "revoked");

    expect(response).toMatchObject({ success: false });
    expect(handleDownloadFile).not.toHaveBeenCalled();
    expectNoCapabilityLeak(response, [token]);
  });

  it("does not revive stale constructor authority in an untokened request", async () => {
    const identity = {
      agentId: "agent-a",
      runId: "run-stale",
      sessionId: "session-stale",
      sessionKey: "agent:agent-a:session-stale",
    };
    const constructorToken = mintAttemptCapability(identity, "sender-stale");
    const controller = createControllerFixture({
      requestIdentity: identity,
      constructorToken,
    });

    const response = await runDownload(controller, "stale");

    expect(response).toMatchObject({ success: false });
    expect(handleDownloadFile).not.toHaveBeenCalled();
    expectNoCapabilityLeak(response, [constructorToken]);
  });

  it("rejects conflicting constructor and active request capabilities", async () => {
    const identity = {
      agentId: "agent-a",
      runId: "run-conflict",
      sessionId: "session-conflict",
      sessionKey: "agent:agent-a:session-conflict",
    };
    const activeToken = mintAttemptCapability(identity, "sender-active");
    const constructorToken = mintAttemptCapability(identity, "sender-constructor");
    const controller = createControllerFixture({
      requestIdentity: identity,
      attemptToken: activeToken,
      constructorToken,
    });

    const response = await runDownload(controller, "conflict");

    expect(response).toMatchObject({ success: false });
    expect(handleDownloadFile).not.toHaveBeenCalled();
    expectNoCapabilityLeak(response, [activeToken, constructorToken]);
  });

  it.each([
    {
      name: "agent",
      toolIdentity: {
        agentId: "agent-b",
        runId: "run-b",
        sessionId: "session-a",
        sessionKey: "agent:agent-a:session-a",
      },
    },
    {
      name: "session",
      toolIdentity: {
        agentId: "agent-a",
        runId: "run-a",
        sessionId: "session-b",
        sessionKey: "agent:agent-a:session-b",
      },
    },
  ])("rejects a prebuilt message tool from a different $name", async ({ toolIdentity }) => {
    const requestIdentity = {
      agentId: "agent-a",
      runId: "run-a",
      sessionId: "session-a",
      sessionKey: "agent:agent-a:session-a",
    };
    const activeToken = mintAttemptCapability(requestIdentity, "sender-a");
    const controller = createControllerFixture({
      requestIdentity,
      attemptToken: activeToken,
      toolIdentity,
    });

    const response = await runDownload(controller, `cross-${toolIdentity.agentId}`);

    expect(response).toMatchObject({ success: false });
    expect(handleDownloadFile).not.toHaveBeenCalled();
    expectNoCapabilityLeak(response, [activeToken]);
  });

  it("isolates concurrent downloads across different agents and sessions", async () => {
    const firstIdentity = {
      agentId: "agent-a",
      runId: "run-a",
      sessionId: "session-a",
      sessionKey: "agent:agent-a:session-a",
    };
    const secondIdentity = {
      agentId: "agent-b",
      runId: "run-b",
      sessionId: "session-b",
      sessionKey: "agent:agent-b:session-b",
    };
    const firstToken = mintAttemptCapability(firstIdentity, "sender-a");
    const secondToken = mintAttemptCapability(secondIdentity, "sender-b");
    let entered = 0;
    let releaseOverlap: (() => void) | undefined;
    const overlap = new Promise<void>((resolve) => {
      releaseOverlap = resolve;
    });
    handleDownloadFile.mockImplementation(async (ctx) => {
      entered += 1;
      if (entered === 2) {
        releaseOverlap?.();
      }
      await overlap;
      return downloadFileResult(ctx);
    });
    const first = createControllerFixture({
      requestIdentity: firstIdentity,
      attemptToken: firstToken,
    });
    const second = createControllerFixture({
      requestIdentity: secondIdentity,
      attemptToken: secondToken,
    });

    const responses = await Promise.all([
      runDownload(first, "concurrent-a"),
      runDownload(second, "concurrent-b"),
    ]);

    expect(responses).toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    expect(handleDownloadFile).toHaveBeenCalledTimes(2);
    expect(
      handleDownloadFile.mock.calls.map(([ctx]) => ({
        fileId: ctx.params.fileId,
        requesterSenderId: ctx.requesterSenderId,
        sessionKey: ctx.sessionKey,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          fileId: "F-concurrent-a",
          requesterSenderId: "sender-a",
          sessionKey: firstIdentity.sessionKey,
        },
        {
          fileId: "F-concurrent-b",
          requesterSenderId: "sender-b",
          sessionKey: secondIdentity.sessionKey,
        },
      ]),
    );
    expectNoCapabilityLeak(responses, [firstToken, secondToken]);
  });
});
