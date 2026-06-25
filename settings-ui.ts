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
  };

  // Step 1: Ask for API key
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

  // Fetch models
  try {
    state.availableModels = await (deps?.fetchOpenRouterModels ?? fetchOpenRouterModels)(state.apiKey);
  } catch {
    ctx.ui.notify("Connected, but could not fetch model list. Using recommended defaults.", "warning");
    state.availableModels = [
      { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
      { id: "z-ai/glm-5.2", name: "GLM-5.2" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ];
  }

  // Step 2: Select 3 council models
  const modelItems = state.availableModels.map(m => ({ value: m.id, label: m.name }));

  const model1Choice = await ctx.ui.select("Council Model 1 (required)", modelItems.map(m => m.label));
  if (!model1Choice) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.model1 = modelItems.find(m => m.label === model1Choice)?.value ?? model1Choice;

  const model2Items = modelItems.filter(m => m.value !== state.model1);
  const model2Choice = await ctx.ui.select("Council Model 2 (required)", model2Items.map(m => m.label));
  if (!model2Choice) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.model2 = model2Items.find(m => m.label === model2Choice)?.value ?? model2Choice;

  const model3Items = model2Items.filter(m => m.value !== state.model2);
  const model3Choice = await ctx.ui.select("Council Model 3 (required)", model3Items.map(m => m.label));
  if (!model3Choice) { ctx.ui.notify("Cancelled.", "info"); return; }
  state.model3 = model3Items.find(m => m.label === model3Choice)?.value ?? model3Choice;

  // Step 3: Validate
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

  // Step 4: Second opinion model
  const opinionChoice = await ctx.ui.select(
    "Second Opinion Model",
    state.availableModels.map(m => m.name),
  );
  if (!opinionChoice) { ctx.ui.notify("Cancelled.", "info"); return; }
  const selectedModel = state.availableModels.find(m => m.name === opinionChoice);
  if (selectedModel) {
    const parts = selectedModel.id.split("/");
    state.opinionProvider = parts[0] ?? "openrouter";
    state.opinionModelId = selectedModel.id;
  }

  // Step 5: Structured output toggle
  state.useStructuredOutput = await ctx.ui.confirm(
    "Structured Output",
    "Use structured JSON output for faster parsing? (Recommended: Yes)",
  );

  // Step 6: Confirm and save
  const summary = [
    `OpenRouter API Key: ${redactedApiKey(state.apiKey)}`,
    `Council Models: ${state.model1}, ${state.model2}, ${state.model3}`,
    `Opinion Model: ${state.opinionModelId}`,
    `Structured Output: ${state.useStructuredOutput ? "enabled" : "disabled"}`,
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
  const available = await ctx.modelRegistry.getAvailable();

  if (available.length === 0) {
    ctx.ui.notify("No models with valid API keys available. Configure API keys in pi settings.", "error");
    return;
  }

  const providerGroups = new Map<string, string[]>();
  for (const model of available) {
    const list = providerGroups.get(model.provider) ?? [];
    list.push(model.id);
    providerGroups.set(model.provider, list);
  }

  const providers = Array.from(providerGroups.keys());
  const providerChoice = await ctx.ui.select("Provider", providers);
  if (!providerChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

  const modelIds = providerGroups.get(providerChoice) ?? [];
  const modelChoice = await ctx.ui.select("Model", modelIds);
  if (!modelChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

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
