// Slack tests cover actionsownload file plugin behavior.
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackMedia = vi.fn();
const createSlackLookupClientMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));

let downloadSlackFile: typeof import("./actions.js").downloadSlackFile;
let downloadSlackFileDecision: typeof import("./actions.runtime.js").downloadSlackFileDecision;

function createClient() {
  return {
    files: {
      info: vi.fn(async () => ({ file: {} })),
    },
  } as unknown as WebClient & {
    files: {
      info: ReturnType<typeof vi.fn>;
    };
  };
}

function makeSlackFileInfo(overrides?: Record<string, unknown>) {
  return {
    id: "F123",
    name: "image.png",
    mimetype: "image/png",
    url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
    ...overrides,
  };
}

function makeResolvedSlackMedia(overrides?: Record<string, unknown>) {
  return {
    path: "/tmp/image.png",
    contentType: "image/png",
    placeholder: "[Slack file: image.png]",
    ...overrides,
  };
}

const RECEIPT_FILE_ID = "F0BQZC8T7B4";
const RECEIPT_CHANNEL_ID = "C0BQ0LHJV8D";

function makeReceiptSlackFileInfo(overrides?: Record<string, unknown>) {
  return makeSlackFileInfo({
    id: RECEIPT_FILE_ID,
    size: 136878,
    channels: [RECEIPT_CHANNEL_ID],
    shares: {
      private: {
        [RECEIPT_CHANNEL_ID]: [{ ts: "1787058054.361039" }],
      },
    },
    ...overrides,
  });
}

function makeShareMapFile(value: unknown) {
  return makeSlackFileInfo({
    channels: [],
    shares: { private: { [RECEIPT_CHANNEL_ID]: value } },
  });
}

function decisionOptions(
  client: ReturnType<typeof createClient>,
  maxBytes: number,
  channelId = RECEIPT_CHANNEL_ID,
) {
  return { client, token: "xoxb-test", maxBytes, channelId };
}

function expectNoMediaDownload(result: Awaited<ReturnType<typeof downloadSlackFile>>) {
  expect(result).toBeNull();
  expect(resolveSlackMedia).not.toHaveBeenCalled();
}

function expectResolveSlackMediaCalledWithDefaults() {
  expect(resolveSlackMedia).toHaveBeenCalledWith({
    files: [
      {
        id: "F123",
        name: "image.png",
        mimetype: "image/png",
        url_private: undefined,
        url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
      },
    ],
    token: "xoxb-test",
    maxBytes: 1024,
  });
}

function mockSuccessfulMediaDownload(client: ReturnType<typeof createClient>) {
  client.files.info.mockResolvedValueOnce({
    file: makeSlackFileInfo(),
  });
  resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);
}

