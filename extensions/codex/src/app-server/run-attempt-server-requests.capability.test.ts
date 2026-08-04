import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  createTestRegistry,
  mintMessageActionTurnCapabilityForTest,
  resetPluginRuntimeStateForTest,
  revokeMessageActionTurnCapabilityForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlackAction, slackActionRuntime } from "../../../slack/runtime-api.js";
import { setSlackRuntime, slackPlugin } from "../../../slack/test-api.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { createCodexDynamicToolExecutionRegistry } from "./run-attempt-tools.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

type Identity = {
  agentId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
};

const CHANNEL_ID = "CDOSSIERS";
const THREAD_ID = "111.222";
const minted: string[] = [];
const downloadSlackFile = vi.fn(async () => null);

function mint(identity: Identity, accountId = "default") {
  const token = mintMessageActionTurnCapabilityForTest({
    ...identity,
    requesterAccountId: accountId,
    requesterSenderId: "U-DOSSIER",
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: CHANNEL_ID,
      currentMessagingTarget: CHANNEL_ID,
      currentThreadTs: THREAD_ID,
      sameChannelThreadRequired: true,
    },
  });
  minted.push(token);
  return token;
}

function controller(params: {
  identity: Identity;
  activeToken?: string;
  constructorToken?: string;
  toolSessionKey?: string;
}) {
  const toolIdentity = {
    ...params.identity,
    sessionKey: params.toolSessionKey ?? params.identity.sessionKey,
  };
  const tools = createOpenClawCodingTools({
    ...toolIdentity,
    cwd: "/tmp/workspace",
    workspaceDir: "/tmp/workspace",
    config: { channels: { slack: { botToken: "xoxb-test" } } } as never,
    messageProvider: "slack",
    messageChannel: "slack",
    toolPolicyMessageProvider: "slack",
    agentAccountId: "default",
    currentChannelId: CHANNEL_ID,
    currentMessagingTarget: CHANNEL_ID,
    currentThreadTs: THREAD_ID,
    messageActionTurnCapability: params.constructorToken,
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
  const message = tools.find((tool) => tool.name === "message");
  if (!message) {
    throw new Error("expected composed message tool");
  }
  const abortController = new AbortController();
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params: {
              ...params.identity,
              messageActionTurnCapability: params.activeToken,
              timeoutMs: 1_000,
              provider: "openai",
              modelId: "gpt-5.6-sol",
            },
            computerUseConfig: { enabled: false },
            runAbortController: abortController,
            appServer: {},
            sessionAgentId: params.identity.agentId,
            sandboxSessionKey: params.identity.sessionKey,
          },
        },
        attemptTools: {
          toolBridge: createCodexDynamicToolBridge({
            tools: [message],
            signal: abortController.signal,
          }),
          toolOutcomeOrdinals: new Map(),
          suppressedDynamicToolOutcomeOrdinals: new Set(),
        },
      },
    },
    state: { thread: { threadId: "thread-1" } },
    projectorRef: {},
  } as unknown as CodexAttemptResources;
  const turnRuntime = {
    state: { activeAppServerTurnRequests: 0, turnCrossedToolHandoff: false },
    turnIdRef: { current: "turn-1" },
    userInputBridgeRef: {},
    openClawDynamicToolExecutions: createCodexDynamicToolExecutionRegistry(),
    pendingOpenClawDynamicToolCompletionIds: new Set(),
    postToolRawAssistantCompletionIdleTimeoutMs: 5,
    turnWatches: {
      clearCompletionIdleTimer: vi.fn(),
      disarmAssistantCompletionIdleWatch: vi.fn(),
      touchActivity: vi.fn(),
      armCompletionIdleWatch: vi.fn(),
      scheduleProgressWatches: vi.fn(),
    },
  } as unknown as CodexAttemptTurnState;
  return createCodexAttemptServerRequestController(resources, turnRuntime, {
    emitExecutionPhaseOnce: vi.fn(),
    scheduleTurnReleaseAfterTerminalDynamicTool: vi.fn(),
    scheduleTerminalDynamicToolReleaseCheck: vi.fn(),
  } as unknown as CodexAttemptLifecycleController);
}

describe("Codex private Slack download authority", () => {
  const originalSlackActionRuntime = { ...slackActionRuntime };

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", source: "test", origin: "bundled", plugin: slackPlugin },
      ]),
    );
    downloadSlackFile.mockReset().mockResolvedValue(null);
    Object.assign(slackActionRuntime, {
      downloadSlackFile,
      resolveSlackConversationInfo: vi.fn(async () => ({ type: "channel" as const })),
    });
    setSlackRuntime({ channel: { slack: { handleSlackAction } } } as never);
  });

  afterEach(() => {
    setSlackRuntime(null as never);
    Object.assign(slackActionRuntime, originalSlackActionRuntime);
    for (const token of minted.splice(0)) {
      revokeMessageActionTurnCapabilityForTest(token);
    }
    resetPluginRuntimeStateForTest();
  });

  it.each([
    { name: "the exact private Slack account, channel, and thread", expectedDownloads: 1 },
    { name: "another account", accountId: "other", expectedDownloads: 0 },
    { name: "another channel", channelId: "C-OTHER", expectedDownloads: 0 },
    { name: "another thread", threadId: "333.444", expectedDownloads: 0 },
    {
      name: "another session",
      toolSessionKey: "agent:main:slack:other",
      expectedDownloads: 0,
    },
    {
      name: "a conflicting constructor capability",
      conflictingCapability: true,
      expectedDownloads: 0,
    },
  ])("accepts only $name without exposing its capability", async (testCase) => {
    const identity = {
      agentId: "main",
      runId: "run-private-download",
      sessionId: "session-private-download",
      sessionKey: "agent:main:slack:dossier",
    };
    const activeToken = mint(identity);
    const constructorToken = testCase.conflictingCapability ? mint(identity) : undefined;
    const response = await controller({
      identity,
      activeToken,
      constructorToken,
      toolSessionKey: testCase.toolSessionKey,
    }).handleServerRequest(
      {
        id: "request-download",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-download",
          namespace: null,
          tool: "message",
          arguments: {
            action: "download-file",
            channel: "slack",
            channelId: testCase.channelId ?? CHANNEL_ID,
            threadId: testCase.threadId ?? THREAD_ID,
            ...(testCase.accountId ? { accountId: testCase.accountId } : {}),
            fileId: "F-DOSSIER",
          },
        },
      },
      { threadId: "thread-1", turnId: "turn-1" },
    );
    expect(downloadSlackFile).toHaveBeenCalledTimes(testCase.expectedDownloads);
    if (testCase.expectedDownloads) {
      expect(downloadSlackFile).toHaveBeenCalledWith(
        "F-DOSSIER",
        expect.objectContaining({
          channelId: CHANNEL_ID,
          threadId: THREAD_ID,
          requireScopeEvidence: true,
        }),
      );
    }
    const visible = JSON.stringify(response);
    expect(visible).not.toContain(activeToken);
    expect(visible).not.toContain(constructorToken ?? "not-a-token");
  });
});
