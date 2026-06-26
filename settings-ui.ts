import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CouncilSettings, ValidationResult, OpenRouterModel } from "./types.js";
import {
  loadSettings,
  saveSettings,
  getSettingsPath,
  formatSettingsForDisplay,
  createDefaultSettings,
  redactedApiKey,
} from "./settings.js";
import {
  pingOpenRouter as defaultPingOpenRouter,
  fetchOpenRouterModels as defaultFetchOpenRouterModels,
  pingOpenRouter,
  fetchOpenRouterModels,
} from "./openrouterClient.js";
import { searchableSelect, type SelectableItem } from "./searchSelector.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Shape of a Model object as returned by ctx.modelRegistry.getAvailable().
 * We accept a structural subset so we don't have to import Model<Api> from
 * @earendil-works/pi-ai (it's re-exported by pi-coding-agent, but we want the
 * settings UI to be usable from tests that mock the registry loosely).
 */
export interface RegistryModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Pull every model the current registry considers "available" (i.e. has
 * credentials configured) and filter down to those served by OpenRouter.
 *
 * This is the preferred path — it re-uses the OpenRouter provider that pi
 * already registers when the user sets `OPENROUTER_API_KEY` (or runs
 * `/login openrouter`), so the API key only has to live in one place.
 */
export function getOpenRouterModelsFromRegistry(
  models: ReadonlyArray<RegistryModel>,
): OpenRouterModel[] {
  return models
    .filter((m) => m.provider === "openrouter")
    .map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Resolve an OpenRouter API key from three sources, in priority order:
 *
 *   1. Explicit key passed in (the legacy `/council-settings` UI flow)
 *   2. Pi's auth storage via ctx.modelRegistry
 *   3. `OPENROUTER_API_KEY` environment variable
 *
 * Returns `undefined` when no key can be found.
 */
export async function resolveOpenRouterApiKey(
  ctx: ExtensionCommandContext,
  explicitKey?: string,
): Promise<string | undefined> {
  if (explicitKey && explicitKey.trim().length > 0) {
    return explicitKey.trim();
  }

  try {
    const fromRegistry = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
    if (fromRegistry && fromRegistry.trim().length > 0) {
      return fromRegistry.trim();
    }
  } catch {
    // Registry may not be available in all contexts; fall through.
  }

  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  return undefined;
}

// ─── Validation ────────────────────────────────────────────────────────────────

export async function validateCouncilSettings(
  settings: Partial<CouncilSettings>,
  availableModels?: OpenRouterModel[],
  pingFn?: (apiKey: string) => Promise<{ ok: boolean; error?: string; quota?: string }>,
  fetchFn?: (apiKey: string) => Promise<OpenRouterModel[]>,
): Promise<ValidationResult> {
  const pingOpenRouter = pingFn ?? defaultPingOpenRouter;
  const fetchOpenRouterModels = fetchFn ?? defaultFetchOpenRouterModels;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!settings.openRouter?.apiKey) {
    errors.push("OpenRouter API key is required");
    return { valid: false, errors, warnings };
  }

  if (!settings.openRouter.apiKey.startsWith("sk-or-v1")) {
    errors.push("API key must start with 'sk-or-v1'");
  }

  const ping = await pingOpenRouter(settings.openRouter.apiKey);
  if (!ping.ok) {
    errors.push(`OpenRouter validation failed: ${ping.error}`);
    return { valid: false, errors, warnings };
  }
  if (ping.quota) {
    warnings.push(`Connected. ${ping.quota}`);
  }

  let models: OpenRouterModel[] | undefined = availableModels;
  if (!models) {
    try {
      models = await fetchOpenRouterModels(settings.openRouter.apiKey);
    } catch {
      warnings.push("Could not fetch model list — skipping model validation");
    }
  }

  const { model1, model2, model3 } = settings.openRouter.models ?? {};
  const modelsList = [model1, model2, model3];

  if (modelsList.some(m => !m)) {
    errors.push("All 3 council models must be selected");
  }

  if (models) {
    const availableIds = new Set(models.map(m => m.id));
    for (const model of modelsList) {
      if (model && !availableIds.has(model)) {
        errors.push(`Model not available on OpenRouter: ${model}`);
      }
    }
  }

  if (model1 && model2 && model3) {
    if (new Set([model1, model2, model3]).size !== 3) {
      errors.push("All 3 council models must be different");
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Show current settings (list command) ─────────────────────────────────────

export async function showCurrentSettings(ctx: ExtensionCommandContext): Promise<void> {
  const settings = await loadSettings(ctx.cwd, ctx.isProjectTrusted());
  const lines = formatSettingsForDisplay(settings);

  const output = lines.join("\n");
  ctx.ui.notify(output, "info");
}

// ─── Reset settings ────────────────────────────────────────────────────────────

export async function resetSettings(
  ctx: ExtensionCommandContext,
  scope: "all" | "council" | "opinion" = "all",
): Promise<void> {
  const path = getSettingsPath(ctx.cwd, ctx.isProjectTrusted());
  const { unlink } = await import("node:fs/promises");

  try {
    await unlink(path);
  } catch {
    // File didn't exist — that's fine
  }

  const scopeLabel = scope === "all" ? "All settings" : scope === "council" ? "Council settings" : "Opinion settings";
  ctx.ui.notify(`${scopeLabel} have been reset. Run /council-settings to reconfigure.`, "info");
}

// ─── Full settings UI ──────────────────────────────────────────────────────────

type SettingsState = {
  apiKey: string;
  model1: string;
  model2: string;
  model3: string;
  opinionProvider: string;
  opinionModelId: string;
  useStructuredOutput: boolean;
  availableModels: OpenRouterModel[];
  /** How the model list was obtained — surfaced in the save summary. */
  modelSource: "registry" | "rest" | "fallback";
};

export async function openCouncilSettingsUI(
  ctx: ExtensionCommandContext,
  deps?: {
    pingOpenRouter?: (apiKey: string) => Promise<{ ok: boolean; error?: string; quota?: string }>;
    fetchOpenRouterModels?: (apiKey: string) => Promise<OpenRouterModel[]>;
  },
): Promise<void> {
  const current = await loadSettings(ctx.cwd, ctx.isProjectTrusted());
  const defaults = createDefaultSettings();

  const state: SettingsState = {
    apiKey: current?.openRouter.apiKey ?? "",
    model1: current?.openRouter.models.model1 ?? "",
    model2: current?.openRouter.models.model2 ?? "",
    model3: current?.openRouter.models.model3 ?? "",
    opinionProvider: current?.opinion.provider ?? defaults.opinion.provider,
    opinionModelId: current?.opinion.modelId ?? defaults.opinion.modelId,
    useStructuredOutput: current?.options.useStructuredOutput ?? true,
    availableModels: [],
    modelSource: "registry",
  };

  // ── Step 1: discover models via the pi registry (preferred) ─────────────
  // If the user has already configured OpenRouter for pi (via OPENROUTER_API_KEY
  // or `/login openrouter`) the registry exposes every OpenRouter model that
  // pi ships with — no extra HTTP calls, no API key prompt.
  let registryModels: RegistryModel[] = [];
  try {
    registryModels = (await ctx.modelRegistry.getAvailable()) as RegistryModel[];
  } catch {
    registryModels = [];
  }

  const openrouterFromRegistry = getOpenRouterModelsFromRegistry(registryModels);

  if (openrouterFromRegistry.length >= 3) {
    state.availableModels = openrouterFromRegistry;
    state.modelSource = "registry";

    // Try to surface the API key from pi's auth storage so the saved settings
    // remain self-contained for the runtime layer.
    const registryKey = await resolveOpenRouterApiKey(ctx);
    if (registryKey) {
      state.apiKey = registryKey;
    }
  } else {
    // ── Step 1 (fallback): ask the user for an API key ────────────────────
    const apiKeyInput = await ctx.ui.input("OpenRouter API Key", "sk-or-v1-...");

    if (!apiKeyInput) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }

    state.apiKey = apiKeyInput.trim();

    // Ping to validate
    const ping = await (deps?.pingOpenRouter ?? pingOpenRouter)(state.apiKey);
    if (!ping.ok) {
      ctx.ui.notify(`Connection failed: ${ping.error}`, "error");
      return;
    }

    ctx.ui.notify(ping.quota ? `Connected. ${ping.quota}` : "Connected.", "info");

    // Fetch models from OpenRouter
    try {
      state.availableModels = await (deps?.fetchOpenRouterModels ?? fetchOpenRouterModels)(state.apiKey);
      state.modelSource = "rest";
    } catch {
      ctx.ui.notify("Connected, but could not fetch model list. Using recommended defaults.", "warning");
      state.availableModels = [
        { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
        { id: "z-ai/glm-5.2", name: "GLM-5.2" },
        { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      ];
      state.modelSource = "fallback";
    }
  }

  // ── Step 2: select 3 council models (forced-distinct, prompt in order) ──
  // Each SelectableItem carries a searchHaystack so typing "claude" matches
  // "anthropic/claude-3.5-sonnet" even though the visible label is just the
  // model name. Already-picked models are filtered out for the next step.
  const buildModelItems = (exclude: ReadonlyArray<string> = []): SelectableItem[] =>
    state.availableModels
      .filter((m) => !exclude.includes(m.id))
      .map((m) => ({
        value: m.id,
        label: m.name,
        description: m.id,
        searchHaystack: `${m.name} ${m.id}`,
      }));

  const allModelItems: SelectableItem[] = state.availableModels.map((m) => ({
    value: m.id,
    label: m.name,
    description: m.id,
    searchHaystack: `${m.name} ${m.id}`,
  }));

  const model1Pick = await searchableSelect(ctx, {
    title: "Council Model 1 of 3",
    searchPlaceholder: "Type to search (e.g. \"claude\", \"gpt\", \"qwen\")",
    hint: `${state.availableModels.length} models available · type to filter · ↑↓ to navigate`,
    items: buildModelItems(),
  });
  if (!model1Pick) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.model1 = model1Pick.value;

  const model2Pick = await searchableSelect(ctx, {
    title: "Council Model 2 of 3",
    searchPlaceholder: `Pick a different model — excluding "${model1Pick.label}"`,
    hint: `${state.availableModels.length - 1} models remaining`,
    items: buildModelItems([state.model1]),
  });
  if (!model2Pick) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.model2 = model2Pick.value;

  const model3Pick = await searchableSelect(ctx, {
    title: "Council Model 3 of 3",
    searchPlaceholder: "Pick a third, distinct model",
    hint: `${state.availableModels.length - 2} models remaining`,
    items: buildModelItems([state.model1, state.model2]),
  });
  if (!model3Pick) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.model3 = model3Pick.value;

  // ── Step 3: pick a 4th synthesis model ─────────────────────────────────
  // The synthesis model reads the three council opinions and writes a single
  // decision. We default to "Council Model 1" since the user already
  // trusts it as a council member, but they can pick any OpenRouter model.
  const synthesisDefaultLabel = model1Pick.label;

  const synthesisPick = await searchableSelect(ctx, {
    title: "Synthesis Model",
    searchPlaceholder: `Reads all 3 council opinions. Default: ${synthesisDefaultLabel}`,
    hint: `Recommended: a reasoning-tuned model · default: ${synthesisDefaultLabel}`,
    items: allModelItems,
  });
  if (!synthesisPick) { ctx.ui.notify("Cancelled.", "info"); return; }
  const synthesisModelId = synthesisPick.value;

  // ── Step 4: pick the second-opinion model (used by /opinion) ───────────
  const opinionPick = await searchableSelect(ctx, {
    title: "Second Opinion Model",
    searchPlaceholder: "Single-model quick check (used by /opinion)",
    hint: "Recommended: a fast model for routine questions",
    items: allModelItems,
  });
  if (!opinionPick) { ctx.ui.notify("Cancelled.", "info"); return; }
  const opinionModel = state.availableModels.find((m) => m.id === opinionPick.value);
  if (opinionModel) {
    const parts = opinionModel.id.split("/");
    state.opinionProvider = parts[0] ?? "openrouter";
    state.opinionModelId = opinionModel.id;
  }

  // ── Step 5: structured output toggle ───────────────────────────────────
  state.useStructuredOutput = await ctx.ui.confirm(
    "Structured Output",
    "Use structured JSON output for faster parsing? (Recommended: Yes)",
  );

  // ── Step 6: validate the chosen API key (if we have one) ────────────────
  if (state.apiKey) {
    const validation = await validateCouncilSettings({
      openRouter: {
        apiKey: state.apiKey,
        models: { model1: state.model1, model2: state.model2, model3: state.model3 },
      },
    }, state.availableModels);

    if (!validation.valid) {
      for (const err of validation.errors) {
        ctx.ui.notify(`Validation error: ${err}`, "error");
      }
      return;
    }
  }

  // ── Step 7: confirm and save ────────────────────────────────────────────
  const summary = [
    `OpenRouter API Key: ${state.apiKey ? redactedApiKey(state.apiKey) : "(none — using pi auth)"}`,
    `Council Models:`,
    `  1. ${state.model1}`,
    `  2. ${state.model2}`,
    `  3. ${state.model3}`,
    `Synthesis Model: ${synthesisModelId}`,
    `Second Opinion Model: ${state.opinionModelId}`,
    `Structured Output: ${state.useStructuredOutput ? "enabled" : "disabled"}`,
    `Model List Source: ${state.modelSource}`,
  ].join("\n");

  const confirmed = await ctx.ui.confirm("Save Settings?", summary);
  if (!confirmed) {
    ctx.ui.notify("Settings not saved.", "info");
    return;
  }

  const settings: CouncilSettings = {
    version: 1,
    openRouter: {
      apiKey: state.apiKey,
      models: {
        model1: state.model1,
        model2: state.model2,
        model3: state.model3,
      },
    },
    opinion: {
      provider: state.opinionProvider,
      modelId: state.opinionModelId,
    },
    synthesis: {
      modelId: synthesisModelId,
    },
    options: {
      useStructuredOutput: state.useStructuredOutput,
      modelTimeoutMs: 300000,
      synthesisTimeoutMs: 360000,
      retryAttempts: 3,
      retryDelayMs: 3000,
    },
    lastUpdated: new Date().toISOString(),
  };

  await saveSettings(settings, ctx.cwd, ctx.isProjectTrusted());
  ctx.ui.notify("Council settings saved successfully!", "info");
}

// ─── Opinion settings UI ────────────────────────────────────────────────────────

export async function openOpinionSettingsUI(
  ctx: ExtensionCommandContext,
  deps?: {
    loadSettings?: (cwd: string, isProjectTrusted: boolean) => Promise<CouncilSettings | null>;
    saveSettings?: (settings: CouncilSettings, cwd: string, isProjectTrusted: boolean) => Promise<void>;
  },
): Promise<void> {
  const available = (await ctx.modelRegistry.getAvailable()) as RegistryModel[];

  if (available.length === 0) {
    ctx.ui.notify("No models with valid API keys available. Configure API keys in pi settings.", "error");
    return;
  }

  // Build a flat list of all available models with provider badges so a single
  // typeahead picker can choose from any provider without a separate Provider
  // step. Each item's haystack includes both the provider and model id so
  // typing "openrouter" or "anthropic" narrows correctly.
  const items: SelectableItem[] = available.map((m) => ({
    value: `${m.provider}::${m.id}`,
    label: m.name ?? m.id,
    description: `${m.provider} · ${m.id}`,
    searchHaystack: `${m.provider} ${m.id} ${m.name ?? ""}`,
  }));

  const pick = await searchableSelect(ctx, {
    title: "Second Opinion Model",
    searchPlaceholder: "Type to search by provider or model name",
    hint: `${available.length} models available across ${new Set(available.map((m) => m.provider)).size} providers`,
    items,
  });
  if (!pick) { ctx.ui.notify("Cancelled.", "info"); return; }

  const [providerChoice, modelChoice] = pick.value.split("::");

  const confirmed = await ctx.ui.confirm("Save Opinion Model?", `${providerChoice}/${modelChoice}`);
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  const existing = await (deps?.loadSettings ?? loadSettings)(ctx.cwd, ctx.isProjectTrusted());
  const settings = existing ?? createDefaultSettings();

  settings.opinion = {
    provider: providerChoice,
    modelId: modelChoice,
  };
  settings.lastUpdated = new Date().toISOString();

  await (deps?.saveSettings ?? saveSettings)(settings, ctx.cwd, ctx.isProjectTrusted());
  ctx.ui.notify(`Opinion model set to: ${providerChoice}/${modelChoice}`, "info");
}