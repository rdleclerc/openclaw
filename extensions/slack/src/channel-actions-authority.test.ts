import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackActionRuntime } from "./action-runtime.js";
import { slackPlugin } from "./channel.js";

const originalDownloadSlackFile = slackActionRuntime.downloadSlackFile;
const originalResolveSlackConversationInfo = slackActionRuntime.resolveSlackConversationInfo;
const downloadSlackFile = vi.fn(async () => ({
  path: "/tmp/dossier.pdf",
  contentType: "application/pdf",
  placeholder: "[Slack file: dossier.pdf (fileId: F-DOSSIER)]",
}));
const resolveSlackConversationInfo = vi.fn(async () => ({ type: "channel" as const }));

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      groupPolicy: "allowlist",
      channels: {
        C12345678: { enabled: true },
      },
    },
  },
} as OpenClawConfig;

function createContext(
  toolContext: NonNullable<ChannelMessageActionContext["toolContext"]>,
): ChannelMessageActionContext {
  return {
    action: "download-file",
    channel: "slack",
    accountId: "default",
    requesterAccountId: "default",
    requesterSenderId: "U-DOSSIER",
    conversationReadOrigin: "delegated",
    cfg,
    params: {
      channelId: "C12345678",
      threadId: "111.222",
      fileId: "F-DOSSIER",
    },
    toolContext,
  };
}

function requireSlackActionHandler() {
  const handleAction = slackPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("slackPlugin.actions.handleAction is unavailable");
  }
  return handleAction;
}

describe("Slack message action authority composition", () => {
  beforeEach(() => {
    downloadSlackFile.mockReset();
    downloadSlackFile.mockResolvedValue({
      path: "/tmp/dossier.pdf",
      contentType: "application/pdf",
      placeholder: "[Slack file: dossier.pdf (fileId: F-DOSSIER)]",
    });
    slackActionRuntime.downloadSlackFile =
      downloadSlackFile as unknown as typeof slackActionRuntime.downloadSlackFile;
    slackActionRuntime.resolveSlackConversationInfo = resolveSlackConversationInfo;
  });

  afterEach(() => {
    slackActionRuntime.downloadSlackFile = originalDownloadSlackFile;
    slackActionRuntime.resolveSlackConversationInfo = originalResolveSlackConversationInfo;
  });

  it("composes the shipped adapter with delegated Slack download authorization", async () => {
    const result = await requireSlackActionHandler()(
      createContext({
        currentChannelProvider: "slack",
        currentChannelId: "C12345678",
        currentMessagingTarget: "C12345678",
        currentThreadTs: "111.222",
        sameChannelThreadRequired: true,
      }),
    );

    const firstContent = result.content?.[0];
    expect(firstContent).toMatchObject({ type: "text" });
    if (firstContent?.type !== "text") {
      throw new Error("expected the Slack download result to be text content");
    }
    expect(firstContent.text).toContain("[Slack file: dossier.pdf (fileId: F-DOSSIER)]");
    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F-DOSSIER",
      expect.objectContaining({
        cfg,
        channelId: "C12345678",
        threadId: "111.222",
        requireScopeEvidence: true,
      }),
    );
  });

  it.each([
    {
      name: "another account",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "C12345678",
        currentMessagingTarget: "C12345678",
        currentThreadTs: "111.222",
        sameChannelThreadRequired: true,
      },
      requesterAccountId: "other",
    },
    {
      name: "another channel",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "C-OTHER",
        currentMessagingTarget: "C-OTHER",
        currentThreadTs: "111.222",
        sameChannelThreadRequired: true,
      },
    },
    {
      name: "another thread",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "C12345678",
        currentMessagingTarget: "C12345678",
        currentThreadTs: "333.444",
        sameChannelThreadRequired: true,
      },
    },
  ])(
    "rejects delegated downloads from $name before Slack file access",
    async ({ toolContext, requesterAccountId }) => {
      const context = createContext(toolContext);
      if (requesterAccountId) {
        context.requesterAccountId = requesterAccountId;
      }

      await expect(requireSlackActionHandler()(context)).rejects.toThrow(
        "requires the exact current conversation and account",
      );
      expect(downloadSlackFile).not.toHaveBeenCalled();
    },
  );
});
