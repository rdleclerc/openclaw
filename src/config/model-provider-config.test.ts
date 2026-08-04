import { describe, expect, it } from "vitest";
import {
  resolveMergedModelProviderModels,
  resolveModelProviderRouteOverridePresence,
} from "./model-provider-config.js";
import type { ModelDefinitionConfig } from "./types.models.js";

function model(id: string, fields: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return { id, ...fields } as ModelDefinitionConfig;
}

describe("resolveMergedModelProviderModels", () => {
  it("keeps first-row fields and fills only omissions from canonical duplicates", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("openai/gpt-5.5", {
          api: "openai-responses",
          headers: {},
        }),
        model("gpt-5.5", {
          api: "openai-completions",
          baseUrl: "https://relay.example.test/v1",
          headers: { "x-route": "custom" },
          params: { azureApiVersion: "2025-01-01" },
        }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")).toEqual({
      id: "openai/gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      headers: {},
      params: { azureApiVersion: "2025-01-01" },
    });
  });

  it("fills headers when the first canonical row omits them", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("gpt-5.5", { api: "openai-responses" }),
        model("openai/gpt-5.5", { headers: { "x-route": "custom" } }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")?.headers).toEqual({ "x-route": "custom" });
  });
});

describe("resolveModelProviderRouteOverridePresence", () => {
  it("treats authored model compatibility as request behavior", () => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              { id: "gpt-5.5", compat: { supportsStore: false } },
              { id: "gpt-5.5-empty", compat: {} },
            ],
          },
        },
      },
    } as never;

    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
      }),
    ).toBe("present");
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.5-empty",
        config,
      }),
    ).toBe("none");
  });

  it("treats a provider request timeout as authored behavior", () => {
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: { baseUrl: "", timeoutSeconds: 90, models: [model("gpt-5.5")] },
            },
          },
        },
      }),
    ).toBe("present");
  });

  it("does not let a provider private-network opt-in block an official model endpoint", () => {
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:9999/openai/v1",
                request: { allowPrivateNetwork: true },
                models: [
                  model("gpt-5.6-sol", {
                    api: "openai-chatgpt-responses",
                    baseUrl: "https://chatgpt.com/backend-api/codex",
                  }),
                ],
              },
            },
          },
        } as never,
      }),
    ).toBe("none");
  });

  it("does not treat native reasoning metadata as a transport override", () => {
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config: {
          models: {
            providers: {
              openai: {
                models: [
                  model("gpt-5.6-sol", {
                    api: "openai-chatgpt-responses",
                    baseUrl: "https://chatgpt.com/backend-api/codex",
                    compat: {
                      supportsReasoningEffort: true,
                      supportedReasoningEfforts: ["none", "xhigh", "max"],
                    },
                  }),
                ],
              },
            },
          },
        } as never,
      }),
    ).toBe("none");
  });

  it("keeps the private-network opt-in blocking for a custom model endpoint", () => {
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-custom",
        config: {
          models: {
            providers: {
              openai: {
                request: { allowPrivateNetwork: true },
                models: [model("gpt-custom", { baseUrl: "http://127.0.0.1:9999/v1" })],
              },
            },
          },
        } as never,
      }),
    ).toBe("present");
  });

  it("keeps other provider transport overrides blocking for an official model endpoint", () => {
    expect(
      resolveModelProviderRouteOverridePresence({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config: {
          models: {
            providers: {
              openai: {
                request: { headers: { "x-test": "custom" } },
                models: [
                  model("gpt-5.6-sol", {
                    api: "openai-chatgpt-responses",
                    baseUrl: "https://chatgpt.com/backend-api/codex",
                  }),
                ],
              },
            },
          },
        } as never,
      }),
    ).toBe("present");
  });
});
