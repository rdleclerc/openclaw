/** Test-only helpers for exercising plugin hook behavior. */
import type { HookExternalContentSource } from "../security/external-content.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-helpers.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";

export { addTestHook, createMockPluginRegistry };
export type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
} from "./hook-types.js";
export type PluginTargetedInboundClaimOutcome = Awaited<
  ReturnType<ReturnType<typeof createHookRunner>["runInboundClaimForPluginOutcome"]>
>;

export const TEST_PLUGIN_AGENT_CTX: PluginHookAgentContext = {
  runId: "test-run-id",
  agentId: "test-agent",
  sessionKey: "test-session",
  sessionId: "test-session-id",
  workspaceDir: "/tmp/openclaw-test",
  messageProvider: "test",
};

export function addStaticTestHooks<TResult>(
  registry: PluginRegistry,
  params: {
    hookName: PluginHookRegistration["hookName"];
    hooks: ReadonlyArray<{
      pluginId: string;
      result: TResult;
      priority?: number;
      handler?: () => TResult | Promise<TResult>;
      requiredForExternalContentSource?: HookExternalContentSource;
    }>;
  },
) {
  for (const {
    pluginId,
    result,
    priority,
    handler,
    requiredForExternalContentSource,
  } of params.hooks) {
    addTestHook({
      registry,
      pluginId,
      hookName: params.hookName,
      handler: (handler ?? (() => result)) as PluginHookRegistration["handler"],
      ...(priority !== undefined ? { priority } : {}),
      ...(requiredForExternalContentSource ? { requiredForExternalContentSource } : {}),
    });
  }
}

export function createHookRunnerWithRegistry(
  hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
    priority?: number;
    timeoutMs?: number;
  }>,
  options?: Parameters<typeof createHookRunner>[1],
) {
  const registry = createMockPluginRegistry(hooks);
  return {
    registry,
    runner: createHookRunner(registry, options),
  };
}
