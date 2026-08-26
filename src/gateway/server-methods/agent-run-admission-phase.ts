import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
} from "../../agents/embedded-agent-runner/runs.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveStateDir } from "../../config/paths.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-events.js";
import {
  admitGaiaAcceptance as admitGaiaAcceptanceToStore,
  recoverGaiaAcceptance,
  type GaiaAcceptedEnvelope,
} from "../../infra/outbound/delivery-queue-storage.js";
import {
  bindGaiaAcceptedEnvelope,
  bindGaiaRecoveredAcceptedEnvelope,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { registerChatAbortController, resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  isConfirmedAcpManualSpawnTaskOwner,
  registerPluginSubagentRunFromGateway,
  resolveGatewayAgentTaskTrackingMode,
  type GatewayAgentTaskTrackingMode,
} from "./agent-task-tracking.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type PreparedAgentRunDispatch = {
  activeGatewayWorkAdmission: SessionWorkAdmissionLease;
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  effectiveProviderOverride?: string;
  effectiveModelOverride?: string;
  effectiveThinking?: string;
  effectiveAllowModelOverride: boolean;
  restoredCronContinuationLifecycleRevision?: string;
  lifecycleStorePath: string;
  resolvedThreadId?: string | number;
  dispatchTaskTrackingMode: Exclude<GatewayAgentTaskTrackingMode, "plugin_subagent">;
};

export type AgentRunAcceptedResponse = {
  runId: string;
  sessionKey?: string;
  status: "accepted";
  acceptedAt: number;
  agentId?: string;
  receiptPluginId?: "gaia-workflow-preflight";
};

/** Build the host-owned acceptance shape before it is sent or cached. */
export function buildAgentRunAcceptedResponse(params: {
  runId: string;
  resolvedSessionKey?: string;
  activeSessionAgentId: string;
  acceptedAt: number;
  gaiaWorkflowPreflight: boolean;
  admissionAgentId?: string;
}): AgentRunAcceptedResponse {
  const accepted: AgentRunAcceptedResponse = {
    runId: params.runId,
    sessionKey: params.resolvedSessionKey,
    ...(params.resolvedSessionKey === "global" ? { agentId: params.activeSessionAgentId } : {}),
    status: "accepted",
    acceptedAt: params.acceptedAt,
  };
  if (
    params.gaiaWorkflowPreflight &&
    params.resolvedSessionKey &&
    params.resolvedSessionKey !== "global"
  ) {
    return {
      ...accepted,
      agentId: normalizeAgentId(params.admissionAgentId ?? params.activeSessionAgentId),
      receiptPluginId: "gaia-workflow-preflight",
    };
  }
  return accepted;
}

function resolveGaiaRecoveryAcceptedEnvelope(params: {
  request: AgentRunRequest;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  activeSessionAgentId: string;
  admissionAgentId?: string;
  client: GatewayRequestHandlerOptions["client"];
  stateDir?: string;
}): GaiaAcceptedEnvelope | undefined {
  const sessionEntry = params.sessionEntry;
  const recoveryRunId = normalizeOptionalString(sessionEntry?.restartRecoveryDeliveryRunId);
  const sourceRunId = normalizeOptionalString(sessionEntry?.restartRecoveryDeliverySourceRunId);
  const expectedSessionId = normalizeOptionalString(params.request.expectedExistingSessionId);
  const sessionKey = normalizeOptionalString(params.resolvedSessionKey);
  if (!sourceRunId || !sessionKey) {
    return undefined;
  }

  const selector = {
    runId: sourceRunId,
    sessionKey,
    agentId: normalizeAgentId(params.admissionAgentId ?? params.activeSessionAgentId),
    receiptPluginId: "gaia-workflow-preflight" as const,
  };
  const recovered = recoverGaiaAcceptance(selector, params.stateDir ?? resolveStateDir());
  if (recovered.status === "absent") {
    return undefined;
  }
  if (recovered.status === "corrupt") {
    throw new Error("Gaia recovery found corrupt durable acceptance evidence.");
  }
  if (recovered.status === "mismatch") {
    throw new Error("Gaia recovery owner does not match durable acceptance evidence.");
  }

  if (
    !sessionEntry ||
    !recoveryRunId ||
    recoveryRunId !== params.request.idempotencyKey.trim() ||
    !expectedSessionId ||
    expectedSessionId !== sessionEntry.sessionId ||
    sessionEntry.status !== "running" ||
    sessionEntry.abortedLastRun !== true
  ) {
    throw new Error("Gaia recovery claim does not match the durable recovery state.");
  }

  const scope = getPluginRuntimeGatewayRequestScope();
  const clientPluginId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId);
  if (scope?.pluginId !== undefined || clientPluginId !== undefined) {
    throw new Error("Gaia recovered acceptance requires a host gateway request scope.");
  }
  return recovered.accepted;
}

