// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import { createHash } from "node:crypto";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  deleteDeliveryQueueEntry,
  completeDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  loadDeliveryQueueEntryRecord,
  loadDeliveryQueueEntryRecordsByGaiaSlackRequest,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueRowMetadata,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_NAME = "outbound";
export const GAIA_KEYED_OUTPUT_VERSION = "gaia-slack-output-v1" as const;

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedReplyPayloadSendingHook = {
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  messageSentReceiptPluginId?: string;
  context: PluginHookReplyPayloadSendingContext;
};

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /** Original queue durability policy when known. */
  queuePolicy?: "required" | "best_effort";
  /** Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  /** Replayable reply payload hook context for recovery and live delivery. */
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  silent?: boolean;
  mirror?: OutboundMirror;
  /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
  /** Gaia-only owner identity and admission fingerprint. */
  gaiaKeyedOutput?: GaiaKeyedOutputOwner;
};

export type GaiaKeyedOutputOwner = {
  version: typeof GAIA_KEYED_OUTPUT_VERSION;
  accepted: GaiaAcceptedEnvelope;
  fingerprint: string;
};

export type GaiaAcceptedEnvelope = Readonly<{
  runId: string;
  sessionKey: string;
  agentId: string;
  acceptedAt: number;
  receiptPluginId: "gaia-workflow-preflight";
}>;

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  /** Count authority-only reconciliation gaps without consuming send retries. */
  reconciliationAttemptCount?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** Known permanent provider error awaiting exact platform readback. */
  pendingPermanentError?: string;
  platformSendStartedAt?: number;
  /** Canonical reply target after hooks; null records an intentional root send. */
  effectiveReplyToId?: string | null;
  recoveryState?: QueuedDeliveryRecoveryState;
}

export type QueuedDeliveryRecoveryState =
  | "send_attempt_started"
  | "unknown_after_send"
  | "ambiguous_failure"
  | "permanent_pre_send_failure";

function queuedDeliveryMetadata(entry: QueuedDelivery): DeliveryQueueRowMetadata {
  return {
    entryKind: "outbound",
    sessionKey: entry.session?.key,
    channel: entry.channel,
    target: entry.to,
    accountId: entry.accountId,
  };
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const id = generateSecureUuid();
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    payloads: params.payloads,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    replyPayloadSendingHook: params.replyPayloadSendingHook,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    gaiaKeyedOutput: params.gaiaKeyedOutput,
    retryCount: 0,
  };
  upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedDeliveryMetadata(entry),
    stateDir,
  });
  return id;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  deleteDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
}

/** Complete a delivery and retain its idempotency tombstone. */
export async function completeDelivery(id: string, stateDir?: string): Promise<void> {
  completeDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
}

