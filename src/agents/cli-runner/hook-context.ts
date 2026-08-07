import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import type { ContextWindowInfo } from "../context-window-guard.js";
import type { AgentHarnessHookContext } from "../harness/hook-context.js";
import type { RunCliAgentParams } from "./types.js";

type CliAgentHookContextRun = Pick<
  RunCliAgentParams,
  | "agentAccountId"
  | "agentId"
  | "channelContext"
  | "chatId"
  | "config"
  | "currentChannelId"
  | "currentMessageId"
  | "currentThreadTs"
  | "externalContentSource"
  | "jobId"
  | "messageChannel"
  | "messageProvider"
  | "runId"
  | "senderId"
  | "sessionId"
  | "sessionKey"
  | "trigger"
  | "workspaceDir"
>;

/** Builds the shared lifecycle-hook context for a prepared CLI run. */
export function buildCliAgentHookContext(params: {
  run: CliAgentHookContextRun;
  contextWindowInfo?: ContextWindowInfo;
  includeConfig?: boolean;
}): AgentHarnessHookContext {
  const { run, contextWindowInfo, includeConfig = true } = params;
  return {
    runId: run.runId,
    jobId: run.jobId,
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    workspaceDir: run.workspaceDir,
    trigger: run.trigger,
    // Terminal hooks must receive the typed source, not infer it from session text.
    ...(run.externalContentSource ? { externalContentSource: run.externalContentSource } : {}),
    ...(includeConfig && run.config ? { config: run.config } : {}),
    ...(contextWindowInfo?.tokens ? { contextTokenBudget: contextWindowInfo.tokens } : {}),
    ...(contextWindowInfo?.source ? { contextWindowSource: contextWindowInfo.source } : {}),
    ...(contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: contextWindowInfo.referenceTokens }
      : {}),
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields({
      trigger: run.trigger,
      senderId: run.senderId,
      chatId: run.chatId,
      channelContext: run.channelContext,
    }),
  };
}
