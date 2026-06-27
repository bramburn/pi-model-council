import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCouncil } from "../../councilRunner.js";
import { CouncilSetupError } from "../../types.js";
import * as openrouterClient from "../../openrouterClient.js";
import { extractJsonObject } from "../../openrouterClient.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// Mock all external dependencies
vi.mock("../../openrouterClient.js", () => ({
  pingOpenRouter: vi.fn(),
  fetchOpenRouterModels: vi.fn(),
  callOpenRouterChat: vi.fn(),
  extractJsonObject: vi.fn(),
}));

const TEST_DIR = join(tmpdir(), `pi-model-council-council-test-${Date.now()}`);

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(TEST_DIR, { recursive: true });
});

function createValidSettings() {
  return JSON.stringify({
    version: 1,
    openRouter: {
      apiKey: "sk-or-v1-testkey123456789",
      models: {
        model1: "qwen/qwen3.7-max",
        model2: "z-ai/glm-5.2",
        model3: "deepseek/deepseek-v4-pro",
      },
    },
    opinion: { provider: "openrouter", modelId: "qwen/qwen3.7-max" },
    options: {
      useStructuredOutput: true,
      modelTimeoutMs: 300000,
      synthesisTimeoutMs: 360000,
      retryAttempts: 1,
      retryDelayMs: 100,
    },
    lastUpdated: new Date().toISOString(),
  });
}

async function writeSettings(settings: string) {
  await mkdir(join(TEST_DIR, ".pi"), { recursive: true });
  await writeFile(join(TEST_DIR, ".pi", "council-settings.json"), settings, "utf8");
}

describe("runCouncil", () => {
  it("throws CouncilSetupError when settings file does not exist", async () => {
    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: false,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });

  it("throws CouncilSetupError with setup instructions when settings missing", async () => {
    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: false,
      }),
    ).rejects.toBeInstanceOf(CouncilSetupError);
  });

  it("throws CouncilSetupError when API key ping fails", async () => {
    await writeSettings(createValidSettings());
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: false, error: "Invalid API key" });

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });

  it("throws CouncilSetupError when configured model is not available", async () => {
    await writeSettings(createValidSettings());
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "only-one-model", name: "Only One" },
    ]);

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });

  it("throws when problem is empty", async () => {
    await writeSettings(createValidSettings());
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "qwen/qwen3.7-max", name: "Qwen" },
      { id: "z-ai/glm-5.2", name: "GLM" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek" },
    ]);

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow("Problem is required");
  });

  it("throws when mode is invalid", async () => {
    await writeSettings(createValidSettings());
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "qwen/qwen3.7-max", name: "Qwen" },
      { id: "z-ai/glm-5.2", name: "GLM" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek" },
    ]);

    await expect(
      runCouncil({
        input: { mode: "invalid", problem: "test" } as Parameters<typeof runCouncil>[0]["input"],
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow("Invalid mode");
  });

  it("returns a valid decision when all models respond", async () => {
    await writeSettings(createValidSettings());
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "qwen/qwen3.7-max", name: "Qwen" },
      { id: "z-ai/glm-5.2", name: "GLM" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek" },
    ]);

    const mockOpinion = {
      stance: "Test stance",
      recommendedApproach: "Test approach",
      steps: ["Step 1"],
      filesToConsider: [],
      risks: [],
      verification: [],
      confidence: "high" as const,
    };

    // Make extractJsonObject return a valid object so repairModelOpinion succeeds
    vi.mocked(extractJsonObject).mockReturnValue(mockOpinion);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(JSON.stringify(mockOpinion));

    const result = await runCouncil({
      input: { mode: "fix", problem: "How do I fix this bug?" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    } as Parameters<typeof runCouncil>[0]);

    expect(result.decision).toBeDefined();
    expect(result.decision.decisionId).toBeDefined();
    expect(result.decision.mode).toBe("fix");
    expect(result.decision.handoffPrompt).toBeDefined();
    expect(result.markdown).toContain("Council Decision");
  });
});