function normalizeGaiaAcceptedEnvelope(accepted: GaiaAcceptedEnvelope): GaiaAcceptedEnvelope {
  if (!accepted || typeof accepted !== "object") {
    throw new Error("Gaia keyed output requires an exact accepted envelope.");
  }
  const runId = typeof accepted.runId === "string" ? accepted.runId.trim() : "";
  const sessionKey = typeof accepted.sessionKey === "string" ? accepted.sessionKey.trim() : "";
  const agentId = typeof accepted.agentId === "string" ? accepted.agentId.trim().toLowerCase() : "";
  if (
    !runId ||
    !sessionKey ||
    !agentId ||
    !Number.isSafeInteger(accepted.acceptedAt) ||
    accepted.acceptedAt <= 0 ||
    accepted.receiptPluginId !== "gaia-workflow-preflight"
  ) {
    throw new Error("Gaia keyed output accepted envelope is invalid.");
  }
  return {
    runId,
    sessionKey,
    agentId,
    acceptedAt: accepted.acceptedAt,
    receiptPluginId: "gaia-workflow-preflight",
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function gaiaSlackAdmissionRequestId(runId: string): string | undefined {
  const replay = /^gaia-slack-admission-replay:(req_[a-f0-9]+)$/u.exec(runId);
  const continuation = /^gaia-slack-admission-continuation:(req_[a-f0-9]+):[1-9]\d*$/u.exec(runId);
  return replay?.[1] ?? continuation?.[1];
}

/** Reject a different Gaia run when one Slack request already has a durable output owner. */
export function hasGaiaSlackRequestOutputOwnerConflict(runId: string, stateDir?: string): boolean {
  const normalizedRunId = runId.trim();
  const requestId = gaiaSlackAdmissionRequestId(normalizedRunId);
  if (!requestId) {
    return false;
  }
  return loadDeliveryQueueEntryRecordsByGaiaSlackRequest({
    queueName: QUEUE_NAME,
    replayRunId: `gaia-slack-admission-replay:${requestId}`,
    continuationRunIdPrefix: `gaia-slack-admission-continuation:${requestId}:`,
    stateDir,
  }).some((record) => {
    const storedRunId = (record.entry as QueuedDelivery | null)?.gaiaKeyedOutput?.accepted.runId;
    return storedRunId !== undefined && storedRunId !== normalizedRunId;
  });
}

/** Derive the stable Gaia owner row ID from the host-accepted run identity. */
export function deriveGaiaKeyedOutputOwnerId(runId: string): string {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    throw new Error("Gaia keyed output owner derivation requires an accepted run identity.");
  }
  return createHash("sha256")
    .update(`${GAIA_KEYED_OUTPUT_VERSION}\0${normalizedRunId}`, "utf8")
    .digest("hex");
}

/** Fingerprint the normalized destination and the rendered payload bytes. */
export function fingerprintGaiaKeyedOutput(params: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  replyToId?: string | null;
  payloads: readonly ReplyPayload[];
}): string {
  const fingerprintTuple = [
    GAIA_KEYED_OUTPUT_VERSION,
    params.channel.trim().toLowerCase(),
    params.accountId?.trim() || "default",
    params.to.trim(),
    params.replyToId == null ? "" : String(params.replyToId).trim(),
    params.threadId == null ? "" : String(params.threadId).trim(),
    params.payloads,
  ];
  return createHash("sha256").update(canonicalJson(fingerprintTuple), "utf8").digest("hex");
}

export type GaiaKeyedOutputDeliveryParams = Omit<QueuedDeliveryPayload, "gaiaKeyedOutput"> & {
  accepted: GaiaAcceptedEnvelope;
};

export type GaiaKeyedOutputAdmission = {
  status: "new" | "duplicate" | "conflict";
  ownerId: string;
  fingerprint: string;
  entry: QueuedDelivery;
};

export type GaiaKeyedOutputInspection = {
  ownerId: string;
  status:
    | "pending"
    | "failed"
    | "ambiguous_failure"
    | "permanent_failure"
    | "completed"
    | "conflict";
  entry: QueuedDelivery;
};

export type GaiaSlackSendFenceResult =
  | { status: "acquired"; entry: QueuedDelivery }
  | { status: "owned" | "absent" | "conflict" };

function sameGaiaAcceptedEnvelope(
  left: GaiaAcceptedEnvelope | undefined,
  right: GaiaAcceptedEnvelope,
): boolean {
  return Boolean(
    left &&
    left.runId === right.runId &&
    left.sessionKey === right.sessionKey &&
    left.agentId === right.agentId &&
    left.acceptedAt === right.acceptedAt &&
    left.receiptPluginId === right.receiptPluginId,
  );
}

function buildGaiaKeyedOutputEntry(params: GaiaKeyedOutputDeliveryParams): {
  ownerId: string;
  fingerprint: string;
  entry: QueuedDelivery;
} {
  const accepted = normalizeGaiaAcceptedEnvelope(params.accepted);
  const ownerId = deriveGaiaKeyedOutputOwnerId(accepted.runId);
  const fingerprint = fingerprintGaiaKeyedOutput(params);
  const entry: QueuedDelivery = {
    id: ownerId,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    payloads: [...params.payloads],
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    replyPayloadSendingHook: params.replyPayloadSendingHook,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    gaiaKeyedOutput: { version: GAIA_KEYED_OUTPUT_VERSION, accepted, fingerprint },
    retryCount: 0,
  };
  return { ownerId, fingerprint, entry };
}

