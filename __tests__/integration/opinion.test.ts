import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSecondOpinion } from "../../secondOpinionRunner.js";
import { OpinionSetupError } from "../../types.js";
import * as openrouterClient from "../../openrouterClient.js";
import { extractJsonObject } from "../../openrouterClient.js";
import * as settingsModule from "../../settings.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

vi.mock("../../openrouterClient.js", () => ({
  callOpenRouterChat: vi.fn(),
  extractJsonObject: vi.fn(),
}));

vi.mock("../../settings.js", () => ({
  loadSettings: vi.fn(),
}));

const TEST_DIR = join(tmpdir(), `pi-model-council-opinion-test-${Date.now()}`);

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(TEST_DIR, { recursive: true });
});

function createValidSettings() {
  return {
    version: 1,
    openRouter: {
      apiKey: "sk-or-v1-opinion-test-key",
      councilModels: ["qwen/qwen3.7-max", "z-ai/glm-5.2", "deepseek/deepseek-v4-pro"],
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
  };
}

describe("runSecondOpinion", () => {
  it("throws OpinionSetupError when settings not configured", async () => {
    vi.mocked(settingsModule.loadSettings).mockResolvedValue(null);

    await expect(
      runSecondOpinion({
        input: { problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow(OpinionSetupError);
  });

  it("OpinionSetupError includes setup instructions", async () => {
    vi.mocked(settingsModule.loadSettings).mockResolvedValue(null);

    await expect(
      runSecondOpinion({
        input: { problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toBeInstanceOf(OpinionSetupError);
  });

  it("throws when problem is empty", async () => {
    vi.mocked(settingsModule.loadSettings).mockResolvedValue(createValidSettings());

    await expect(
      runSecondOpinion({
        input: { problem: "" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow("Problem is required");
  });

  it("returns opinion when API responds with structured JSON", async () => {
    vi.mocked(settingsModule.loadSettings).mockResolvedValue(createValidSettings());

    const mockOpinion = {
      stance: "Proceed with refactor",
      recommendedApproach: "Extract to helper function",
      steps: ["Step 1: identify the function", "Step 2: create helper"],
      filesToConsider: [{ path: "src/utils.ts", reason: "where the logic lives", suggestedAction: "Modify" }],
      risks: ["May affect existing callers"],
      verification: ["Run tests"],
      confidence: "high",
    };

    vi.mocked(extractJsonObject).mockReturnValue(mockOpinion);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(JSON.stringify(mockOpinion));

    const result = await runSecondOpinion({
      input: { problem: "How should I refactor this?" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });

    expect(result.opinion.stance).toBe("Proceed with refactor");
    expect(result.opinion.confidence).toBe("high");
    expect(result.markdown).toContain("Second Opinion");
    expect(result.markdown).toContain("Proceed with refactor");
  });

  it("returns markdown with model info", async () => {
    vi.mocked(settingsModule.loadSettings).mockResolvedValue(createValidSettings());

    const mockOpinion = {
      stance: "Test",
      recommendedApproach: "Test approach",
      steps: [],
      filesToConsider: [],
      risks: [],
      verification: [],
      confidence: "medium" as const,
    };
    vi.mocked(extractJsonObject).mockReturnValue(mockOpinion);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(JSON.stringify(mockOpinion));

    const result = await runSecondOpinion({
      input: { problem: "test", mode: "fix" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });

    expect(result.markdown).toContain("model-council");
  });

  it("throws when API call fails", async () => {
    vi.mocked(settingsModule.loadSettings).mockResolvedValue(createValidSettings());
    vi.mocked(openrouterClient.callOpenRouterChat).mockRejectedValue(new Error("Network timeout"));

    await expect(
      runSecondOpinion({
        input: { problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow("Model qwen/qwen3.7-max failed");
  });
});
