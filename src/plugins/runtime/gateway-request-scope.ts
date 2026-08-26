// Gateway request scope tracks request-local plugin runtime context across async work.
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginOrigin } from "../plugin-origin.types.js";

type PluginRuntimeGatewayRequestScope = {
  context?: GatewayRequestContext;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
};

type GaiaAcceptedEnvelopeStore = {
  value?: GaiaHostAcceptedEnvelope;
  recoveredValue?: GaiaHostAcceptedEnvelope;
};

export type GaiaHostAcceptedEnvelope = Readonly<{
  runId: string;
  sessionKey: string;
  agentId: string;
  acceptedAt: number;
  receiptPluginId: "gaia-workflow-preflight";
}>;

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);

const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRuntimeGatewayRequestScope>
>(
  PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>(),
);

const GAIA_ACCEPTED_ENVELOPE_STORE_KEY: unique symbol = Symbol.for(
  "openclaw.gaiaAcceptedEnvelopeStore",
);

const gaiaAcceptedEnvelopeStore = resolveGlobalSingleton<
  AsyncLocalStorage<GaiaAcceptedEnvelopeStore>
>(GAIA_ACCEPTED_ENVELOPE_STORE_KEY, () => new AsyncLocalStorage<GaiaAcceptedEnvelopeStore>());

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const requestScope: PluginRuntimeGatewayRequestScope =
    current?.pluginId && scope.pluginId === undefined
      ? { ...scope, pluginId: current.pluginId }
      : scope;
  // A gateway request is a new authority boundary. Preserve the caller's
  // plugin identity, but never carry a prior request's accepted envelope into it.
  return pluginRuntimeGatewayRequestScope.run(requestScope, () =>
    gaiaAcceptedEnvelopeStore.run({}, run),
  );
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginScope<T>(scope: PluginRuntimePluginScope, run: () => T): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = current
    ? { ...current, pluginId: scope.pluginId }
    : {
        pluginId: scope.pluginId,
        isWebchatConnect: () => false,
      };
  if (scope.pluginSource !== undefined) {
    scoped.pluginSource = scope.pluginSource;
  } else {
    delete scoped.pluginSource;
  }
  if (scope.pluginOrigin !== undefined) {
    scoped.pluginOrigin = scope.pluginOrigin;
  } else {
    delete scoped.pluginOrigin;
  }
  if (scope.pluginTrustedOfficialInstall !== undefined) {
    scoped.pluginTrustedOfficialInstall = scope.pluginTrustedOfficialInstall;
  } else {
    delete scoped.pluginTrustedOfficialInstall;
  }
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginIdScope<T>(pluginId: string, run: () => T): T {
  return withPluginRuntimePluginScope({ pluginId }, run);
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}

/** Bind the host-accepted Gaia envelope to the current gateway request only. */
export function bindGaiaAcceptedEnvelope(envelope: GaiaHostAcceptedEnvelope): void {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.context) {
    throw new Error("Gaia host acceptance requires a gateway request scope.");
  }
  if (scope.pluginId !== "gaia-workflow-preflight") {
    throw new Error(
      "Gaia host acceptance requires the exact gaia-workflow-preflight plugin scope.",
    );
  }
  const normalized = normalizeGaiaAcceptedEnvelope(envelope);
  const stored = gaiaAcceptedEnvelopeStore.getStore();
  if (!stored) {
    throw new Error("Gaia host acceptance requires a gateway request scope.");
  }
  const current = stored.value;
  if (current) {
    if (!sameGaiaAcceptedEnvelope(current, normalized)) {
      throw new Error("Gaia host acceptance envelope cannot be replaced.");
    }
    return;
  }
  stored.value = normalized;
}

/**
 * Binds the original accepted owner for a host recovery request. Recovery is
 * a host boundary, so plugin-scoped callers cannot mint this authority.
 */
export function bindGaiaRecoveredAcceptedEnvelope(envelope: GaiaHostAcceptedEnvelope): void {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.context) {
    throw new Error("Gaia recovered acceptance requires a gateway request scope.");
  }
  if (scope.pluginId !== undefined || scope.client?.internal?.pluginRuntimeOwnerId !== undefined) {
    throw new Error("Gaia recovered acceptance requires a host gateway request scope.");
  }
  const normalized = normalizeGaiaAcceptedEnvelope(envelope);
  const stored = gaiaAcceptedEnvelopeStore.getStore();
  if (!stored) {
    throw new Error("Gaia recovered acceptance requires a gateway request scope.");
  }
  if (stored.value && !sameGaiaAcceptedEnvelope(stored.value, normalized)) {
    throw new Error("Gaia recovered acceptance cannot replace normal acceptance.");
  }
  const current = stored.recoveredValue;
  if (current && !sameGaiaAcceptedEnvelope(current, normalized)) {
    throw new Error("Gaia recovered acceptance envelope cannot be replaced.");
  }
  stored.recoveredValue = normalized;
}

function normalizeGaiaAcceptedEnvelope(
  envelope: GaiaHostAcceptedEnvelope,
): GaiaHostAcceptedEnvelope {
  if (
    !envelope.runId.trim() ||
    !envelope.sessionKey.trim() ||
    !envelope.agentId.trim() ||
    !Number.isSafeInteger(envelope.acceptedAt) ||
    envelope.acceptedAt <= 0 ||
    envelope.receiptPluginId !== "gaia-workflow-preflight"
  ) {
    throw new Error("Gaia host acceptance envelope is invalid.");
  }
  return Object.freeze({
    runId: envelope.runId.trim(),
    sessionKey: envelope.sessionKey.trim(),
    agentId: envelope.agentId.trim().toLowerCase(),
    acceptedAt: envelope.acceptedAt,
    receiptPluginId: "gaia-workflow-preflight",
  });
}

function sameGaiaAcceptedEnvelope(
  left: GaiaHostAcceptedEnvelope,
  right: GaiaHostAcceptedEnvelope,
): boolean {
  return (
    left.runId === right.runId &&
    left.sessionKey === right.sessionKey &&
    left.agentId === right.agentId &&
    left.acceptedAt === right.acceptedAt &&
    left.receiptPluginId === right.receiptPluginId
  );
}

/** Read the exact host-accepted Gaia envelope from the current Gaia request. */
export function readGaiaAcceptedEnvelope(): GaiaHostAcceptedEnvelope | undefined {
  return gaiaAcceptedEnvelopeStore.getStore()?.value;
}

/** Read the exact original owner bound by the host recovery path. */
export function readGaiaRecoveredAcceptedEnvelope(): GaiaHostAcceptedEnvelope | undefined {
  return gaiaAcceptedEnvelopeStore.getStore()?.recoveredValue;
}

/**
 * Requires the exact Gaia workflow preflight plugin and gateway request scopes.
 * Caller-supplied run IDs are not authority; the full accepted envelope remains required.
 */
export function assertGaiaWorkflowPreflightPluginScope(): void {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (scope?.pluginId !== "gaia-workflow-preflight") {
    throw new Error("Gaia keyed output requires the exact gaia-workflow-preflight plugin scope.");
  }
}
