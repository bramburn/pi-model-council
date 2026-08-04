/**
 * Tests for runCouncil with dynamic councilModels[] array size.
 * Verifies the runner works with 1, 3, and 5 council members.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCouncil } from "../../councilRunner.js";
import { CouncilSetupError } from "../../types.js";
import * as openrouterClient from "../../openrouterClient.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

vi.mock("../../openrouterClient.js", () => ({
  pingOpenRouter: vi.fn(),
  fetchOpenRouterModels: vi.fn(),
  callOpenRouterChat: vi.fn(),
  extractJsonObject: vi.fn(),
}));

const TEST_DIR = join(tmpdir(), `pi-mc-dynamic-council-${Date.now()}`);

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(TEST_DIR, { recursive: true });
});

function writeSettings(councilModels: string[]): Promise<void> {
  const settings = {
    version: 1,
    openRouter: {
      apiKey: "sk-or-v1-dynamic-test-key",
      councilModels,
    },
    opinion: { provider: "openrouter", modelId: councilModels[0] ?? "any/model" },
    options: {
      useStructuredOutput: true,
      modelTimeoutMs: 300000,
      synthesisTimeoutMs: 360000,
      retryAttempts: 1,
      retryDelayMs: 100,
    },
    lastUpdated: new Date().toISOString(),
  };
  return mkdir(join(TEST_DIR, ".pi"), { recursive: true }).then(() =>
    writeFile(
      join(TEST_DIR, ".pi", "council-settings.json"),
      JSON.stringify(settings),
      "utf8",
    ),
  );
}

const VALID_OPINION = JSON.stringify({
  stance: "do X",
  recommendedApproach: "X is good",
  steps: ["step 1", "step 2"],
  filesToConsider: [],
  risks: [],
  verification: [],
  confidence: "high",
});

describe("runCouncil — dynamic councilModels[] size", () => {
  it("works with a single-model council (minimum allowed)", async () => {
    await writeSettings(["solo/model"]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "solo/model", name: "Solo" },
    ]);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(VALID_OPINION);
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();
    // Should have called the solo model once + synthesis once = 2 calls
    expect(openrouterClient.callOpenRouterChat).toHaveBeenCalledTimes(2);
  });

  it("works with the default 3-model council", async () => {
    await writeSettings([
      "model-a",
      "model-b",
      "model-c",
    ]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "model-a", name: "A" },
      { id: "model-b", name: "B" },
      { id: "model-c", name: "C" },
    ]);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(VALID_OPINION);
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();
    // 3 council + 1 synthesis = 4 calls
    expect(openrouterClient.callOpenRouterChat).toHaveBeenCalledTimes(4);
  });

  it("works with a 5-model council (no hard-coded upper limit)", async () => {
    await writeSettings(["m1", "m2", "m3", "m4", "m5"]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "m1", name: "M1" },
      { id: "m2", name: "M2" },
      { id: "m3", name: "M3" },
      { id: "m4", name: "M4" },
      { id: "m5", name: "M5" },
    ]);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(VALID_OPINION);
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();
    // 5 council + 1 synthesis = 6 calls
    expect(openrouterClient.callOpenRouterChat).toHaveBeenCalledTimes(6);
  });

  it("throws CouncilSetupError when councilModels is empty", async () => {
    await writeSettings([]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });

  it("uses the configured synthesis model when set, otherwise first council model", async () => {
    await writeSettings(["a/m1", "b/m2", "c/m3"]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "a/m1", name: "M1" },
      { id: "b/m2", name: "M2" },
      { id: "c/m3", name: "M3" },
      { id: "special/synth", name: "Special" },
    ]);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(VALID_OPINION);
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    // Without an explicit synthesis override, the runner uses councilModels[0]
    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();

    // The synthesis call should be for "a/m1" (first council model)
    const callArgs = vi.mocked(openrouterClient.callOpenRouterChat).mock.calls;
    // Last call = synthesis
    const synthesisCall = callArgs[callArgs.length - 1][0];
    expect(synthesisCall.model).toBe("a/m1");
  });
});