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
    const result = await loadSettings(testDir, true);
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

    await saveSettings(settings, testDir, true);
    const loaded = await loadSettings(testDir, true);

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
    const result = await loadSettings(testDir, true);
    expect(result).toBeNull();
  });

  it("returns null for missing version field", async () => {
    const path = join(testDir, ".pi", "council-settings.json");
    await writeFile(path, JSON.stringify({ version: 2, openRouter: { apiKey: "x", councilModels: ["a", "b", "c"] } }), "utf8");
    const result = await loadSettings(testDir, true);
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

  it("writes settings file with mode 0o600 (owner read/write only)", async () => {
    // SECURITY: README claims 0600 perms. Verify the file is created with
    // owner-only access so the API key isn't world-readable on multi-user
    // systems. Windows ignores the mode bits but the test still confirms
    // the write succeeded and the file isn't accidentally 0o644 elsewhere.
    const projectDir = join(testDir, "perm-test");
    await mkdir(projectDir, { recursive: true });
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-perm-test";
    settings.openRouter.councilModels = ["m1", "m2", "m3"];

    await saveSettings(settings, projectDir, true);

    const { statSync } = await import("node:fs");
    const stats = statSync(join(projectDir, ".pi", "council-settings.json"));
    // 0o600 = 384. On POSIX this exact value matters; on Windows the
    // mode bits are ignored (always reports 0o666) so we accept either.
    const mode = stats.mode & 0o777;
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    } else {
      // Windows: just confirm the file exists with the right content
      expect(stats.size).toBeGreaterThan(0);
    }
  });

  it("untrusted project writes settings to home dir, not cwd (hijack prevention)", async () => {
    // SECURITY: untrusted projects must NEVER write settings to the
    // working directory. A malicious repo could ship its own
    // .pi/agent/council-settings.json to hijack model picks + API keys.
    const projectDir = join(testDir, "hostile-repo");
    await mkdir(projectDir, { recursive: true });
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-hostile";
    settings.openRouter.councilModels = ["m1"];

    // Snapshot the home-dir settings so we can restore them afterwards.
    // Without this, tests that pollute ~/.pi/agent/ would leak into other
    // test files (e.g. smoke.test.ts).
    const { getSettingsDir } = await import("../settings.js");
    const homeDir = getSettingsDir(projectDir, false);
    const homePath = join(homeDir, "council-settings.json");
    const { existsSync, readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
    const existedBefore = existsSync(homePath);
    const beforeContent = existedBefore ? readFileSync(homePath, "utf8") : null;

    try {
      await saveSettings(settings, projectDir, false);

      // The local <cwd>/.pi/agent/ must NOT contain settings (would be a
      // hijack vector). The home dir IS expected to be written.
      const localPath = join(projectDir, ".pi", "agent", "council-settings.json");
      expect(existsSync(localPath)).toBe(false);

      // Confirm by reading back: loadSettings with the same args should
      // return the settings we just wrote (from home dir).
      const loaded = await loadSettings(projectDir, false);
      expect(loaded?.openRouter.apiKey).toBe("sk-or-v1-hostile");
    } finally {
      // Restore or remove so we don't leak state into other test files.
      if (existedBefore && beforeContent !== null) {
        writeFileSync(homePath, beforeContent, "utf8");
      } else {
        try { unlinkSync(homePath); } catch { /* ignore */ }
      }
    }
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

describe("getSettingsDir", () => {
  it("returns <cwd>/.pi for trusted projects", async () => {
    const { getSettingsDir } = await import("../settings.js");
    const dir = getSettingsDir("/some/project", true);
    expect(dir).toBe(join("/some/project", ".pi"));
  });

  it("returns ~/.pi/agent for untrusted projects (NOT <cwd>/.pi/agent)", async () => {
    // SECURITY: this is the hijack-prevention invariant.
    const { getSettingsDir } = await import("../settings.js");
    const dir = getSettingsDir("/some/hostile/repo", false);
    expect(dir).not.toContain("/some/hostile/repo");
    expect(dir).toMatch(/\.pi[\\/]agent$/);
  });

  it("returns ~/.pi/agent even when cwd is empty or root", async () => {
    const { getSettingsDir } = await import("../settings.js");
    expect(getSettingsDir("", false)).toMatch(/\.pi[\\/]agent$/);
    expect(getSettingsDir("/", false)).toMatch(/\.pi[\\/]agent$/);
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
