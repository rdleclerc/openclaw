// Slack plugin module implements actions behavior.
import type { WebClient } from "@slack/web-api";
import {
  collectSlackDirectShareChannelIds,
  collectSlackSharedChannelIds,
  getClient,
  normalizeSlackScopeValue,
  resolveToken,
  type SlackActionClientOpts,
  type SlackFileInfoSummary,
} from "./actions.js";
import { resolveSlackMedia } from "./monitor/media.js";
import type { SlackMediaResult } from "./monitor/media.js";

export {
  deleteSlackMessage,
  downloadSlackFile,
  editSlackMessage,
  getSlackMemberInfo,
  listSlackEmojis,
  listSlackPins,
  listSlackReactions,
  pinSlackMessage,
  reactSlackMessage,
  readSlackMessages,
  removeOwnSlackReactions,
  removeSlackReaction,
  resolveSlackConversationName,
  sendSlackMessage,
  unpinSlackMessage,
} from "./actions.js";

type SlackDownloadDecisionFailure = {
  ok: false;
  error: string;
  errorCode:
    | "slack_api_lookup_failed"
    | "file_no_download_url"
    | "file_channel_provenance_denied"
    | "file_too_large"
    | "download_failed";
  deniedBy:
    | "slack_api"
    | "openclaw_channel_provenance"
    | "openclaw_size_limit"
    | "download_transport";
  detail?: { slackErrorCode: string } | { sizeBytes: number; maxBytes: number };
};
type SlackDownloadDecision =
  | SlackDownloadDecisionFailure
  | {
      ok: true;
      media: SlackMediaResult;
      provenance: { channelId: string; matchedBy: "direct_share" | "share_map" };
    };
function getSafeSlackErrorCode(err: unknown): "file_not_found" | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const data = (err as { data?: unknown }).data;
  const code =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { error?: unknown }).error
      : undefined;
  return code === "file_not_found" ? code : undefined;
}
export async function downloadSlackFileDecision(
  fileId: string,
  opts: SlackActionClientOpts & { maxBytes: number; channelId: string },
): Promise<SlackDownloadDecision> {
  const token = resolveToken(opts.token, opts.accountId, opts.cfg);
  const client = await getClient(opts);

  let info: Awaited<ReturnType<WebClient["files"]["info"]>>;
  try {
    info = await client.files.info({ file: fileId });
  } catch (err) {
    const slackErrorCode = getSafeSlackErrorCode(err);
    return {
      ok: false,
      error: slackErrorCode
        ? `Slack files.info failed with error code ${slackErrorCode}.`
        : "Slack files.info failed.",
      errorCode: "slack_api_lookup_failed",
      deniedBy: "slack_api",
      ...(slackErrorCode ? { detail: { slackErrorCode } } : {}),
    };
  }
  const file = info.file as SlackFileInfoSummary | undefined;
  const channelId = normalizeSlackScopeValue(opts.channelId);
  const directIds = file ? collectSlackDirectShareChannelIds(file) : new Set<string>();
  const sharedIds = file ? collectSlackSharedChannelIds(file) : new Set<string>();
  const matchedBy =
    channelId && directIds.has(channelId)
      ? "direct_share"
      : channelId && sharedIds.has(channelId)
        ? "share_map"
        : undefined;
  if (!channelId || !matchedBy) {
    return {
      ok: false,
      error: "OpenClaw could not verify the file in the current Slack channel.",
      errorCode: "file_channel_provenance_denied",
      deniedBy: "openclaw_channel_provenance",
    };
  }

  if (!file?.url_private_download && !file?.url_private) {
    return {
      ok: false,
      error: "Slack returned no downloadable URL for the authorized file.",
      errorCode: "file_no_download_url",
      deniedBy: "slack_api",
    };
  }

  const sizeBytes =
    typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0
      ? file.size
      : undefined;
  if (sizeBytes !== undefined && sizeBytes > opts.maxBytes) {
    return {
      ok: false,
      error: "OpenClaw rejected the Slack file because it exceeds the configured size limit.",
      errorCode: "file_too_large",
      deniedBy: "openclaw_size_limit",
      detail: { sizeBytes, maxBytes: opts.maxBytes },
    };
  }

  let results: SlackMediaResult[] | null | undefined;
  try {
    results = await resolveSlackMedia({
      files: [
        {
          id: file.id,
          name: file.name,
          mimetype: file.mimetype,
          url_private: file.url_private,
          url_private_download: file.url_private_download,
        },
      ],
      token,
      maxBytes: opts.maxBytes,
    });
  } catch {
    results = undefined;
  }
  const media = results?.[0];
  if (!media) {
    return {
      ok: false,
      error: "OpenClaw could not download the authorized Slack file.",
      errorCode: "download_failed",
      deniedBy: "download_transport",
    };
  }

  return {
    ok: true,
    media,
    provenance: { channelId, matchedBy },
  };
}
