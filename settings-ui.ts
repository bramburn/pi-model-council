import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CouncilSettings, ValidationResult, OpenRouterModel } from "./types.js";
import { DEFAULT_COUNCIL_SIZE, MIN_COUNCIL_MODELS, MAX_COUNCIL_MODELS } from "./types.js";
import {
  loadSettings,
  saveSettings,
  getSettingsPath,
  formatSettingsForDisplay,
  createDefaultSettings,
  redactedApiKey,
} from "./settings.js";
import { pingOpenRouter, fetchOpenRouterModels } from "./openrouterClient.js";
import { searchableSelect, type SelectableItem } from "./searchSelector.js";
import { multiSelectPicker, type MultiSelectItem } from "./multiSelectPicker.js";

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
    .map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    }));
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
export async function resolveApiKeyFromContext(
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
  // The optional injected functions take precedence so tests can stub
  // them. Otherwise fall through to the real OpenRouter client.
  const pingModel = pingFn ?? pingOpenRouter;
  const fetchModelList = fetchFn ?? fetchOpenRouterModels;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!settings.openRouter?.apiKey) {
    errors.push("OpenRouter API key is required");
    return { valid: false, errors, warnings };
  }

  if (!settings.openRouter.apiKey.startsWith("sk-or-v1")) {
    errors.push("API key must start with 'sk-or-v1'");
  }

  const ping = await pingModel(settings.openRouter.apiKey);
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
      models = await fetchModelList(settings.openRouter.apiKey);
    } catch {
      warnings.push("Could not fetch model list — skipping model validation");
    }
  }

  const councilModels = settings.openRouter.councilModels ?? [];

  if (councilModels.length === 0) {
    errors.push("At least one council model must be selected");
  }

  if (models) {
    const availableIds = new Set(models.map(m => m.id));
    for (const modelId of councilModels) {
      if (modelId && !availableIds.has(modelId)) {
        errors.push(`Model not available on OpenRouter: ${modelId}`);
      }
    }
  }

  if (councilModels.length > 1) {
    if (new Set(councilModels).size !== councilModels.length) {
      errors.push("All council models must be distinct (no duplicates)");
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

/**
 * Reset council/opinion settings. The `scope` parameter controls what
 * gets wiped:
 *
 *   - "all"     — delete the entire settings file
 *   - "council" — wipe only the council models + synthesis model field;
 *                 keep the opinion config and API key
 *   - "opinion" — wipe only the opinion model config; keep the council
 *                 and API key
 *
 * Previously, all three scopes were implemented identically (delete the
 * whole file), which meant `/opinion-settings reset` silently wiped the
 * council config too. That was a real UX bug: a user resetting their
 * opinion model would unexpectedly lose their council setup.
 */
export async function resetSettings(
  ctx: ExtensionCommandContext,
  scope: "all" | "council" | "opinion" = "all",
): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  const scopeLabel =
    scope === "all"
      ? "All settings"
      : scope === "council"
        ? "Council settings"
        : "Opinion settings";

  if (scope === "all") {
    const path = getSettingsPath(ctx.cwd, ctx.isProjectTrusted());
    try {
      await unlink(path);
    } catch {
      // File didn't exist — that's fine
    }
    ctx.ui.notify(`${scopeLabel} have been reset. Run /council-settings to reconfigure.`, "info");
    return;
  }

  // Partial reset: load the existing settings, mutate the targeted field,
  // save back. If no settings file exists yet, partial reset is a no-op.
  const existing = await loadSettings(ctx.cwd, ctx.isProjectTrusted());
  if (!existing) {
    ctx.ui.notify(`No settings to reset.`, "info");
    return;
  }

  if (scope === "council") {
    existing.openRouter.councilModels = [];
    delete existing.synthesis;
  } else {
    // "opinion" — wipe only the opinion field; reset to defaults so the
    // settings file remains structurally valid.
    existing.opinion = createDefaultSettings().opinion;
  }
  existing.lastUpdated = new Date().toISOString();

  await saveSettings(existing, ctx.cwd, ctx.isProjectTrusted());
  ctx.ui.notify(`${scopeLabel} have been reset.`, "info");
}

// ─── Full settings UI ──────────────────────────────────────────────────────────

type SettingsState = {
  apiKey: string;
  /** Ordered list of council models. */
  councilModels: string[];
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
    councilModels: current?.openRouter.councilModels?.length
      ? [...current.openRouter.councilModels]
      : Array(DEFAULT_COUNCIL_SIZE).fill(""),
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

  // Previously required >= 3 models to skip the API-key prompt. That was
  // arbitrary — if the user has 1 OpenRouter model configured in pi's
  // registry, that's enough to skip the prompt (the registry already
  // provides the API key).
  if (openrouterFromRegistry.length > 0) {
    state.availableModels = openrouterFromRegistry;
    state.modelSource = "registry";

    // Try to surface the API key from pi's auth storage so the saved settings
    // remain self-contained for the runtime layer.
    const registryKey = await resolveApiKeyFromContext(ctx);
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

  // ── Step 2: select council models via MultiSelectPicker ────────────────
  // MultiSelectPicker handles all/scoped Tab toggle, fuzzy search, ↑↓ nav,
  // Enter to toggle ✓/☐, and validates min/max picks on commit.
  // ── Step 2: select council models via MultiSelectPicker ────────────────
  // P3 fix: source picker items from the FULL registry (every
  // credentialed model), not just OpenRouter. Direct-provider models
  // (anthropic, openai, google, etc.) now appear alongside OpenRouter
  // models so the user can build a mixed-provider council.
  //
  // Fall back to state.availableModels (OpenRouter REST catalog) when
  // the registry returned nothing — e.g. user has OpenRouter configured
  // via env var but no models in the registry.
  const buildRegistryItems = (): MultiSelectItem[] => {
    const items: MultiSelectItem[] = [];
    for (const m of registryModels) {
      const isOpenRouterModel = m.provider === "openrouter";
      // Include the provider in the label for non-OpenRouter models so
      // users can distinguish anthropic/claude-3.5-sonnet from
      // openai/claude-3.5-sonnet. Search-haystack includes the provider
      // so typing "anthropic" or "openai" narrows correctly.
      const label = isOpenRouterModel ? m.name : `${m.name}  [${m.provider}]`;
      items.push({
        value: m.id,
        label,
        description: m.reasoning ? `${m.id}  ·  [reasoning]` : `${m.provider}: ${m.id}`,
        searchHaystack: `${m.provider} ${m.name ?? ""} ${m.id}`,
        reasoning: m.reasoning,
      });
    }
    return items;
  };
  const allRegistryItems: MultiSelectItem[] = buildRegistryItems();
  const councilModelItems: MultiSelectItem[] = allRegistryItems.length > 0
    ? allRegistryItems
    : state.availableModels.map((m) => ({
        value: m.id,
        label: m.name,
        description: m.reasoning ? `${m.id}  ·  [reasoning]` : m.id,
        searchHaystack: `${m.name} ${m.id}`,
        reasoning: m.reasoning,
      }));

  // Pre-populate picks from existing saved settings only. When no settings
  // exist, start with an empty picker — the user must explicitly choose
  // their council. Previously the picker auto-pre-selected the first 3
  // models of the catalog, which led to users accidentally running a
  // council they didn't choose.
  const initialCouncilPicks = state.councilModels.filter(Boolean);

  const pickedCouncilModels = await multiSelectPicker(ctx, {
    title: "Council Models",
    subtitle: `Pick ${MIN_COUNCIL_MODELS}–${MAX_COUNCIL_MODELS} models to serve on the council. Use [tab] to toggle all/scoped view.`,
    items: councilModelItems,
    initialPicks: initialCouncilPicks,
    minPicks: MIN_COUNCIL_MODELS,
    maxPicks: MAX_COUNCIL_MODELS,
    searchPlaceholder: 'Type to search (e.g. "claude", "openrouter", "qwen")',
    hint: `↑↓ navigate  Enter toggle  [tab] scope  Esc cancel  Enter on [done] to commit`,
  });

  if (pickedCouncilModels === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.councilModels = pickedCouncilModels;

  // ── Step 3: pick synthesis model ────────────────────────────────────────
  // The synthesis model reads the council opinions and writes a single
  // decision. Defaults to the first picked council model; any model works.
  const synthesisDefaultId = pickedCouncilModels[0] ?? councilModelItems[0]?.value ?? "";
  const synthesisDefaultLabel = councilModelItems.find((m) => m.value === synthesisDefaultId)?.label ?? synthesisDefaultId;

  const synthesisPick = await searchableSelect(ctx, {
    title: "Synthesis Model",
    searchPlaceholder: `Reads council opinions. Default: ${synthesisDefaultLabel}`,
    hint: `Look for [reasoning] badge · default: ${synthesisDefaultLabel}`,
    items: councilModelItems,
  });
  if (!synthesisPick) { ctx.ui.notify("Cancelled.", "info"); return; }
  const synthesisModelId = synthesisPick.value;

  // ── Step 4: pick the second-opinion model (used by /opinion) ───────────
  const opinionPick = await searchableSelect(ctx, {
    title: "Second Opinion Model",
    searchPlaceholder: "Single-model quick check (used by /opinion)",
    hint: "Recommended: a fast model for routine questions",
    items: councilModelItems,
  });
  if (!opinionPick) { ctx.ui.notify("Cancelled.", "info"); return; }
  // P3 fix: look up the picked model in the FULL registry (not just the
  // OpenRouter-filtered state.availableModels). This way direct-provider
  // models can be saved with their actual provider, not a hard-coded
  // "openrouter". Falls back to the OpenRouter-filtered list if the
  // registry didn't return the picked model (e.g. user has OpenRouter
  // via env var but the model isn't in the registry).
  const opinionModel =
    registryModels.find((m) => m.id === opinionPick.value) ??
    state.availableModels.find((m) => m.id === opinionPick.value);
  if (opinionModel) {
    // P3 fix: use the model's actual provider. For OpenRouter models
    // the provider is "openrouter" (matches the existing format); for
    // direct providers we store the real provider name. The second-
    // opinion runner already handles both via resolveModel + dispatch.
    state.opinionProvider = (opinionModel as RegistryModel).provider;
    state.opinionModelId = opinionModel.id; // full id, e.g. "anthropic/claude-3.5-sonnet"
  }

  // ── Step 5: structured output toggle ───────────────────────────────────
  state.useStructuredOutput = await ctx.ui.confirm(
    "Structured Output",
    "Use structured JSON output for faster parsing? (Recommended: Yes)",
  );

  // ── Step 6: validate the chosen API key (if we have one) ────────────────
  //
  // M4 fix: extracted into a small named helper. The previous inline
  // `if (state.apiKey) { ... }` block was a paragraph-long nested
  // expression that hid two non-obvious things:
  //   1. The validation is intentionally SKIPPED when `state.apiKey` is
  //      empty. That's correct for pi-auth-only users — the runner
  //      resolves the key from registry/env at call-time. But the
  //      condition was easy to misread as "if the user provided a key,
  //      validate it" (true meaning) when it actually means
  //      "if the user saved a key locally, validate it; otherwise skip
  //      and trust the runtime resolver".
  //   2. The injected `deps.pingOpenRouter` / `deps.fetchOpenRouterModels`
  //      are forwarded so unit tests can mock them (otherwise the
  //      real OpenRouter client is hit during validation).
  //
  // The helper documents both behaviours explicitly and notifies the
  // user on invalid result (so the caller doesn't need to know about
  // the validation detail).
  if (!(await validateCouncilSettingsStep(ctx, state, deps))) return;

  // ── Step 7: confirm and save ────────────────────────────────────────────
  const summary = [
    `OpenRouter API Key: ${state.apiKey ? redactedApiKey(state.apiKey) : "(none — using pi auth)"}`,
    `Council Models (${state.councilModels.length}):`,
    ...state.councilModels.map((id, i) => `  ${i + 1}. ${id}`),
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
      councilModels: state.councilModels,
    },
    opinion: {
      provider: state.opinionProvider,
      modelId: state.opinionModelId,
    },
    synthesis: {
      modelId: synthesisModelId,
    },
    options: current?.options ?? {
      // Defaults for first-time save — kept in sync with
      // settings.ts DEFAULT_SETTINGS so a brand-new file matches.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run the council-settings validation step (the "are the model ids
 * real?" check). Returns:
 *   - "valid"     — apiKey is empty (skipped, deferred to runtime
 *                   resolution) OR validation passed
 *   - "invalid"   — validation failed; the user was notified and the
 *                   settings UI should bail out
 *   - "cancelled" — future-proof; the current impl doesn't cancel, but
 *                   this lets the caller distinguish "we asked and got
 *                   no" from "we didn't ask".
 *
 * Behaviour notes (M4):
 *   - When `state.apiKey` is empty, the validation is intentionally
 *     skipped. The runner resolves the key from pi's auth storage or
 *     `OPENROUTER_API_KEY` env at call-time, so an empty key is a
 *     valid state (pi-auth-only users).
 *   - The injected `deps.pingOpenRouter` / `deps.fetchOpenRouterModels`
 *     are forwarded so unit tests can mock them. Without forwarding,
 *     `validateCouncilSettings` would fall back to the real
 *     `openrouterClient` and hit the live API.
 */
async function validateCouncilSettingsStep(
  ctx: ExtensionCommandContext,
  state: SettingsState,
  deps?: {
    pingOpenRouter?: (apiKey: string) => Promise<{ ok: boolean; error?: string; quota?: string }>;
    fetchOpenRouterModels?: (apiKey: string) => Promise<OpenRouterModel[]>;
  },
): Promise<boolean> {
  if (!state.apiKey) return true; // skipped — see notes

  const validation = await validateCouncilSettings(
    {
      openRouter: {
        apiKey: state.apiKey,
        councilModels: state.councilModels,
      },
    },
    state.availableModels,
    deps?.pingOpenRouter,
    deps?.fetchOpenRouterModels,
  );

  if (!validation.valid) {
    for (const err of validation.errors) {
      ctx.ui.notify(`Validation error: ${err}`, "error");
    }
    return false;
  }
  return true;
}