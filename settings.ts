import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { CouncilSettings } from "./types.js";

const SETTINGS_FILE = "council-settings.json";

const DEFAULT_SETTINGS: Omit<CouncilSettings, "version" | "lastUpdated" | "openRouter" | "opinion"> = {
  options: {
    useStructuredOutput: true,
    modelTimeoutMs: 300000,
    synthesisTimeoutMs: 360000,
    retryAttempts: 3,
    retryDelayMs: 3000,
  },
};

export function getSettingsDir(cwd: string, isProjectTrusted: boolean): string {
  if (isProjectTrusted) {
    return join(cwd, CONFIG_DIR_NAME);
  }
  // Use cwd if provided, fall back to home dir
  if (cwd && cwd !== "/") {
    return join(cwd, ".pi", "agent");
  }
  return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(cwd: string, isProjectTrusted: boolean): string {
  return join(getSettingsDir(cwd, isProjectTrusted), SETTINGS_FILE);
}

export async function loadSettings(
  cwd: string,
  isProjectTrusted: boolean,
): Promise<CouncilSettings | null> {
  const path = getSettingsPath(cwd, isProjectTrusted);
  if (!existsSync(path)) return null;

  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as CouncilSettings;
    // Basic validation
    if (parsed.version !== 1) return null;
    if (!parsed.openRouter?.apiKey) return null;
    if (!parsed.openRouter?.models) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSettings(
  settings: CouncilSettings,
  cwd: string,
  isProjectTrusted: boolean,
): Promise<void> {
  // Determine the target directory based on trust level
  const dir = isProjectTrusted
    ? join(cwd, CONFIG_DIR_NAME)
    : (cwd && cwd !== "/" ? join(cwd, ".pi", "agent") : join(homedir(), ".pi", "agent"));
  await mkdir(dir, { recursive: true });

  const path = join(dir, SETTINGS_FILE);
  const toSave: CouncilSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    version: 1,
    lastUpdated: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(toSave, null, 2), "utf8");
}

export function redactedApiKey(apiKey: string): string {
  if (apiKey.length <= 11) return "••••••••";
  // Keep first 11 chars (e.g. "sk-or-v1-ab") + 18 bullets = 29 total
  return apiKey.slice(0, 11) + "••••••••••••••••••";
}

export function formatSettingsForDisplay(settings: CouncilSettings | null): string[] {
  if (!settings) {
    return [
      "Council Settings: Not configured",
      "Run /council-settings to set up your API key and models.",
    ];
  }

  const lines: string[] = [];
  lines.push("Council Settings:");
  lines.push(`  OpenRouter API Key: ${redactedApiKey(settings.openRouter.apiKey)}`);
  lines.push(`  Model 1: ${settings.openRouter.models.model1}`);
  lines.push(`  Model 2: ${settings.openRouter.models.model2}`);
  lines.push(`  Model 3: ${settings.openRouter.models.model3}`);
  lines.push(`  Second Opinion Model: ${settings.opinion.provider}/${settings.opinion.modelId}`);
  lines.push(`  Structured Output: ${settings.options.useStructuredOutput ? "enabled" : "disabled"}`);
  lines.push(`  Model Timeout: ${settings.options.modelTimeoutMs / 1000}s`);
  lines.push(`  Retry Attempts: ${settings.options.retryAttempts}`);
  lines.push(`  Last Updated: ${settings.lastUpdated}`);
  return lines;
}

export function createDefaultSettings(): CouncilSettings {
  return {
    version: 1,
    openRouter: {
      apiKey: "",
      models: {
        model1: "",
        model2: "",
        model3: "",
      },
    },
    opinion: {
      provider: "openrouter",
      modelId: "qwen/qwen3.7-max",
    },
    options: {
      useStructuredOutput: true,
      modelTimeoutMs: 300000,
      synthesisTimeoutMs: 360000,
      retryAttempts: 3,
      retryDelayMs: 3000,
    },
    lastUpdated: new Date().toISOString(),
  };
}
