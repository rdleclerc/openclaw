import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { AUTH_STORE_VERSION } from "../../auth-profiles/constants.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../../auth-profiles/store.js";
import { testing as authPlanTesting } from "./auth-plan.test-support.js";

describe("embedded run auth profile loading", () => {
  let stateDir: string | undefined;

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("reloads a durable OAuth profile when the gateway snapshot is stale", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "openclaw-embedded-auth-store-"));
    const agentDir = join(stateDir, "agents", "main", "agent");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access: "test-access",
              refresh: "test-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
          order: { openai: ["openai:default"] },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: { version: AUTH_STORE_VERSION, profiles: {} } },
      ]);

      const staleStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
        externalCliProviderIds: ["openai"],
        readOnly: true,
      });
      expect(staleStore.profiles["openai:default"]).toBeUndefined();

      const loadedStore = authPlanTesting.loadEmbeddedRunAuthProfileStore({
        agentDir,
        config: {},
        externalCliProviderIds: ["openai"],
      });
      expect(loadedStore.profiles["openai:default"]).toMatchObject({
        type: "oauth",
        provider: "openai",
      });
    });
  });
});
