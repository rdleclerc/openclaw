// Coverage for cron before_agent_reply hook handling before embedded attempts.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE } from "../harness/terminal-finalization-error.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function firstBeforeAgentReplyCall() {
  // Helper keeps assertions on the hook payload and context close to the tests
  // without leaking mock tuple details into every case.
  const call = mockedGlobalHookRunner.runBeforeAgentReply.mock.calls[0];
  if (!call) {
    throw new Error("expected before_agent_reply hook call");
  }
  return call;
}

function firstAttemptParams(): {
  cleanupBundleMcpOnRunEnd?: boolean;
  disableTrajectory?: boolean;
  modelRun?: boolean;
  promptMode?: string;
  promptCacheKey?: string;
  suppressLiveStreamOutput?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[0] as
    | [
        {
          cleanupBundleMcpOnRunEnd?: boolean;
          disableTrajectory?: boolean;
          modelRun?: boolean;
          promptMode?: string;
          promptCacheKey?: string;
          suppressLiveStreamOutput?: boolean;
        },
      ]
    | undefined;
  if (!call) {
    throw new Error("expected embedded attempt call");
  }
  return call[0];
}

describe("runEmbeddedAgent cron before_agent_reply seam", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    // Cron hooks can fully handle maintenance prompts before the model is
    // invoked, which avoids unnecessary prompt-cache and setup work.
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName: string) =>
      ["before_agent_reply", "agent_end"].includes(hookName),
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const onExecutionPhase = vi.fn();

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
      externalContentSource: "gmail",
      currentMessageId: "gmail-message-123",
      onExecutionPhase,
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    const [hookPayload, hookContext] = firstBeforeAgentReplyCall();
    expect(hookPayload).toEqual({
      cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
    });
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionId).toBe("test-session");
    expect(hookContext?.sessionKey).toBe("test-key");
    expect(hookContext?.workspaceDir).toBe("/tmp/workspace");
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.externalContentSource).toBe("gmail");
    expect(hookContext?.messageId).toBe("gmail-message-123");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(mockedGlobalHookRunner.runAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({
        externalContentSource: "gmail",
        messageId: "gmail-message-123",
      }),
      {
        unrefTimeout: false,
        requiredForExternalContentSource: "gmail",
        awaitOnlyRequired: true,
      },
    );
    expect(mockedGlobalHookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("fails a handled Gmail cron turn when the trusted message identity is missing", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName: string) =>
      ["before_agent_reply", "agent_end"].includes(hookName),
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });

    const result = runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "The prose mentions gmail-message-from-prompt, but it is not trusted.",
      externalContentSource: "gmail",
    });

    await expect(result).rejects.toMatchObject({
      name: "AgentEndTerminalFinalizationError",
      code: AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE,
    });
    await expect(result).rejects.toThrow(
      "required agent_end handler missing host-owned message identity",
    );
    expect(mockedGlobalHookRunner.runAgentEnd).not.toHaveBeenCalled();
  });

  it("fails a handled Gmail cron turn when the required handler is missing", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName: string) =>
      ["before_agent_reply", "agent_end"].includes(hookName),
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const runAgentEnd = mockedGlobalHookRunner.runAgentEnd;
    Reflect.set(mockedGlobalHookRunner, "runAgentEnd", undefined);
    try {
      const result = runEmbeddedAgent({
        ...overflowBaseRunParams,
        trigger: "cron",
        jobId: "cron-job-123",
        externalContentSource: "gmail",
        currentMessageId: "gmail-message-123",
      });

      await expect(result).rejects.toMatchObject({
        name: "AgentEndTerminalFinalizationError",
        code: AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE,
      });
      await expect(result).rejects.toThrow(
        "required agent_end handler missing for external content source: gmail",
      );
    } finally {
      Reflect.set(mockedGlobalHookRunner, "runAgentEnd", runAgentEnd);
    }
  });

  it("surfaces a handled Gmail finalizer failure to the owning cron run", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName: string) =>
      ["before_agent_reply", "agent_end"].includes(hookName),
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    mockedGlobalHookRunner.runAgentEnd.mockRejectedValueOnce(new Error("Gmail finalizer failed"));

    const result = runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      externalContentSource: "gmail",
      currentMessageId: "gmail-message-123",
    });

    await expect(result).rejects.toMatchObject({
      name: "AgentEndTerminalFinalizationError",
      code: AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE,
    });
    await expect(result).rejects.toThrow("Gmail finalizer failed");
    expect(mockedGlobalHookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("does not emit agent_end for a handled cron turn without a typed external source", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName: string) =>
      ["before_agent_reply", "agent_end"].includes(hookName),
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "handled" },
    });

    await runEmbeddedAgent({ ...overflowBaseRunParams, trigger: "cron" });

    expect(mockedGlobalHookRunner.runAgentEnd).not.toHaveBeenCalled();
  });

  it("keeps explicit webhook provenance on a handled Gmail-looking cron key", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((hookName: string) =>
      ["before_agent_reply", "agent_end"].includes(hookName),
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "handled" },
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      sessionKey: "hook:gmail:message-123",
      externalContentSource: "webhook",
    });

    expect(mockedGlobalHookRunner.runAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({
        sessionKey: "hook:gmail:message-123",
        externalContentSource: "webhook",
      }),
      expect.anything(),
    );
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
    });

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("re-arms setup progress when a cron hook does not claim", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "runtime_plugins" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not invoke before_agent_reply for non-cron embedded runs", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("forwards one-shot auxiliary-run flags into the embedded attempt", async () => {
    // Auxiliary-run flags are request-scoped; they must pass through to the
    // first attempt without becoming persistent session settings.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      disableTrajectory: true,
      modelRun: true,
      promptMode: "none",
    });

    const attemptParams = firstAttemptParams();
    expect(attemptParams.disableTrajectory).toBe(true);
    expect(attemptParams.modelRun).toBe(true);
    expect(attemptParams.promptMode).toBe("none");
  });

  it("forwards one-shot bundle MCP cleanup into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(firstAttemptParams().cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("forwards prompt cache identity into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      promptCacheKey: "cron-cache-key",
    });

    expect(firstAttemptParams().promptCacheKey).toBe("cron-cache-key");
  });

  it("forwards suppressed live stream output into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      suppressLiveStreamOutput: true,
    });

    expect(firstAttemptParams().suppressLiveStreamOutput).toBe(true);
  });
});
