import {
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  runAgentCleanupStep,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { scheduleCodexNativeHookRelayUnregister } from "./native-hook-relay.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export type CodexRequiredCleanupFailure = { error: unknown };

export async function runCodexRequiredCleanupStep(
  params: Parameters<typeof runAgentCleanupStep>[0],
): Promise<CodexRequiredCleanupFailure | undefined> {
  const state: { value: "pending" | "completed" | "failed" } = { value: "pending" };
  let error: unknown;
  await runAgentCleanupStep({
    ...params,
    cleanup: async () => {
      try {
        await params.cleanup();
        state.value = "completed";
      } catch (cause) {
        state.value = "failed";
        error = cause;
        throw cause;
      }
    },
  });
  if (state.value === "completed") return undefined;
  return {
    error:
      state.value === "failed" ? error : new Error(`agent cleanup timed out: step=${params.step}`),
  };
}

export async function cleanupCodexAttempt(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
  activeTurn?: CodexAttemptActiveTurn,
) {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    releaseCurrentRoute,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, options, runAbortController, abortFromUpstream, terminalState } = connection;
  const { state, steeringQueueRef, userInputBridgeRef, turnWatches } = turnRuntime;
  const {
    maybeEmitFastModeAutoResetBestEffort,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
  } = lifecycle;
  const { codexModelCallDiagnostics } = requestRuntime;
  const activeTurnId = activeTurn?.activeTurnId ?? turnRuntime.turnIdRef.current ?? "unknown";
  const abortListener = activeTurn?.abortListener;
  const handle = activeTurn?.handle;
  const freezeRunTerminalOutcome =
    activeTurn?.freezeRunTerminalOutcome ??
    (() => {
      if (terminalState.terminalOutcomeFrozen) {
        return;
      }
      terminalState.terminalOutcomeFrozen = true;
      params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    });
  let firstRequiredCleanupFailure: CodexRequiredCleanupFailure | undefined;
  const runRequiredCleanupStep = async (
    step: string,
    cleanup: () => Promise<void>,
  ): Promise<void> => {
    const failure = await runCodexRequiredCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step,
      log: embeddedAgentLog,
      cleanup,
    });
    if (failure !== undefined && firstRequiredCleanupFailure === undefined) {
      firstRequiredCleanupFailure = failure;
    }
  };
  if (params.isFinalFallbackAttempt !== false) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-fast-mode-auto-reset",
      log: embeddedAgentLog,
      cleanup: maybeEmitFastModeAutoResetBestEffort,
    });
  }
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-model-call-diagnostics-error",
    log: embeddedAgentLog,
    cleanup: async () => {
      codexModelCallDiagnostics.emitError(
        "codex app-server run completed without model-call terminal event",
      );
    },
  });
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-lifecycle-terminal",
    log: embeddedAgentLog,
    cleanup: async () => {
      emitLifecycleTerminal({
        phase: "error",
        error: "codex app-server run completed without lifecycle terminal event",
        ...buildLifecycleTerminalMeta({
          aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
          timedOut: state.timedOut,
        }),
      });
    },
  });
  if (trajectoryRecorder && !resourceState.trajectoryEndRecorded) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-trajectory-record-end",
      log: embeddedAgentLog,
      cleanup: async () => {
        trajectoryRecorder.recordEvent("session.ended", {
          status:
            state.timedOut || (runAbortController.signal.aborted && !state.clientClosedAbort)
              ? "interrupted"
              : "cleanup",
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          timedOut: state.timedOut,
          aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
        });
      },
    });
  }
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-trajectory-flush",
    log: embeddedAgentLog,
    cleanup: async () => trajectoryRecorder?.flush(),
  });
  if (!state.timedOut && !runAbortController.signal.aborted) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-steering-flush",
      log: embeddedAgentLog,
      cleanup: async () => steeringQueueRef.current?.flushPending(),
    });
  }
  if (!state.timedOut) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-thread-unsubscribe",
      log: embeddedAgentLog,
      cleanup: async () => {
        await unsubscribeCodexThreadBestEffort(resourceState.client, {
          threadId: resourceState.thread.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
      },
    });
  }
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-user-input-cancel",
    log: embeddedAgentLog,
    cleanup: async () => userInputBridgeRef.current?.cancelPending(),
  });
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-turn-watches-clear",
    log: embeddedAgentLog,
    cleanup: async () => turnWatches.clearAllTimers(),
  });
  await runRequiredCleanupStep("codex-route-release", async () => releaseCurrentRoute());
  await runRequiredCleanupStep(
    "codex-shared-client-release",
    releaseSharedClientLeaseAndRetireOneShotClient,
  );
  const nativeHookRelay = resourceState.nativeHookRelay;
  if (nativeHookRelay) {
    if (state.shouldDelayNativeHookRelayUnregister) {
      // Native hook subprocesses can finish shortly after turn completion.
      await runAgentCleanupStep({
        runId: params.runId,
        sessionId: params.sessionId,
        step: "codex-native-hook-relay-unregister-schedule",
        log: embeddedAgentLog,
        cleanup: async () =>
          scheduleCodexNativeHookRelayUnregister({
            relay: nativeHookRelay,
            hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
          }),
      });
    } else {
      await runAgentCleanupStep({
        runId: params.runId,
        sessionId: params.sessionId,
        step: "codex-native-hook-relay-unregister",
        log: embeddedAgentLog,
        cleanup: async () => nativeHookRelay.unregister(),
      });
    }
  }
  await runRequiredCleanupStep("codex-sandbox-release", releaseSandboxExecEnvironment);
  await runRequiredCleanupStep("codex-scoped-mcp-dispose", async () => {
    await prompt.context.attemptTools.scopedMcpTools?.dispose();
  });
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-abort-listener-remove",
    log: embeddedAgentLog,
    cleanup: async () => {
      if (abortListener) {
        runAbortController.signal.removeEventListener("abort", abortListener);
      }
    },
  });
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-steering-cancel",
    log: embeddedAgentLog,
    cleanup: async () => steeringQueueRef.current?.cancel(),
  });
  await runRequiredCleanupStep("codex-terminal-outcome-freeze", async () =>
    freezeRunTerminalOutcome(),
  );
  if (handle) {
    await runRequiredCleanupStep("codex-reply-backend-detach", async () =>
      params.replyOperation?.detachBackend(handle),
    );
    await runRequiredCleanupStep("codex-active-run-clear", async () =>
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile),
    );
  }
  if (firstRequiredCleanupFailure !== undefined) {
    throw firstRequiredCleanupFailure.error;
  }
}
