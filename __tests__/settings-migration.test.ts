/**
 * Tests for the v1 → v2 settings migration (fixed model1/2/3 → councilModels[])
 * and the dynamic councilModels[] schema.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadSettings, createDefaultSettings, formatSettingsForDisplay } from "../settings.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const getTestDir = () => join(tmpdir(), `pi-mc-migration-test-${Date.now()}-${Math.random()}`);

describe("loadSettings — legacy v1 migration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    // isProjectTrusted=true reads from <cwd>/.pi/council-settings.json
    // (Untrusted now reads from ~/.pi/agent/, which is brittle to test)
    await mkdir(join(testDir, ".pi"), { recursive: true });
  });

  it("migrates a legacy v1 file (models: {model1,model2,model3}) to councilModels[]", async () => {
    const legacySettings = {
      version: 1,
      openRouter: {
        apiKey: "sk-or-v1-legacy-key",
        models: {
          model1: "qwen/qwen3.7-max",
          model2: "anthropic/claude-3.5-sonnet",
          model3: "deepseek/deepseek-v4-pro",
        },
      },
      opinion: { provider: "openrouter", modelId: "qwen/qwen3.7-max" },
      options: {
        useStructuredOutput: true,
        modelTimeoutMs: 300000,
        synthesisTimeoutMs: 360000,
        retryAttempts: 3,
        retryDelayMs: 3000,
      },
      lastUpdated: "2024-01-01T00:00:00.000Z",
    };

    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(settingsPath, JSON.stringify(legacySettings), "utf8");

    // Load and migrate
    const loaded = await loadSettings(testDir, true);
    expect(loaded).not.toBeNull();
    expect(loaded!.openRouter.councilModels).toEqual([
      "qwen/qwen3.7-max",
      "anthropic/claude-3.5-sonnet",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(loaded!.openRouter.apiKey).toBe("sk-or-v1-legacy-key");
  });

  it("auto-saves migrated settings back to disk in the new format", async () => {
    const legacySettings = {
      version: 1,
      openRouter: {
        apiKey: "sk-or-v1-legacy-key",
        models: { model1: "a/m1", model2: "b/m2", model3: "c/m3" },
      },
      opinion: { provider: "openrouter", modelId: "a/m1" },
      options: {
        useStructuredOutput: true,
        modelTimeoutMs: 300000,
        synthesisTimeoutMs: 360000,
        retryAttempts: 3,
        retryDelayMs: 3000,
      },
      lastUpdated: "2024-01-01T00:00:00.000Z",
    };

    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(settingsPath, JSON.stringify(legacySettings), "utf8");

    // Load (triggers migration + re-save)
    await loadSettings(testDir, true);

    // Re-read the raw file — should be the new format
    const rawContent = await import("node:fs/promises").then((fs) =>
      fs.readFile(settingsPath, "utf8"),
    );
    const reloaded = JSON.parse(rawContent);
    expect(reloaded.openRouter).toHaveProperty("councilModels");
    expect(reloaded.openRouter.councilModels).toEqual(["a/m1", "b/m2", "c/m3"]);
    expect(reloaded.openRouter).not.toHaveProperty("models");
  });

  it("loads a current-format v1 file (councilModels[]) without migration", async () => {
    const currentSettings = {
      version: 1,
      openRouter: {
        apiKey: "sk-or-v1-current-key",
        councilModels: ["model/a", "model/b", "model/c"],
      },
      opinion: { provider: "openrouter", modelId: "model/a" },
      options: {
        useStructuredOutput: true,
        modelTimeoutMs: 300000,
        synthesisTimeoutMs: 360000,
        retryAttempts: 3,
        retryDelayMs: 3000,
      },
      lastUpdated: "2025-01-01T00:00:00.000Z",
    };

    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(settingsPath, JSON.stringify(currentSettings), "utf8");

    const loaded = await loadSettings(testDir, true);
    expect(loaded).not.toBeNull();
    expect(loaded!.openRouter.councilModels).toEqual(["model/a", "model/b", "model/c"]);
  });

  it("returns null for invalid JSON", async () => {
    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(settingsPath, "not json{", "utf8");
    const result = await loadSettings(testDir, true);
    expect(result).toBeNull();
  });

  it("returns null for version !== 1", async () => {
    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 2, openRouter: { apiKey: "x", councilModels: [] } }),
      "utf8",
    );
    const result = await loadSettings(testDir, true);
    expect(result).toBeNull();
  });

  it("returns null when councilModels is missing from current schema", async () => {
    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 1, openRouter: { apiKey: "x" } }),
      "utf8",
    );
    const result = await loadSettings(testDir, true);
    expect(result).toBeNull();
  });
});

describe("createDefaultSettings — councilModels array", () => {
  it("initialises councilModels with DEFAULT_COUNCIL_SIZE (3) empty strings", () => {
    const settings = createDefaultSettings();
    expect(settings.openRouter.councilModels).toHaveLength(3);
    expect(settings.openRouter.councilModels).toEqual(["", "", ""]);
  });

  it("sets opinion provider to 'openrouter' and modelId to 'qwen/qwen3.7-max'", () => {
    const settings = createDefaultSettings();
    expect(settings.opinion.provider).toBe("openrouter");
    expect(settings.opinion.modelId).toBe("qwen/qwen3.7-max");
  });
});

describe("formatSettingsForDisplay — dynamic councilModels list", () => {
  it("shows each council model on its own line with index", () => {
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-display-test";
    settings.openRouter.councilModels = [
      "qwen/qwen3.7-max",
      "anthropic/claude-3.5-sonnet",
      "deepseek/deepseek-v4-pro",
    ];

    const lines = formatSettingsForDisplay(settings);
    expect(lines).toContain("  Council Model 1: qwen/qwen3.7-max");
    expect(lines).toContain("  Council Model 2: anthropic/claude-3.5-sonnet");
    expect(lines).toContain("  Council Model 3: deepseek/deepseek-v4-pro");
  });

  it("shows (none configured) when councilModels is empty", () => {
    const settings = createDefaultSettings();
    settings.openRouter.councilModels = [];
    settings.openRouter.apiKey = "sk-or-v1-test";

    const lines = formatSettingsForDisplay(settings);
    expect(lines).toContain("  Council Models: (none configured)");
  });

  it("uses the first council model as synthesis default in display", () => {
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-test";
    settings.openRouter.councilModels = ["first/model", "second/model"];
    settings.synthesis = undefined; // use default

    const lines = formatSettingsForDisplay(settings);
    expect(lines.some((l) => l.includes("Synthesis Model: first/model (default: first council model)"))).toBe(true);
  });
});
