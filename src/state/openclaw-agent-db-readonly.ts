import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

type OpenClawAgentReadOnlyDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
};

function assertSupportedSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw agent database",
      pathname,
      userVersion,
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
  if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${pathname} uses schema version ${userVersion}; expected ${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
    );
  }
}

function assertAgentOwner(db: DatabaseSync, agentId: string, pathname: string): void {
  const row = db
    .prepare("SELECT role, agent_id AS agentId FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { agentId?: unknown; role?: unknown } | undefined;
  const role = normalizeLowercaseStringOrEmpty(row?.role);
  const storedAgentId =
    typeof row?.agentId === "string" && row.agentId.trim()
      ? normalizeAgentId(row.agentId)
      : undefined;
  if (role !== "agent" || storedAgentId !== agentId) {
    throw new Error(`OpenClaw agent database ${pathname} is not owned by agent ${agentId}.`);
  }
}

/**
 * Read one current-schema agent database without joining its writable lifecycle.
 *
 * Authorization hot paths use this seam for indexed point lookups. A writable
 * open performs full integrity and schema maintenance, which is deliberately
 * excluded here; this handle cannot mutate the database and still validates
 * the schema version and agent owner before returning data.
 */
export function withOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
): T {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = path.resolve(resolveOpenClawAgentSqlitePath({ ...options, agentId }));
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    assertAgentOwner(db, agentId, pathname);
    return operation({ agentId, db, path: pathname });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}