/** Atomically admit a Gaia output owner without sending or closing admission. */
export async function admitGaiaKeyedOutput(
  params: GaiaKeyedOutputDeliveryParams,
  stateDir?: string,
): Promise<GaiaKeyedOutputAdmission> {
  const requestedAccepted = normalizeGaiaAcceptedEnvelope(params.accepted);
  return runOpenClawStateWriteTransaction(
    () => {
      const acceptance = loadGaiaAcceptanceEnvelope(requestedAccepted.runId, stateDir);
      if (acceptance.status === "absent") {
        throw new Error("Gaia keyed output requires a matching durable acceptance row.");
      }
      if (acceptance.status === "corrupt") {
        throw new Error("Gaia keyed output found corrupt durable acceptance evidence.");
      }
      if (!sameGaiaAcceptanceTuple(acceptance.accepted, requestedAccepted)) {
        const candidate = buildGaiaKeyedOutputEntry({
          ...params,
          accepted: requestedAccepted,
        });
        return { status: "conflict", ...candidate };
      }
      const candidate = buildGaiaKeyedOutputEntry({
        ...params,
        accepted: acceptance.accepted,
      });
      if (hasGaiaSlackRequestOutputOwnerConflict(acceptance.accepted.runId, stateDir)) {
        return { status: "conflict", ...candidate };
      }
      const inserted = upsertDeliveryQueueEntry({
        queueName: QUEUE_NAME,
        entry: candidate.entry,
        metadata: queuedDeliveryMetadata(candidate.entry),
        stateDir,
        insertOnly: true,
      });
      if (inserted) {
        return { status: "new", ...candidate };
      }
      const stored = loadDeliveryQueueEntryRecord(QUEUE_NAME, candidate.ownerId, stateDir)?.entry;
      if (!stored) {
        throw new Error(
          `Gaia keyed output owner ${candidate.ownerId} disappeared during admission.`,
        );
      }
      const entry = stored as QueuedDelivery;
      return {
        status:
          entry.gaiaKeyedOutput?.version === GAIA_KEYED_OUTPUT_VERSION &&
          sameGaiaAcceptedEnvelope(
            entry.gaiaKeyedOutput.accepted,
            candidate.entry.gaiaKeyedOutput!.accepted,
          ) &&
          entry.gaiaKeyedOutput.fingerprint === candidate.fingerprint
            ? "duplicate"
            : "conflict",
        ownerId: candidate.ownerId,
        fingerprint: candidate.fingerprint,
        entry,
      };
    },
    { env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env },
  );
}

/** Inspect a Gaia owner across pending, failed, and completed queue rows. */
export function inspectGaiaKeyedOutput(
  accepted: GaiaAcceptedEnvelope,
  stateDir?: string,
): GaiaKeyedOutputInspection | null {
  const normalizedAccepted = normalizeGaiaAcceptedEnvelope(accepted);
  const ownerId = deriveGaiaKeyedOutputOwnerId(normalizedAccepted.runId);
  const record = loadDeliveryQueueEntryRecord(QUEUE_NAME, ownerId, stateDir);
  if (!record?.entry) {
    return null;
  }
  const entry = record.entry as QueuedDelivery;
  return {
    ownerId,
    status:
      entry.gaiaKeyedOutput?.version === GAIA_KEYED_OUTPUT_VERSION &&
      sameGaiaAcceptedEnvelope(entry.gaiaKeyedOutput.accepted, normalizedAccepted)
        ? record.status === "failed" && entry.recoveryState === "permanent_pre_send_failure"
          ? "permanent_failure"
          : record.status === "failed" && entry.recoveryState === "ambiguous_failure"
            ? "ambiguous_failure"
            : record.status
        : "conflict",
    entry,
  };
}

