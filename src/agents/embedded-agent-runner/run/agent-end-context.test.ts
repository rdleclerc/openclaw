import { describe, expect, it, vi } from "vitest";
import { awaitAgentHarnessAgentEndHook } from "../../harness/lifecycle-hook-helpers.js";
import { buildEmbeddedAgentEndContext } from "./agent-end-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const SOURCES = ["gmail", "webhook"] as const;

function makeRun(externalContentSource: (typeof SOURCES)[number]): EmbeddedRunAttemptParams {
  return {
    runId: `cron-${externalContentSource}`,
    sessionId: `session-${externalContentSource}`,
    sessionKey: `cron:${externalContentSource}`,
    workspaceDir: "/workspace",
    provider: "openai",
    modelId: "gpt-5.4",
    trigger: "cron",
    externalContentSource,
  } as EmbeddedRunAttemptParams;
}

describe("buildEmbeddedAgentEndContext", () => {
  it.each(SOURCES)("preserves cron externalContentSource=%s for agent_end", async (source) => {
    const run = makeRun(source);
    const event = {
      messages: [],
      success: true,
    } as never;
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(async () => undefined),
    };

    await awaitAgentHarnessAgentEndHook({
      event,
      ctx: buildEmbeddedAgentEndContext({
        run,
        agentId: "main",
        trace: { traceId: "trace-1" },
        skillWorkshopAvailable: false,
        compacted: false,
      }),
      hookRunner: hookRunner as never,
    });

    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ trigger: "cron", externalContentSource: source }),
      { unrefTimeout: false },
    );
  });
});