describe("downloadSlackFile", () => {
  beforeAll(async () => {
    ({ downloadSlackFile } = await import("./actions.js"));
    ({ downloadSlackFileDecision } = await import("./actions.runtime.js"));
  });

  beforeEach(() => {
    resolveSlackMedia.mockReset();
    createSlackLookupClientMock.mockReset();
  });

  it("returns null when files.info has no private download URL", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: {
        id: "F123",
        name: "image.png",
      },
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(result).toBeNull();
    expect(resolveSlackMedia).not.toHaveBeenCalled();
  });

  it("downloads via resolveSlackMedia using fresh files.info metadata", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(client.files.info).toHaveBeenCalledWith({ file: "F123" });
    expectResolveSlackMediaCalledWithDefaults();
    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("preserves non-image download metadata", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        name: "report.pdf",
        mimetype: "application/pdf",
        url_private_download: "https://files.slack.com/files-pri/T1-F123/report.pdf",
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([
      makeResolvedSlackMedia({
        path: "/tmp/report.pdf",
        contentType: "application/pdf",
        placeholder: "[Slack file: report.pdf (fileId: F123)]",
      }),
    ]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(resolveSlackMedia).toHaveBeenCalledWith({
      files: [
        {
          id: "F123",
          name: "report.pdf",
          mimetype: "application/pdf",
          url_private: undefined,
          url_private_download: "https://files.slack.com/files-pri/T1-F123/report.pdf",
        },
      ],
      token: "xoxb-test",
      maxBytes: 1024,
    });
    expect(result).toEqual(
      makeResolvedSlackMedia({
        path: "/tmp/report.pdf",
        contentType: "application/pdf",
        placeholder: "[Slack file: report.pdf (fileId: F123)]",
      }),
    );
  });

  it("returns null when channel scope definitely mismatches file shares", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({ channels: ["C999"] }),
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
    });

    expectNoMediaDownload(result);
  });

  it("returns null when thread scope definitely mismatches file share thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: {
          private: {
            C123: [{ ts: "1787058054.361039", thread_ts: "1787058054.361039" }],
          },
        },
      }),
    });

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "1787058055.361039",
    });

    expectNoMediaDownload(result);
  });

  it("keeps legacy behavior when file metadata does not expose channel/thread shares", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
    });

    expect(result).toEqual(makeResolvedSlackMedia());
    expect(resolveSlackMedia).toHaveBeenCalledTimes(1);
    expectResolveSlackMediaCalledWithDefaults();
  });

  it("returns null when delegated download requires scope evidence that Slack did not provide", async () => {
    const client = createClient();
    mockSuccessfulMediaDownload(client);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "222.222",
      requireScopeEvidence: true,
    });

    expectNoMediaDownload(result);
  });

  it("downloads when Slack proves the exact delegated channel and thread", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        shares: {
          private: {
            C123: [{ ts: "1787058054.361039", thread_ts: "1787058054.361039" }],
          },
        },
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFile("F123", {
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      channelId: "C123",
      threadId: "1787058054.361039",
      requireScopeEvidence: true,
    });

    expect(result).toEqual(makeResolvedSlackMedia());
    expectResolveSlackMediaCalledWithDefaults();
  });

  it("resolves the bot token from cfg when no explicit token or client is provided", async () => {
    // Regression guard for the 95331e5cc5 migration: downloadSlackFile must
    // thread opts.cfg into resolveToken so the cfg-only resolution branch works
    // from any caller (not only action-runtime.ts which always injects token).
    const client = createClient();
    mockSuccessfulMediaDownload(client);
    createSlackLookupClientMock.mockReturnValueOnce(client);

    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: "xoxb-from-cfg",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await downloadSlackFile("F123", {
      cfg,
      accountId: "default",
      maxBytes: 1024,
    });

    expect(createSlackLookupClientMock).toHaveBeenCalledWith("xoxb-from-cfg");
    expect(resolveSlackMedia).toHaveBeenCalledWith({
      files: [
        {
          id: "F123",
          name: "image.png",
          mimetype: "image/png",
          url_private: undefined,
          url_private_download: "https://files.slack.com/files-pri/T1-F123/image.png",
        },
      ],
      token: "xoxb-from-cfg",
      maxBytes: 1024,
    });
    expect(result).toEqual(makeResolvedSlackMedia());
  });

  it("accepts the minimized same-channel cross-thread Slack fixture", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeReceiptSlackFileInfo({ channels: [] }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFileDecision(
      RECEIPT_FILE_ID,
      decisionOptions(client, 136878),
    );

    expect(result).toEqual({
      ok: true,
      media: makeResolvedSlackMedia(),
      provenance: { channelId: RECEIPT_CHANNEL_ID, matchedBy: "share_map" },
    });
  });

  it.each([
    {
      name: "missing evidence",
      file: makeSlackFileInfo({ channels: [], shares: {} }),
    },
    {
      name: "foreign-only evidence",
      file: makeSlackFileInfo({
        channels: ["C-FOREIGN"],
        shares: { private: { "C-FOREIGN": [{ ts: "1787058054.361039" }] } },
      }),
    },
    { name: "null share-map value", file: makeShareMapFile(null) },
    { name: "string share-map value", file: makeShareMapFile("not-an-array") },
    { name: "empty share-map array", file: makeShareMapFile([]) },
    {
      name: "non-array share-map object",
      file: makeShareMapFile({ ts: "1787058054.361039" }),
    },
    {
      name: "share-map array without a valid timestamped object",
      file: makeShareMapFile([{}]),
    },
    {
      name: "malformed ts",
      file: makeShareMapFile([{ ts: "not-a-slack-timestamp" }]),
    },
    {
      name: "malformed thread_ts",
      file: makeShareMapFile([{ thread_ts: "not-a-slack-timestamp" }]),
    },
    { name: "integer-only", file: makeShareMapFile([{ ts: "1787058054" }]) },
    { name: "short fraction", file: makeShareMapFile([{ thread_ts: "1787058054.36103" }]) },
    { name: "eleven seconds", file: makeShareMapFile([{ ts: "17870580540.361039" }]) },
    { name: "seven-digit fraction", file: makeShareMapFile([{ thread_ts: "1787058054.3610390" }]) },
  ])("returns the same safe denial for $name", async ({ file }) => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({ file });

    const result = await downloadSlackFileDecision("F123", decisionOptions(client, 1024));

    expect(result).toEqual({
      ok: false,
      error: "OpenClaw could not verify the file in the current Slack channel.",
      errorCode: "file_channel_provenance_denied",
      deniedBy: "openclaw_channel_provenance",
    });
    expect(JSON.stringify(result)).not.toMatch(/C-FOREIGN|image\.png|files\.slack\.com/);
  });

  it("accepts an exact thread_ts when ts is malformed", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeReceiptSlackFileInfo({
        channels: [],
        shares: {
          private: {
            [RECEIPT_CHANNEL_ID]: [{ ts: "not-a-slack-timestamp", thread_ts: "1787058054.361039" }],
          },
        },
      }),
    });
    resolveSlackMedia.mockResolvedValueOnce([makeResolvedSlackMedia()]);

    const result = await downloadSlackFileDecision(
      RECEIPT_FILE_ID,
      decisionOptions(client, 136878),
    );

    expect(result).toEqual({
      ok: true,
      media: makeResolvedSlackMedia(),
      provenance: { channelId: RECEIPT_CHANNEL_ID, matchedBy: "share_map" },
    });
  });

  it("denies foreign provenance before URL and size classification", async () => {
    const client = createClient();
    client.files.info.mockResolvedValueOnce({
      file: makeSlackFileInfo({
        channels: ["C-FOREIGN"],
        shares: { private: { "C-FOREIGN": [{ ts: "1787058054.361039" }] } },
        url_private: undefined,
        url_private_download: undefined,
        size: Number.MAX_SAFE_INTEGER,
      }),
    });

    const result = await downloadSlackFileDecision("F123", decisionOptions(client, 1024));

    expect(result).toEqual({
      ok: false,
      error: "OpenClaw could not verify the file in the current Slack channel.",
      errorCode: "file_channel_provenance_denied",
      deniedBy: "openclaw_channel_provenance",
    });
  });

  it.each([
    {
      payloadCode: "file_not_found",
      expected: {
        error: "Slack files.info failed with error code file_not_found.",
        detail: { slackErrorCode: "file_not_found" },
      },
    },
    {
      payloadCode: "xoxb-123-secret",
      expected: { error: "Slack files.info failed." },
    },
  ])("reflects only the safe files.info code $payloadCode", async ({ payloadCode, expected }) => {
    const client = createClient();
    client.files.info.mockRejectedValueOnce(
      Object.assign(new Error("private request and token"), {
        data: { error: payloadCode },
      }),
    );

    const result = await downloadSlackFileDecision("F123", decisionOptions(client, 1024));

    expect(result).toEqual({
      ok: false,
      ...expected,
      errorCode: "slack_api_lookup_failed",
      deniedBy: "slack_api",
    });
    expect(JSON.stringify(result)).not.toContain("private request");
    expect(JSON.stringify(result)).not.toContain("xoxb-123-secret");
  });

  it("classifies authorized no-URL, size, and transport failures safely", async () => {
    const noUrlClient = createClient();
    noUrlClient.files.info.mockResolvedValueOnce({
      file: makeReceiptSlackFileInfo({
        url_private: undefined,
        url_private_download: undefined,
      }),
    });
    await expect(
      downloadSlackFileDecision(RECEIPT_FILE_ID, decisionOptions(noUrlClient, 1024)),
    ).resolves.toEqual({
      ok: false,
      error: "Slack returned no downloadable URL for the authorized file.",
      errorCode: "file_no_download_url",
      deniedBy: "slack_api",
    });

    const sizeClient = createClient();
    sizeClient.files.info.mockResolvedValueOnce({
      file: makeReceiptSlackFileInfo({ size: 1025 }),
    });
    await expect(
      downloadSlackFileDecision(RECEIPT_FILE_ID, decisionOptions(sizeClient, 1024)),
    ).resolves.toEqual({
      ok: false,
      error: "OpenClaw rejected the Slack file because it exceeds the configured size limit.",
      errorCode: "file_too_large",
      deniedBy: "openclaw_size_limit",
      detail: { sizeBytes: 1025, maxBytes: 1024 },
    });

    const transportClient = createClient();
    transportClient.files.info.mockResolvedValueOnce({ file: makeReceiptSlackFileInfo() });
    resolveSlackMedia.mockResolvedValueOnce(null);
    await expect(
      downloadSlackFileDecision(RECEIPT_FILE_ID, decisionOptions(transportClient, 136878)),
    ).resolves.toEqual({
      ok: false,
      error: "OpenClaw could not download the authorized Slack file.",
      errorCode: "download_failed",
      deniedBy: "download_transport",
    });
  });

  it("keeps the public wrapper's files.info exception behavior", async () => {
    const client = createClient();
    client.files.info.mockRejectedValueOnce(new Error("raw Slack lookup failure"));

    await expect(
      downloadSlackFile("F123", {
        client,
        token: "xoxb-test",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("raw Slack lookup failure");
  });
});