/** Atomically claim the one durable Gaia Slack row that may cross the send boundary. */
export function acquireGaiaSlackSendFence(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): GaiaSlackSendFenceResult {
  return runOpenClawStateWriteTransaction(
    () => {
      const record = loadDeliveryQueueEntryRecord(QUEUE_NAME, id, stateDir);
      if (!record) {
        return { status: "absent" };
      }
      if (record.status !== "pending") {
        return { status: "owned" };
      }
      const entry = record.entry as QueuedDelivery | null;
      if (!entry?.gaiaKeyedOutput || entry.channel !== "slack") {
        return { status: "conflict" };
      }
      if (
        entry.platformSendStartedAt !== undefined ||
        entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send"
      ) {
        return { status: "owned" };
      }
      const fencedAt = Date.now();
      const fencedEntry: QueuedDelivery = {
        ...entry,
        platformSendStartedAt: fencedAt,
        ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
        recoveryState: "send_attempt_started",
      };
      const updated = upsertDeliveryQueueEntry({
        queueName: QUEUE_NAME,
        entry: fencedEntry,
        metadata: queuedDeliveryMetadata(fencedEntry),
        stateDir,
        updatePendingOnly: true,
      });
      return updated ? { status: "acquired", entry: fencedEntry } : { status: "owned" };
    },
    { env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env },
  );
}

/** Reopen one failed Gaia owner; the existing recovery path sends the stored row. */
export function resumeGaiaKeyedOutput(
  accepted: GaiaAcceptedEnvelope,
  stateDir?: string,
): GaiaKeyedOutputInspection | null {
  const inspection = inspectGaiaKeyedOutput(accepted, stateDir);
  if (!inspection || inspection.status !== "failed") {
    return inspection;
  }
  upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    // Reset only the generic pre-send retry budget. Owner identity and all
    // send/reconciliation evidence remain durable across the resume.
    entry: { ...inspection.entry, retryCount: 0 },
    metadata: queuedDeliveryMetadata(inspection.entry),
    status: "pending",
    stateDir,
    reviveFailedOrCorruptPending: true,
  });
  return inspectGaiaKeyedOutput(accepted, stateDir);
}

// Durable Gaia host-acceptance checkpoint. One completed row per accepted run
// in the shared delivery-queue table under a dedicated queue name. The store
// has no count eviction, and the per-queue completed sweep never runs for this
// queue, so acceptance authority outlives every Gaia admission retention
// window and survives process restarts.
export const GAIA_ACCEPTANCE_VERSION = "gaia-slack-acceptance-v1" as const;
const GAIA_ACCEPTANCE_QUEUE = "gaia-acceptance";

type GaiaAcceptanceEntry = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  gaiaAcceptance: GaiaAcceptedEnvelope;
};

export type GaiaAcceptanceSelector = Readonly<{
  runId: string;
  sessionKey: string;
  agentId: string;
  receiptPluginId: "gaia-workflow-preflight";
}>;

export type GaiaAcceptanceAdmission =
  | { status: "accepted"; accepted: GaiaAcceptedEnvelope }
  | { status: "conflict"; reason: string };

export type GaiaAcceptanceRecovery =
  | { status: "found"; accepted: GaiaAcceptedEnvelope }
  | { status: "absent" }
  | { status: "corrupt" }
  | { status: "mismatch" };

/** Derive the stable acceptance row ID, domain-separated from the owner ID. */
export function deriveGaiaAcceptanceId(runId: string): string {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    throw new Error("Gaia acceptance derivation requires an accepted run identity.");
  }
  return createHash("sha256")
    .update(`${GAIA_ACCEPTANCE_VERSION}\0${normalizedRunId}`, "utf8")
    .digest("hex");
}

type GaiaAcceptanceLookup =
  | { status: "found"; accepted: GaiaAcceptedEnvelope }
  | { status: "absent" }
  | { status: "corrupt" };

