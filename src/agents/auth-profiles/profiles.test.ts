/**
 * Tests auth profile mutation helpers.
 * Covers locked upserts, order promotion, last-good clearing, legacy OAuth file
 * imports, and credential normalization.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  clearLastGoodProfileWithLock,
  promoteAuthProfileInOrder,
  removeAuthProfilesWithLock,
  removeProviderAuthProfilesWithLock,
  upsertAuthProfileWithLock,
} from "./profiles.js";
import {
  getRuntimeAuthProfileStoreSnapshot as getInternalRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreStateMutationToken,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, runAuthProfileWriteTransaction } from "./sqlite.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  getRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
  restoreAuthProfileStorePersistenceSnapshot,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import { testing as storeTesting } from "./store.test-support.js";
import type { AuthProfileStore, OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

type ExpectedOAuthCredentialFields = {
  provider: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

type AuthProfileTestState = {
  stateDir: string;
  agentDir: string;
  agentDirFor: (agentId: string) => string;
};

afterEach(() => {
  storeTesting.resetRuntimeSnapshotPublisherForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

async function withAuthProfileTestState<T>(
  prefix: string,
  run: (state: AuthProfileTestState) => Promise<T> | T,
  options: { clearOAuthDir?: boolean } = {},
): Promise<T> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentDirFor = (agentId: string) => path.join(stateDir, "agents", agentId, "agent");
  try {
    return await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        ...(options.clearOAuthDir ? { OPENCLAW_OAUTH_DIR: undefined } : {}),
      },
      async () =>
        await run({
          stateDir,
          agentDir: agentDirFor("main"),
          agentDirFor,
        }),
    );
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function expectOAuthCredentialFields(
  value: unknown,
  expected: ExpectedOAuthCredentialFields,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected OAuth credential object");
  }
  const credential = value as Record<string, unknown>;
  expect(credential.type).toBe("oauth");
  expect(credential.provider).toBe(expected.provider);
  for (const field of [
    "access",
    "refresh",
    "idToken",
    "expires",
    "email",
    "accountId",
    "chatgptPlanType",
  ] as const) {
    if (field in expected) {
      expect(credential[field]).toBe(expected[field]);
    }
  }
  return credential;
}

function spawnAuthFixture(source: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`fixture exited ${code}: ${stderr}`)),
    );
  });
  const waitFor = async (text: string) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (stdout.includes(text)) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`fixture exited before ${text}: ${stderr}`);
      }
      await delay(10);
    }
    throw new Error(`fixture did not emit ${text}: ${stderr}`);
  };
  return { child, done, waitFor };
}

function spawnAuthRaceWorker(env: Record<string, string>) {
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const persistedUrl = new URL("./persisted.ts", import.meta.url).href;
  const profilesUrl = new URL("./profiles.ts", import.meta.url).href;
  const sqliteUrl = new URL("./sqlite.ts", import.meta.url).href;
  const upsertUrl = new URL("./upsert-with-lock.ts", import.meta.url).href;
  const agentDbUrl = new URL("../../state/openclaw-agent-db.ts", import.meta.url).href;
  return spawnAuthFixture(
    `
      const { updateAuthProfileStoreWithLock } = await import(${JSON.stringify(storeUrl)});
      const { loadPersistedAuthProfileStore } = await import(${JSON.stringify(persistedUrl)});
      const { removeAuthProfilesWithLock } = await import(${JSON.stringify(profilesUrl)});
      const { runAuthProfileWriteTransaction } = await import(${JSON.stringify(sqliteUrl)});
      const { upsertAuthProfileWithLock } = await import(${JSON.stringify(upsertUrl)});
      const { closeOpenClawAgentDatabasesForTest } = await import(${JSON.stringify(agentDbUrl)});
      console.log("ready");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      const started = Date.now();
      const profileId = process.env.AUTH_RACE_PROFILE_ID;
      const childDir = process.env.AUTH_RACE_CHILD_DIR;
      const action = process.env.AUTH_RACE_ACTION;
      const takeover = action === "takeover";
      let result;
      if (action === "upsert") {
        result = await upsertAuthProfileWithLock({
          agentDir: childDir,
          profileId,
          credential: JSON.parse(process.env.AUTH_RACE_CREDENTIAL),
        });
      } else if (action === "remove") {
        result = await removeAuthProfilesWithLock({
          agentDir: childDir,
          profileIds: [profileId],
        });
      } else {
        result = await updateAuthProfileStoreWithLock({
            agentDir: takeover ? undefined : childDir,
            ...(takeover ? {} : { ownership: { mode: "persisted-profile", profileId } }),
            updater: (store) => {
              if (takeover) {
                const source = runAuthProfileWriteTransaction(childDir, (database) =>
                  loadPersistedAuthProfileStore(childDir, { database }),
                );
                const credential = source?.profiles[profileId];
                if (!credential) return false;
                store.profiles[profileId] = structuredClone(credential);
                const usage = source.usageStats?.[profileId];
                if (usage) store.usageStats = { ...store.usageStats, [profileId]: structuredClone(usage) };
              } else {
                store.usageStats = {
                  ...store.usageStats,
                  [profileId]: { blockedUntil: Number(process.env.AUTH_RACE_BLOCKED_UNTIL) },
                };
              }
              return true;
            },
          });
      }
      closeOpenClawAgentDatabasesForTest();
      console.log(JSON.stringify({ ok: result !== null, elapsedMs: Date.now() - started }));
    `,
    env,
  );
}

function spawnAuthLockHolder(
  databasePath: string,
  replacement?: AuthProfileStore["profiles"][string],
) {
  return spawnAuthFixture(
    `
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(process.env.AUTH_RACE_DATABASE_PATH);
      db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      if (process.env.AUTH_RACE_REPLACEMENT) {
        const row = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'").get();
        const store = JSON.parse(row.store_json);
        store.profiles[process.env.AUTH_RACE_PROFILE_ID] = JSON.parse(process.env.AUTH_RACE_REPLACEMENT);
        db.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = 'primary'")
          .run(JSON.stringify(store), Date.now());
      }
      console.log("locked");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      db.exec("COMMIT");
      db.close();
    `,
    {
      AUTH_RACE_DATABASE_PATH: databasePath,
      AUTH_RACE_PROFILE_ID: "openai:primary",
      ...(replacement ? { AUTH_RACE_REPLACEMENT: JSON.stringify(replacement) } : {}),
    },
  );
}

async function waitForSqliteWriteLock(databasePath: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const probe = new DatabaseSync(databasePath);
    probe.exec("PRAGMA busy_timeout = 0");
    try {
      probe.exec("BEGIN IMMEDIATE; ROLLBACK");
    } catch {
      probe.close();
      return;
    }
    probe.close();
    await delay(10);
  }
  throw new Error(`database did not become write-locked: ${databasePath}`);
}

function authRaceResult(stdout: string): { ok: boolean; elapsedMs: number } {
  const line = stdout
    .trim()
    .split("\n")
    .findLast((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error(`missing race result: ${stdout}`);
  }
  return JSON.parse(line) as { ok: boolean; elapsedMs: number };
}

type AuthOwnerRaceHarness = {
  childDir: string;
  childCredential: OAuthCredential;
  profileId: string;
  now: number;
  mainPath: string;
  childPath: string;
  seed: () => void;
  worker: (
    action: "update" | "takeover",
    blockedUntil: number,
  ) => ReturnType<typeof spawnAuthRaceWorker>;
  start: (fixture: ReturnType<typeof spawnAuthRaceWorker>) => Promise<void>;
  release: (fixture: ReturnType<typeof spawnAuthLockHolder>) => Promise<void>;
};

async function withAuthOwnerRaceState(
  run: (harness: AuthOwnerRaceHarness) => Promise<void>,
): Promise<void> {
  await withAuthProfileTestState(
    "openclaw-auth-owner-races-",
    async ({ stateDir, agentDirFor }) => {
      const childDir = agentDirFor("child");
      const profileId = "openai:primary";
      const now = Date.now();
      const mainCredential = {
        type: "oauth" as const,
        provider: "openai",
        access: "main-old",
        refresh: "refresh",
        expires: now + 60_000,
        accountId: "acct",
      };
      const childCredential = {
        ...mainCredential,
        access: "child-new",
        expires: now + 120_000,
      };
      const seed = () => {
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: mainCredential },
          usageStats: { [profileId]: { lastUsed: 0 } },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: { [profileId]: childCredential },
            usageStats: { [profileId]: { lastUsed: 1 } },
          },
          childDir,
        );
      };
      const worker = (action: "update" | "takeover", blockedUntil: number) =>
        spawnAuthRaceWorker({
          OPENCLAW_STATE_DIR: stateDir,
          AUTH_RACE_ACTION: action,
          AUTH_RACE_PROFILE_ID: profileId,
          AUTH_RACE_CHILD_DIR: childDir,
          AUTH_RACE_BLOCKED_UNTIL: String(blockedUntil),
        });
      const start = async (fixture: ReturnType<typeof spawnAuthRaceWorker>) => {
        await fixture.waitFor("ready");
        fixture.child.stdin.end("go\n");
      };
      const release = async (fixture: ReturnType<typeof spawnAuthLockHolder>) => {
        if (fixture.child.exitCode === null) {
          fixture.child.stdin.end("release\n");
        }
        await fixture.done;
      };
      await run({
        childDir,
        childCredential,
        profileId,
        now,
        mainPath: resolveAuthProfileDatabasePath(),
        childPath: resolveAuthProfileDatabasePath(childDir),
        seed,
        worker,
        start,
        release,
      });
    },
    { clearOAuthDir: true },
  );
}

describe("promoteAuthProfileInOrder", () => {
  it("publishes a child-owner update after the coordinating main transaction commits", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-child-publication-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const expires = Date.now() + 120_000;
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-old",
              refresh: "refresh",
              expires: expires - 60_000,
              accountId: "acct",
            },
          },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai",
                access: "child-new",
                refresh: "refresh",
                expires,
                accountId: "acct",
              },
            },
          },
          childDir,
        );
        let publishedAfterMainCommit = false;
        storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
          const probe = new DatabaseSync(resolveAuthProfileDatabasePath());
          probe.exec("PRAGMA busy_timeout = 0");
          expect(() => probe.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
          probe.close();
          publishedAfterMainCommit = true;
          publish();
        });

        await updateAuthProfileStoreWithLock({
          agentDir: childDir,
          ownership: { mode: "persisted-profile", profileId },
          updater: (store) => {
            store.usageStats = { [profileId]: { lastUsed: 7 } };
            return true;
          },
        });

        expect(publishedAfterMainCommit).toBe(true);
        expect(loadPersistedAuthProfileStore(childDir)?.usageStats?.[profileId]).toEqual({
          lastUsed: 7,
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("withholds publication and invalidates snapshots after an outer main rollback", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-coordinated-rollback-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const inheritedProfileId = "openai:inherited";
        const localProfileId = "openai:local";
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [inheritedProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60_000,
              accountId: "acct-main",
            },
          },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [localProfileId]: {
                type: "api_key",
                provider: "openai",
                key: "sk-local",
              },
            },
          },
          childDir,
        );
        replaceRuntimeAuthProfileStoreSnapshots([
          { store: loadAuthProfileStoreForRuntime() },
          { agentDir: childDir, store: loadAuthProfileStoreForRuntime(childDir) },
        ]);
        const mainDatabase = openOpenClawAgentDatabase({
          agentId: "main",
          path: resolveAuthProfileDatabasePath(),
        });
        mainDatabase.db.exec(`
          CREATE TRIGGER reject_coordinated_main_auth_update
          BEFORE UPDATE ON auth_profile_store
          BEGIN
            SELECT RAISE(ABORT, 'injected coordinating main failure');
          END;
        `);
        let publicationCount = 0;
        storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
          publicationCount += 1;
          publish();
        });

        const result = await removeAuthProfilesWithLock({
          agentDir: childDir,
          profileIds: [localProfileId, inheritedProfileId],
        });
        mainDatabase.db.exec("DROP TRIGGER reject_coordinated_main_auth_update;");

        expect(result).toBeNull();
        expect(publicationCount).toBe(0);
        expect(loadPersistedAuthProfileStore(childDir)?.profiles[localProfileId]).toBeUndefined();
        expect(loadPersistedAuthProfileStore()?.profiles[inheritedProfileId]).toBeDefined();
        expect(getRuntimeAuthProfileStoreSnapshot()).toBeUndefined();
        expect(getRuntimeAuthProfileStoreSnapshot(childDir)).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("serializes a direct child OAuth upsert behind the main ownership snapshot", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-upsert-race-",
      async ({ stateDir, agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        const mainCredential = {
          type: "oauth" as const,
          provider: "openai",
          access: "main-before-snapshot",
          refresh: "main-refresh",
          expires: now + 60_000,
          accountId: "acct",
        };
        const mainSnapshot = {
          ...mainCredential,
          access: "main-snapshot",
          expires: now + 120_000,
        };
        const upsertCredential = {
          ...mainCredential,
          access: "direct-upsert",
          refresh: "direct-upsert-refresh",
          expires: now + 180_000,
        };
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: mainCredential },
        });
        saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles: {} }, childDir);

        const mainHolder = spawnAuthLockHolder(resolveAuthProfileDatabasePath(), mainSnapshot);
        await mainHolder.waitFor("locked");
        const upsert = spawnAuthRaceWorker({
          OPENCLAW_STATE_DIR: stateDir,
          AUTH_RACE_ACTION: "upsert",
          AUTH_RACE_PROFILE_ID: profileId,
          AUTH_RACE_CHILD_DIR: childDir,
          AUTH_RACE_CREDENTIAL: JSON.stringify(upsertCredential),
        });
        try {
          await upsert.waitFor("ready");
          upsert.child.stdin.end("go\n");
          const completedWhileMainSnapshotHeld = await Promise.race([
            upsert.done.then(() => true),
            delay(500).then(() => false),
          ]);
          expect(completedWhileMainSnapshotHeld).toBe(false);
          mainHolder.child.stdin.end("release\n");
          await mainHolder.done;
          expect(authRaceResult(await upsert.done).ok).toBe(true);
        } finally {
          if (mainHolder.child.exitCode === null) {
            mainHolder.child.stdin.end("release\n");
            await mainHolder.done;
          }
        }

        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
          access: "direct-upsert",
          refresh: "direct-upsert-refresh",
        });
        expect(loadPersistedAuthProfileStore(childDir)?.profiles[profileId]).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("writes a child-targeted different OAuth identity to the child owner", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-upsert-identity-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        const mainCredential = {
          type: "oauth" as const,
          provider: "openai",
          access: "main-account-a",
          refresh: "main-refresh-a",
          expires: now + 180_000,
          accountId: "account-a",
        };
        const inheritedChildCredential = {
          ...mainCredential,
          access: "child-stale-account-a",
          expires: now + 120_000,
        };
        const replacement = {
          ...mainCredential,
          access: "child-account-b",
          refresh: "child-refresh-b",
          expires: now + 240_000,
          accountId: "account-b",
        };
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: { [profileId]: inheritedChildCredential },
          },
          childDir,
          { filterExternalAuthProfiles: false },
        );
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: mainCredential },
        });

        await upsertAuthProfileWithLock({
          agentDir: childDir,
          profileId,
          credential: replacement,
        });

        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
          access: "main-account-a",
          accountId: "account-a",
        });
        expect(loadPersistedAuthProfileStore(childDir)?.profiles[profileId]).toMatchObject({
          access: "child-account-b",
          accountId: "account-b",
        });
        expect(loadAuthProfileStoreForRuntime(childDir).profiles[profileId]).toMatchObject({
          access: "child-account-b",
          accountId: "account-b",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("adopts the authoritative inherited OAuth credential over a freshness regression", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-upsert-freshness-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        const mainCredential = {
          type: "oauth" as const,
          provider: "openai",
          access: "main-fresh",
          refresh: "main-refresh",
          expires: now + 180_000,
          accountId: "account-a",
        };
        const inheritedChildCredential = {
          ...mainCredential,
          access: "child-stale",
          expires: now + 120_000,
        };
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: { [profileId]: inheritedChildCredential },
          },
          childDir,
          { filterExternalAuthProfiles: false },
        );
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: mainCredential },
        });

        const updated = await upsertAuthProfileWithLock({
          agentDir: childDir,
          profileId,
          credential: {
            ...mainCredential,
            access: "regressing-upsert",
            refresh: "regressing-refresh",
            expires: now + 60_000,
          },
        });

        expect(updated?.profiles[profileId]).toMatchObject({ access: "main-fresh" });
        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
          access: "main-fresh",
          expires: now + 180_000,
        });
        expect(loadPersistedAuthProfileStore(childDir)?.profiles[profileId]).toMatchObject({
          access: "child-stale",
          expires: now + 120_000,
        });
        expect(loadAuthProfileStoreForRuntime(childDir).profiles[profileId]).toMatchObject({
          access: "main-fresh",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("removes main and stale child OAuth material after a child snapshot", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-remove-race-",
      async ({ stateDir, agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        const mainCredential = {
          type: "oauth" as const,
          provider: "openai",
          access: "main-current",
          refresh: "main-refresh",
          expires: now + 180_000,
          accountId: "account-a",
        };
        const childSnapshot = {
          ...mainCredential,
          access: "child-stale-snapshot",
          expires: now + 60_000,
        };
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: { [profileId]: mainCredential },
        });
        saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles: {} }, childDir);

        const childHolder = spawnAuthLockHolder(
          resolveAuthProfileDatabasePath(childDir),
          childSnapshot,
        );
        await childHolder.waitFor("locked");
        const removal = spawnAuthRaceWorker({
          OPENCLAW_STATE_DIR: stateDir,
          AUTH_RACE_ACTION: "remove",
          AUTH_RACE_PROFILE_ID: profileId,
          AUTH_RACE_CHILD_DIR: childDir,
        });
        try {
          await removal.waitFor("ready");
          removal.child.stdin.end("go\n");
          await waitForSqliteWriteLock(resolveAuthProfileDatabasePath());
          const completedWhileChildSnapshotHeld = await Promise.race([
            removal.done.then(() => true),
            delay(500).then(() => false),
          ]);
          expect(completedWhileChildSnapshotHeld).toBe(false);
          childHolder.child.stdin.end("release\n");
          await childHolder.done;
          expect(authRaceResult(await removal.done).ok).toBe(true);
        } finally {
          if (childHolder.child.exitCode === null) {
            childHolder.child.stdin.end("release\n");
            await childHolder.done;
          }
        }

        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toBeUndefined();
        expect(loadPersistedAuthProfileStore(childDir)?.profiles[profileId]).toBeUndefined();
        expect(loadAuthProfileStoreForRuntime(childDir).profiles[profileId]).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  }, 10_000);

  it("preserves a different-identity main OAuth profile during child-targeted removal", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-remove-identity-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-account-a",
              refresh: "main-refresh-a",
              expires: now + 180_000,
              accountId: "account-a",
            },
          },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai",
                access: "child-account-b",
                refresh: "child-refresh-b",
                expires: now + 240_000,
                accountId: "account-b",
              },
            },
          },
          childDir,
          { filterExternalAuthProfiles: false },
        );

        await removeAuthProfilesWithLock({ agentDir: childDir, profileIds: [profileId] });

        expect(loadPersistedAuthProfileStore(childDir)?.profiles[profileId]).toBeUndefined();
        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
          access: "main-account-a",
          accountId: "account-a",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("preserves a different-identity main OAuth profile during provider-wide force cleanup", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-provider-remove-identity-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-account-a",
              refresh: "main-refresh-a",
              expires: now + 180_000,
              accountId: "account-a",
            },
          },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai",
                access: "child-account-b",
                refresh: "child-refresh-b",
                expires: now + 240_000,
                accountId: "account-b",
              },
              "openai:child-token": {
                type: "token",
                provider: "openai",
                token: "child-token",
              },
            },
          },
          childDir,
          { filterExternalAuthProfiles: false },
        );

        await removeProviderAuthProfilesWithLock({ provider: "openai", agentDir: childDir });

        expect(loadPersistedAuthProfileStore(childDir)?.profiles).toEqual({});
        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
          access: "main-account-a",
          accountId: "account-a",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("does not leak main lifecycle state into a child-owned OAuth overlay", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-oauth-lifecycle-overlay-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:primary";
        const now = Date.now();
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-account-a",
              refresh: "main-refresh-a",
              expires: now + 180_000,
              accountId: "account-a",
            },
          },
          usageStats: { [profileId]: { blockedUntil: now + 60_000 } },
          lastGood: { openai: profileId },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai",
                access: "child-account-b",
                refresh: "child-refresh-b",
                expires: now + 240_000,
                accountId: "account-b",
              },
            },
          },
          childDir,
          { filterExternalAuthProfiles: false },
        );

        const runtime = loadAuthProfileStoreForRuntime(childDir);
        expect(runtime.profiles[profileId]).toMatchObject({ accountId: "account-b" });
        expect(runtime.usageStats?.[profileId]).toBeUndefined();
        expect(runtime.lastGood?.openai).toBeUndefined();
        expect(loadPersistedAuthProfileStore()?.usageStats?.[profileId]).toEqual({
          blockedUntil: now + 60_000,
        });
        expect(loadPersistedAuthProfileStore()?.lastGood?.openai).toBe(profileId);
      },
      { clearOAuthDir: true },
    );
  });

  it("keeps parent non-OAuth credentials while removing provider auth from child scope", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-provider-remove-scope-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openrouter:oauth";
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openrouter",
                access: "child-stale-oauth",
                refresh: "child-stale-refresh",
                expires: Date.now() + 60_000,
              },
              "openrouter:child-token": {
                type: "token",
                provider: "openrouter",
                token: "child-token",
              },
              "anthropic:child-key": {
                type: "api_key",
                provider: "anthropic",
                key: "anthropic-key",
              },
            },
          },
          childDir,
          { filterExternalAuthProfiles: false },
        );
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openrouter",
              access: "main-oauth",
              refresh: "main-refresh",
              expires: Date.now() + 120_000,
            },
            "openrouter:main-key": {
              type: "api_key",
              provider: "openrouter",
              key: "main-key",
            },
          },
        });

        await removeProviderAuthProfilesWithLock({
          provider: "openrouter",
          agentDir: childDir,
        });

        expect(loadPersistedAuthProfileStore()?.profiles).toMatchObject({
          "openrouter:main-key": { type: "api_key", key: "main-key" },
        });
        expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toBeUndefined();
        expect(loadPersistedAuthProfileStore(childDir)?.profiles).toMatchObject({
          "anthropic:child-key": { type: "api_key", key: "anthropic-key" },
        });
        expect(
          loadPersistedAuthProfileStore(childDir)?.profiles["openrouter:child-token"],
        ).toBeUndefined();
        expect(loadPersistedAuthProfileStore(childDir)?.profiles[profileId]).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("serializes a main-owner writer before a child takeover", async () => {
    await withAuthOwnerRaceState(
      async ({ childDir, childPath, mainPath, now, profileId, release, seed, start, worker }) => {
        seed();
        const childHolder = spawnAuthLockHolder(childPath);
        await childHolder.waitFor("locked");
        try {
          const writer = worker("update", now + 300_000);
          await start(writer);
          await waitForSqliteWriteLock(mainPath);
          const takeover = worker("takeover", 0);
          await start(takeover);
          await release(childHolder);
          expect(authRaceResult(await writer.done).ok).toBe(true);
          expect(authRaceResult(await takeover.done).ok).toBe(true);
        } finally {
          if (childHolder.child.exitCode === null) {
            await release(childHolder);
          }
        }
        expect(loadPersistedAuthProfileStore()?.usageStats?.[profileId]?.blockedUntil).toBe(
          now + 300_000,
        );
        expect(loadPersistedAuthProfileStore(childDir)?.usageStats?.[profileId]?.blockedUntil).toBe(
          now + 300_000,
        );
      },
    );
  });

  it("serializes a child-owner update behind a main takeover", async () => {
    await withAuthOwnerRaceState(
      async ({
        childCredential,
        childDir,
        mainPath,
        now,
        profileId,
        release,
        seed,
        start,
        worker,
      }) => {
        seed();
        const mainHolder = spawnAuthLockHolder(mainPath, {
          ...childCredential,
          access: "main-takeover",
          expires: now + 180_000,
        });
        await mainHolder.waitFor("locked");
        const takeoverFollower = worker("update", now + 400_000);
        try {
          await start(takeoverFollower);
          const completedWhileHeld = await Promise.race([
            takeoverFollower.done.then(() => true),
            delay(500).then(() => false),
          ]);
          expect(completedWhileHeld).toBe(false);
          await release(mainHolder);
          expect(authRaceResult(await takeoverFollower.done).ok).toBe(true);
        } finally {
          if (mainHolder.child.exitCode === null) {
            await release(mainHolder);
          }
        }
        expect(loadPersistedAuthProfileStore()?.usageStats?.[profileId]?.blockedUntil).toBe(
          now + 400_000,
        );
        expect(loadPersistedAuthProfileStore(childDir)?.usageStats?.[profileId]).toEqual({
          lastUsed: 1,
        });
      },
    );
  });

  it("times out a child-owner update without mutating the child store while main is locked", async () => {
    await withAuthOwnerRaceState(
      async ({ childDir, mainPath, now, profileId, release, seed, start, worker }) => {
        seed();
        const slowMainHolder = spawnAuthLockHolder(mainPath);
        await slowMainHolder.waitFor("locked");
        const timedOut = worker("update", now + 500_000);
        try {
          await start(timedOut);
          const result = authRaceResult(await timedOut.done);
          expect(result.ok).toBe(false);
          expect(result.elapsedMs).toBeGreaterThanOrEqual(4_500);
        } finally {
          await release(slowMainHolder);
        }
        expect(loadPersistedAuthProfileStore(childDir)?.usageStats?.[profileId]).toEqual({
          lastUsed: 1,
        });
      },
    );
  });

  it("refreshes inherited main selection state without advancing credential ownership", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-main-selection-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        const mainStore = (selected: string): AuthProfileStore => ({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:first": {
              type: "api_key",
              provider: "openai",
              key: "sk-first",
            },
            "openai:second": {
              type: "api_key",
              provider: "openai",
              key: "sk-second",
            },
          },
          order: { openai: [selected] },
        });
        saveAuthProfileStore(mainStore("openai:first"));
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: customAgentDir,
            store: loadAuthProfileStoreForRuntime(customAgentDir),
          },
        ]);
        const credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();

        saveAuthProfileStore(mainStore("openai:second"));

        expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialsRevision);
        expect(getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.order?.openai).toEqual([
          "openai:second",
        ]);
      },
      { clearOAuthDir: true },
    );
  });

  it("rebuilds a derived custom-agent snapshot after locked main OAuth rotation", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-main-inheritance-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        const mainStore = (access: string): AuthProfileStore => ({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access,
              refresh: `refresh-${access}`,
              expires: Date.now() + 60_000,
            },
          },
        });
        saveAuthProfileStore(mainStore("old"));
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "anthropic:custom": {
                type: "api_key",
                provider: "anthropic",
                keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
                key: "sk-custom-resolved",
              },
            },
          },
          customAgentDir,
        );
        const derivedStore = loadAuthProfileStoreForRuntime(customAgentDir);
        const customCredential = derivedStore.profiles["anthropic:custom"];
        if (customCredential?.type !== "api_key") {
          throw new Error("expected custom API-key profile");
        }
        customCredential.key = "sk-custom-resolved";
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: customAgentDir,
            store: derivedStore,
          },
        ]);
        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["openai:default"],
        ).toMatchObject({ access: "old" });

        await upsertAuthProfileWithLock({
          profileId: "openai:default",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "new",
            refresh: "refresh-new",
            expires: Date.now() + 60_000,
          },
        });

        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["openai:default"],
        ).toMatchObject({ access: "new", refresh: "refresh-new" });
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(customAgentDir).profiles[
            "anthropic:custom"
          ],
        ).toMatchObject({
          key: "sk-custom-resolved",
          keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("keeps inherited resolved credentials when publishing a locked custom-agent save", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-custom-publication-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:inherited": {
              type: "api_key",
              provider: "anthropic",
              keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
            },
          },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:local": {
                type: "oauth",
                provider: "openai",
                access: "local-old",
                refresh: "local-refresh-old",
                expires: Date.now() + 60_000,
              },
            },
          },
          customAgentDir,
        );
        const runtimeStore = loadAuthProfileStoreForRuntime(customAgentDir);
        const inherited = runtimeStore.profiles["anthropic:inherited"];
        if (inherited?.type !== "api_key") {
          throw new Error("expected inherited API-key profile");
        }
        inherited.key = "sk-inherited-resolved";
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: customAgentDir, store: runtimeStore },
        ]);

        externalAuthTesting.setResolveExternalAuthProfilesForTest(() => {
          throw new Error("external auth hook must not run during postcommit rebuild");
        });
        try {
          await upsertAuthProfileWithLock({
            agentDir: customAgentDir,
            profileId: "openai:local",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "local-new",
              refresh: "local-refresh-new",
              expires: Date.now() + 120_000,
            },
          });
        } finally {
          externalAuthTesting.resetResolveExternalAuthProfilesForTest();
        }

        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["anthropic:inherited"],
        ).toMatchObject({
          key: "sk-inherited-resolved",
          keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["openai:local"],
        ).toMatchObject({ access: "local-new", refresh: "local-refresh-new" });
      },
      { clearOAuthDir: true },
    );
  });

  it("clears runtime snapshots when postcommit publication throws", () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "sk-runtime" },
          },
        },
      },
    ]);

    expect(
      storeTesting.publishRuntimeSnapshotsAfterCommit(() => {
        throw new Error("postcommit publication failed");
      }),
    ).toBe(false);
    expect(getRuntimeAuthProfileStoreSnapshot()).toBeUndefined();
  });

  it("keeps a direct save committed when postcommit publication throws", async () => {
    await withAuthProfileTestState("openclaw-auth-direct-publication-", async ({ agentDir }) => {
      const store = (key: string): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
        },
      });
      saveAuthProfileStore(store("sk-old"), agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
      ]);
      storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
        publish();
        throw new Error("postcommit publication failed");
      });
      let result: ReturnType<typeof saveAuthProfileStore> = undefined;
      try {
        expect(() => {
          result = saveAuthProfileStore(store("sk-new"), agentDir);
        }).not.toThrow();
      } finally {
        storeTesting.resetRuntimeSnapshotPublisherForTest();
      }

      expect(result).toBeUndefined();
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
    });
  });

  it("publishes a caller-owned database transaction from the supplied store", async () => {
    await withAuthProfileTestState("openclaw-auth-caller-transaction-", async ({ agentDir }) => {
      const store = (key: string): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
          "openai:backup": { type: "api_key", provider: "openai", key: "sk-backup" },
        },
        order: {
          openai:
            key === "sk-old"
              ? ["openai:default", "openai:backup"]
              : ["openai:backup", "openai:default"],
        },
      });
      saveAuthProfileStore(store("sk-old"), agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
      ]);
      const credentialRevision =
        getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision;
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision;

      runAuthProfileWriteTransaction(agentDir, (database) => {
        saveAuthProfileStore(store("sk-new"), agentDir, undefined, database);
      });

      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(
        getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
      ).toMatchObject({ key: "sk-new" });
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.order?.openai).toEqual([
        "openai:backup",
        "openai:default",
      ]);
      expect(getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision).toBeGreaterThan(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision).toBeGreaterThan(
        stateRevision,
      );
    });
  });

  it("preserves derived runtime snapshots on a caller-owned main-store no-op", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-caller-noop-",
      async ({ agentDir, agentDirFor }) => {
        const derivedAgentDir = agentDirFor("worker");
        const mainStore: AuthProfileStore = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "sk-main" },
          },
        };
        saveAuthProfileStore(mainStore, agentDir);
        const derivedStore = loadAuthProfileStoreForRuntime(derivedAgentDir);
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
          { agentDir: derivedAgentDir, store: derivedStore },
        ]);

        runAuthProfileWriteTransaction(agentDir, (database) => {
          saveAuthProfileStore(mainStore, agentDir, undefined, database);
        });

        expect(getRuntimeAuthProfileStoreSnapshot(derivedAgentDir)).toEqual(derivedStore);
      },
    );
  });

  it("drops caller-owned publication when a nested savepoint rolls back", async () => {
    await withAuthProfileTestState("openclaw-auth-caller-savepoint-", async ({ agentDir }) => {
      const initial: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-initial" },
        },
      };
      const candidate: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-candidate" },
        },
      };
      saveAuthProfileStore(initial, agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);

      runAuthProfileWriteTransaction(agentDir, () => {
        expect(() =>
          runAuthProfileWriteTransaction(agentDir, (database) => {
            saveAuthProfileStore(candidate, agentDir, undefined, database);
            throw new Error("rollback savepoint");
          }),
        ).toThrow("rollback savepoint");
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(initial);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toEqual(initial);
    });
  });

  it("rolls back credentials when the state write fails", async () => {
    await withAuthProfileTestState("openclaw-auth-atomic-save-", async ({ agentDir }) => {
      const oldStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:old": { type: "api_key", provider: "openai", key: "sk-old" },
        },
        order: { openai: ["openai:old"] },
      };
      saveAuthProfileStore(oldStore, agentDir);
      const credentialRevision =
        getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision;
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision;
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: resolveAuthProfileDatabasePath(agentDir),
      });
      database.db.exec(`
        CREATE TRIGGER reject_auth_profile_state_update
        BEFORE UPDATE ON auth_profile_state
        BEGIN
          SELECT RAISE(ABORT, 'injected auth state write failure');
        END;
      `);

      expect(() =>
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:new": { type: "api_key", provider: "openai", key: "sk-new" },
            },
            order: { openai: ["openai:new"] },
          },
          agentDir,
        ),
      ).toThrow("injected auth state write failure");
      database.db.exec("DROP TRIGGER reject_auth_profile_state_update;");

      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir)).toMatchObject(oldStore);
      expect(getRuntimeAuthProfileStoreCredentialMutationToken(agentDir).revision).toBe(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision).toBe(stateRevision);
    });
  });

  it("restores materialized and runtime-external snapshot credentials after a temporary write", async () => {
    await withAuthProfileTestState("openclaw-auth-runtime-restore-", async ({ agentDir }) => {
      const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-materialized",
              keyRef,
            },
          },
        },
        agentDir,
      );
      const runtimeStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-materialized",
            keyRef,
          },
          "anthropic:external": {
            type: "oauth",
            provider: "anthropic",
            access: "external-access",
            refresh: "external-refresh",
            expires: Date.now() + 60_000,
          },
        },
        runtimeExternalProfileIds: ["anthropic:external"],
      };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: runtimeStore }]);
      const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot,
        agentDir,
        store: {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:temporary": {
              type: "api_key",
              provider: "openai",
              key: "sk-temporary",
            },
          },
        },
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      const { owned } = committed;
      restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toMatchObject(runtimeStore);
      expect(
        getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
      ).toBeUndefined();
    });
  });

  it.each(["before save", "before publication"] as const)(
    "preserves a runtime-only OAuth mutation %s",
    async (mutationTiming) => {
      await withAuthProfileTestState(
        "openclaw-auth-runtime-edge-ownership-",
        async ({ agentDir }) => {
          const baselineStore: AuthProfileStore = {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:baseline": {
                type: "api_key",
                provider: "openai",
                key: "sk-baseline",
              },
              "anthropic:external": {
                type: "oauth",
                provider: "anthropic",
                access: "external-before-capture",
                refresh: "external-refresh",
                expires: Date.now() + 60_000,
              },
            },
            runtimeExternalProfileIds: ["anthropic:external"],
          };
          saveAuthProfileStore(baselineStore, agentDir);
          replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: baselineStore }]);
          const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

          const mutateRuntimeStore = () => {
            replaceRuntimeAuthProfileStoreSnapshots([
              {
                agentDir,
                store: {
                  ...baselineStore,
                  profiles: {
                    ...baselineStore.profiles,
                    "anthropic:external": {
                      type: "oauth",
                      provider: "anthropic",
                      access: "external-after-capture",
                      refresh: "external-refresh-new",
                      expires: Date.now() + 120_000,
                    },
                  },
                },
              },
            ]);
          };
          if (mutationTiming === "before save") {
            mutateRuntimeStore();
          }
          const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
            snapshot,
            agentDir,
            store: {
              version: AUTH_STORE_VERSION,
              profiles: {
                "openai:temporary": {
                  type: "api_key",
                  provider: "openai",
                  key: "sk-temporary",
                },
              },
            },
          });
          if (mutationTiming === "before publication") {
            storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
              storeTesting.resetRuntimeSnapshotPublisherForTest();
              mutateRuntimeStore();
              publish();
            });
          }
          expect(committed.publishRuntimeSnapshots()).toBe(true);
          const { owned } = committed;

          restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

          expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles).toMatchObject({
            "openai:baseline": { key: "sk-baseline" },
            "anthropic:external": {
              access: "external-after-capture",
              refresh: "external-refresh-new",
            },
          });
          expect(
            getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
          ).toBeUndefined();
        },
        { clearOAuthDir: true },
      );
    },
  );

  it("restores captured and rebuilds newer derived snapshots after main rollback", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-main-derived-rollback-",
      async ({ agentDirFor }) => {
        const capturedAgentDir = agentDirFor("captured");
        const newerAgentDir = agentDirFor("newer");
        const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:baseline": {
              type: "api_key",
              provider: "openai",
              keyRef,
            },
          },
        });
        const capturedRuntime = loadAuthProfileStoreForRuntime(capturedAgentDir);
        const capturedProfile = capturedRuntime.profiles["openai:baseline"];
        if (capturedProfile?.type !== "api_key") {
          throw new Error("expected captured derived API-key profile");
        }
        capturedProfile.key = "sk-captured-resolved";
        capturedRuntime.profiles["anthropic:captured-external"] = {
          type: "oauth",
          provider: "anthropic",
          access: "captured-external-access",
          refresh: "captured-external-refresh",
          expires: Date.now() + 60_000,
        };
        capturedRuntime.runtimeExternalProfileIds = ["anthropic:captured-external"];
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: capturedAgentDir, store: capturedRuntime },
        ]);
        const snapshot = captureAuthProfileStorePersistenceSnapshot();

        const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
          snapshot,
          store: {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:temporary": {
                type: "api_key",
                provider: "openai",
                key: "sk-temporary",
              },
            },
          },
        });
        capturedRuntime.profiles["anthropic:captured-external"] = {
          type: "oauth",
          provider: "anthropic",
          access: "captured-publication-edge-access",
          refresh: "captured-publication-edge-refresh",
          expires: Date.now() + 120_000,
        };
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: capturedAgentDir, store: capturedRuntime },
        ]);
        expect(committed.publishRuntimeSnapshots()).toBe(true);
        const { owned } = committed;
        const ownedCapturedRuntime = getRuntimeAuthProfileStoreSnapshot(capturedAgentDir);
        if (!ownedCapturedRuntime) {
          throw new Error("expected apply-owned derived runtime snapshot");
        }
        expect(ownedCapturedRuntime.profiles["openai:baseline"]).toBeUndefined();
        expect(ownedCapturedRuntime.profiles["anthropic:captured-external"]).toMatchObject({
          access: "captured-publication-edge-access",
          refresh: "captured-publication-edge-refresh",
        });
        const newerRuntime = loadAuthProfileStoreForRuntime(newerAgentDir);
        newerRuntime.profiles["anthropic:newer-external"] = {
          type: "oauth",
          provider: "anthropic",
          access: "newer-external-access",
          refresh: "newer-external-refresh",
          expires: Date.now() + 60_000,
        };
        newerRuntime.runtimeExternalProfileIds = ["anthropic:newer-external"];
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: capturedAgentDir, store: ownedCapturedRuntime },
          { agentDir: newerAgentDir, store: newerRuntime },
        ]);

        restoreAuthProfileStorePersistenceSnapshot(snapshot, owned);

        expect(getRuntimeAuthProfileStoreSnapshot(capturedAgentDir)?.profiles).toMatchObject({
          "openai:baseline": { key: "sk-captured-resolved", keyRef },
          "anthropic:captured-external": {
            access: "captured-publication-edge-access",
            refresh: "captured-publication-edge-refresh",
          },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(capturedAgentDir)?.profiles["openai:temporary"],
        ).toBeUndefined();
        expect(getRuntimeAuthProfileStoreSnapshot(newerAgentDir)?.profiles).toMatchObject({
          "openai:baseline": { keyRef },
          "anthropic:newer-external": { access: "newer-external-access" },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(newerAgentDir)?.profiles["openai:temporary"],
        ).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("tracks state-only saves without advancing credential ownership", async () => {
    await withAuthProfileTestState("openclaw-auth-state-lineage-", async ({ agentDir }) => {
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-stable" },
        },
      };
      saveAuthProfileStore(store, agentDir);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialsRevision();
      const stateRevision = getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision;

      saveAuthProfileStore(
        { ...store, usageStats: { "openai:default": { lastUsed: 42 } } },
        agentDir,
      );

      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialRevision);
      expect(getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision).toBeGreaterThan(
        stateRevision,
      );
    });
  });

  it("marks newly saved runtime snapshot profiles as persisted", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-runtime-persisted-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir,
            store: {
              version: AUTH_STORE_VERSION,
              profiles: {},
            },
          },
        ]);
        try {
          saveAuthProfileStore(
            {
              version: AUTH_STORE_VERSION,
              profiles: {
                "openai:work": {
                  type: "oauth",
                  provider: "openai",
                  access: "access-token",
                  refresh: "refresh-token",
                  expires: Date.now() + 60_000,
                  accountId: "account-123",
                },
              },
            },
            agentDir,
          );

          expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.runtimePersistedProfileIds).toEqual([
            "openai:work",
          ]);
          expect(
            getInternalRuntimeAuthProfileStoreSnapshot(agentDir)?.runtimeLocalProfileIds,
          ).toEqual(["openai:work"]);
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
      { clearOAuthDir: true },
    );
  });

  it("normalizes copied secrets when using the locked upsert path", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-upsert-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });

        await upsertAuthProfileWithLock({
          profileId: "openai:manual",
          credential: {
            type: "token",
            provider: "openai",
            token: "  bearer\r\n-token\u2502  ",
          },
          agentDir,
        });
        await upsertAuthProfileWithLock({
          profileId: "anthropic:key",
          credential: {
            type: "api_key",
            provider: "anthropic",
            key: "  sk-\r\nant\u2502  ",
          },
          agentDir,
        });

        const store = loadAuthProfileStoreWithoutExternalProfiles(
          agentDir,
        ) as RuntimeAuthProfileStore;
        expect(store.runtimePersistedProfileIds).toEqual(["anthropic:key", "openai:manual"]);
        expect(store.runtimeLocalProfileIds).toEqual(["anthropic:key", "openai:manual"]);
        expect(store.runtimeExternalProfileIds).toBeUndefined();
        expect(store.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
        const profiles = store.profiles;
        expect(profiles["openai:manual"]).toMatchObject({
          type: "token",
          provider: "openai",
          token: "bearer-token",
        });
        expect(profiles["anthropic:key"]).toMatchObject({
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("persists openai oauth credentials inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-metadata-", ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "local-access-token",
              refresh: "local-refresh-token",
              idToken: "local-id-token",
              expires,
              email: "dev@example.test",
              accountId: "acct-local",
              chatgptPlanType: "plus",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];

      expectOAuthCredentialFields(credential, {
        provider: "openai",
        access: "local-access-token",
        refresh: "local-refresh-token",
        idToken: "local-id-token",
        expires,
        email: "dev@example.test",
        accountId: "acct-local",
        chatgptPlanType: "plus",
      });
      expect(credential).not.toHaveProperty("oauthRef");
      expect(fs.existsSync(path.join(resolveOAuthDir(), "auth-profiles"))).toBe(false);

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai",
          access: "local-access-token",
          refresh: "local-refresh-token",
          idToken: "local-id-token",
        },
      );
    });
  });

  it("preserves access-only openai oauth credentials inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-access-only-", ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "access-only-token",
              expires,
            } as AuthProfileStore["profiles"][string],
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
      expectOAuthCredentialFields(credential, {
        provider: "openai",
        access: "access-only-token",
        expires,
      });
      expect(credential).not.toHaveProperty("oauthRef");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai",
          access: "access-only-token",
        },
      );
    });
  });

  it("keeps copied openai oauth profiles inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-copy-ref-", ({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const copiedAgentDir = agentDirFor("copied");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(copiedAgentDir, { recursive: true });
      const originalProfileId = "openai:default";
      const copiedProfileId = "openai:copied";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [originalProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "copy-access-token",
              refresh: "copy-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
              copyToAgents: true,
            },
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const originalCredential =
        loadAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[originalProfileId];
      expect(originalCredential?.type).toBe("oauth");
      if (!originalCredential || originalCredential.type !== "oauth") {
        throw new Error("expected original oauth credential");
      }
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [copiedProfileId]: originalCredential,
          },
        },
        copiedAgentDir,
        { filterExternalAuthProfiles: false },
      );

      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {},
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(copiedAgentDir).profiles[copiedProfileId],
        {
          provider: "openai",
          access: "copy-access-token",
          refresh: "copy-refresh-token",
        },
      );
      expect(
        loadPersistedAuthProfileStore(copiedAgentDir)?.profiles[copiedProfileId],
      ).toMatchObject({
        access: "copy-access-token",
        refresh: "copy-refresh-token",
      });
    });
  });

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-promote-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:bunsthedev@gmail.com";
      const staleProfileId = "openai:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          order: {
            openai: [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
      });

      expect(updated?.order?.["openai"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    });
  });

  it("creates a per-agent provider order when relogin has no existing order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-create-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      const primaryProfileId = "openai:primary-login";
      const backupProfileId = "openai:backup-login";
      const unrelatedProfileId = "openai:unrelated-login";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [primaryProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "primary-access",
              refresh: "primary-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
            [backupProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "backup-access",
              refresh: "backup-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [unrelatedProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "unrelated-access",
              refresh: "unrelated-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
        createFromOrder: [backupProfileId, primaryProfileId],
      });

      expect(updated?.order?.["openai"]).toEqual([newProfileId, backupProfileId, primaryProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        backupProfileId,
        primaryProfileId,
      ]);
    });
  });

  it("preserves config-only fallback ids when creating a relogin order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-config-only-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      const existingProfileId = "openai:old-login";
      const configOnlyProfileId = "openai:aws-sdk";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [existingProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "old-access",
              refresh: "old-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
      );

      await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
        createFromOrder: [existingProfileId, configOnlyProfileId],
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        existingProfileId,
        configOnlyProfileId,
      ]);
      saveAuthProfileStore(loadAuthProfileStoreForRuntime(agentDir), agentDir);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        existingProfileId,
        configOnlyProfileId,
      ]);
    });
  });

  it("keeps implicit round-robin when relogin has no existing order by default", async () => {
    await withAuthProfileTestState("openclaw-auth-order-implicit-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai"]).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toBeUndefined();
    });
  });

  it("clears matching lastGood after a stale refresh_token_reused profile", async () => {
    await withAuthProfileTestState("openclaw-auth-clear-lastgood-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const staleProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access-token",
              refresh: "stale-refresh-token",
              expires: Date.now() - 60_000,
            },
          },
          lastGood: { openai: staleProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai",
        profileId: staleProfileId,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    });
  });

  it("clears an inherited main lastGood pointer from requested child scope", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-clear-inherited-lastgood-",
      async ({ agentDirFor }) => {
        const childDir = agentDirFor("child");
        const profileId = "openai:default";
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access-token",
              refresh: "stale-refresh-token",
              expires: Date.now() - 60_000,
            },
          },
          lastGood: { openai: profileId },
        });
        saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles: {} }, childDir);

        await clearLastGoodProfileWithLock({
          agentDir: childDir,
          provider: "openai",
          profileId,
        });

        expect(loadPersistedAuthProfileStore()?.lastGood).toBeUndefined();
        expect(loadPersistedAuthProfileStore(childDir)?.lastGood).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("removes selected profiles while preserving unrelated provider credentials", async () => {
    await withAuthProfileTestState("openclaw-auth-remove-selected-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openrouter:oauth": {
              type: "oauth",
              provider: "openrouter",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
            "openrouter:api-key": {
              type: "api_key",
              provider: "openrouter",
              key: "api-key",
            },
          },
          order: { openrouter: ["openrouter:oauth", "openrouter:api-key"] },
          lastGood: { openrouter: "openrouter:oauth" },
          usageStats: {
            "openrouter:oauth": { lastUsed: 1 },
            "openrouter:api-key": { lastUsed: 2 },
          },
        },
        agentDir,
      );

      await removeAuthProfilesWithLock({
        agentDir,
        profileIds: ["openrouter:oauth"],
      });

      expect(loadAuthProfileStoreForRuntime(agentDir)).toMatchObject({
        profiles: { "openrouter:api-key": expect.any(Object) },
        order: { openrouter: ["openrouter:api-key"] },
        usageStats: { "openrouter:api-key": { lastUsed: 2 } },
      });
      expect(loadAuthProfileStoreForRuntime(agentDir).profiles["openrouter:oauth"]).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    });
  });

  it("does not clear lastGood when the failed profile is not the stored profile", async () => {
    await withAuthProfileTestState("openclaw-auth-clear-lastgood-keep-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const goodProfileId = "openai:user@example.test";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [goodProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "good-access-token",
              refresh: "good-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          lastGood: { openai: goodProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai",
        profileId: "openai:default",
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood?.["openai"]).toBe(goodProfileId);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
