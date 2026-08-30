// SQLite schema test support reads schema files for shape assertions.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Test helpers for comparing SQLite schema shape.
 *
 * The collected shape intentionally ignores SQLite autoindex suffixes while
 * preserving named index terms, ordering, collation, expressions, and predicates.
 */
type ColumnShape = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

type IndexShape = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  terms: IndexTermShape[];
};

type IndexTermShape = {
  kind: "column" | "expression" | "rowid";
  name: string | null;
  coll: string;
  desc: number;
};

/** Comparable SQLite schema summary used by generated-schema tests. */
export type SqliteSchemaShape = Record<
  string,
  {
    columns: ColumnShape[];
    indexes: IndexShape[];
    strict: number;
  }
>;

type TableInfoRow = ColumnShape & {
  cid: number;
};

type IndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type SqliteMasterRow = {
  name: string;
};

type IndexSqlRow = {
  sql?: unknown;
};

type IndexXInfoRow = {
  cid: number;
  name: string | null;
  coll: string;
  desc: number;
  key: number;
};

/** Execute schema SQL in memory and return its comparable shape. */
export function createSqliteSchemaShapeFromSql(schemaUrl: URL): SqliteSchemaShape {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(schemaUrl, "utf8"));
    return collectSqliteSchemaShape(db);
  } finally {
    db.close();
  }
}

/** Collect table columns and indexes from an open SQLite database. */
export function collectSqliteSchemaShape(db: DatabaseSync): SqliteSchemaShape {
  const tableRows = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `,
    )
    .all() as SqliteMasterRow[];

  return Object.fromEntries(
    tableRows.map((table) => [
      table.name,
      {
        columns: collectColumns(db, table.name),
        indexes: collectIndexes(db, table.name),
        strict: collectStrictFlag(db, table.name),
      },
    ]),
  );
}

function collectStrictFlag(db: DatabaseSync, tableName: string): number {
  const row = db
    .prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(tableName) as { strict?: unknown } | undefined;
  if (typeof row?.strict !== "number") {
    throw new Error(`SQLite table ${tableName} has no table_list entry`);
  }
  return row.strict;
}

function collectColumns(db: DatabaseSync, tableName: string): ColumnShape[] {
  return (
    db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all() as TableInfoRow[]
  )
    .map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function collectIndexes(db: DatabaseSync, tableName: string): IndexShape[] {
  return (
    db.prepare(`PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`).all() as IndexListRow[]
  )
    .map(({ name, unique, origin, partial }) => {
      const row = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get(name) as IndexSqlRow | undefined;
      return {
        name: normalizeAutoIndexName(name),
        unique,
        origin,
        partial,
        sql: typeof row?.sql === "string" ? row.sql : null,
        terms: collectIndexTerms(db, name),
      };
    })
    .toSorted((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0
        ? nameOrder
        : JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
}

function collectIndexTerms(db: DatabaseSync, indexName: string): IndexTermShape[] {
  return (
    db.prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(indexName)})`).all() as IndexXInfoRow[]
  )
    .filter((term) => term.key === 1)
    .map(({ cid, name, coll, desc }) => ({
      kind: cid === -2 ? "expression" : cid === -1 ? "rowid" : "column",
      name,
      coll,
      desc,
    }));
}

