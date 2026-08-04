// Covers host-private receipt binding from an exact Slack source send into the durable queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  deliverOutboundPayloadsInternal: vi.fn(),
  resolveOutboundDurableFinalDeliverySupport: vi.fn(),
}));

vi.mock("./deliver.js", async () => {
  const actual = await vi.importActual<typeof import("./deliver.js")>("./deliver.js");
  return {
    ...actual,
    deliverOutboundPayloads: mocks.deliverOutboundPayloads,
    deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloadsInternal,
    resolveOutboundDurableFinalDeliverySupport: mocks.resolveOutboundDurableFinalDeliverySupport,
  };
});

import { runMessageAction, type RunMessageActionParams } from "./message-action-runner.js";

const INCIDENT = {
  accountId: "default",
  channelId: "channel:C123",
  currentMessageId: "req_9915c61a648e85c0197ff52703cf4349",
  receiptPluginId: "gaia-workflow-preflight",
  runId: "run-incident-9915c61a648e85c0197ff52703cf4349",
  senderId: "U123",
  sessionId: "session-incident",
  sessionKey: "agent:main:slack:channel:C123",
  threadId: "1785794733.801399",
} as const;

function registerSlack() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            outbound: { deliveryMode: "direct", sendText: vi.fn() },
          }),
          actions: {
            prepareSendPayload: async (params: { payload: ReplyPayload }) => params.payload,
          },
          config: {
            listAccountIds: () => [INCIDENT.accountId],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          threading: {
            resolveAutoThreadId: () => INCIDENT.threadId,
            resolveReplyTransport: ({ threadId }: { threadId?: string | number | null }) => ({
              replyToId: threadId == null ? undefined : String(threadId),
            }),
          },
        },
      },
    ]),
  );
}

function input(): RunMessageActionParams {
  return {
    cfg: { channels: { slack: { enabled: true } } } as OpenClawConfig,
    action: "send",
    params: {
      channel: "slack",
      target: INCIDENT.channelId,
      message: "The durable acknowledgement must be visible in the original thread.",
    },
    defaultAccountId: INCIDENT.accountId,
    agentId: "main",
    requesterAccountId: INCIDENT.accountId,
    requesterSenderId: INCIDENT.senderId,
    messageActionAuthorization: {
      requesterAccountId: INCIDENT.accountId,
      requesterSenderId: INCIDENT.senderId,
      runId: INCIDENT.runId,
      sessionKey: INCIDENT.sessionKey,
      sessionId: INCIDENT.sessionId,
      messageSentReceiptPluginId: INCIDENT.receiptPluginId,
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: INCIDENT.channelId,
        currentThreadTs: INCIDENT.threadId,
        currentMessageId: INCIDENT.currentMessageId,
        replyToMode: "all",
      },
    },
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: INCIDENT.channelId,
      currentThreadTs: INCIDENT.threadId,
      currentMessageId: INCIDENT.currentMessageId,
      replyToMode: "all",
    },
    sessionKey: INCIDENT.sessionKey,
    sessionId: INCIDENT.sessionId,
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
  };
}

function delivery(): Record<string, unknown> {
  const [call] = mocks.deliverOutboundPayloadsInternal.mock.calls.length
    ? mocks.deliverOutboundPayloadsInternal.mock.calls
    : mocks.deliverOutboundPayloads.mock.calls;
  const value = call?.[0];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected durable outbound delivery");
  }
  return value as Record<string, unknown>;
}

type Case = {
  name: string;
  expected: boolean;
  authorization?: Partial<NonNullable<RunMessageActionParams["messageActionAuthorization"]>>;
  toolContext?: Record<string, unknown>;
  params?: Record<string, unknown>;
  sessionKey?: string;
};

describe("receipt-bound Slack message actions", () => {
  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "slack", messageId: "delivery" }]);
    mocks.deliverOutboundPayloadsInternal.mockReset();
    mocks.deliverOutboundPayloadsInternal.mockResolvedValue([
      { channel: "slack", messageId: "delivery" },
    ]);
    mocks.resolveOutboundDurableFinalDeliverySupport.mockReset();
    mocks.resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    registerSlack();
  });

  afterEach(() => setActivePluginRegistry(createTestRegistry([])));

  it.each([
    { name: "the exact incident-shaped source thread", expected: true },
    {
      name: "a different provider",
      expected: false,
      toolContext: { currentChannelProvider: "telegram" },
    },
    {
      name: "a different account",
      expected: false,
      authorization: { requesterAccountId: "other" },
    },
    {
      name: "a different channel",
      expected: false,
      toolContext: { currentChannelId: "channel:C999" },
    },
    {
      name: "a different thread",
      expected: false,
      toolContext: { currentThreadTs: "1785794733.801400" },
    },
    {
      name: "a different session",
      expected: false,
      authorization: { sessionKey: "agent:main:slack:channel:C999" },
    },
    {
      name: "a missing receipt owner",
      expected: false,
      authorization: { messageSentReceiptPluginId: undefined },
    },
    { name: "a root send", expected: false, params: { topLevel: true } },
  ] as Case[])("binds only $name", async (testCase) => {
    const action = input();
    const authorization = action.messageActionAuthorization;
    if (!authorization?.toolContext) {
      throw new Error("expected trusted authorization");
    }
    action.messageActionAuthorization = {
      ...authorization,
      ...testCase.authorization,
      toolContext: { ...authorization.toolContext, ...testCase.toolContext },
    };
    action.params = { ...action.params, ...testCase.params };
    action.sessionKey = testCase.sessionKey ?? action.sessionKey;

    const result = await runMessageAction(action);
    const outbound = delivery();
    expect(JSON.stringify(result)).not.toContain(INCIDENT.receiptPluginId);
    if (!testCase.expected) {
      expect(outbound).toMatchObject({ queuePolicy: "best_effort" });
      expect(outbound.replyPayloadSendingHook).toBeUndefined();
      return;
    }
    expect(outbound).toMatchObject({
      queuePolicy: "required",
      bestEffort: false,
      requireUnknownSendReconciliation: true,
      replyPayloadSendingHook: {
        kind: "final",
        channel: "slack",
        sessionKey: INCIDENT.sessionKey,
        runId: INCIDENT.runId,
        messageSentReceiptPluginId: INCIDENT.receiptPluginId,
        context: {
          channelId: "slack",
          accountId: INCIDENT.accountId,
          conversationId: INCIDENT.channelId,
          sessionKey: INCIDENT.sessionKey,
          runId: INCIDENT.runId,
          messageId: INCIDENT.currentMessageId,
        },
      },
    });
  });
});