function loadGaiaAcceptanceEnvelope(runId: string, stateDir?: string): GaiaAcceptanceLookup {
  const record = loadDeliveryQueueEntryRecord(
    GAIA_ACCEPTANCE_QUEUE,
    deriveGaiaAcceptanceId(runId),
    stateDir,
  );
  if (!record) {
    return { status: "absent" };
  }
  if (record.status !== "completed" || !record.entry) {
    return { status: "corrupt" };
  }
  const stored = (record.entry as GaiaAcceptanceEntry).gaiaAcceptance;
  if (!stored) {
    return { status: "corrupt" };
  }
  try {
    return { status: "found", accepted: normalizeGaiaAcceptedEnvelope(stored) };
  } catch {
    return { status: "corrupt" };
  }
}

function sameGaiaAcceptanceTuple(
  left: GaiaAcceptedEnvelope,
  right: Omit<GaiaAcceptedEnvelope, "acceptedAt">,
): boolean {
  return (
    left.runId === right.runId &&
    left.sessionKey === right.sessionKey &&
    left.agentId === right.agentId &&
    left.receiptPluginId === right.receiptPluginId
  );
}

/**
 * Commit the durable host acceptance for one Gaia-owned run before the host
 * reports acceptance. Identical-tuple re-acceptance refreshes `acceptedAt` so
 * a crash-window re-dispatch converges; the refresh is refused once a keyed
 * output owner exists because execution identity is frozen at that point.
 */
export function admitGaiaAcceptance(
  accepted: GaiaAcceptedEnvelope,
  stateDir?: string,
): GaiaAcceptanceAdmission {
  const envelope = normalizeGaiaAcceptedEnvelope(accepted);
  const id = deriveGaiaAcceptanceId(envelope.runId);
  return runOpenClawStateWriteTransaction(
    () => {
      const entry: GaiaAcceptanceEntry = {
        id,
        enqueuedAt: envelope.acceptedAt,
        retryCount: 0,
        gaiaAcceptance: envelope,
      };
      const inserted = upsertDeliveryQueueEntry({
        queueName: GAIA_ACCEPTANCE_QUEUE,
        entry,
        metadata: { entryKind: GAIA_ACCEPTANCE_VERSION, sessionKey: envelope.sessionKey },
        status: "completed",
        stateDir,
        insertOnly: true,
      });
      if (inserted) {
        return { status: "accepted", accepted: envelope };
      }
      const stored = loadGaiaAcceptanceEnvelope(envelope.runId, stateDir);
      if (stored.status === "corrupt") {
        return {
          status: "conflict",
          reason: "a durable acceptance exists for this run but its evidence is corrupt",
        };
      }
      if (stored.status !== "found" || !sameGaiaAcceptanceTuple(stored.accepted, envelope)) {
        return {
          status: "conflict",
          reason: "a durable acceptance exists for this run with a different identity tuple",
        };
      }
      const outputOwner = loadDeliveryQueueEntryRecord(
        QUEUE_NAME,
        deriveGaiaKeyedOutputOwnerId(envelope.runId),
        stateDir,
      );
      if (outputOwner) {
        return {
          status: "conflict",
          reason: "a keyed output owner already exists for this run; acceptance is frozen",
        };
      }
      upsertDeliveryQueueEntry({
        queueName: GAIA_ACCEPTANCE_QUEUE,
        entry,
        metadata: { entryKind: GAIA_ACCEPTANCE_VERSION, sessionKey: envelope.sessionKey },
        status: "completed",
        stateDir,
      });
      return { status: "accepted", accepted: envelope };
    },
    { env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env },
  );
}

/** Read the exact durable host acceptance for one full recovery selector. */
export function recoverGaiaAcceptance(
  selector: GaiaAcceptanceSelector,
  stateDir?: string,
): GaiaAcceptanceRecovery {
  const runId = typeof selector?.runId === "string" ? selector.runId.trim() : "";
  const sessionKey = typeof selector?.sessionKey === "string" ? selector.sessionKey.trim() : "";
  const agentId =
    typeof selector?.agentId === "string" ? selector.agentId.trim().toLowerCase() : "";
  if (
    !runId ||
    !sessionKey ||
    !agentId ||
    selector?.receiptPluginId !== "gaia-workflow-preflight"
  ) {
    throw new Error("Gaia acceptance recovery requires the complete durable selector.");
  }
  const stored = loadGaiaAcceptanceEnvelope(runId, stateDir);
  if (stored.status === "absent") {
    return { status: "absent" };
  }
  if (stored.status === "corrupt") {
    return { status: "corrupt" };
  }
  if (
    !sameGaiaAcceptanceTuple(stored.accepted, {
      runId,
      sessionKey,
      agentId,
      receiptPluginId: "gaia-workflow-preflight",
    })
  ) {
    return { status: "mismatch" };
  }
  return { status: "found", accepted: stored.accepted };
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
  }));
}

