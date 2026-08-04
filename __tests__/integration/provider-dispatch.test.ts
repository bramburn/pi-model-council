/**
 * Tests for runCouncil with non-OpenRouter models.
 *
 * Verifies the runner routes a `provider/modelId` model id through
 * pi-ai/compat's completeSimple, instead of forcing everything through
 * OpenRouter REST.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCouncil } from "../../councilRunner.js";
import * as openrouterClient from "../../openrouterClient.js";
import * as piAi from "@earendil-works/pi-ai/compat";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

vi.mock("../../openrouterClient.js", () => ({
  pingOpenRouter: vi.fn(),
  fetchOpenRouterModels: vi.fn(),
  callOpenRouterChat: vi.fn(),
  extractJsonObject: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: vi.fn(),
}));

const TEST_DIR = join(tmpdir(), `pi-mc-dispatch-${Date.now()}`);

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(TEST_DIR, { recursive: true });
});

function writeSettings(councilModels: string[]): Promise<void> {
  const settings = {
    version: 1,
    openRouter: {
      apiKey: "sk-or-v1-dispatch-test-key",
      councilModels,
    },
    opinion: {
      provider: "anthropic",
      modelId: "anthropic/claude-3.5-sonnet",
    },
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

/** Mock ModelRegistry that reports the given models as available. */
function fakeRegistry(models: Array<{ provider: string; id: string }>): ModelRegistry {
  const registryModels = models.map((m) => ({
    id: m.id,
    name: m.id,
    provider: m.provider,
    api: "openai-completions" as const,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  }));
  return {
    getAll: () => registryModels,
    getAvailable: () => registryModels,
    find: (provider: string, id: string) => {
      const match = models.find((m) => m.provider === provider && m.id === id);
      if (!match) return undefined;
      return registryModels.find((m) => m.provider === match.provider && m.id === match.id);
    },
    refresh: () => {},
    getError: () => undefined,
    hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
    getProviderAuthStatus: () => ({ configured: true }),
    getProviderDisplayName: (p: string) => p,
    getApiKeyForProvider: async () => "sk-test",
    isUsingOAuth: () => false,
    registerProvider: () => {},
    unregisterProvider: () => {},
    authStorage: undefined as unknown as ModelRegistry["authStorage"],
    modelsJsonPath: "",
  } as unknown as ModelRegistry;
}

describe("runCouncil — provider dispatch", () => {
  it("routes an anthropic model through pi-ai/compat instead of OpenRouter REST", async () => {
    await writeSettings(["anthropic/claude-3.5-sonnet"]);
    // Registry knows about the anthropic model
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);
    // OpenRouter ping should still happen (since apiKey is set in settings)
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    // completeSimple returns a plain-text JSON opinion
    vi.mocked(piAi.completeSimple).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: VALID_OPINION }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3.5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    // extractJsonObject returns the parsed object (the runner falls back
    // to this since non-OpenRouter calls don't go through structured output)
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
      modelRegistry: reg,
    });
    expect(result).toBeDefined();

    // The non-OpenRouter council model + synthesis should both go through
    // completeSimple (the dispatcher), NOT callOpenRouterChat.
    expect(piAi.completeSimple).toHaveBeenCalled();
    expect(openrouterClient.callOpenRouterChat).not.toHaveBeenCalled();
  });

  it("routes a mix of openrouter + direct providers to their respective APIs", async () => {
    await writeSettings([
      "qwen/qwen3.7-max",         // openrouter (legacy bare id)
      "anthropic/claude-3.5-sonnet", // direct provider
    ]);
    const reg = fakeRegistry([
      { provider: "openrouter", id: "qwen/qwen3.7-max" },
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(VALID_OPINION);
    vi.mocked(piAi.completeSimple).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: VALID_OPINION }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3.5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
      modelRegistry: reg,
    });
    expect(result).toBeDefined();

    // OpenRouter REST was hit twice: qwen (council) + qwen (synthesis,
    // since synthesis defaults to councilModels[0]). Anthropic went
    // through completeSimple once (council call).
    expect(openrouterClient.callOpenRouterChat).toHaveBeenCalledTimes(2);
    expect(piAi.completeSimple).toHaveBeenCalledTimes(1);
  });

  it("does not require an OpenRouter apiKey when only direct providers are used", async () => {
    // Settings has empty apiKey (pi auth only) — runner should resolve the
    // key per-provider via the registry's getApiKeyForProvider, not via
    // the OpenRouter ping.
    const settings = {
      version: 1 as const,
      openRouter: { apiKey: "", councilModels: ["anthropic/claude-3.5-sonnet"] },
      opinion: { provider: "anthropic", modelId: "anthropic/claude-3.5-sonnet" },
      options: {
        useStructuredOutput: true,
        modelTimeoutMs: 300000,
        synthesisTimeoutMs: 360000,
        retryAttempts: 1,
        retryDelayMs: 100,
      },
      lastUpdated: new Date().toISOString(),
    };
    await mkdir(join(TEST_DIR, ".pi"), { recursive: true });
    await writeFile(
      join(TEST_DIR, ".pi", "council-settings.json"),
      JSON.stringify(settings),
      "utf8",
    );
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);
    vi.mocked(piAi.completeSimple).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: VALID_OPINION }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3.5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    vi.mocked(openrouterClient.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
      modelRegistry: reg,
    });
    expect(result).toBeDefined();

    // OpenRouter REST never called; OpenRouter ping never called either
    // (empty apiKey short-circuits the OpenRouter ping pre-flight).
    expect(openrouterClient.callOpenRouterChat).not.toHaveBeenCalled();
    expect(openrouterClient.pingOpenRouter).not.toHaveBeenCalled();
  });
});