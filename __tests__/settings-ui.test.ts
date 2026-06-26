import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import {
  showCurrentSettings,
  resetSettings,
  openCouncilSettingsUI,
  openOpinionSettingsUI,
  getOpenRouterModelsFromRegistry,
  resolveOpenRouterApiKey,
} from "../settings-ui.js";

// ─── Test constants ────────────────────────────────────────────────────────────

const MOCK_MODELS = [
  { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
  { id: "z-ai/glm-5.2", name: "GLM-5.2" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
];

function makeCtx(testDir: string) {
  return {
    cwd: testDir,
    isProjectTrusted: () => !testDir.includes("agent"),
    modelRegistry: {
      getAvailable: vi.fn().mockResolvedValue([]),
      getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
    },
    ui: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
    },
  } as Parameters<typeof showCurrentSettings>[0];
}

// ─── Show current settings ─────────────────────────────────────────────────────

describe("showCurrentSettings", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `pi-mc-show-${Date.now()}`);
    await mkdir(join(testDir, ".pi", "agent"), { recursive: true });
  });

  it("notifies unconfigured when no settings file exists", async () => {
    const ctx = makeCtx(join(testDir, "agent"));
    await showCurrentSettings(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    const [msg] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("Not configured");
  });

  it("shows settings summary when configured", async () => {
    // Trusted mode uses cwd/.pi/council-settings.json
    const settingsDir = join(testDir, ".pi");
    const settings = {
      version: 1,
      openRouter: { apiKey: "sk-or-v1-testkey123456", models: { model1: "qwen/qwen3.7-max", model2: "z-ai/glm-5.2", model3: "deepseek/deepseek-v4-pro" } },
      opinion: { provider: "openrouter", modelId: "qwen/qwen3.7-max" },
      options: { useStructuredOutput: true, modelTimeoutMs: 300000, synthesisTimeoutMs: 360000, retryAttempts: 3, retryDelayMs: 3000 },
      lastUpdated: "2026-06-25T00:00:00Z",
    };
    await writeFile(join(settingsDir, "council-settings.json"), JSON.stringify(settings), "utf8");
    const ctx = makeCtx(testDir); // makeCtx uses isProjectTrusted = !cwd.includes("agent")
    await showCurrentSettings(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    const [msg] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("qwen/qwen3.7-max");
  });
});

// ─── Reset settings ────────────────────────────────────────────────────────────

describe("resetSettings", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `pi-mc-reset-${Date.now()}`);
    await mkdir(join(testDir, ".pi"), { recursive: true });
  });

  it("notifies when resetting all settings", async () => {
    const ctx = makeCtx(testDir);
    await resetSettings(ctx, "all");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("reset");
  });

  it("notifies when resetting council only", async () => {
    const ctx = makeCtx(testDir);
    await resetSettings(ctx, "council");
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("Council");
  });

  it("does not throw when file does not exist", async () => {
    const ctx = makeCtx(testDir);
    await expect(resetSettings(ctx, "all")).resolves.toBeUndefined();
  });
});

// ─── openCouncilSettingsUI ────────────────────────────────────────────────────