/** Record a failed attempt whose retry provably cannot duplicate a recipient-visible send. */
export async function failDeliveryBeforePlatformSend(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    // Clear both fields together; retaining either would preserve false send evidence.
    platformSendStartedAt: undefined,
    recoveryState: undefined,
  }));
}

/** Record a failed attempt without losing evidence that platform delivery may have completed. */
export async function failDeliveryAfterPlatformSend(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    recoveryState: "unknown_after_send",
  }));
}

/** Keep a Gaia readback gap pending without consuming the generic send retry budget. */
export async function recordGaiaReadbackGap(
  id: string,
  error: string,
  stateDir?: string,
  options: { terminal?: boolean } = {},
): Promise<"pending" | "failed" | "not_pending"> {
  return runOpenClawStateWriteTransaction(
    () => {
      const record = loadDeliveryQueueEntryRecord(QUEUE_NAME, id, stateDir);
      if (!record || record.status !== "pending" || !record.entry) {
        return "not_pending";
      }
      const entry = record.entry as QueuedDelivery;
      const updatedEntry: QueuedDelivery = {
        ...entry,
        reconciliationAttemptCount: (entry.reconciliationAttemptCount ?? 0) + 1,
        lastAttemptAt: Date.now(),
        lastError: error,
        platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
        recoveryState: options.terminal ? "ambiguous_failure" : "unknown_after_send",
      };
      if (options.terminal) {
        return failPendingDeliveryQueueEntry({
          queueName: QUEUE_NAME,
          id,
          expectedStatus: "pending",
          lastError: error,
          entry: updatedEntry,
          recoveryState: "ambiguous_failure",
          stateDir,
        }).status;
      }
      upsertDeliveryQueueEntry({
        queueName: QUEUE_NAME,
        entry: updatedEntry,
        metadata: queuedDeliveryMetadata(updatedEntry),
        stateDir,
        updatePendingOnly: true,
      });
      return "pending";
    },
    { env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env },
  );
}

/** Keep a known permanent error across process-style reconciliation retries. */
export async function recordPendingPermanentDeliveryError(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    pendingPermanentError: entry.pendingPermanentError ?? error,
  }));
}

function updateQueuedDelivery(
  id: string,
  stateDir: string | undefined,
  update: (entry: QueuedDelivery) => QueuedDelivery,
): void {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => update(entry as QueuedDelivery));
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
  }));
}

/** Refresh the attempt timestamp before recipient-visible or finalizing platform I/O. */
export async function markDeliveryPlatformSendDispatched(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
  }));
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    recoveryState: "unknown_after_send",
  }));
}

/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir) as QueuedDelivery | null;
}

/** Load all pending delivery entries from the queue. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(QUEUE_NAME, stateDir) as QueuedDelivery[];
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  moveDeliveryQueueEntryToFailed(QUEUE_NAME, id, stateDir);
}

type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    expectedStatus: "pending";
    lastError: string;
    entry: QueuedDelivery;
  },
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  return failPendingDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    ...params,
    stateDir,
  });
}

/** Atomically terminalize a Gaia owner rejected before any platform send. */
export async function failPendingGaiaKeyedOutput(
  entry: QueuedDelivery,
  lastError: string,
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  if (!entry.gaiaKeyedOutput) {
    throw new Error("Permanent pre-send failure requires a Gaia keyed output owner.");
  }
  return failPendingDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    id: entry.id,
    expectedStatus: "pending",
    lastError,
    entry,
    recoveryState: "permanent_pre_send_failure",
    stateDir,
  });
}
