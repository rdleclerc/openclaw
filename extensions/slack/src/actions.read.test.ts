// Slack tests cover actions.read plugin behavior.
import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackMessages, resolveSlackConversationName } from "./actions.js";

const createSlackLookupClientMock = vi.hoisted(() =>
  vi.fn(() => ({ conversations: { info: vi.fn(), replies: vi.fn(), history: vi.fn() } })),
);

vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));

function createClient() {
  return {
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "general" } })),
      replies: vi.fn(async () => ({ messages: [], has_more: false })),
      history: vi.fn(async () => ({ messages: [], has_more: false })),
    },
  } as unknown as WebClient & {
    conversations: {
      info: ReturnType<typeof vi.fn>;
      replies: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
  };
}

describe("Slack read actions", () => {
  it("resolves the current Slack conversation name without caching failures", async () => {
    const client = createClient();
    client.conversations.info
      .mockRejectedValueOnce(new Error("temporary_failure"))
      .mockResolvedValueOnce({ channel: { name: "  allowed-channel  " } });

    await expect(
      resolveSlackConversationName("C1", { client, token: "xoxp-reader" }),
    ).rejects.toThrow("temporary_failure");
    await expect(
      resolveSlackConversationName("C1", { client, token: "xoxp-reader" }),
    ).resolves.toBe("allowed-channel");
    expect(client.conversations.info).toHaveBeenNthCalledWith(1, { channel: "C1" });
    expect(client.conversations.info).toHaveBeenNthCalledWith(2, { channel: "C1" });
  });

  it("uses conversations.replies and drops the parent message", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "171234.890" }, { ts: "171235.000" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: undefined,
      latest: undefined,
      oldest: undefined,
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["171234.890", "171235.000"]);
  });

  it("reads a complete thread with a normalized root and replies", async () => {
    const client = createClient();
    client.conversations.replies
      .mockResolvedValueOnce({
        messages: [
          { ts: "root", text: "question", user: "U1", thread_ts: "root" },
          { ts: "reply-1", text: "answer", user: "U2", thread_ts: "root" },
        ],
        has_more: true,
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "reply-2", text: "bot answer", bot_id: "B1", thread_ts: "root" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "root",
      complete: true,
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenNthCalledWith(1, {
      channel: "C1",
      ts: "root",
      limit: 100,
    });
    expect(client.conversations.replies).toHaveBeenNthCalledWith(2, {
      channel: "C1",
      ts: "root",
      limit: 100,
      cursor: "page-2",
    });
    expect(result).toMatchObject({
      status: "complete",
      code: null,
      channelId: "C1",
      threadId: "root",
      pages: 2,
      finalCursor: "",
      paginationComplete: true,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(result.root).toEqual({
      ts: "root",
      text: "question",
      actorId: "U1",
      isBot: false,
      threadTs: "root",
    });
    expect(result.replies).toEqual([
      { ts: "reply-1", text: "answer", actorId: "U2", isBot: false, threadTs: "root" },
      {
        ts: "reply-2",
        text: "bot answer",
        actorId: "B1",
        botId: "B1",
        isBot: true,
        threadTs: "root",
      },
    ]);
    expect(result.messages).toEqual(result.replies);
  });

  it("reads one exact channel message with bounded history parameters", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "171234.890", text: "exact", user: "U1" }],
      has_more: false,
      response_metadata: { next_cursor: "" },
    });

    const result = await readSlackMessages("C1", {
      client,
      messageId: "171234.890",
      complete: true,
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: "171234.890",
    });
    expect(result).toMatchObject({
      status: "complete",
      code: null,
      messages: [{ ts: "171234.890", text: "exact", actorId: "U1", isBot: false }],
      replies: [],
      pages: 1,
      finalCursor: "",
      paginationComplete: true,
    });
  });

  it.each([
    ["malformed cursor", { messages: [], response_metadata: { next_cursor: 7 } }],
    ["malformed has_more", { messages: [], has_more: "true" }],
    [
      "cursor and flag conflict",
      { messages: [], has_more: false, response_metadata: { next_cursor: "next" } },
    ],
    ["malformed row", { messages: [{ ts: "1", text: "missing actor" }], has_more: false }],
  ])("returns an incomplete receipt for %s", async (_label, page) => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce(page);

    const result = await readSlackMessages("C1", {
      client,
      threadId: "root",
      complete: true,
      token: "xoxb-test",
    });

    expect(result).toMatchObject({
      status: "incomplete",
      code: "SLACK_READ_INCOMPLETE",
      pages: 1,
      paginationComplete: false,
    });
    expect(client.conversations.replies).toHaveBeenCalledTimes(1);
  });

  it("returns incomplete when a thread page omits its root", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "reply", text: "reply", user: "U1", thread_ts: "root" }],
      has_more: false,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "root",
      complete: true,
      token: "xoxb-test",
    });

    expect(result).toMatchObject({
      status: "incomplete",
      code: "SLACK_READ_INCOMPLETE",
      threadId: "root",
      pages: 1,
      finalCursor: "",
      paginationComplete: false,
    });
  });

  it("returns incomplete instead of following a repeated cursor", async () => {
    const client = createClient();
    client.conversations.replies
      .mockResolvedValueOnce({
        messages: [{ ts: "root", text: "root", user: "U1" }],
        has_more: true,
        response_metadata: { next_cursor: "same" },
      })
      .mockResolvedValueOnce({
        messages: [],
        has_more: true,
        response_metadata: { next_cursor: "same" },
      });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "root",
      complete: true,
      token: "xoxb-test",
    });

    expect(result).toMatchObject({
      status: "incomplete",
      finalCursor: "same",
      pages: 2,
      paginationComplete: false,
    });
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
  });

  it("returns incomplete at the page cap", async () => {
    const client = createClient();
    client.conversations.replies.mockImplementation(async ({ cursor }: { cursor?: string }) => ({
      messages: cursor ? [] : [{ ts: "root", text: "root", user: "U1" }],
      has_more: true,
      response_metadata: { next_cursor: cursor ? `next-${cursor}` : "next-1" },
    }));

    const result = await readSlackMessages("C1", {
      client,
      threadId: "root",
      complete: true,
      token: "xoxb-test",
    });

    expect(result).toMatchObject({ status: "incomplete", pages: 100, paginationComplete: false });
    expect(client.conversations.replies).toHaveBeenCalledTimes(100);
  });

  it("returns incomplete when the total deadline expires during a later page", async () => {
    const client = createClient();
    client.conversations.replies
      .mockResolvedValueOnce({
        messages: [{ ts: "root", text: "root", user: "U1" }],
        has_more: true,
        response_metadata: { next_cursor: "next" },
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const resultPromise = readSlackMessages("C1", { client, threadId: "root", complete: true });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toMatchObject({
        status: "incomplete",
        pages: 1,
        finalCursor: "next",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns incomplete for an exact message with any cursor", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "exact", text: "exact", user: "U1" }],
      has_more: true,
      response_metadata: { next_cursor: "next" },
    });

    const result = await readSlackMessages("C1", {
      client,
      messageId: "exact",
      complete: true,
      token: "xoxb-test",
    });

    expect(result).toMatchObject({ status: "incomplete", pages: 1, finalCursor: "next" });
    expect(client.conversations.history).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid complete targets and filters before client I/O", async () => {
    const client = createClient();
    for (const options of [
      { complete: true },
      { complete: true, threadId: "root", messageId: "exact" },
      { complete: true, threadId: "root", limit: 1 },
      { complete: true, threadId: "root", before: "1" },
      { complete: true, threadId: "root", after: "1" },
      { complete: true, threadId: "root", around: "1" },
      { complete: true, threadId: "root", includeThread: true },
    ]) {
      await expect(readSlackMessages("C1", { client, ...options } as never)).rejects.toThrow(
        /Complete Slack reads/,
      );
    }
    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("filters a specific thread reply by messageId", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "171234.890", text: "reply" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      messageId: "171234.890",
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: undefined,
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "reply" }],
      hasMore: false,
    });
  });

  it("uses conversations.history when threadId is missing", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1" }],
      has_more: false,
    });

    const result = await readSlackMessages("C1", {
      client,
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 20,
      latest: undefined,
      oldest: undefined,
    });
    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["1"]);
  });

  it("filters a specific channel message by messageId", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "171234.890", text: "exact" }, { ts: "171234.891" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      messageId: "171234.890",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: undefined,
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "exact" }],
      hasMore: false,
    });
  });

  it("passes Slack timestamp strings through to history bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      before: "1712345678.654321",
      after: "1712340000.000001",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712345678.654321",
      oldest: "1712340000.000001",
    });
  });

  it("converts ISO date strings to epoch seconds for history bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      before: "2024-04-05T12:34:56.000Z",
      after: "2024-04-05T00:00:00.000Z",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712320496",
      oldest: "1712275200",
    });
  });

  it("converts ISO date strings with offsets to epoch seconds for history bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      before: "2024-04-05T12:34:56+03:00",
      after: "2024-04-05T12:34:56.789+03:00",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712309696",
      oldest: "1712309696.789",
    });
  });

  it.each(["not-a-timestamp", "2024-02-30T00:00:00.000Z", "04/05/2024", "2024-04-05T12:34:56"])(
    "rejects invalid history bound %s with a clear timestamp error",
    async (before) => {
      const client = createClient();

      await expect(
        readSlackMessages("C1", {
          client,
          before,
          token: "xoxb-test",
        }),
      ).rejects.toThrow(
        `Invalid Slack read before timestamp "${before}": expected a Slack timestamp or ISO-8601 date string`,
      );
      expect(client.conversations.history).not.toHaveBeenCalled();
    },
  );

  it("normalizes ISO date strings and Slack timestamp strings for thread reply bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      threadId: "1712345678.000001",
      before: "2024-04-05T12:34:56.000Z",
      after: "1712340000.000001",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1712345678.000001",
      limit: undefined,
      latest: "1712320496",
      oldest: "1712340000.000001",
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("routes read-mode actions through the bounded lookup client", async () => {
    createSlackLookupClientMock.mockReturnValue({
      conversations: {
        info: vi.fn().mockResolvedValue({ channel: { name: "general" } }),
        replies: vi.fn(),
        history: vi.fn(),
      },
    });

    await resolveSlackConversationName("C1", {
      token: "test-auth-token",
      cfg: { channels: { slack: { enabled: true, botToken: "test-auth-token" } } },
    } as Parameters<typeof resolveSlackConversationName>[1]);

    expect(createSlackLookupClientMock).toHaveBeenCalledWith("test-auth-token");
  });
});