describe("openCouncilSettingsUI", () => {
  let testDir: string;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `pi-mc-council-ui-${Date.now()}`);
    await mkdir(join(testDir, ".pi"), { recursive: true });
    ctx = makeCtx(testDir);
  });

  it("notifies cancelled when user provides empty API key", async () => {
    ctx.ui.input.mockResolvedValue("");
    await openCouncilSettingsUI(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("notifies error when ping fails", async () => {
    ctx.ui.input.mockResolvedValue("sk-or-v1-test");
    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: false, error: "Invalid key" }),
    });

    const errorCall = ctx.ui.notify.mock.calls.find(([, type]) => type === "error");
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).toContain("Connection failed");
  });

  it("notifies cancelled when model1 selection is cancelled", async () => {
    ctx.ui.input.mockResolvedValue("sk-or-v1-test");
    ctx.ui.select.mockResolvedValue("");
    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: true }),
      fetchOpenRouterModels: vi.fn().mockResolvedValue(MOCK_MODELS),
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("notifies cancelled when model2 selection is cancelled", async () => {
    ctx.ui.input.mockResolvedValue("sk-or-v1-test");
    ctx.ui.select
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("");
    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: true }),
      fetchOpenRouterModels: vi.fn().mockResolvedValue(MOCK_MODELS),
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("notifies cancelled when model3 selection is cancelled", async () => {
    ctx.ui.input.mockResolvedValue("sk-or-v1-test");
    ctx.ui.select
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("GLM-5.2")
      .mockResolvedValueOnce("");
    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: true }),
      fetchOpenRouterModels: vi.fn().mockResolvedValue(MOCK_MODELS),
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("saves settings when user confirms all selections", async () => {
    ctx.ui.input.mockResolvedValue("sk-or-v1-test");
    ctx.ui.select
      .mockResolvedValueOnce("Qwen 3.7 Max")   // model 1
      .mockResolvedValueOnce("GLM-5.2")         // model 2
      .mockResolvedValueOnce("DeepSeek V4 Pro") // model 3
      .mockResolvedValueOnce("Qwen 3.7 Max")   // synthesis model
      .mockResolvedValueOnce("Qwen 3.7 Max");  // opinion model
    ctx.ui.confirm
      .mockResolvedValueOnce(true)              // structured output
      .mockResolvedValueOnce(true);             // save confirmation
    ctx.modelRegistry.getAvailable.mockResolvedValue([]); // force REST fallback

    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: true }),
      fetchOpenRouterModels: vi.fn().mockResolvedValue(MOCK_MODELS),
    });

    const successCall = ctx.ui.notify.mock.calls.find(([msg]) => msg.includes("saved successfully"));
    expect(successCall).toBeDefined();
  });

  it("notifies 'not saved' when user rejects save confirmation", async () => {
    ctx.ui.input.mockResolvedValue("sk-or-v1-test");
    ctx.ui.select
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("GLM-5.2")
      .mockResolvedValueOnce("DeepSeek V4 Pro")
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("Qwen 3.7 Max");
    ctx.ui.confirm
      .mockResolvedValueOnce(true)              // structured output = yes
      .mockResolvedValueOnce(false);             // save = no
    ctx.modelRegistry.getAvailable.mockResolvedValue([]); // force REST fallback

    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: true }),
      fetchOpenRouterModels: vi.fn().mockResolvedValue(MOCK_MODELS),
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith("Settings not saved.", "info");
  });
});

// ─── openOpinionSettingsUI ───────────────────────────────────────────────────

describe("openOpinionSettingsUI", () => {
  let testDir: string;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `pi-mc-opinion-ui-${Date.now()}`);
    await mkdir(join(testDir, ".pi"), { recursive: true });
    ctx = makeCtx(testDir);
  });

  it("notifies error when no models are available", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([]);
    await openOpinionSettingsUI(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [msg, type] = ctx.ui.notify.mock.calls[0];
    expect(type).toBe("error");
    expect(msg).toContain("No models");
  });

  it("cancels when provider selection is cancelled", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen" },
    ]);
    ctx.ui.select.mockResolvedValue("");

    await openOpinionSettingsUI(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("cancels when model selection is cancelled", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen" },
    ]);
    ctx.ui.select
      .mockResolvedValueOnce("openrouter")
      .mockResolvedValueOnce("");

    await openOpinionSettingsUI(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("cancels when user rejects the save confirmation", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen 3.7 Max" },
    ]);
    ctx.ui.select
      .mockResolvedValueOnce("openrouter")
      .mockResolvedValueOnce("qwen/qwen3.7-max");
    ctx.ui.confirm.mockResolvedValue(false);

    await openOpinionSettingsUI(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  it("saves and notifies success when confirmed", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen 3.7 Max" },
    ]);
    ctx.ui.select
      .mockResolvedValueOnce("openrouter")
      .mockResolvedValueOnce("qwen/qwen3.7-max");
    ctx.ui.confirm.mockResolvedValue(true);

    await openOpinionSettingsUI(ctx);

    const successCall = ctx.ui.notify.mock.calls.find(([msg]) => msg.includes("Opinion model set"));
    expect(successCall).toBeDefined();
    expect(successCall![0]).toContain("qwen/qwen3.7-max");
  });
});

