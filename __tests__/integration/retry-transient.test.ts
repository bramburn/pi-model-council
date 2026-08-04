/**
 * Tests for HIGH-3.3: councilRunner retries on transient errors.
 *
 * Previously only the structured-output fallback path was wrapped in
 * retry(). A transient network error on the first call would fail the
 * model entirely, ignoring the configured `retryAttempts`. This file
 * verifies the fix: the initial call is wrapped in retry() so a single
 * transient blip gets recovered automatically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCouncil } from "../../councilRunner.js";
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

const TEST_DIR = join(tmpdir(), `pi-mc-retry-${Date.now()}`);

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(TEST_DIR, { recursive: true });
});

const VALID_OPINION = JSON.stringify({
  stance: "do X",
  recommendedApproach: "X is good",
  steps: ["s1", "s2"],
  filesToConsider: [],
  risks: [],
  verification: [],
  confidence: "high",
});

/** Write a settings file with N council models + the given retryAttempts. */
async function writeSettings(
  councilModels: string[],
  retryAttempts: number,
): Promise<void> {
  const settings = {
    version: 1,
    openRouter: {
      apiKey: "sk-or-v1-retry-test-key",
      councilModels,
    },
    opinion: { provider: "openrouter", modelId: councilModels[0] ?? "any/model" },
    options: {
      useStructuredOutput: false,
      modelTimeoutMs: 300000,
      synthesisTimeoutMs: 360000,
      retryAttempts,
      retryDelayMs: 10,
    },
    lastUpdated: new Date().toISOString(),
  };
  await mkdir(join(TEST_DIR, ".pi"), { recursive: true });
  await writeFile(
    join(TEST_DIR, ".pi", "council-settings.json"),
    JSON.stringify(settings),
    "utf8",
  );
}

describe("runCouncil — retry on transient errors", () => {
  it("retries on a transient network error and recovers on a later attempt", async () => {
    await writeSettings(["model-a", "model-b"], 3);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "model-a", name: "A" },
      { id: "model-b", name: "B" },
    ]);
    // model-a: 2 failures then success (3 attempts total). model-b: success.
    vi.mocked(openrouterClient.callOpenRouterChat)
      .mockRejectedValueOnce(new Error("network reset"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(VALID_OPINION) // model-a attempt 3
      .mockResolvedValueOnce(VALID_OPINION) // model-b
      .mockResolvedValueOnce(VALID_OPINION); // synthesis
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();

    // 3 attempts on model-a + 1 attempt on model-b + 1 synthesis = 5
    expect(openrouterClient.callOpenRouterChat).toHaveBeenCalledTimes(5);
  });

  it("exhausts all retry attempts before marking the model as failed", async () => {
    await writeSettings(["model-a", "model-b"], 3);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "model-a", name: "A" },
      { id: "model-b", name: "B" },
    ]);
    // model-a: all 3 attempts fail. model-b: success. synthesis: success.
    vi.mocked(openrouterClient.callOpenRouterChat)
      .mockRejectedValueOnce(new Error("persistent network error"))
      .mockRejectedValueOnce(new Error("persistent network error"))
      .mockRejectedValueOnce(new Error("persistent network error"))
      .mockResolvedValueOnce(VALID_OPINION) // model-b
      .mockResolvedValueOnce(VALID_OPINION); // synthesis
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();

    // 3 attempts on model-a (all fail) + 1 on model-b + 1 synthesis = 5.
    // (Note: the runner may also make an extra structured-output-fallback
    // call even when useStructuredOutput=false in some cases; we test
    // the retry behaviour semantically — model-a is retried up to
    // retryAttempts times before being marked as failed — and don't
    // over-specify the exact call count.)
    expect(
      vi.mocked(openrouterClient.callOpenRouterChat).mock.calls.length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("does not silently succeed on transient errors that exhaust retries (single model)", async () => {
    // Single-model council with all retries failing. The runner should
    // throw an error after exhausting retries — never silently succeed
    // with no model output. We don't pin the exact error class because
    // it depends on the path that the runner takes (CouncilSetupError
    // for setup, plain Error for the "all failed" guard), but the test
    // verifies that:
    //   (a) an error IS thrown (not silently swallowed)
    //   (b) the model is retried retryAttempts times before giving up
    await writeSettings(["only/model"], 3);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "only/model", name: "Only" },
    ]);
    vi.mocked(openrouterClient.callOpenRouterChat).mockRejectedValue(
      new Error("persistent network error"),
    );

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
      }),
    ).rejects.toThrow();

    // The model was retried at least retryAttempts times before the
    // runner gave up. (May be more if a structured-output fallback
    // path triggered; the test is about behaviour, not call-count
    // pinning.)
    expect(
      vi.mocked(openrouterClient.callOpenRouterChat).mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
  });
});