function normalizeAutoIndexName(name: string): string {
  // SQLite autoindex names include table-specific suffixes that do not affect schema behavior.
  return name.startsWith("sqlite_autoindex_") ? "sqlite_autoindex" : name;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export type OpenClawSchema6SourceVersion = 3 | 4 | 5 | 6;

export type OpenClawSchema6CompatibilityCase = {
  name: string;
  expectedObjects: readonly string[];
  activate: (database: DatabaseSync) => void;
};

export type OpenClawSchema6CompatibilityReceipt = {
  fileSha256: string;
  fileSize: number;
  foreignKeys: string;
  integrity: string;
  logicalRows: string;
  schemaMeta: string;
  schemaObjects: string;
  userVersion: number;
};

const PRE_V6_ADDITIVE_TABLE_CASES = [
  { name: "apns_registration_tombstones", expectedObjects: ["apns_registration_tombstones"] },
  { name: "mcp_oauth_stores", expectedObjects: ["mcp_oauth_stores"] },
  { name: "onboarding_recommendations", expectedObjects: ["onboarding_recommendations"] },
  { name: "workspace_attestations", expectedObjects: ["workspace_attestations"] },
  {
    name: "workspace_generated_bootstrap_hashes",
    expectedObjects: ["workspace_attestations", "workspace_generated_bootstrap_hashes"],
  },
  { name: "workspace_path_aliases", expectedObjects: ["workspace_path_aliases"] },
  {
    name: "worktree_provisioned_file_chunks",
    expectedObjects: ["worktree_provisioned_file_chunks"],
  },
] as const;

const V6_ADDITIVE_TABLE_CASES = [
  { name: "agent_database_leases", expectedObjects: ["agent_database_leases"] },
  { name: "agent_deletion_journal", expectedObjects: ["agent_deletion_journal"] },
  { name: "claw_cron_refs", expectedObjects: ["claw_cron_refs"] },
  { name: "claw_installs", expectedObjects: ["claw_installs"] },
  { name: "claw_mcp_server_refs", expectedObjects: ["claw_mcp_server_refs"] },
  { name: "claw_package_refs", expectedObjects: ["claw_package_refs"] },
  { name: "claw_workspace_files", expectedObjects: ["claw_workspace_files"] },
  { name: "config_machine_state", expectedObjects: ["config_machine_state"] },
  { name: "cron_job_scratch", expectedObjects: ["cron_job_scratch"] },
  {
    name: "meeting_transcript_sessions",
    expectedObjects: ["meeting_transcript_sessions"],
  },
  {
    name: "meeting_transcript_summaries",
    expectedObjects: ["meeting_transcript_sessions", "meeting_transcript_summaries"],
  },
  {
    name: "meeting_transcript_utterances",
    expectedObjects: ["meeting_transcript_sessions", "meeting_transcript_utterances"],
  },
  { name: "model_catalog_remote", expectedObjects: ["model_catalog_remote"] },
  { name: "outbound_media_provenance", expectedObjects: ["outbound_media_provenance"] },
  { name: "sidebar_sections", expectedObjects: ["sidebar_sections"] },
  {
    name: "skill_workshop_proposal_events",
    expectedObjects: ["skill_workshop_proposal_events", "skill_workshop_proposals"],
  },
  {
    name: "skill_workshop_proposal_origin_runs",
    expectedObjects: ["skill_workshop_proposal_origin_runs", "skill_workshop_proposals"],
  },
  {
    name: "skill_workshop_proposal_rollbacks",
    expectedObjects: ["skill_workshop_proposal_rollbacks", "skill_workshop_proposals"],
  },
  { name: "skill_workshop_proposals", expectedObjects: ["skill_workshop_proposals"] },
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

function tableCompatibilityCase(
  entry: (typeof PRE_V6_ADDITIVE_TABLE_CASES)[number] | (typeof V6_ADDITIVE_TABLE_CASES)[number],
): OpenClawSchema6CompatibilityCase {
  return {
    name: entry.name,
    expectedObjects: entry.expectedObjects,
    activate(database) {
      seedCompatibilityTable(database, entry.name);
    },
  };
}

function columnCompatibilityCase(params: {
  name: string;
  table: string;
  columns: readonly string[];
  expectedObjects?: readonly string[];
}): OpenClawSchema6CompatibilityCase {
  return {
    name: params.name,
    expectedObjects: params.expectedObjects ?? [params.name],
    activate(database) {
      seedCompatibilityTable(database, params.table, params.columns);
    },
  };
}

/** Return the frozen negative-family matrix for one canonical source version. */
export function getOpenClawSchema6CompatibilityCases(
  version: OpenClawSchema6SourceVersion,
): OpenClawSchema6CompatibilityCase[] {
  const cases: OpenClawSchema6CompatibilityCase[] =
    PRE_V6_ADDITIVE_TABLE_CASES.map(tableCompatibilityCase);
  if (version === 6) {
    cases.push(...V6_ADDITIVE_TABLE_CASES.map(tableCompatibilityCase));
  }
  if (version >= 5) {
    cases.push(
      columnCompatibilityCase({
        name: "diagnostic_events.sequence",
        table: "diagnostic_events",
        columns: ["sequence"],
      }),
    );
  }
  if (version >= 4) {
    cases.push(
      columnCompatibilityCase({
        name: "device_pairing_pending.browser_origin",
        table: "device_pairing_pending",
        columns: ["browser_origin"],
      }),
      columnCompatibilityCase({
        name: "device_pairing_paired.browser_origin",
        table: "device_pairing_paired",
        columns: ["browser_origin"],
      }),
    );
  }
  cases.push(
    columnCompatibilityCase({
      name: "apns_registrations.relay_origin",
      table: "apns_registrations",
      columns: ["relay_origin"],
    }),
    columnCompatibilityCase({
      name: "node_host_config.installed_apps_sharing",
      table: "node_host_config",
      columns: ["installed_apps_sharing"],
    }),
    columnCompatibilityCase({
      name: "subagent_runs.requester_settle_*",
      table: "subagent_runs",
      columns:
        version === 6 ? [...REQUESTER_SETTLE_COLUMNS, ...SWARM_COLUMNS] : REQUESTER_SETTLE_COLUMNS,
      expectedObjects:
        version === 6
          ? ["subagent_runs.requester_settle_*", "subagent_runs.swarm_*"]
          : ["subagent_runs.requester_settle_*"],
    }),
    columnCompatibilityCase({
      name: "worktrees.provisioned_paths_json",
      table: "worktrees",
      columns: ["provisioned_paths_json"],
    }),
  );
  if (version >= 5) {
    cases.push(
      columnCompatibilityCase({
        name: "worker_workspace_pending_results.staged_result_ref",
        table: "worker_workspace_pending_results",
        columns: ["staged_result_ref"],
      }),
    );
  }
  return cases;
}

/** Downgrade the current generated schema to the frozen canonical source boundary. */
export function markOpenClawStateDatabaseSourceVersion(
  database: DatabaseSync,
  version: OpenClawSchema6SourceVersion,
): void {
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    if (version < 6) {
      for (const entry of V6_ADDITIVE_TABLE_CASES) {
        database.exec(`DROP TABLE ${quoteSqliteIdentifier(entry.name)};`);
      }
      for (const column of SWARM_COLUMNS) {
        database.exec(`ALTER TABLE subagent_runs DROP COLUMN ${quoteSqliteIdentifier(column)};`);
      }
    }
    if (version < 5) {
      database.exec(`
        DROP INDEX idx_diagnostic_events_scope_sequence;
        ALTER TABLE diagnostic_events DROP COLUMN sequence;
        ALTER TABLE worker_workspace_pending_results DROP COLUMN staged_result_ref;
      `);
    }
    if (version < 4) {
      database.exec(`
        ALTER TABLE device_pairing_pending DROP COLUMN browser_origin;
        ALTER TABLE device_pairing_paired DROP COLUMN browser_origin;
        ALTER TABLE session_watch_cursors DROP COLUMN provenance;
      `);
    }
    database.exec(`
      PRAGMA user_version = ${version};
      UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

/** Seed distant families in reverse order to prove manifest-ordered refusal. */
export function activateOpenClawSchema6MultiObjectCase(
  database: DatabaseSync,
  version: OpenClawSchema6SourceVersion,
): readonly string[] {
  seedCompatibilityTable(database, "worktrees", ["provisioned_paths_json"]);
  seedCompatibilityTable(database, "apns_registration_tombstones");
  if (version >= 4) {
    seedCompatibilityTable(database, "device_pairing_pending", ["browser_origin"]);
  }
  return version >= 4
    ? [
        "apns_registration_tombstones",
        "device_pairing_pending.browser_origin",
        "worktrees.provisioned_paths_json",
      ]
    : ["apns_registration_tombstones", "worktrees.provisioned_paths_json"];
}

/** Capture all no-write receipts required by the compatibility boundary. */
export function captureOpenClawSchema6CompatibilityReceipt(
  databasePath: string,
): OpenClawSchema6CompatibilityReceipt {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let receipt: Omit<OpenClawSchema6CompatibilityReceipt, "fileSha256" | "fileSize">;
  try {
    receipt = {
      foreignKeys: hashReceiptValue(database.prepare("PRAGMA foreign_key_check;").all()),
      integrity: hashReceiptValue(database.prepare("PRAGMA integrity_check;").all()),
      logicalRows: fingerprintLogicalRows(database),
      schemaMeta: hashReceiptValue(
        database.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").all(),
      ),
      schemaObjects: fingerprintSchemaObjects(database),
      userVersion: (database.prepare("PRAGMA user_version;").get() as { user_version: number })
        .user_version,
    };
  } finally {
    database.close();
  }
  const bytes = readFileSync(databasePath);
  return {
    ...receipt,
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    fileSize: statSync(databasePath).size,
  };
}

function seedCompatibilityTable(
  database: DatabaseSync,
  tableName: string,
  activeColumns: readonly string[] = [],
  overrides: Record<string, SQLInputValue> = {},
  stack: Set<string> = new Set(),
): Record<string, SQLInputValue> {
  const quotedTable = quoteSqliteIdentifier(tableName);
  const existing = database.prepare(`SELECT * FROM ${quotedTable} LIMIT 1`).get();
  if (existing) {
    return existing;
  }
  if (stack.has(tableName)) {
    throw new Error(
      `SQLite compatibility fixture has a required foreign-key cycle at ${tableName}`,
    );
  }
  stack.add(tableName);
  const columns = database.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{
    dflt_value: unknown;
    name: string;
    notnull: number;
    pk: number;
    type: string;
  }>;
  const values: Record<string, SQLInputValue> = { ...overrides };
  const tableSql = (
    database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(tableName) as { sql: string }
  ).sql;
  for (const columnName of activeColumns) {
    const column = columns.find((entry) => entry.name === columnName);
    if (!column) {
      throw new Error(`SQLite compatibility fixture is missing ${tableName}.${columnName}`);
    }
    values[columnName] = compatibilityColumnValue(tableName, column, tableSql);
  }
  const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quotedTable})`).all() as Array<{
    from: string;
    id: number;
    table: string;
    to: string;
  }>;
  const foreignKeyGroups = new Map<number, typeof foreignKeys>();
  for (const foreignKey of foreignKeys) {
    const group = foreignKeyGroups.get(foreignKey.id) ?? [];
    group.push(foreignKey);
    foreignKeyGroups.set(foreignKey.id, group);
  }
  for (const group of foreignKeyGroups.values()) {
    const firstForeignKey = group[0];
    if (!firstForeignKey) {
      continue;
    }
    const needsParent = group.some((foreignKey) => {
      const column = columns.find((entry) => entry.name === foreignKey.from);
      return foreignKey.from in values || column?.notnull === 1;
    });
    if (!needsParent) {
      continue;
    }
    const parentOverrides: Record<string, SQLInputValue> = {};
    for (const foreignKey of group) {
      const value = values[foreignKey.from];
      if (value !== undefined) {
        parentOverrides[foreignKey.to] = value;
      }
    }
    const parent = seedCompatibilityTable(
      database,
      firstForeignKey.table,
      [],
      parentOverrides,
      stack,
    );
    for (const foreignKey of group) {
      const parentValue = parent[foreignKey.to];
      if (parentValue === undefined) {
        throw new Error(
          `SQLite compatibility fixture is missing ${firstForeignKey.table}.${foreignKey.to}`,
        );
      }
      values[foreignKey.from] = parentValue;
    }
  }
  if (tableName === "meeting_transcript_summaries") {
    values.summary_json = "{}";
  }
  for (const column of columns) {
    if (
      !(column.name in values) &&
      column.dflt_value === null &&
      (column.notnull === 1 || column.pk > 0)
    ) {
      values[column.name] = compatibilityColumnValue(tableName, column, tableSql);
    }
  }
  const insertColumns = Object.keys(values).filter((name) =>
    columns.some((column) => column.name === name),
  );
  database
    .prepare(
      `INSERT INTO ${quotedTable} (${insertColumns.map(quoteSqliteIdentifier).join(", ")}) ` +
        `VALUES (${insertColumns.map(() => "?").join(", ")})`,
    )
    .run(...insertColumns.map((name) => values[name] as SQLInputValue));
  stack.delete(tableName);
  return database.prepare(`SELECT * FROM ${quotedTable} LIMIT 1`).get() as Record<
    string,
    SQLInputValue
  >;
}

function compatibilityColumnValue(
  tableName: string,
  column: { name: string; type: string },
  tableSql: string,
): SQLInputValue {
  const escapedName = column.name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const textEnum = tableSql.match(
    new RegExp(
      `\\b${escapedName}\\b[^,]*?CHECK\\s*\\([^)]*?\\bIN\\s*\\(\\s*['"]([^'"]+)['"]`,
      "isu",
    ),
  );
  const textEnumValue = textEnum?.[1];
  if (textEnumValue !== undefined) {
    return textEnumValue;
  }
  const integerEnum = tableSql.match(
    new RegExp(`\\b${escapedName}\\b[^,]*?CHECK\\s*\\([^)]*?\\bIN\\s*\\(\\s*(-?\\d+)`, "isu"),
  );
  if (integerEnum) {
    return Number(integerEnum[1]);
  }
  if (/INT|REAL|NUM/iu.test(column.type)) {
    return 1;
  }
  if (/BLOB/iu.test(column.type)) {
    return Buffer.from([1]);
  }
  if (/(?:^|_)ids?_json$|paths_json$|files_json$|args_json$|refs_json$/u.test(column.name)) {
    return "[]";
  }
  if (column.name.endsWith("_json")) {
    return "{}";
  }
  return `${tableName}-${column.name}`;
}

function fingerprintLogicalRows(database: DatabaseSync): string {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const records = tables.map(({ name }) => {
    const columns = database
      .prepare(`PRAGMA table_xinfo(${quoteSqliteIdentifier(name)})`)
      .all() as Array<{ cid: number; name: string }>;
    const orderedColumns = columns.toSorted((left, right) => left.cid - right.cid);
    const projections = orderedColumns.flatMap((column, index) => [
      `typeof(${quoteSqliteIdentifier(column.name)}) AS ${quoteSqliteIdentifier(`t${index}`)}`,
      `hex(CAST(${quoteSqliteIdentifier(column.name)} AS BLOB)) AS ${quoteSqliteIdentifier(`v${index}`)}`,
    ]);
    const rows = database
      .prepare(`SELECT ${projections.join(", ")} FROM ${quoteSqliteIdentifier(name)}`)
      .all()
      .map((row) => JSON.stringify(row, receiptReplacer))
      .toSorted();
    return { columns: orderedColumns, name, rows };
  });
  return hashReceiptValue(records);
}

function fingerprintSchemaObjects(database: DatabaseSync): string {
  return hashReceiptValue(
    database
      .prepare(
        `SELECT type, name, tbl_name, rootpage, sql
           FROM sqlite_schema
          ORDER BY type, name`,
      )
      .all(),
  );
}

function receiptReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value instanceof Uint8Array) {
    return `blob:${Buffer.from(value).toString("base64")}`;
  }
  return value;
}

function hashReceiptValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, receiptReplacer)).digest("hex");
}
