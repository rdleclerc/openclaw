import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";
const sessionKey = "agent:main:main",
  sessionId = "run-session",
  runId = "finalizing-run";
const deliveryContext = {
  accountId: "main",
  channel: "slack",
  threadId: "123.456",
  to: "C123",
} satisfies DeliveryContext;
const payloads: ReplyPayload[] = [{ text: "final answer" }];
const recoveryState = {
  restartRecoveryDeliveryContext: deliveryContext,
  restartRecoveryDeliveryRunId: runId,
  restartRecoveryResumingNoticeRunId: "notice-run",
} satisfies Partial<SessionEntry>;
let tempDir: string, storePath: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pending-final-marker-"));
  storePath = path.join(tempDir, "sessions.json");
});
afterEach(() => fs.rmSync(tempDir, { force: true, recursive: true }));
function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...recoveryState, ...overrides };
}
async function runMarker(current: SessionEntry, initial = current) {
  await replaceSessionEntry({ sessionKey, storePath }, current);
  const before = loadSessionEntry({ sessionKey, storePath })!;
  const sessionStore = { [sessionKey]: initial };
  const result = await persistPendingFinalDeliveryMarker({
    deliver: true,
    sessionStore,
    sessionKey,
    storePath,
    suppressVisibleSessionEffects: false,
    sessionReboundDuringRun: false,
    payloads,
    deliveryContext,
    runOwnedSessionId: sessionId,
    runId,
  });
  return { after: loadSessionEntry({ sessionKey, storePath })!, before, result };
}
describe("persistPendingFinalDeliveryMarker", () => {
  it("persists an exact interrupted-run claim without dropping recovery state", async () => {
    const { after, result } = await runMarker(
      makeEntry({ abortedLastRun: true, status: "running" }),
    );
    expect(result).toMatchObject({
      pendingFinalDeliveryMarkerPersisted: true,
      pendingFinalDeliveryTextForThisRun: "final answer",
    });
    expect(after).toMatchObject({
      ...recoveryState,
      abortedLastRun: true,
      pendingFinalDelivery: true,
      pendingFinalDeliveryContext: deliveryContext,
      pendingFinalDeliveryText: "final answer",
      status: "running",
    });
  });
  it("keeps normal non-aborted persistence", async () => {
    const { after, result } = await runMarker(makeEntry({ abortedLastRun: false }));
    expect(result.pendingFinalDeliveryMarkerPersisted).toBe(true);
    expect(after).toMatchObject({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "final answer",
    });
  });
  it.each([
    ["missing claim", { restartRecoveryDeliveryRunId: undefined }],
    ["replacement claim", { restartRecoveryDeliveryRunId: "replacement-run" }],
    ["replacement session", { sessionId: "replacement-session" }],
    ["terminal status", { status: "done" }],
  ] as const)(
    "rejects %s without faking success for identical pending text",
    async (_name, overrides) => {
      const { after, before, result } = await runMarker(
        makeEntry({
          abortedLastRun: true,
          status: "running",
          ...overrides,
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: "final answer",
        }),
        makeEntry({ abortedLastRun: true, status: "running" }),
      );
      expect(result.pendingFinalDeliveryMarkerPersisted).toBe(false);
      expect(after).toEqual(before);
    },
  );
});
