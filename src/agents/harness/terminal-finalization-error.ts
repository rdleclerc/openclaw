/** Typed terminal error for required external agent_end finalization failures. */
export const AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE = "agent_end_terminal_finalization";

export class AgentEndTerminalFinalizationError extends Error {
  readonly code = AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AgentEndTerminalFinalizationError";
  }
}

export function isAgentEndTerminalFinalizationError(
  error: unknown,
): error is AgentEndTerminalFinalizationError {
  return Boolean(
    error instanceof AgentEndTerminalFinalizationError ||
    (error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AgentEndTerminalFinalizationError" &&
      (error as { code?: unknown }).code === AGENT_END_TERMINAL_FINALIZATION_ERROR_CODE),
  );
}

export function toAgentEndTerminalFinalizationError(
  error: unknown,
): AgentEndTerminalFinalizationError {
  if (isAgentEndTerminalFinalizationError(error)) {
    return error;
  }
  return new AgentEndTerminalFinalizationError(
    error instanceof Error ? error.message : String(error),
    error,
  );
}
