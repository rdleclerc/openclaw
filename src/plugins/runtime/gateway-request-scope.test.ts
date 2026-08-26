// Gateway request scope tests cover request-local plugin runtime context propagation.
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.test-fixtures.js";

const TEST_SCOPE: PluginRuntimeGatewayRequestScope = {
  context: {} as PluginRuntimeGatewayRequestScope["context"],
  isWebchatConnect: (() => false) as PluginRuntimeGatewayRequestScope["isWebchatConnect"],
};

const ACCEPTED = {
  runId: "accepted-run",
  sessionKey: "agent:gaia:slack:channel:C123",
  agentId: "Gaia",
  acceptedAt: 1_700_000_000_000,
  receiptPluginId: "gaia-workflow-preflight" as const,
};

describe("gateway request scope", () => {
  async function importGatewayRequestScopeModule() {
    return await import("./gateway-request-scope.js");
  }

  async function withTestGatewayScope<T>(
    run: (runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>) => Promise<T>,
  ) {
    const runtimeScope = await importGatewayRequestScopeModule();
    return await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      return await run(runtimeScope);
    });
  }

  function expectGatewayScope(
    runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>,
    expected: PluginRuntimeGatewayRequestScope,
  ) {
    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toEqual(expected);
  }

  async function expectPluginIdScopedGatewayScope(pluginId: string) {
    await withPluginIdScope(pluginId, async (runtimeScope) => {
      expectGatewayScope(runtimeScope, {
        ...TEST_SCOPE,
        pluginId,
      });
    });
  }

  async function withPluginIdScope(
    pluginId: string,
    run: (
      runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>,
    ) => Promise<void>,
  ) {
    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimePluginIdScope(pluginId, async () => {
        await run(runtimeScope);
      });
    });
  }

  it("reuses AsyncLocalStorage across reloaded module instances", async () => {
    const first = await importGatewayRequestScopeModule();

    await first.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      vi.resetModules();
      const second = await importGatewayRequestScopeModule();
      expectGatewayScope(second, TEST_SCOPE);
    });
  });

  it("attaches plugin id to the active scope", async () => {
    await expectPluginIdScopedGatewayScope("voice-call");
  });

  it("keeps normal acceptance binding behind the exact Gaia plugin scope", async () => {
    await withTestGatewayScope(async (runtimeScope) => {
      expect(() => runtimeScope.bindGaiaAcceptedEnvelope(ACCEPTED)).toThrow(
        "exact gaia-workflow-preflight plugin scope",
      );
      await runtimeScope.withPluginRuntimePluginIdScope("gaia-workflow-preflight", async () =>
        runtimeScope.bindGaiaAcceptedEnvelope(ACCEPTED),
      );
      expect(runtimeScope.readGaiaAcceptedEnvelope()).toMatchObject({
        runId: ACCEPTED.runId,
        agentId: "gaia",
      });
    });
  });

  it("allows recovered acceptance only from the unowned host scope", async () => {
    await withTestGatewayScope(async (runtimeScope) => {
      expect(() => runtimeScope.bindGaiaRecoveredAcceptedEnvelope(ACCEPTED)).not.toThrow();
      expect(runtimeScope.readGaiaRecoveredAcceptedEnvelope()).toMatchObject({
        runId: ACCEPTED.runId,
        agentId: "gaia",
      });
    });

    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimePluginIdScope("gaia-workflow-preflight", async () => {
        expect(() => runtimeScope.bindGaiaRecoveredAcceptedEnvelope(ACCEPTED)).toThrow(
          "host gateway request scope",
        );
      });
    });

    await runtimeScopeForHostClient("other-plugin");
  });

  async function runtimeScopeForHostClient(pluginRuntimeOwnerId: string) {
    const runtimeScope = await importGatewayRequestScopeModule();
    await runtimeScope.withPluginRuntimeGatewayRequestScope(
      {
        ...TEST_SCOPE,
        client: { internal: { pluginRuntimeOwnerId } } as never,
      },
      async () => {
        expect(() => runtimeScope.bindGaiaRecoveredAcceptedEnvelope(ACCEPTED)).toThrow(
          "host gateway request scope",
        );
      },
    );
  }
});
