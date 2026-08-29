// Codex plugin module implements run attempt behavior.
import {
  embeddedAgentLog,
  formatErrorMessage,
  toAgentEndTerminalFinalizationError,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  activateCodexAttemptTurn,
  type CodexAttemptActiveTurn,
} from "./run-attempt-active-turn.js";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { finalizeCodexAttempt } from "./run-attempt-finalize.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { runCodexAgentEndHook } from "./run-attempt-lifecycle.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRoute } from "./run-attempt-route.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { startCodexAttemptRuntime } from "./run-attempt-start.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import { buildCodexUserPromptMessage } from "./transcript-mirror.js";

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: CodexRunAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  const connection = await prepareCodexAttemptConnection({ params, options });
  const runtime = await prepareCodexAttemptRuntime(connection);
  const attemptTools = await prepareCodexAttemptTools(runtime);
  const attemptContext = await prepareCodexAttemptContext(runtime, attemptTools);
  const attemptPrompt = await prepareCodexAttemptPrompt(attemptContext);
  const resources = prepareCodexAttemptResources(attemptPrompt);
  await startCodexAttemptRuntime(resources);

  const turnRuntime = createCodexAttemptTurnState(resources);
  const lifecycle = createCodexAttemptLifecycleController(resources, turnRuntime);
  const notifications = createCodexAttemptNotificationController(resources, turnRuntime, lifecycle);
  const serverRequests = createCodexAttemptServerRequestController(
    resources,
    turnRuntime,
    lifecycle,
  );
  const { ensureCurrentThreadRoute } = await prepareCodexAttemptRoute(
    resources,
    turnRuntime,
    notifications,
    serverRequests.handleServerRequest,
  );
  const turnRequest = await prepareCodexAttemptTurnRequest(
    resources,
    turnRuntime,
    ensureCurrentThreadRoute,
    notifications.waitForActiveNativeTurnCompletion,
  );
  const turnStart = await startCodexAttemptTurn(resources, turnRuntime, notifications, turnRequest);
  if ("result" in turnStart) {
    return turnStart.result;
  }
  let activeTurn: CodexAttemptActiveTurn | undefined;
  let result: EmbeddedRunAttemptResult | undefined;
  let finalizationError: unknown;
  let finalizationFailed = false;
  try {
    activeTurn = await activateCodexAttemptTurn(
      resources,
      turnRuntime,
      lifecycle,
      notifications,
      turnStart.turn,
    );
    result = await finalizeCodexAttempt(
      resources,
      turnRuntime,
      lifecycle,
      notifications,
      turnRequest,
      activeTurn,
    );
  } catch (error) {
    finalizationFailed = true;
    finalizationError = error;
    if (!activeTurn) {
      turnRuntime.turnWatches.clearAllTimers();
      turnRuntime.state.completed = true;
      turnRuntime.state.resolveCompletion?.();
      const { prompt } = resources;
      const { context, turnState } = prompt;
      const { runtime, historyState, hookContext, hookRunner } = context;
      const { connection, runtimeParams } = runtime;
      const activationErrorMessage =
        formatErrorMessage(error) || "codex app-server active turn activation failed";
      try {
        await runCodexAgentEndHook(params, {
          event: {
            messages: [
              ...historyState.messages,
              buildCodexUserPromptMessage({
                ...runtimeParams,
                prompt: turnState.codexTurnPromptText,
              }),
            ],
            success: false,
            error: activationErrorMessage,
            durationMs: Date.now() - connection.attemptStartedAt,
          },
          ctx: hookContext,
          hookRunner,
        });
      } catch (agentEndError) {
        finalizationError = toAgentEndTerminalFinalizationError(agentEndError);
      }
      if (finalizationError === error) {
        finalizationError = toAgentEndTerminalFinalizationError(error);
      }
    }
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await cleanupCodexAttempt(resources, turnRuntime, lifecycle, turnRequest, activeTurn);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (finalizationFailed) {
    if (cleanupFailed) {
      embeddedAgentLog.warn("codex app-server cleanup failed after attempt finalization failure", {
        error: cleanupError,
      });
    }
    throw finalizationError;
  }
  if (cleanupFailed) {
    if (activeTurn?.activationFailed) {
      embeddedAgentLog.warn(
        "codex app-server cleanup failed after active-turn activation failure",
        {
          error: cleanupError,
        },
      );
      throw toAgentEndTerminalFinalizationError(activeTurn.activationError);
    }
    throw toAgentEndTerminalFinalizationError(cleanupError);
  }
  if (activeTurn?.activationFailed) {
    throw toAgentEndTerminalFinalizationError(activeTurn.activationError);
  }
  return result as EmbeddedRunAttemptResult;
}
