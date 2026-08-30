import type { DatabaseSync } from "node:sqlite";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

/** Canonical source versions whose newly introduced state must be empty first. */
export type OpenClawStateSchemaSourceVersion = 3 | 4 | 5 | 6;

const PRE_V6_ADDITIVE_TABLES = [
  "apns_registration_tombstones",
  "mcp_oauth_stores",
  "onboarding_recommendations",
  "workspace_attestations",
  "workspace_generated_bootstrap_hashes",
  "workspace_path_aliases",
  "worktree_provisioned_file_chunks",
] as const;

const V6_ADDITIVE_TABLES = [
  "agent_database_leases",
  "agent_deletion_journal",
  "claw_cron_refs",
  "claw_installs",
  "claw_mcp_server_refs",
  "claw_package_refs",
  "claw_workspace_files",
  "config_machine_state",
  "cron_job_scratch",
  "meeting_transcript_sessions",
  "meeting_transcript_summaries",
  "meeting_transcript_utterances",
  "model_catalog_remote",
  "outbound_media_provenance",
  "sidebar_sections",
  "skill_workshop_proposal_events",
  "skill_workshop_proposal_origin_runs",
  "skill_workshop_proposal_rollbacks",
  "skill_workshop_proposals",
] as const;

const REQUESTER_SETTLE_COLUMNS = [
  "requester_settle_wake_status",
  "requester_settle_wake_attempt_count",
  "requester_settle_wake_replay_count",
  "requester_settle_wake_next_attempt_at",
  "requester_settle_wake_batch_run_ids_json",
  "requester_settle_wake_last_error",
  "requester_settle_wake_retire_after",
] as const;

const SWARM_COLUMNS = [
  "swarm_group_id",
  "swarm_collector",
  "swarm_output_schema_json",
  "swarm_completion_status",
  "swarm_structured_json",
  "swarm_schema_error",
  "swarm_usage_json",
] as const;

const COLUMN_PREDICATES = [
  {
    objectName: "diagnostic_events.sequence",
    versions: [5, 6],
    table: "diagnostic_events",
    columns: ["sequence"],
    where: "sequence IS NOT NULL",
  },
  {
    objectName: "device_pairing_pending.browser_origin",
    versions: [4, 5, 6],
    table: "device_pairing_pending",
    columns: ["browser_origin"],
    where: "browser_origin IS NOT NULL",
  },
  {
    objectName: "device_pairing_paired.browser_origin",
    versions: [4, 5, 6],
    table: "device_pairing_paired",
    columns: ["browser_origin"],
    where: "browser_origin IS NOT NULL",
  },
  {
    objectName: "apns_registrations.relay_origin",
    versions: [3, 4, 5, 6],
    table: "apns_registrations",
    columns: ["relay_origin"],
    where: "relay_origin IS NOT NULL",
  },
  {
    objectName: "node_host_config.installed_apps_sharing",
    versions: [3, 4, 5, 6],
    table: "node_host_config",
    columns: ["installed_apps_sharing"],
    where: "installed_apps_sharing IS NOT 0",
  },
  {
    objectName: "subagent_runs.requester_settle_*",
    versions: [3, 4, 5, 6],
    table: "subagent_runs",
    columns: REQUESTER_SETTLE_COLUMNS,
    where: REQUESTER_SETTLE_COLUMNS.map((column) => `${column} IS NOT NULL`).join(" OR "),
  },
  {
    objectName: "subagent_runs.swarm_*",
    versions: [6],
    table: "subagent_runs",
    columns: SWARM_COLUMNS,
    where: SWARM_COLUMNS.map((column) => `${column} IS NOT NULL`).join(" OR "),
  },
  {
    objectName: "worktrees.provisioned_paths_json",
    versions: [3, 4, 5, 6],
    table: "worktrees",
    columns: ["provisioned_paths_json"],
    where: "provisioned_paths_json IS NOT NULL",
  },
  {
    objectName: "worker_workspace_pending_results.staged_result_ref",
    versions: [5, 6],
    table: "worker_workspace_pending_results",
    columns: ["staged_result_ref"],
    where: "staged_result_ref IS NOT NULL",
  },
] as const;

function hasRows(database: DatabaseSync, tableName: string, where?: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }
  const sql = where
    ? `SELECT 1 FROM ${tableName} WHERE ${where} LIMIT 1`
    : `SELECT 1 FROM ${tableName} LIMIT 1`;
  return database.prepare(sql).get() !== undefined;
}

function hasColumnRows(
  database: DatabaseSync,
  predicate: (typeof COLUMN_PREDICATES)[number],
): boolean {
  if (
    !tableExists(database, predicate.table) ||
    !predicate.columns.every((column) => tableHasColumn(database, predicate.table, column))
  ) {
    return false;
  }
  return hasRows(database, predicate.table, predicate.where);
}

/** Return unsupported active-state object names in deterministic manifest order. */
export function listUnsupportedActiveStateObjects(
  database: DatabaseSync,
  sourceVersion: number,
): string[] {
  if (sourceVersion < 3 || sourceVersion > 6) {
    return [];
  }
  const unsupported: string[] = [];
  const additiveTables =
    sourceVersion === 6
      ? [...PRE_V6_ADDITIVE_TABLES, ...V6_ADDITIVE_TABLES]
      : PRE_V6_ADDITIVE_TABLES;
  for (const tableName of additiveTables) {
    if (hasRows(database, tableName)) {
      unsupported.push(tableName);
    }
  }
  for (const predicate of COLUMN_PREDICATES) {
    if (predicate.versions.includes(sourceVersion as never) && hasColumnRows(database, predicate)) {
      unsupported.push(predicate.objectName);
    }
  }
  return unsupported;
}

/** Refuse a source schema before any migration, repair, DDL, or metadata write. */
export function assertOpenClawStateSchema6Compatibility(
  database: DatabaseSync,
  pathname: string,
  sourceVersion: number,
): void {
  const unsupported = listUnsupportedActiveStateObjects(database, sourceVersion);
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(
    `OpenClaw state database ${pathname} has unsupported active shared-state objects: ${unsupported.join(", ")}; run a newer OpenClaw before migrating.`,
  );
}

export const OPENCLAW_STATE_SCHEMA6_COMPATIBILITY_FAMILY_COUNTS = {
  3: 11,
  4: 13,
  5: 15,
  6: 34,
} as const;
