import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  assertOpenClawStateSchema6Compatibility,
  listUnsupportedActiveStateObjects,
  OPENCLAW_STATE_SCHEMA6_COMPATIBILITY_FAMILY_COUNTS,
} from "./openclaw-state-db-schema6-compatibility.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import {
  activateOpenClawSchema6MultiObjectCase,
  captureOpenClawSchema6CompatibilityReceipt,
  getOpenClawSchema6CompatibilityCases,
  markOpenClawStateDatabaseSourceVersion,
  type OpenClawSchema6SourceVersion,
} from "./sqlite-schema-shape.test-support.js";

const tempDirs: string[] = [];
const SOURCE_VERSIONS = [3, 4, 5, 6] as const;

function createCompatibilityFixture(params: {
  version: OpenClawSchema6SourceVersion;
  activate?: (database: DatabaseSync) => void;
}): string {
  const stateDir = makeTempDir(tempDirs, `openclaw-schema6-v${params.version}-`);
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  const database = new DatabaseSync(databasePath);
  try {
    markOpenClawStateDatabaseSourceVersion(database, params.version);
    params.activate?.(database);
    expect(database.prepare("PRAGMA foreign_key_check;").all()).toEqual([]);
  } finally {
    database.close();
  }
  return databasePath;
}

function readUnsupportedObjects(databasePath: string, version: OpenClawSchema6SourceVersion) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return listUnsupportedActiveStateObjects(database, version);
  } finally {
    database.close();
  }
}

function expectCompatibilityRefusal(params: {
  databasePath: string;
  version: OpenClawSchema6SourceVersion;
  expectedObjects: readonly string[];
}): void {
  const before = captureOpenClawSchema6CompatibilityReceipt(params.databasePath);
  const refusal =
    `OpenClaw state database ${params.databasePath} has unsupported active shared-state objects: ` +
    `${params.expectedObjects.join(", ")}; run a newer OpenClaw before migrating.`;
  const database = new DatabaseSync(params.databasePath, { readOnly: true });
  try {
    expect(() =>
      assertOpenClawStateSchema6Compatibility(database, params.databasePath, params.version),
    ).toThrow(refusal);
  } finally {
    database.close();
  }
  expect(captureOpenClawSchema6CompatibilityReceipt(params.databasePath)).toEqual(before);
  expect(() => detectOpenClawStateDatabaseSchemaMigrations({ path: params.databasePath })).toThrow(
    refusal,
  );
  expect(captureOpenClawSchema6CompatibilityReceipt(params.databasePath)).toEqual(before);
  expect(() => openOpenClawStateDatabase({ path: params.databasePath })).toThrow(refusal);
  expect(captureOpenClawSchema6CompatibilityReceipt(params.databasePath)).toEqual(before);
  expect(repairOpenClawStateDatabaseSchema({ path: params.databasePath })).toEqual({
    changes: [],
    warnings: [
      `Failed migrating shared state database schema at ${params.databasePath}: Error: ${refusal}`,
    ],
  });
  expect(captureOpenClawSchema6CompatibilityReceipt(params.databasePath)).toEqual(before);
}

afterAll(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("schema-6 source compatibility", () => {
  it("declares the exact negative-family counts", () => {
    expect(OPENCLAW_STATE_SCHEMA6_COMPATIBILITY_FAMILY_COUNTS).toEqual({
      3: 11,
      4: 13,
      5: 15,
      6: 34,
    });
    for (const version of SOURCE_VERSIONS) {
      expect(getOpenClawSchema6CompatibilityCases(version)).toHaveLength(
        OPENCLAW_STATE_SCHEMA6_COMPATIBILITY_FAMILY_COUNTS[version],
      );
    }
  });

  for (const version of SOURCE_VERSIONS) {
    describe(`canonical schema ${version}`, () => {
      it("accepts the supported empty-state boundary", () => {
        const databasePath = createCompatibilityFixture({ version });
        expect(readUnsupportedObjects(databasePath, version)).toEqual([]);
      });

      for (const compatibilityCase of getOpenClawSchema6CompatibilityCases(version)) {
        it(`refuses ${compatibilityCase.name} without changing the database`, () => {
          const databasePath = createCompatibilityFixture({
            version,
            activate: compatibilityCase.activate,
          });
          expect(readUnsupportedObjects(databasePath, version)).toEqual(
            compatibilityCase.expectedObjects,
          );
          expectCompatibilityRefusal({
            databasePath,
            version,
            expectedObjects: compatibilityCase.expectedObjects,
          });
        });
      }

      it("reports multiple active objects in stable manifest order", () => {
        let expectedObjects: readonly string[] = [];
        const databasePath = createCompatibilityFixture({
          version,
          activate(database) {
            expectedObjects = activateOpenClawSchema6MultiObjectCase(database, version);
          },
        });
        expect(readUnsupportedObjects(databasePath, version)).toEqual(expectedObjects);
        expectCompatibilityRefusal({ databasePath, version, expectedObjects });
      });
    });
  }

  it("uses the provided path in the stable refusal", () => {
    const databasePath = createCompatibilityFixture({
      version: 6,
      activate: getOpenClawSchema6CompatibilityCases(6)[0].activate,
    });
    expect(path.isAbsolute(databasePath)).toBe(true);
  });
});
