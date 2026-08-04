import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolCallerMessageActionCapability,
  runWithGatewayToolCallerRequestContext,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

describe("gateway caller context wrapper", () => {
  it("preserves tool metadata used by policy and presentation layers", () => {
    const tool: AnyAgentTool = {
      name: "plugin_tool",
      label: "Plugin tool",
      description: "plugin tool",
      parameters: Type.Object({}),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };
    setPluginToolMeta(tool, { pluginId: "plugin-a", optional: false });
    setChannelAgentToolMeta(tool as never, { channelId: "telegram" });
    setToolTerminalPresentation(tool, () => ({ text: "done" }));

    const beforeWrapped = wrapToolWithBeforeToolCallHook(tool);
    const wrapped = wrapToolWithGatewayCallerIdentity(beforeWrapped, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    expect(getPluginToolMeta(wrapped)).toEqual({ pluginId: "plugin-a", optional: false });
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
    expect(getToolTerminalPresentation(wrapped)).toBe(getToolTerminalPresentation(tool));
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  });

  it("supplies attempt authority to a pre-materialized same-identity tool", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "attempt-token",
      },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: true, token: "attempt-token" });
    expect(resolveGatewayToolCallerMessageActionCapability(undefined)).toEqual({ ok: true });
  });

  it("fails closed on conflicting constructor authority", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability("constructor-token");
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
      messageActionTurnCapability: "constructor-token",
    });

    await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "attempt-token",
      },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
  });

  it("clears inherited authority at an untokened nested attempt boundary", async () => {
    const observed = await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "outer-token",
      },
      () =>
        runWithGatewayToolCallerRequestContext(
          { agentId: "agent-a", sessionKey: "agent-a:session" },
          () => resolveGatewayToolCallerMessageActionCapability(undefined),
        ),
    );

    expect(observed).toEqual({ ok: true });
    expect(resolveGatewayToolCallerMessageActionCapability(undefined)).toEqual({ ok: true });
  });

  it("prevents a wrapped tool from reviving constructor authority in an untokened request", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
      messageActionTurnCapability: "stale-constructor-token",
    });

    await runWithGatewayToolCallerRequestContext(
      { agentId: "agent-a", sessionKey: "agent-a:session" },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
    expect(resolveGatewayToolCallerMessageActionCapability(undefined)).toEqual({ ok: true });
  });

  it("fails closed when a nested tool replaces the request session identity", async () => {
    let observed: unknown;
    const materialized = wrapToolWithGatewayCallerIdentity(
      {
        name: "probe",
        label: "Probe",
        description: "probe",
        parameters: Type.Object({}),
        execute: async () => {
          observed = {
            identity: getGatewayToolCallerIdentity(),
            capability: resolveGatewayToolCallerMessageActionCapability(undefined),
          };
          return { content: [{ type: "text" as const, text: "ok" }], details: {} };
        },
      },
      { agentId: "agent-a", sessionKey: "agent-a:other-session" },
    );

    await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "request-token",
      },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({
      identity: undefined,
      capability: { ok: false, reason: "token_conflict" },
    });
    expect(getGatewayToolCallerIdentity()).toBeUndefined();
  });

  it("rejects wrapped authority from another session when the current request has no authority", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:other-session",
      messageActionTurnCapability: "other-live-token",
    });

    await runWithGatewayToolCallerRequestContext(
      { agentId: "agent-a", sessionKey: "agent-a:session" },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
  });

  it("isolates concurrent request authority across different agents and sessions", async () => {
    const observations: Array<{ agentId?: string; token?: string }> = [];
    let release: (() => void) | undefined;
    const overlap = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const createProbe = (agentId: string, sessionKey: string) =>
      wrapToolWithGatewayCallerIdentity(
        {
          name: `probe_${agentId}`,
          label: "Probe",
          description: "probe",
          parameters: Type.Object({}),
          execute: async () => {
            entered += 1;
            if (entered === 2) {
              release?.();
            }
            await overlap;
            const capability = resolveGatewayToolCallerMessageActionCapability(undefined);
            observations.push({
              agentId: getGatewayToolCallerIdentity()?.agentId,
              token: capability.ok ? capability.token : undefined,
            });
            return { content: [{ type: "text" as const, text: "ok" }], details: {} };
          },
        },
        { agentId, sessionKey },
      );
    const first = createProbe("agent-a", "agent-a:session");
    const second = createProbe("agent-b", "agent-b:session");

    await Promise.all([
      runWithGatewayToolCallerRequestContext(
        {
          agentId: "agent-a",
          sessionKey: "agent-a:session",
          messageActionTurnCapability: "token-a",
        },
        () => first.execute?.("call-a", {}),
      ),
      runWithGatewayToolCallerRequestContext(
        {
          agentId: "agent-b",
          sessionKey: "agent-b:session",
          messageActionTurnCapability: "token-b",
        },
        () => second.execute?.("call-b", {}),
      ),
    ]);

    expect(observations).toEqual(
      expect.arrayContaining([
        { agentId: "agent-a", token: "token-a" },
        { agentId: "agent-b", token: "token-b" },
      ]),
    );
    expect(getGatewayToolCallerIdentity()).toBeUndefined();
  });
});
