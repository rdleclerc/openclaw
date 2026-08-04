import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderRouteOverridePresence } from "../plugin-sdk/provider-model-types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MergedModelProviderEntry = {
  providerKey: string;
  providerConfig: ModelProviderConfig;
};

/** Indexes configured model rows after caller-owned model-id normalization. */
export function resolveMergedModelProviderModels(params: {
  models: readonly ModelDefinitionConfig[] | undefined;
  normalizeModelId: (modelId: string) => string | undefined;
}): ReadonlyMap<string, ModelDefinitionConfig> {
  const models = new Map<string, ModelDefinitionConfig>();
  for (const model of params.models ?? []) {
    const modelId = params.normalizeModelId(model.id);
    if (!modelId) {
      continue;
    }
    const existing = models.get(modelId);
    // Earlier rows stay authoritative, including explicit empty objects;
    // later duplicates only supply top-level fields the first row omitted.
    models.set(modelId, existing ? { ...model, ...existing } : model);
  }
  return models;
}

function normalizeModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.indexOf("/");
  return slashIndex > 0 &&
    normalizeProviderId(trimmed.slice(0, slashIndex)) === normalizeProviderId(provider)
    ? trimmed.slice(slashIndex + 1).trim()
    : trimmed;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

const RUNTIME_MODEL_COMPAT_KEYS = new Set(["supportsReasoningEffort", "supportedReasoningEfforts"]);

function hasMeaningfulModelCompat(value: unknown): boolean {
  const record = readRecord(value);
  return (
    record !== undefined && Object.keys(record).some((key) => !RUNTIME_MODEL_COMPAT_KEYS.has(key))
  );
}

function isOfficialOpenAIEndpoint(provider: string, baseUrl: unknown): boolean {
  if (normalizeProviderId(provider) !== "openai" || typeof baseUrl !== "string") {
    return false;
  }
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.protocol === "https:" &&
      (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com")
    );
  } catch {
    return false;
  }
}

/**
 * The private-network opt-in is only transport-relevant for private routes.
 * An OpenAI model row with its own official endpoint does not inherit the
 * provider's local-network safety switch in a way Codex must reproduce.
 */
function hasMeaningfulProviderRequestOverride(params: {
  provider: string;
  request: unknown;
  effectiveBaseUrl: unknown;
}): boolean {
  const request = readRecord(params.request);
  if (!request || Object.keys(request).length === 0) {
    return false;
  }
  const onlyPrivateNetworkOptIn = Object.keys(request).every(
    (key) => key === "allowPrivateNetwork",
  );
  return (
    !onlyPrivateNetworkOptIn || !isOfficialOpenAIEndpoint(params.provider, params.effectiveBaseUrl)
  );
}

/** Projects authored request behavior without exposing values or local commands. */
export function resolveModelProviderRouteOverridePresence(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  canonicalizeModelId?: (modelId: string) => string;
}): ProviderRouteOverridePresence {
  const providerConfig = resolveMergedModelProviderConfig(params.config, params.provider);
  if (!providerConfig) {
    return "none";
  }
  const canonicalize = (modelId: string) => {
    const normalized = normalizeModelId(params.provider, modelId);
    const canonical = params.canonicalizeModelId?.(normalized).trim();
    return canonical || normalized;
  };
  const modelId = params.modelId ? canonicalize(params.modelId) : undefined;
  const configuredModel = modelId
    ? resolveMergedModelProviderModels({
        models: providerConfig.models,
        normalizeModelId: canonicalize,
      }).get(modelId)
    : undefined;
  if (
    readRecord(providerConfig.localService) !== undefined ||
    hasNonEmptyRecord(providerConfig.headers) ||
    hasMeaningfulProviderRequestOverride({
      provider: params.provider,
      request: providerConfig.request,
      effectiveBaseUrl: configuredModel?.baseUrl ?? providerConfig.baseUrl,
    }) ||
    hasNonEmptyRecord(providerConfig.params) ||
    typeof providerConfig.authHeader === "boolean" ||
    typeof providerConfig.timeoutSeconds === "number"
  ) {
    return "present";
  }
  if (!params.modelId) {
    return "none";
  }
  return configuredModel &&
    (hasNonEmptyRecord(configuredModel.headers) ||
      hasNonEmptyRecord(configuredModel.params) ||
      hasMeaningfulModelCompat(configuredModel.compat))
    ? "present"
    : "none";
}

/** Resolves the provider entry produced by models-config key normalization. */
export function resolveMergedModelProviderEntry(
  config: OpenClawConfig | undefined,
  provider: string,
): MergedModelProviderEntry | undefined {
  const requestedProvider = provider.trim();
  const normalizedProvider = normalizeProviderId(requestedProvider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providers = Object.entries(config?.models?.providers ?? {});
  // normalizeProviders trims keys but does not lowercase them. Preserve its
  // exact-key precedence, then use the existing case-insensitive fallback.
  const exactKey = providers.find(([providerId]) => providerId.trim() === requestedProvider)?.[0];
  const fallbackKey = providers.find(
    ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
  )?.[0];
  const providerKey = (exactKey ?? fallbackKey)?.trim();
  if (!providerKey) {
    return undefined;
  }
  let matched: ModelProviderConfig | undefined;
  for (const [providerId, providerConfig] of providers) {
    if (providerId.trim() !== providerKey) {
      continue;
    }
    // Match normalizeProviders: later fields win, while omitted model rows keep
    // the earlier catalog instead of erasing it from route/auth decisions.
    matched = matched
      ? {
          ...matched,
          ...providerConfig,
          models: providerConfig.models ?? matched.models,
        }
      : providerConfig;
  }
  return matched ? { providerKey, providerConfig: matched } : undefined;
}

/** Resolves only the merged provider config when its canonical key is not needed. */
export function resolveMergedModelProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderEntry(config, provider)?.providerConfig;
}
