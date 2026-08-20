import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackActionRuntime } from "./action-runtime.js";
import { slackPlugin } from "./channel.js";

const originalDownloadSlackFile = slackActionRuntime.downloadSlackFile;
const originalDownloadSlackFileDecision = slackActionRuntime.downloadSlackFileDecision;
const originalResolveSlackConversationInfo = slackActionRuntime.resolveSlackConversationInfo;
const downloadSlackFile = vi.fn(async () => ({
  path: "/tmp/dossier.pdf",
  contentType: "application/pdf",
  placeholder: "[Slack file: dossier.pdf (fileId: F-DOSSIER)]",
}));
const downloadSlackFileDecision = vi.fn(async () => ({
  ok: true as const,
  media: {
    path: "/tmp/dossier.pdf",
    contentType: "application/pdf",
    placeholder: "[Slack file: dossier.pdf (fileId: F-DOSSIER)]",
  },
  provenance: { channelId: "C12345678", matchedBy: "share_map" as const },
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
  overrides?: {
    cfg?: OpenClawConfig;
    channelId?: string;
    threadId?: string;
  },
): ChannelMessageActionContext {
  const channelId = overrides?.channelId ?? "C12345678";
  return {
    action: "download-file",
    channel: "slack",
    accountId: "default",
    requesterAccountId: "default",
    requesterSenderId: "U-DOSSIER",
    conversationReadOrigin: "delegated",
    cfg: overrides?.cfg ?? cfg,
    params: {
      channelId,
      threadId: overrides?.threadId ?? "111.222",
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
    downloadSlackFileDecision.mockReset();
    downloadSlackFileDecision.mockResolvedValue({
      ok: true,
      media: {
        path: "/tmp/dossier.pdf",
        contentType: "application/pdf",
        placeholder: "[Slack file: dossier.pdf (fileId: F-DOSSIER)]",
      },
      provenance: { channelId: "C12345678", matchedBy: "share_map" },
    });
    slackActionRuntime.downloadSlackFile =
      downloadSlackFile as unknown as typeof slackActionRuntime.downloadSlackFile;
    slackActionRuntime.downloadSlackFileDecision =
      downloadSlackFileDecision as unknown as typeof slackActionRuntime.downloadSlackFileDecision;
    slackActionRuntime.resolveSlackConversationInfo = resolveSlackConversationInfo;
  });

  afterEach(() => {
    slackActionRuntime.downloadSlackFile = originalDownloadSlackFile;
    slackActionRuntime.downloadSlackFileDecision = originalDownloadSlackFileDecision;
    slackActionRuntime.resolveSlackConversationInfo = originalResolveSlackConversationInfo;
  });

  it("composes the shipped adapter with delegated Slack download authorization", async () => {
    const result = await requireSlackActionHandler()(
      createContext({
        currentChannelProvider: "slack",
        currentChannelId: "C12345678",
        currentMessagingTarget: "C12345678",
        currentThreadTs: "333.444",
        sameChannelThreadRequired: true,
      }),
    );

    const firstContent = result.content?.[0];
    expect(firstContent).toMatchObject({ type: "text" });
    if (firstContent?.type !== "text") {
      throw new Error("expected the Slack download result to be text content");
    }
    expect(firstContent.text).toContain("[Slack file: dossier.pdf (fileId: F-DOSSIER)]");
    expect(downloadSlackFile).not.toHaveBeenCalled();
    expect(downloadSlackFileDecision).toHaveBeenCalledWith(
      "F-DOSSIER",
      expect.objectContaining({
        cfg,
        channelId: "C12345678",
      }),
    );
    expect(downloadSlackFileDecision.mock.calls[0]?.[1]).not.toHaveProperty("threadId");
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
  ])(
    "returns structured delegated download denials from $name before Slack file access",
    async ({ toolContext, requesterAccountId }) => {
      const context = createContext(toolContext);
      if (requesterAccountId) {
        context.requesterAccountId = requesterAccountId;
      }

      const result = await requireSlackActionHandler()(context);
      expect(result.details).toEqual({
        ok: false,
        error: requesterAccountId
          ? "OpenClaw denied delegated Slack file download: the requester and acting Slack accounts do not match."
          : "OpenClaw denied delegated Slack file download: the requested channel is not the exact current Slack channel.",
        errorCode: requesterAccountId ? "delegated_account_mismatch" : "delegated_channel_mismatch",
        deniedBy: "openclaw_delegated_context",
      });
      expect(downloadSlackFile).not.toHaveBeenCalled();
      expect(downloadSlackFileDecision).not.toHaveBeenCalled();
    },
  );

  it("keeps shipped DM and group-DM downloads on the thread-scoped path", async () => {
    const groupCfg = {
      ...cfg,
      channels: {
        slack: {
          ...cfg.channels?.slack,
          dm: { groupEnabled: true },
        },
      },
    } as OpenClawConfig;

    for (const testCase of [
      { channelId: "D123", cfg },
      { channelId: "G123", cfg: groupCfg },
    ]) {
      await requireSlackActionHandler()(
        createContext(
          {
            currentChannelProvider: "slack",
            currentChannelId: testCase.channelId,
            currentMessagingTarget: testCase.channelId,
            currentThreadTs: "111.222",
            sameChannelThreadRequired: true,
          },
          testCase,
        ),
      );
    }

    expect(downloadSlackFile).toHaveBeenCalledTimes(2);
    expect(downloadSlackFileDecision).not.toHaveBeenCalled();
  });
});
