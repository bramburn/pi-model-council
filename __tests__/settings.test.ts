import { describe, it, expect, beforeEach } from "vitest";
import { loadSettings, saveSettings, createDefaultSettings, redactedApiKey, formatSettingsForDisplay } from "../settings.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Each test gets its own isolated directory
const getTestDir = () => join(tmpdir(), `pi-mc-test-${Date.now()}-${Math.random()}`);

describe("loadSettings / saveSettings", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await mkdir(join(testDir, ".pi"), { recursive: true });
  });

  it("returns null when file does not exist", async () => {
    const result = await loadSettings(testDir, false);
    expect(result).toBeNull();
  });

  it("roundtrips a full settings object", async () => {
    const settings = {
      version: 1 as const,
      openRouter: {
        apiKey: "sk-or-v1-test123",
        councilModels: [
          "qwen/qwen3.7-max",
          "z-ai/glm-5.2",
          "deepseek/deepseek-v4-pro",
        ],
      },
      opinion: { provider: "openrouter", modelId: "qwen/qwen3.7-max" },
      options: {
        useStructuredOutput: true,
        modelTimeoutMs: 300000,
        synthesisTimeoutMs: 360000,
        retryAttempts: 3,
        retryDelayMs: 3000,
      },
      lastUpdated: "2024-06-25T00:00:00.000Z",
    };

    await saveSettings(settings, testDir, false);
    const loaded = await loadSettings(testDir, false);

    expect(loaded).not.toBeNull();
    expect(loaded?.openRouter.apiKey).toBe("sk-or-v1-test123");
    expect(loaded?.openRouter.councilModels).toEqual([
      "qwen/qwen3.7-max",
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(loaded?.opinion.provider).toBe("openrouter");
    expect(loaded?.opinion.modelId).toBe("qwen/qwen3.7-max");
    expect(loaded?.options.useStructuredOutput).toBe(true);
  });

  it("returns null for invalid JSON", async () => {
    const path = join(testDir, ".pi", "council-settings.json");
    await writeFile(path, "not valid json{", "utf8");
    const result = await loadSettings(testDir, false);
    expect(result).toBeNull();
  });

  it("returns null for missing version field", async () => {
    const path = join(testDir, ".pi", "council-settings.json");
    await writeFile(path, JSON.stringify({ version: 2, openRouter: { apiKey: "x", councilModels: ["a", "b", "c"] } }), "utf8");
    const result = await loadSettings(testDir, false);
    expect(result).toBeNull();
  });

  it("saves to project dir when isProjectTrusted is true", async () => {
    const projectDir = join(testDir, "project");
    await mkdir(projectDir, { recursive: true });
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-key2";
    settings.openRouter.councilModels = ["m1", "m2", "m3"];

    await saveSettings(settings, projectDir, true);

    const expectedPath = join(projectDir, ".pi", "council-settings.json");
    const { existsSync } = await import("node:fs");
    expect(existsSync(expectedPath)).toBe(true);
  });
});

describe("redactedApiKey", () => {
  it("redacts long keys keeping first 11 chars", () => {
    const result = redactedApiKey("sk-or-v1-abcdefghijklmnop");
    expect(result).toBe("sk-or-v1-ab••••••••••••••••••");
  });

  it("redacts short keys completely", () => {
    expect(redactedApiKey("sk-short")).toBe("••••••••");
  });
});

describe("formatSettingsForDisplay", () => {
  it("shows unconfigured message when null", () => {
    const lines = formatSettingsForDisplay(null);
    expect(lines[0]).toContain("Not configured");
  });

  it("shows redacted API key", () => {
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-longkey12345";
    const lines = formatSettingsForDisplay(settings);
    expect(lines.some(l => l.includes("••••••••"))).toBe(true);
    expect(lines.some(l => l.includes("sk-or-v1-lo"))).toBe(true);
  });
});

describe("createDefaultSettings", () => {
  it("creates valid default settings", () => {
    const settings = createDefaultSettings();
    expect(settings.version).toBe(1);
    expect(settings.options.useStructuredOutput).toBe(true);
    expect(settings.options.modelTimeoutMs).toBe(300000);
    expect(settings.options.retryAttempts).toBe(3);
    expect(settings.opinion.modelId).toBe("qwen/qwen3.7-max");
  });
});