// ─── Registry helpers ──────────────────────────────────────────────────────

describe("getOpenRouterModelsFromRegistry", () => {
  it("filters to provider === 'openrouter' and keeps id + name", () => {
    const models = [
      { id: "anthropic/claude-3.5-sonnet", provider: "openrouter", name: "Claude 3.5 Sonnet" },
      { id: "openai/gpt-4o", provider: "openai", name: "GPT-4o" },
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen 3.7 Max" },
    ];
    expect(getOpenRouterModelsFromRegistry(models)).toEqual([
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
      { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
    ]);
  });

  it("returns [] when registry is empty", () => {
    expect(getOpenRouterModelsFromRegistry([])).toEqual([]);
  });
});

describe("resolveOpenRouterApiKey", () => {
  function makeCtx() {
    return {
      modelRegistry: {
        getApiKeyForProvider: vi.fn(),
      },
    } as unknown as Parameters<typeof resolveOpenRouterApiKey>[0];
  }

  it("prefers the explicit key over the registry", async () => {
    const ctx = makeCtx();
    const key = await resolveOpenRouterApiKey(ctx, "sk-or-v1-explicit");
    expect(key).toBe("sk-or-v1-explicit");
    expect(ctx.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("falls back to the registry when no explicit key is provided", async () => {
    const ctx = makeCtx();
    ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue("sk-or-v1-from-registry");
    const key = await resolveOpenRouterApiKey(ctx);
    expect(key).toBe("sk-or-v1-from-registry");
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openrouter");
  });

  it("returns undefined when no key is found anywhere", async () => {
    const ctx = makeCtx();
    ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue(undefined);
    delete process.env.OPENROUTER_API_KEY;
    const key = await resolveOpenRouterApiKey(ctx);
    expect(key).toBeUndefined();
  });
});

// ─── Registry-driven council UI flow ────────────────────────────────────────

describe("openCouncilSettingsUI (registry path)", () => {
  let testDir: string;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `pi-mc-council-registry-${Date.now()}`);
    await mkdir(join(testDir, ".pi"), { recursive: true });
    ctx = makeCtx(testDir);
  });

  it("skips the API-key prompt when the registry exposes OpenRouter models", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { id: "anthropic/claude-3.5-sonnet", provider: "openrouter", name: "Claude 3.5 Sonnet" },
      { id: "openai/gpt-4o-mini", provider: "openrouter", name: "GPT-4o Mini" },
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen 3.7 Max" },
    ]);
    ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue("sk-or-v1-from-registry");

    ctx.ui.select
      .mockResolvedValueOnce("Claude 3.5 Sonnet") // model 1
      .mockResolvedValueOnce("GPT-4o Mini")        // model 2
      .mockResolvedValueOnce("Qwen 3.7 Max")       // model 3
      .mockResolvedValueOnce("Claude 3.5 Sonnet")  // synthesis
      .mockResolvedValueOnce("Qwen 3.7 Max");      // opinion
    ctx.ui.confirm.mockResolvedValue(true);

    await openCouncilSettingsUI(ctx);

    // The legacy API-key input was skipped — only confirm() and select() ran.
    expect(ctx.ui.input).not.toHaveBeenCalled();
    const successCall = ctx.ui.notify.mock.calls.find(([msg]) => msg.includes("saved successfully"));
    expect(successCall).toBeDefined();
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openrouter");
  });

  it("falls back to the API-key prompt when the registry has fewer than 3 OpenRouter models", async () => {
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { id: "qwen/qwen3.7-max", provider: "openrouter", name: "Qwen 3.7 Max" },
    ]);
    ctx.ui.input.mockResolvedValue("sk-or-v1-manual");
    ctx.ui.select
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("Qwen 3.7 Max");
    ctx.ui.confirm.mockResolvedValue(true);

    await openCouncilSettingsUI(ctx, {
      pingOpenRouter: vi.fn().mockResolvedValue({ ok: true }),
      fetchOpenRouterModels: vi.fn().mockResolvedValue(MOCK_MODELS),
    });

    expect(ctx.ui.input).toHaveBeenCalledOnce();
  });
});
