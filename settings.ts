import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { CouncilSettings, CouncilSettingsV1 } from "./types.js";
import { DEFAULT_COUNCIL_SIZE } from "./types.js";

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
  // SECURITY: untrusted projects must NEVER read settings from the
  // working directory. Doing so lets a malicious repo ship a
  // `.pi/agent/council-settings.json` containing the attacker's API key
  // and model IDs — when the user runs /council, their prompts (which
  // include code context) get routed to the attacker's models / keys.
  // Always fall back to the user's home directory for untrusted
  // projects. This matches the README's documented behavior.
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
    const parsed = JSON.parse(content) as CouncilSettings | CouncilSettingsV1;

    if (parsed.version !== 1) return null;

    // ── Migrate legacy v1 schema (fixed model1/2/3) → current array schema ──
    if ("models" in parsed.openRouter) {
      const legacy = parsed as CouncilSettingsV1;
      // Filter empty/undefined entries from the legacy fixed slots. A user
      // upgrading from a partial v1 config (e.g. only filled model1) would
      // otherwise carry over empty strings into the new array schema, which
      // the runner rejects at call-time.
      const migrated: CouncilSettings = {
        version: 1,
        openRouter: {
          apiKey: legacy.openRouter.apiKey,
          councilModels: [
            legacy.openRouter.models.model1,
            legacy.openRouter.models.model2,
            legacy.openRouter.models.model3,
          ].filter((id) => typeof id === "string" && id.trim().length > 0),
        },
        opinion: legacy.opinion ?? { provider: "openrouter", modelId: "" },
        synthesis: legacy.synthesis,
        options: legacy.options,
        lastUpdated: legacy.lastUpdated,
      };
      // Auto-upgrade the file silently so next load is fast.
      await saveSettings(migrated, cwd, isProjectTrusted);
      return migrated;
    }

    // Current schema validation
    // apiKey is OPTIONAL — it may be empty when the user relies on
    // pi's auth storage (`/login openrouter`) or `OPENROUTER_API_KEY`
    // env var. The runner resolves the key from settings → registry →
    // env at call-time.
    if (!Array.isArray(parsed.openRouter?.councilModels)) return null;
    // Filter empty/whitespace-only council model entries; legacy
    // migrations may have left gaps. Empty entries would otherwise
    // cause the runner to attempt API calls with model="" which the
    // upstream APIs reject with cryptic errors.
    parsed.openRouter.councilModels = parsed.openRouter.councilModels.filter(
      (id) => typeof id === "string" && id.trim().length > 0,
    );
    return parsed as CouncilSettings;
  } catch {
    return null;
  }
}

export async function saveSettings(
  settings: CouncilSettings,
  cwd: string,
  isProjectTrusted: boolean,
): Promise<void> {
  // Reuse the same dir-resolution helper as getSettingsDir so the two
  // paths can never drift. Also guarantees untrusted projects write to
  // home dir (not cwd), preventing a malicious repo from poisoning the
  // user's settings.
  const dir = getSettingsDir(cwd, isProjectTrusted);
  await mkdir(dir, { recursive: true });

  const path = join(dir, SETTINGS_FILE);
  const toSave: CouncilSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    version: 1,
    lastUpdated: new Date().toISOString(),
  };
  // Write with mode 0o600 (owner read/write only). The README claims
  // 0600 perms; previously the file was written with the process
  // umask (typically 0644), making the API key world-readable on
  // multi-user systems. On Windows, mode is ignored but the file ACL
  // is still scoped to the current user.
  await writeFile(path, JSON.stringify(toSave, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function redactedApiKey(apiKey: string): string {
  if (apiKey.length <= 11) return "••••••••";
  // M5 fix: scale bullet count to the secret length so longer keys
  // get more redaction (8 bullets for a 19-char key, more for a 51-char
  // key). Previously every key got 18 bullets regardless of length,
  // which exposed the relative length of the underlying secret.
  // Cap the redacted length at 32 bullets to keep the display tidy.
  const bullets = Math.min(32, Math.max(8, apiKey.length - 11));
  return apiKey.slice(0, 11) + "•".repeat(bullets);
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
  lines.push(
    settings.openRouter.apiKey
      ? `  OpenRouter API Key: ${redactedApiKey(settings.openRouter.apiKey)}`
      : "  OpenRouter API Key: (using pi auth — no key stored locally)",
  );
  const cm = settings.openRouter.councilModels.filter(
    (id) => typeof id === "string" && id.trim().length > 0,
  );
  if (cm.length === 0) {
    lines.push("  Council Models: (none configured)");
  } else {
    cm.forEach((id, i) => lines.push(`  Council Model ${i + 1}: ${id}`));
  }
  // H2 fix: render the synthesis line in three sensible states instead
  // of always showing the same "(default: first council model)" suffix.
  //   1. synthesis.modelId is set           -> "Synthesis Model: <id>"
  //   2. unset + council has models          -> "Synthesis Model: (default: <first>)"
  //   3. unset + no council                  -> "Synthesis Model: (none — set one in /council-settings)"
  const synthesisModelId = settings.synthesis?.modelId?.trim();
  if (synthesisModelId) {
    lines.push(`  Synthesis Model: ${synthesisModelId}`);
  } else if (cm.length > 0) {
    lines.push(`  Synthesis Model: (default: ${cm[0]})`);
  } else {
    lines.push(`  Synthesis Model: (none — set one in /council-settings)`);
  }
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
      councilModels: Array(DEFAULT_COUNCIL_SIZE).fill(""),
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
