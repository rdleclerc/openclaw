/**
 * Tests mirroring refreshed OAuth credentials to the main store.
 * Protects identity checks and persistence behavior when sub-agents refresh a
 * shared profile.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { resetOAuthRefreshQueuesForTest } from "./oauth.test-support.js";
import { resolveAuthProfileOrder } from "./order.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./store.js";
import { testing as storeTesting } from "./store.test-support.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

function expectPersistedOpenAICodexProfile(
  credential: AuthProfileStore["profiles"][string],
  metadata: Record<string, unknown> = {},
): void {
  expect(credential?.type).toBe("oauth");
  expect(credential?.provider).toBe("openai");
  for (const [key, value] of Object.entries(metadata)) {
    expect((credential as Record<string, unknown> | undefined)?.[key]).toEqual(value);
  }
}

function requireOAuthCredential(store: AuthProfileStore, profileId: string): OAuthCredential {
  const profile = store.profiles[profileId];
  if (!profile || profile.type !== "oauth") {
    throw new Error(`expected OAuth credential for ${profileId}`);
  }
  return profile;
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthProviders: () => [{ id: "anthropic" }, { id: "openai" }],
  getOAuthApiKey: vi.fn(async (provider: string, credentials: Record<string, OAuthCredential>) => {
    const credential = credentials[provider];
    return credential
      ? {
          apiKey: credential.access,
          newCredentials: credential,
        }
      : null;
  }),
}));

describe("resolveApiKeyForProfile OAuth refresh mirror-to-main (#26322)", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let caseIndex = 0;
  let mainAgentDir = "";

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-mirror-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
    clearRuntimeAuthProfileStoreSnapshots();
    caseIndex += 1;
    const caseRoot = path.join(tempRoot, `case-${caseIndex}`);
    mainAgentDir = await createOAuthMainAgentDir(caseRoot);
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    storeTesting.resetRuntimeSnapshotPublisherForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("mirrors refreshed Codex OAuth credentials into the main store", async () => {
    const profileId = "openai:default";
    const backupId = "openai:backup";
    const provider = "openai";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    const blockedUntil = Date.now() + 30 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-mirror", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    const childStore = createExpiredOauthStore({ profileId, provider, accountId });
    requireOAuthCredential(childStore, profileId).expires = Date.now() - 30_000;
    childStore.usageStats = {
      [profileId]: { blockedUntil, blockedReason: "subscription_limit", blockedSource: "wham" },
    };
    childStore.lastGood = { openai: profileId };
    const mainStore = createExpiredOauthStore({ profileId, provider, accountId });
    requireOAuthCredential(mainStore, profileId).expires = Date.now() - 60_000;
    mainStore.profiles[backupId] = {
      type: "oauth",
      provider,
      access: "backup-access",
      refresh: "backup-refresh",
      expires: freshExpiry,
      accountId: "acct-backup",
    };
    mainStore.order = { openai: [profileId, backupId] };
    saveAuthProfileStore(childStore, subAgentDir);
    saveAuthProfileStore(mainStore, mainAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main store should now carry refreshed metadata, so a peer agent
    // starting fresh can resolve the runtime credential without token races.
    const mainRaw = readAuthProfileStoreForTest(mainAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(mainRaw.profiles[profileId], "mainRaw.profiles[profileId] test invariant"),
      {
        access: "sub-refreshed-access",
        refresh: "sub-refreshed-refresh",
        expires: freshExpiry,
        accountId,
      },
    );
    expect(mainRaw.usageStats?.[profileId]).toEqual(childStore.usageStats[profileId]);
    expect(mainRaw.lastGood?.openai).toBe(profileId);
    expect(readAuthProfileStoreForTest(subAgentDir).usageStats?.[profileId]).toEqual(
      childStore.usageStats[profileId],
    );
    const effective = loadAuthProfileStoreForRuntime(subAgentDir);
    expect(effective.usageStats?.[profileId]?.blockedUntil).toBe(blockedUntil);
    expect(resolveAuthProfileOrder({ store: effective, provider })).toEqual([backupId, profileId]);
  });

  it("reads child credential and lifecycle state under one nested transaction before mirroring", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    const subAgentDir = path.join(tempRoot, "agents", "sub-locked-snapshot", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    const childStore = createExpiredOauthStore({ profileId, provider, accountId });
    requireOAuthCredential(childStore, profileId).expires = Date.now() - 30_000;
    childStore.usageStats = { [profileId]: { lastUsed: 1 } };
    const mainStore = createExpiredOauthStore({ profileId, provider, accountId });
    requireOAuthCredential(mainStore, profileId).expires = Date.now() - 60_000;
    saveAuthProfileStore(childStore, subAgentDir);
    saveAuthProfileStore(mainStore, mainAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      type: "oauth",
      provider,
      access: "first-refresh-access",
      refresh: "first-refresh-token",
      expires: freshExpiry,
      accountId,
    } as never);

    const runtimeStore = ensureAuthProfileStore(subAgentDir);
    const markerPath = path.join(tempRoot, `child-writer-${caseIndex}.locked`);
    let intercepted = false;
    let writerDone: Promise<void> | undefined;
    storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
      publish();
      if (intercepted) return;
      intercepted = true;
      const writer = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { writeFileSync } from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.env.AUTH_CHILD_DATABASE_PATH);
        database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
        const storeRow = database.prepare(
          "SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'",
        ).get();
        const stateRow = database.prepare(
          "SELECT state_json FROM auth_profile_state WHERE state_key = 'primary'",
        ).get();
        const store = JSON.parse(storeRow.store_json);
        const state = JSON.parse(stateRow.state_json);
        store.profiles[process.env.AUTH_PROFILE_ID] = JSON.parse(process.env.AUTH_ADVANCED_CREDENTIAL);
        state.usageStats = {
          ...(state.usageStats ?? {}),
          [process.env.AUTH_PROFILE_ID]: { blockedUntil: Number(process.env.AUTH_BLOCKED_UNTIL) },
        };
        database.prepare(
          "UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = 'primary'",
        ).run(JSON.stringify(store), Date.now());
        database.prepare(
          "UPDATE auth_profile_state SET state_json = ?, updated_at = ? WHERE state_key = 'primary'",
        ).run(JSON.stringify(state), Date.now());
        writeFileSync(process.env.AUTH_LOCKED_MARKER, "locked");
        setTimeout(() => {
          database.exec("COMMIT");
          database.close();
        }, 500);
      `,
        ],
        {
          env: {
            ...process.env,
            AUTH_CHILD_DATABASE_PATH: resolveAuthProfileDatabasePath(subAgentDir),
            AUTH_PROFILE_ID: profileId,
            AUTH_ADVANCED_CREDENTIAL: JSON.stringify({
              type: "oauth",
              provider,
              access: "second-refresh-access",
              refresh: "second-refresh-token",
              expires: freshExpiry + 60_000,
              accountId,
            }),
            AUTH_BLOCKED_UNTIL: String(Date.now() + 30 * 60 * 1000),
            AUTH_LOCKED_MARKER: markerPath,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      writer.stderr?.setEncoding("utf8");
      writer.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      writerDone = new Promise((resolve, reject) => {
        writer.once("error", reject);
        writer.once("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`child writer exited ${code}: ${stderr}`));
        });
      });
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 5_000;
      while (!existsSync(markerPath) && Date.now() < deadline) {
        Atomics.wait(waitArray, 0, 0, 10);
      }
      if (!existsSync(markerPath)) throw new Error("child writer did not acquire its transaction");
    });

    const startedAt = Date.now();
    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: runtimeStore,
      profileId,
      agentDir: subAgentDir,
    });
    await writerDone;

    expect(intercepted).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    expect(result?.apiKey).toBe("first-refresh-access");
    expect(requireOAuthCredential(readAuthProfileStoreForTest(subAgentDir), profileId).access).toBe(
      "second-refresh-access",
    );
    expect(
      requireOAuthCredential(readAuthProfileStoreForTest(mainAgentDir), profileId).access,
    ).toBe("cached-access-token");
  });

  it("does not mirror when refresh was performed from the main agent itself", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, access: "main-stale-access" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "main-refreshed-access",
          refresh: "main-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    // Main-agent refresh uses undefined agentDir; the mirror path is a no-op
    // (local == main). Just make sure the main store still reflects the refresh
    // and no double-write happens.
    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(undefined),
      profileId,
      agentDir: undefined,
    });

    expect(result?.apiKey).toBe("main-refreshed-access");
    const mainRaw = readAuthProfileStoreForTest(mainAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(mainRaw.profiles[profileId], "mainRaw.profiles[profileId] test invariant"),
      {
        access: "main-refreshed-access",
        refresh: "main-refreshed-refresh",
        expires: freshExpiry,
      },
    );
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("inherits main-agent credentials via the pre-refresh adopt path when main is already fresher", async () => {
    // Exercises adoptNewerMainOAuthCredential at the top of
    // resolveApiKeyForProfile: main is fresher at flow start, so we adopt
    // BEFORE the refresh attempt. End-user outcome: sub transparently uses
    // main's creds.
    const profileId = "openai:default";
    const provider = "openai";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-fail-inherit", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-fresh-access",
            refresh: "main-fresh-refresh",
            expires: freshExpiry,
            accountId: "acct-shared",
          },
        },
      },
      mainAgentDir,
    );

    // Refresh mock intentionally left as default-undefined — it should not
    // be called, the pre-refresh adopt wins.
    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-fresh-access");
    expect(result?.provider).toBe(provider);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("answers app-server forced refresh from fresh main credentials when a sub-agent copy is expired", async () => {
    const profileId = "openai:peter@example.test";
    const provider = "openai";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-app-server-force", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-shared",
        email: "peter@example.test",
      }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-fresh-access",
            refresh: "main-fresh-refresh",
            expires: freshExpiry,
            accountId: "acct-shared",
            email: "peter@example.test",
          },
        },
      },
      mainAgentDir,
    );

    const store = ensureAuthProfileStore(subAgentDir);
    const credential = store.profiles[profileId];
    if (!credential || credential.type !== "oauth") {
      throw new Error("expected seeded OAuth profile");
    }
    store.profiles[profileId] = { ...credential, expires: 0 };
    saveAuthProfileStore(store, subAgentDir);

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store,
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-fresh-access");
    expect(result?.provider).toBe(provider);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("refreshes the main owner when a stale local OAuth clone shadows a newer main credential", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    const accountId = "acct-shared";
    const now = Date.now();
    const freshExpiry = now + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-stale-clone-owner", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "local-stale-access",
            refresh: "local-stale-refresh",
            expires: now - 120_000,
            accountId,
          },
        },
      },
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-expired-access",
            refresh: "main-owner-refresh",
            expires: now - 60_000,
            accountId,
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => {
        const credential = params?.context as OAuthCredential | undefined;
        expect(credential?.refresh).toBe("main-owner-refresh");
        return {
          access: "main-owner-refreshed-access",
          refresh: "main-owner-refreshed-refresh",
          expires: freshExpiry,
        } as never;
      },
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-owner-refreshed-access");
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);

    const subRaw = readAuthProfileStoreForTest(subAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(subRaw.profiles[profileId], "subRaw.profiles[profileId] test invariant"),
      {
        access: "local-stale-access",
        refresh: "local-stale-refresh",
        expires: now - 120_000,
        accountId,
      },
    );

    const mainRaw = readAuthProfileStoreForTest(mainAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(mainRaw.profiles[profileId], "mainRaw.profiles[profileId] test invariant"),
      {
        access: "main-owner-refreshed-access",
        refresh: "main-owner-refreshed-refresh",
        expires: freshExpiry,
        accountId,
      },
    );
  });

  it("inherits main-agent credentials via the catch-block fallback when refresh throws after main becomes fresh", async () => {
    // Exercises the specific catch-block `if (params.agentDir) { mainStore … }`
    // branch (lines 826-848 in oauth.ts). Setup:
    //   1. sub + main BOTH expired at the start of resolveApiKeyForProfile,
    //      so adoptNewerMainOAuthCredential does not short-circuit.
    //   2. Inside refreshOAuthTokenWithLock, the plugin refresh mock writes
    //      fresh credentials into the main store and then throws a non-
    //      refresh_token_reused error. This simulates "another process
    //      completed a refresh just as ours failed".
    //   3. The catch block's loadFreshStoredOAuthCredential reads the sub
    //      store (still expired). Then the main-agent-inherit fallback
    //      kicks in and returns main's fresh creds read-through without copying
    //      the refresh token into the sub store.
    const profileId = "openai:default";
    const provider = "openai";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-catch-inherit", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Simulate another agent completing its refresh and writing fresh
      // creds to main, concurrent with our attempt.
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider,
              access: "main-side-refreshed-access",
              refresh: "main-side-refreshed-refresh",
              expires: freshExpiry,
              accountId: "acct-shared",
            },
          },
        },
        mainAgentDir,
      );
      // Now throw a non-refresh_token_reused error so we fall through the
      // recovery branches into the catch-block main-agent inherit.
      throw new Error("upstream 503 service unavailable");
    });

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-side-refreshed-access");
    expect(result?.provider).toBe(provider);

    // Sub-agent's store keeps its local expired credential; inherited OAuth is read-through.
    const subRaw = readAuthProfileStoreForTest(subAgentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(subRaw.profiles[profileId], "subRaw.profiles[profileId] test invariant"),
      {
        access: "cached-access-token",
        refresh: "refresh-token",
        accountId: "acct-shared",
      },
    );
  });

  it("does not satisfy forced refresh from unchanged main-agent credentials after refresh fails", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    const accountId = "acct-shared";

    const subAgentDir = path.join(tempRoot, "agents", "sub-force-catch", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-existing-access",
            refresh: "main-existing-refresh",
            expires: Date.now() + 60 * 60 * 1000,
            accountId,
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async (params) => {
      const context = params?.context as OAuthCredential;
      expect(context.access).toBe("main-existing-access");
      throw new Error("upstream 503 service unavailable");
    });

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("mirrors refreshed credentials produced by the plugin-refresh path", async () => {
    // The plugin-refreshed branch in doRefreshOAuthTokenWithLock has its own
    // mirror call; cover it separately so the branch is not orphaned.
    const profileId = "anthropic:plugin";
    const unrelatedId = "openai:unrelated";
    const provider = "anthropic";
    const accountId = "acct-plugin";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-plugin", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    const childStore = createExpiredOauthStore({ profileId, provider, accountId });
    requireOAuthCredential(childStore, profileId).expires = Date.now() - 30_000;
    const mainStore = createExpiredOauthStore({ profileId, provider, accountId });
    requireOAuthCredential(mainStore, profileId).expires = Date.now() - 60_000;
    mainStore.profiles[unrelatedId] = { type: "api_key", provider: "openai", key: "fixture" };
    mainStore.usageStats = { [profileId]: { lastUsed: 1 }, [unrelatedId]: { lastUsed: 9 } };
    mainStore.lastGood = { anthropic: profileId, openai: unrelatedId };
    mainStore.order = { openai: [unrelatedId] };
    saveAuthProfileStore(childStore, subAgentDir);
    saveAuthProfileStore(mainStore, mainAgentDir);

    // Plugin returns a truthy refreshed credential — this takes the plugin
    // branch instead of falling through to getOAuthApiKey.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          access: "plugin-refreshed-access",
          refresh: "plugin-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("plugin-refreshed-access");

    // Main store must have been mirrored from the plugin-refresh branch.
    const mainRaw = readAuthProfileStoreForTest(mainAgentDir);
    const mainCredential = requireOAuthCredential(mainRaw, profileId);
    expect(mainCredential.access).toBe("plugin-refreshed-access");
    expect(mainCredential.refresh).toBe("plugin-refreshed-refresh");
    expect(mainCredential.expires).toBe(freshExpiry);
    expect(mainRaw.usageStats?.[profileId]).toBeUndefined();
    expect(mainRaw.lastGood?.anthropic).toBeUndefined();
    expect(mainRaw.usageStats?.[unrelatedId]).toEqual({ lastUsed: 9 });
    expect(mainRaw.lastGood?.openai).toBe(unrelatedId);
    expect(mainRaw.order?.openai).toEqual([unrelatedId]);
  });
});
