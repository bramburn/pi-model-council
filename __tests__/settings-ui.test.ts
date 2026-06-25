import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import {
  showCurrentSettings,
  resetSettings,
  openCouncilSettingsUI,
  openOpinionSettingsUI,
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
    modelRegistry: { getAvailable: vi.fn().mockResolvedValue([]) },
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
      .mockResolvedValueOnce("Qwen 3.7 Max")
      .mockResolvedValueOnce("GLM-5.2")
      .mockResolvedValueOnce("DeepSeek V4 Pro")
      .mockResolvedValueOnce("Qwen 3.7 Max");
    ctx.ui.confirm.mockResolvedValue(true);

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
      .mockResolvedValueOnce("Qwen 3.7 Max");
    ctx.ui.confirm.mockResolvedValue(false);

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
