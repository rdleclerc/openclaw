// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { listCurrentSessionKeysBySessionId, listSessionEntries } from "./session-accessor.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

// Template-backed stores need per-agent scans before they can be merged for Gateway views.
function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function loadGatewayStoreEntries(params: {
  agentId: string;
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({
      agentId: params.agentId,
      clone: false,
      storePath: params.storePath,
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function resolveGatewaySessionStoreTargets(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean },
): SessionStoreTarget[] {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    return [
      {
        agentId: normalizeAgentId(resolveDefaultAgentId(cfg)),
        storePath: resolveStorePath(storeConfig),
      },
    ];
  }
  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  return requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
}

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    // Preserve the freshest entry while still canonicalizing spawnedBy for this agent store.
    const spawnedBy = canonicalizeSpawnedByForAgent(
      cfg,
      agentId,
      existing.spawnedBy ?? entry.spawnedBy,
    );
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy,
    };
    return;
  }

  const spawnedBy = canonicalizeSpawnedByForAgent(
    cfg,
    agentId,
    entry.spawnedBy ?? existing?.spawnedBy,
  );
  if (!existing && entry.spawnedBy === spawnedBy) {
    combined[canonicalKey] = entry;
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy,
    };
  }
}

/** Loads and canonicalizes session entries for gateway views across one or more agent stores. */
export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean } = {},
): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  const targets = resolveGatewaySessionStoreTargets(cfg, opts);
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadGatewayStoreEntries({ agentId, storePath });
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const storePath =
    targets.length === 1
      ? expectDefined(targets[0], "targets entry at 0").storePath
      : typeof storeConfig === "string" && storeConfig.trim()
        ? storeConfig.trim()
        : "(multiple)";
  return { storePath, store: combined };
}

/**
 * Resolves current canonical session keys for one transcript identity using
 * indexed point reads instead of loading every session entry.
 */
export function resolveCurrentSessionKeysBySessionIdForGateway(
  cfg: OpenClawConfig,
  params: { agentId: string; sessionId: string },
): string[] {
  const keys = new Set<string>();
  for (const target of resolveGatewaySessionStoreTargets(cfg, { agentId: params.agentId })) {
    for (const sessionKey of listCurrentSessionKeysBySessionId({
      agentId: target.agentId,
      sessionId: params.sessionId,
      storePath: target.storePath,
    })) {
      keys.add(
        resolveStoredSessionKeyForAgentStore({
          cfg,
          agentId: target.agentId,
          sessionKey,
        }),
      );
    }
  }
  return [...keys];
}
