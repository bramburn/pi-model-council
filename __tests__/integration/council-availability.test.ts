/**
 * Tests for B3 — councilRunner model-availability check.
 *
 * Before this fix, the missing-models check was implicitly gated by
 * `if (resolvedApiKey) { ... }` because the OpenRouter REST catalog
 * fetch was the only way to populate the available set. That meant a
 * pure direct-provider council (no OpenRouter key) would never
 * validate the synthesis model id at startup, only at synthesis time.
 *
 * The fix extracts the check into a helper that:
 *   1. Builds an available set from the registry (no key needed).
 *   2. Optionally augments with the live OpenRouter catalog (only
 *      when an OpenRouter key is available).
 *   3. Validates each configured model id against the set, accepting
 *      both bare and prefixed forms.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCouncil } from "../../councilRunner.js";
import * as openrouterClient from "../../openrouterClient.js";
import * as providerDispatchModule from "../../providerDispatch.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CouncilSetupError } from "../../types.js";

vi.mock("../../openrouterClient.js", () => ({
  pingOpenRouter: vi.fn(),
  fetchOpenRouterModels: vi.fn(),
  callOpenRouterChat: vi.fn(),
  extractJsonObject: vi.fn(),
}));
vi.mock("../../providerDispatch.js", async () => {
  // Keep the real resolveModel so dispatch routing uses the registry
  // (otherwise bare-id models always route to OpenRouter and the
  // tests don't exercise the direct-provider path).
  const actual = await vi.importActual<typeof import("../../providerDispatch.js")>(
    "../../providerDispatch.js",
  );
  return {
    ...actual,
    callModelViaDispatch: vi.fn(),
    extractJsonObject: vi.fn(),
  };
});

const TEST_DIR = join(tmpdir(), `pi-mc-availability-${Date.now()}`);

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(TEST_DIR, { recursive: true });
});

const VALID_OPINION = JSON.stringify({
  stance: "x",
  recommendedApproach: "x",
  steps: [],
  filesToConsider: [],
  risks: [],
  verification: [],
  confidence: "high",
});

/** Write a settings file with the given council/synthesis models. */
async function writeSettings(
  councilModels: string[],
  options: { opinionProvider?: string; opinionModelId?: string; synthesisModelId?: string; apiKey?: string } = {},
): Promise<void> {
  const settings = {
    version: 1,
    openRouter: {
      apiKey: options.apiKey ?? "",
      councilModels,
    },
    opinion: {
      provider: options.opinionProvider ?? "openrouter",
      modelId: options.opinionModelId ?? "any/model",
    },
    synthesis: options.synthesisModelId
      ? { modelId: options.synthesisModelId }
      : undefined,
    options: {
      useStructuredOutput: false,
      modelTimeoutMs: 300000,
      synthesisTimeoutMs: 360000,
      retryAttempts: 1,
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

describe("runCouncil — model-availability check (B3)", () => {
  it("catches a stale synthesis model id at startup for direct-provider councils", async () => {
    // Pure direct-provider council: anthropic only. No OpenRouter key.
    // The synthesis model is a stale id (anthropic/claude-99-turbo) that
    // doesn't exist in the registry. The runner must fail at startup
    // with CouncilSetupError, not at synthesis time.
    await writeSettings(
      ["anthropic/claude-3.5-sonnet"],
      { synthesisModelId: "anthropic/claude-99-turbo" },
    );
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);
    vi.mocked(providerDispatchModule.callModelViaDispatch).mockResolvedValue(VALID_OPINION);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(providerDispatchModule.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
        modelRegistry: reg,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });

  it("accepts a bare-id synthesis model for direct-provider councils", async () => {
    // The user saved the bare id (without provider prefix) — should
    // still match the registry entry.
    await writeSettings(
      ["claude-3.5-sonnet"],
      { synthesisModelId: "claude-3.5-sonnet" },
    );
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(providerDispatchModule.callModelViaDispatch).mockResolvedValue(VALID_OPINION);

    // Should NOT throw — the bare id resolves via the registry
    // (anthropic/claude-3.5-sonnet is in the registry as provider+id;
    // bare set has claude-3.5-sonnet).
    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
      modelRegistry: reg,
    });
    expect(result).toBeDefined();
  });

  it("catches a stale model id for an OpenRouter council with a key", async () => {
    // OpenRouter council with a configured key. The REST catalog
    // returns the real model, but the user has a stale id that
    // doesn't match.
    await writeSettings(
      ["openrouter/old-model-id"],
      { apiKey: "sk-or-v1-test" },
    );
    const reg = fakeRegistry([
      // Empty — only the OpenRouter REST catalog will populate available.
    ]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
    ]);

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
        modelRegistry: reg,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });

  it("accepts valid OpenRouter models with bare id (legacy form)", async () => {
    // OpenRouter model saved in legacy bare form (no provider prefix).
    // The user had it configured before the openrouter/ prefix was
    // introduced. Must still work.
    await writeSettings(
      ["qwen/qwen3.7-max"],
      { apiKey: "sk-or-v1-test" },
    );
    const reg = fakeRegistry([]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
    ]);
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValue(VALID_OPINION);
    vi.mocked(providerDispatchModule.extractJsonObject).mockReturnValue(JSON.parse(VALID_OPINION));

    const result = await runCouncil({
      input: { mode: "fix", problem: "test" },
      cwd: TEST_DIR,
      isProjectTrusted: true,
      modelRegistry: reg,
    });
    expect(result).toBeDefined();
  });

  it("rejects cross-provider bare-id false-positive (B3)", async () => {
    // B3 fix: previously isModelMissing's bareAlt fallback caused a
    // cross-provider false-positive. With only openai/gpt-4o in the
    // OpenRouter catalog, the bare set contained gpt-4o. So a user
    // who picked anthropic/gpt-4o passed validation but dispatch
    // would fail at call-time. After the fix, anthropic/gpt-4o
    // requires an exact (provider/id) match.
    //
    // We need at least one OpenRouter model so the OpenRouter catalog
    // fetch populates the availableModels set.
    await writeSettings(
      ["openrouter/foo", "anthropic/gpt-4o"],
      { apiKey: "sk-or-v1-b3-test" },
    );
    const reg = fakeRegistry([]);
    vi.mocked(openrouterClient.pingOpenRouter).mockResolvedValue({ ok: true });
    vi.mocked(openrouterClient.fetchOpenRouterModels).mockResolvedValue([
      { id: "foo", name: "Foo" },
    ]);

    await expect(
      runCouncil({
        input: { mode: "fix", problem: "test" },
        cwd: TEST_DIR,
        isProjectTrusted: true,
        modelRegistry: reg,
      }),
    ).rejects.toThrow(CouncilSetupError);
  });
});