function compensateGaiaAdmission(params: {
  context: GatewayRequestHandlerOptions["context"];
  runId: string;
  sessionKey: string;
  lifecycleGeneration: string;
  activeGatewayWorkAdmission: SessionWorkAdmissionLease;
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  chatRunRegistered: boolean;
  runContextClaimed: boolean;
  dedupeKeys: readonly string[];
}): void {
  if (params.activeRunAbort.registered) {
    params.activeRunAbort.controller.abort();
    params.activeRunAbort.cleanup({ force: true });
  }
  if (params.chatRunRegistered) {
    params.context.clearChatRunState(params.runId);
    params.context.removeChatRun(params.runId, params.runId, params.sessionKey);
  }
  if (params.runContextClaimed) {
    clearAgentRunContext(params.runId, params.lifecycleGeneration);
  }
  params.activeGatewayWorkAdmission.release();
  for (const key of params.dedupeKeys) {
    params.context.dedupe.delete(key);
  }
}

export async function prepareAgentRunDispatch(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKey?: string;
  preAcceptedReservedSessionKey?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  restoredCronContinuation?: RestoredCronContinuation;
  providerOverride?: string;
  modelOverride?: string;
  allowModelOverride: boolean;
  lifecycleGeneration: string;
  getAdmittedSessionId: () => string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  suppressVisibleSessionEffects: boolean;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  inputProvenance?: InputProvenance;
  isOneShotModelRun: boolean;
  runId: string;
  agentDedupeKeys: readonly string[];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  respond: GatewayRequestHandlerOptions["respond"];
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  acquireGatewayWorkAdmission: (scope: string) => Promise<void>;
  assertGatewayWorkAdmissionAllowed: () => void;
  hasGatewayAdmissionOutcome: () => boolean;
  respondToGatewayAdmissionOutcome: () => boolean;
  admissionAgentId: () => string | undefined;
  getGatewayWorkAdmission: () => SessionWorkAdmissionLease | undefined;
  setAdmittedRunAbort: (value: ReturnType<typeof registerChatAbortController>) => void;
  getAdmittedRunAbort: () => ReturnType<typeof registerChatAbortController> | undefined;
  markAgentRunAccepted: (accepted: boolean) => void;
  gaiaAcceptanceStateDir?: string;
  admitGaiaAcceptance?: typeof admitGaiaAcceptanceToStore;
  registerPluginSubagentRun?: typeof registerPluginSubagentRunFromGateway;
}): Promise<PreparedAgentRunDispatch | undefined> {
  const preRegistrationAbort = readGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    keys: params.agentDedupeKeys,
  });
  if (
    isPreRegistrationAbortedAgentDedupeEntryForSession({
      entry: preRegistrationAbort,
      runId: params.runId,
      sessionKey: params.resolvedSessionKey,
      alternateSessionKeys: [params.preAcceptedReservedSessionKey, params.requestedSessionKey],
    })
  ) {
    params.markAgentRunAccepted(true);
    params.respond(true, preRegistrationAbort?.payload, undefined, {
      cached: true,
      runId: params.runId,
    });
    return undefined;
  }
  if (
    params.abortForLifecycleRotation({
      sessionKey: params.resolvedSessionKey,
      agentId: params.resolvedSessionKey === "global" ? params.activeSessionAgentId : undefined,
    })
  ) {
    return undefined;
  }
  if (params.restoredCronContinuationIdentity && !params.restoredCronContinuation) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation could not be restored"),
    );
    return undefined;
  }

  const now = Date.now();
  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfgForAgent ?? params.cfg,
    overrideSeconds:
      typeof params.request.timeout === "number" ? params.request.timeout : undefined,
  });
  const effectiveProviderOverride =
    params.restoredCronContinuation?.provider ?? params.providerOverride;
  const effectiveModelOverride = params.restoredCronContinuation?.model ?? params.modelOverride;
  const effectiveThinking = params.restoredCronContinuation
    ? params.restoredCronContinuation.thinking
    : params.request.thinking;
  const effectiveAllowModelOverride =
    params.allowModelOverride || params.restoredCronContinuation !== undefined;
  const activeModelProvider =
    effectiveProviderOverride ??
    resolveSessionModelRef(
      params.cfgForAgent ?? params.cfg,
      params.sessionEntry,
      params.activeSessionAgentId,
    ).provider;
  const lifecycleStorePath = params.resolvedSessionKey
    ? loadSessionEntry(params.resolvedSessionKey, {
        ...(params.activeSessionAgentId ? { agentId: params.activeSessionAgentId } : {}),
        clone: false,
      }).storePath
    : `agent:${params.activeSessionAgentId}`;
  try {
    await params.acquireGatewayWorkAdmission(lifecycleStorePath);
    params.assertGatewayWorkAdmissionAllowed();
    if (!params.hasGatewayAdmissionOutcome()) {
      params.setAdmittedRunAbort(
        registerChatAbortController({
          chatAbortControllers: params.context.chatAbortControllers,
          runId: params.runId,
          // Revalidation above may adopt a rotated session id while admission waits.
          sessionId: params.getAdmittedSessionId(),
          sessionKey: params.resolvedSessionKey,
          agentId: params.admissionAgentId(),
          timeoutMs,
          now,
          expiresAtMs: resolveAgentRunExpiresAtMs({ now, timeoutMs }),
          ownerConnId: params.ownerConnId,
          ownerDeviceId: params.ownerDeviceId,
          providerId: activeModelProvider,
          authProviderId: resolveProviderIdForAuth(activeModelProvider, {
            config: params.cfgForAgent ?? params.cfg,
          }),
          isAbortable: () => isEmbeddedAgentRunAbortableForRunId(params.runId),
          onRemoved: () =>
            clearEmbeddedAgentRunAbortabilityForRunId(params.runId, params.lifecycleGeneration),
          controlUiVisible: !params.suppressVisibleSessionEffects,
          kind: "agent",
          lifecycleGeneration: params.lifecycleGeneration,
        }),
      );
    }
  } catch (err) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    return undefined;
  }
  if (params.respondToGatewayAdmissionOutcome()) {
    return undefined;
  }
  const activeGatewayWorkAdmission = params.getGatewayWorkAdmission();
  if (!activeGatewayWorkAdmission) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    );
    return undefined;
  }
  const activeRunAbort = params.getAdmittedRunAbort();
  if (!activeRunAbort) {
    activeGatewayWorkAdmission.release();
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    );
    return undefined;
  }
  let chatRunRegistered = false;
  let runContextClaimed = false;
  const existingRunAbort = params.context.chatAbortControllers.get(params.runId);
  if (!activeRunAbort.registered && existingRunAbort) {
    activeGatewayWorkAdmission.release();
    params.markAgentRunAccepted(existingRunAbort.kind === "agent");
    params.respond(true, { runId: params.runId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: params.runId,
    });
    return undefined;
  }
  if (!activeRunAbort.registered) {
    activeGatewayWorkAdmission.release();
  } else {
    retainEmbeddedAgentRunAbortabilityForRunId(params.runId);
    if (params.pendingChatRun) {
      params.context.addChatRun(params.runId, {
        ...params.pendingChatRun,
        clientRunId: params.runId,
      });
      chatRunRegistered = true;
    }
    if (params.resolvedSessionKey) {
      claimAgentRunContext(
        params.runId,
        params.suppressVisibleSessionEffects
          ? { isControlUiVisible: false, lifecycleGeneration: params.lifecycleGeneration }
          : {
              sessionKey: params.resolvedSessionKey,
              lifecycleGeneration: params.lifecycleGeneration,
            },
      );
      runContextClaimed = true;
    }
  }

  const resolvedThreadId =
    params.delivery.explicitThreadId ?? params.delivery.deliveryPlan.resolvedThreadId;
  const requestPluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
  const clientPluginId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId);
  const gaiaWorkflowPreflight =
    requestPluginId === "gaia-workflow-preflight" &&
    (clientPluginId === undefined || clientPluginId === "gaia-workflow-preflight");
  const admissionAgentId = params.admissionAgentId();
  const gaiaSessionKey = normalizeOptionalString(params.resolvedSessionKey);
  const gaiaAcceptedEnvelope: GaiaAcceptedEnvelope | undefined =
    gaiaWorkflowPreflight && gaiaSessionKey && gaiaSessionKey !== "global"
      ? {
          runId: params.runId.trim(),
          sessionKey: gaiaSessionKey,
          agentId: normalizeAgentId(admissionAgentId ?? params.activeSessionAgentId),
          acceptedAt: Date.now(),
          receiptPluginId: "gaia-workflow-preflight",
        }
      : undefined;
  try {
    const recoveredAcceptedEnvelope = resolveGaiaRecoveryAcceptedEnvelope({
      request: params.request,
      sessionEntry: params.sessionEntry,
      resolvedSessionKey: params.resolvedSessionKey,
      activeSessionAgentId: params.activeSessionAgentId,
      admissionAgentId,
      client: params.client,
      stateDir: params.gaiaAcceptanceStateDir,
    });
    if (recoveredAcceptedEnvelope) {
      bindGaiaRecoveredAcceptedEnvelope(recoveredAcceptedEnvelope);
    }
  } catch (err) {
    compensateGaiaAdmission({
      context: params.context,
      runId: params.runId,
      sessionKey: params.resolvedSessionKey ?? params.request.sessionKey ?? "",
      lifecycleGeneration: params.lifecycleGeneration,
      activeGatewayWorkAdmission,
      activeRunAbort,
      chatRunRegistered,
      runContextClaimed,
      dedupeKeys: params.agentDedupeKeys,
    });
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    return undefined;
  }
  const taskTrackingMode = resolveGatewayAgentTaskTrackingMode({
    client: params.client,
    sessionKey: params.resolvedSessionKey,
    inputProvenance: params.inputProvenance,
    confirmedAcpManualSpawn: isConfirmedAcpManualSpawnTaskOwner({
      acpTurnSource: params.request.acpTurnSource,
      sessionKey: params.resolvedSessionKey,
      client: params.client,
      logGateway: params.context.logGateway,
    }),
    modelRun: params.isOneShotModelRun,
  });
  let dispatchTaskTrackingMode: PreparedAgentRunDispatch["dispatchTaskTrackingMode"] =
    taskTrackingMode === "cli" ? "cli" : "none";
  const registerPluginSubagentRun = async () => {
    try {
      await (params.registerPluginSubagentRun ?? registerPluginSubagentRunFromGateway)({
        cfg: params.cfg,
        runId: params.runId,
        childSessionKey: params.resolvedSessionKey ?? "",
        task: params.request.message.trim(),
        requesterOrigin: normalizeDeliveryContext({
          channel: params.delivery.resolvedChannel,
          to: params.delivery.resolvedTo,
          accountId: params.delivery.resolvedAccountId,
          threadId: resolvedThreadId,
        }),
        pluginId: normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId),
      });
    } catch (err) {
      if (gaiaAcceptedEnvelope) {
        throw err;
      }
      params.context.logGateway.warn(
        `failed to register plugin subagent run ${params.runId}; falling back to cli task tracking: ${formatForLog(err)}`,
      );
      dispatchTaskTrackingMode = "cli";
    }
  };
  // Gaia subagent rows are authority, so create them only after durable acceptance.
  if (
    taskTrackingMode === "plugin_subagent" &&
    params.resolvedSessionKey &&
    !gaiaAcceptedEnvelope
  ) {
    await registerPluginSubagentRun();
  }
  let accepted: AgentRunAcceptedResponse;
  if (gaiaAcceptedEnvelope) {
    try {
      const admission = (params.admitGaiaAcceptance ?? admitGaiaAcceptanceToStore)(
        gaiaAcceptedEnvelope,
        params.gaiaAcceptanceStateDir ?? resolveStateDir(),
      );
      if (admission.status === "conflict") {
        throw new Error(admission.reason);
      }
      bindGaiaAcceptedEnvelope(admission.accepted);
      if (taskTrackingMode === "plugin_subagent" && params.resolvedSessionKey) {
        await registerPluginSubagentRun();
      }
      accepted = buildAgentRunAcceptedResponse({
        runId: admission.accepted.runId,
        resolvedSessionKey: admission.accepted.sessionKey,
        activeSessionAgentId: params.activeSessionAgentId,
        acceptedAt: admission.accepted.acceptedAt,
        gaiaWorkflowPreflight: true,
        admissionAgentId: admission.accepted.agentId,
      });
    } catch (err) {
      compensateGaiaAdmission({
        context: params.context,
        runId: params.runId,
        sessionKey: params.resolvedSessionKey ?? gaiaAcceptedEnvelope.sessionKey,
        lifecycleGeneration: params.lifecycleGeneration,
        activeGatewayWorkAdmission,
        activeRunAbort,
        chatRunRegistered,
        runContextClaimed,
        dedupeKeys: params.agentDedupeKeys,
      });
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return undefined;
    }
  } else {
    const acceptedAt = Date.now();
    accepted = buildAgentRunAcceptedResponse({
      runId: params.runId,
      resolvedSessionKey: params.resolvedSessionKey,
      activeSessionAgentId: params.activeSessionAgentId,
      acceptedAt,
      gaiaWorkflowPreflight,
      admissionAgentId,
    });
  }
  params.markAgentRunAccepted(true);
  setGatewayDedupeEntries({
    dedupe: params.context.dedupe,
    keys: params.agentDedupeKeys,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: {
        ...accepted,
        controlUiVisible: !params.suppressVisibleSessionEffects,
        dedupeKeys: params.agentDedupeKeys,
        ownerConnId: params.ownerConnId,
        ownerDeviceId: params.ownerDeviceId,
      },
    },
  });
  params.respond(true, accepted, undefined, { runId: params.runId });
  return {
    activeGatewayWorkAdmission,
    activeRunAbort,
    effectiveProviderOverride,
    effectiveModelOverride,
    effectiveThinking,
    effectiveAllowModelOverride,
    restoredCronContinuationLifecycleRevision: params.restoredCronContinuation?.lifecycleRevision,
    lifecycleStorePath,
    resolvedThreadId,
    dispatchTaskTrackingMode,
  };
}
