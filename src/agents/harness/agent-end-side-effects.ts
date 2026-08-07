import type { ChatType } from "../../channels/chat-type.js";
/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger core research capture and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HookExternalContentSource } from "../../security/external-content.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";
import { AgentEndTerminalFinalizationError } from "./terminal-finalization-error.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  /** Fail closed when the typed terminal source has no host-owned message id. */
  requireMessageId?: boolean;
  ctx: BaseAgentEndSideEffectsParams["ctx"] & {
    authProfileId?: string;
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    messageChannel?: string | null;
    chatType?: ChatType;
    agentAccountId?: string | null;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    memberRoleIds?: readonly string[];
    spawnedBy?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
    senderIsOwner?: boolean;
  };
};

type AgentEndTerminalOptions = Pick<
  BaseAgentEndSideEffectsParams,
  "requiredForExternalContentSource" | "awaitOnlyRequired"
> & {
  requireMessageId?: boolean;
};

/** Returns the required terminal options for a typed Gmail turn. */
export function buildGmailAgentEndSideEffectOptions(
  source?: HookExternalContentSource,
): AgentEndTerminalOptions {
  if (source !== "gmail") {
    return {};
  }
  return {
    requiredForExternalContentSource: "gmail",
    awaitOnlyRequired: true,
    requireMessageId: true,
  };
}

async function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  try {
    const { scheduleSkillExperienceReview } =
      await import("../../skills/workshop/experience-review-default.js");
    scheduleSkillExperienceReview({
      event: params.event,
      ctx: params.ctx,
      ...(params.ctx.config ? { config: params.ctx.config } : {}),
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
  }
  try {
    const { runSkillResearchAutoCapture } = await import("../../skills/research/autocapture.js");
    await runSkillResearchAutoCapture({
      event: params.event,
      ctx: params.ctx,
      ...(params.ctx.config ? { config: params.ctx.config } : {}),
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill research auto-capture failed: ${String(error)}`);
  }
}

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  const { requireMessageId: _requireMessageId, ...hookParams } = params;
  void runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook(hookParams);
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  if (params.requireMessageId && params.ctx.messageId === undefined) {
    throw new AgentEndTerminalFinalizationError(
      "required agent_end handler missing host-owned message identity",
    );
  }
  const { requireMessageId: _requireMessageId, ...hookParams } = params;
  await runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook(hookParams);
}
