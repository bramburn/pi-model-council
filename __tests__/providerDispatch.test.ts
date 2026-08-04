/**
 * Tests for providerDispatch — the layer that routes model calls to the
 * right provider (OpenRouter REST vs pi-ai/compat inference).
 *
 * The dispatch module is the foundation for "council picks from pi's
 * full model registry" — without it, the runner can't call anthropic,
 * openai, google, etc. directly.
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveModel,
  callModelViaDispatch,
  OPENROUTER_PROVIDER,
} from "../providerDispatch.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: vi.fn(),
}));

vi.mock("../openrouterClient.js", () => ({
  callOpenRouterChat: vi.fn(),
}));

/**
 * Build a fake ModelRegistry that knows about a fixed set of models.
 * Used by tests to verify provider resolution without touching the real
 * pi internals.
 */
function fakeRegistry(models: Array<{ provider: string; id: string }>): ModelRegistry {
  return {
    getAll: () => models.map((m) => ({
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
    })),
    getAvailable: () => [],
    find: (provider: string, id: string) => {
      const match = models.find((m) => m.provider === provider && m.id === id);
      if (!match) return undefined;
      return {
        id: match.id,
        name: match.id,
        provider: match.provider,
        api: "openai-completions" as const,
        baseUrl: "",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      };
    },
    // remaining methods unused by these tests
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

describe("resolveModel", () => {
  it("treats bare IDs as OpenRouter by default (legacy compat)", () => {
    expect(resolveModel("qwen/qwen3.7-max")).toEqual({
      provider: OPENROUTER_PROVIDER,
      id: "qwen/qwen3.7-max",
    });
  });

  it("treats ids without a slash as OpenRouter", () => {
    expect(resolveModel("gpt-4o")).toEqual({
      provider: OPENROUTER_PROVIDER,
      id: "gpt-4o",
    });
  });

  it("recognises the openrouter/ prefix explicitly", () => {
    expect(resolveModel("openrouter/qwen/qwen3.7-max")).toEqual({
      provider: OPENROUTER_PROVIDER,
      id: "qwen/qwen3.7-max",
    });
  });

  it("splits non-openrouter prefixes by default (anthropic, openai, google, …)", () => {
    expect(resolveModel("anthropic/claude-3.5-sonnet")).toEqual({
      provider: "anthropic",
      id: "claude-3.5-sonnet",
    });
    expect(resolveModel("openai/gpt-4o")).toEqual({
      provider: "openai",
      id: "gpt-4o",
    });
    expect(resolveModel("google/gemini-2.0-flash")).toEqual({
      provider: "google",
      id: "gemini-2.0-flash",
    });
  });

  it("uses the registry to find the canonical provider when available", () => {
    // Registry says "anthropic" owns this id; resolveModel should agree
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
      { provider: "openai", id: "gpt-4o" },
    ]);
    expect(resolveModel("claude-3.5-sonnet", reg)).toEqual({
      provider: "anthropic",
      id: "claude-3.5-sonnet",
    });
  });

  it("falls back to heuristic when registry lookup fails", () => {
    const reg = fakeRegistry([]); // empty registry
    expect(resolveModel("anthropic/claude-3.5-sonnet", reg)).toEqual({
      provider: "anthropic",
      id: "claude-3.5-sonnet",
    });
  });

  it("trims whitespace around the model id", () => {
    expect(resolveModel("  qwen/qwen3.7-max  ")).toEqual({
      provider: OPENROUTER_PROVIDER,
      id: "qwen/qwen3.7-max",
    });
  });

  it("throws on empty model id", () => {
    expect(() => resolveModel("")).toThrow(/Cannot resolve empty model ID/);
    expect(() => resolveModel("   ")).toThrow(/Cannot resolve empty model ID/);
  });
});

describe("callModelViaDispatch", () => {
  it("routes an OpenRouter model through callOpenRouterChat", async () => {
    const { callOpenRouterChat } = await import("../openrouterClient.js");
    vi.mocked(callOpenRouterChat).mockResolvedValueOnce("OpenRouter response");

    const result = await callModelViaDispatch({
      rawId: "qwen/qwen3.7-max",
      systemPrompt: "sys",
      userPrompt: "user",
      apiKey: "sk-or-v1-test",
    });
    expect(result).toBe("OpenRouter response");
    expect(callOpenRouterChat).toHaveBeenCalledTimes(1);
    expect(callOpenRouterChat).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-or-v1-test",
        model: "qwen/qwen3.7-max",
      }),
    );
  });

  it("rejects OpenRouter calls when no apiKey is supplied", async () => {
    await expect(
      callModelViaDispatch({
        rawId: "qwen/qwen3.7-max",
        systemPrompt: "sys",
        userPrompt: "user",
        // no apiKey
      }),
    ).rejects.toThrow(/OpenRouter API key is required/);
  });

  it("routes a non-OpenRouter model through pi-ai/compat (via registry)", async () => {
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      role: "assistant",
      content: [{ type: "text", text: "Anthropic response" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3.5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await callModelViaDispatch({
      rawId: "anthropic/claude-3.5-sonnet",
      systemPrompt: "sys",
      userPrompt: "user",
      modelRegistry: reg,
    });
    expect(result).toBe("Anthropic response");
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when a non-OpenRouter model is not in the registry", async () => {
    const reg = fakeRegistry([]); // empty

    await expect(
      callModelViaDispatch({
        rawId: "anthropic/claude-3.5-sonnet",
        systemPrompt: "sys",
        userPrompt: "user",
        modelRegistry: reg,
      }),
    ).rejects.toThrow(/is not registered/);
  });

  it("wraps the underlying error message with the model id for traceability", async () => {
    const reg = fakeRegistry([
      { provider: "anthropic", id: "claude-3.5-sonnet" },
    ]);
    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockRejectedValueOnce(new Error("network reset"));

    await expect(
      callModelViaDispatch({
        rawId: "anthropic/claude-3.5-sonnet",
        systemPrompt: "sys",
        userPrompt: "user",
        modelRegistry: reg,
      }),
    ).rejects.toThrow(/Model anthropic\/claude-3.5-sonnet failed: network reset/);
  });
});