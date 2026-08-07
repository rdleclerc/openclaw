import { describe, expect, it, vi } from "vitest";
import { awaitAgentHarnessAgentEndHook } from "../harness/lifecycle-hook-helpers.js";
import { buildCliAgentHookContext } from "./hook-context.js";

const SOURCES = [
  { externalContentSource: "gmail", sessionKey: "hook:gmail:message-1" },
  { externalContentSource: "webhook", sessionKey: "hook:gmail:message-2" },
] as const;

describe("buildCliAgentHookContext", () => {
  it.each(SOURCES)(
    "passes typed $externalContentSource provenance to agent_end",
    async ({ externalContentSource, sessionKey }) => {
      const event = { messages: [], success: true } as never;
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
        runAgentEnd: vi.fn(async () => undefined),
      };

      await awaitAgentHarnessAgentEndHook({
        event,
        ctx: buildCliAgentHookContext({
          run: {
            runId: `run-${externalContentSource}`,
            sessionId: `session-${externalContentSource}`,
            sessionKey,
            workspaceDir: "/workspace",
            trigger: "cron",
            externalContentSource,
          },
        }),
        hookRunner: hookRunner as never,
      });

      expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          trigger: "cron",
          externalContentSource,
        }),
        { unrefTimeout: false },
      );
    },
  );
});
