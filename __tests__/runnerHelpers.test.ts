import { describe, it, expect, vi } from "vitest";
import {
  resolveOpenRouterApiKey,
  parseModelOpinionResponse,
  callModelWithTimeout,
} from "../runnerHelpers.js";
import * as openrouterClient from "../openrouterClient.js";

vi.mock("../openrouterClient.js", async () => {
  const actual = await vi.importActual<typeof openrouterClient>("../openrouterClient.js");
  return {
    ...actual,
    callOpenRouterChat: vi.fn(),
  };
});

describe("resolveOpenRouterApiKey", () => {
  it("returns the settings key when present", async () => {
    const key = await resolveOpenRouterApiKey({
      openRouter: { apiKey: "sk-or-v1-settings", councilModels: ["m1", "m2"] },
    });
    expect(key).toBe("sk-or-v1-settings");
  });

  it("trims whitespace from the settings key", async () => {
    const key = await resolveOpenRouterApiKey({
      openRouter: { apiKey: "  sk-or-v1-trimmed  ", councilModels: ["m1", "m2"] },
    });
    expect(key).toBe("sk-or-v1-trimmed");
  });

  it("falls back to the registry when settings has no key", async () => {
    const key = await resolveOpenRouterApiKey(
      { openRouter: { apiKey: "", councilModels: ["m1", "m2"] } },
      {
        getAvailable: async () => [],
        getApiKeyForProvider: async (p: string) =>
          p === "openrouter" ? "sk-or-v1-from-registry" : undefined,
        hasConfiguredAuth: () => true,
      } as never,
    );
    expect(key).toBe("sk-or-v1-from-registry");
  });

  it("falls back to OPENROUTER_API_KEY env var when nothing else", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-from-env";
    try {
      const key = await resolveOpenRouterApiKey({
        openRouter: { apiKey: "", councilModels: ["m1", "m2"] },
      });
      expect(key).toBe("sk-or-v1-from-env");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("returns undefined when no source yields a key", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const key = await resolveOpenRouterApiKey({
        openRouter: { apiKey: "", councilModels: ["m1", "m2"] },
      });
      expect(key).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("skips the registry when getApiKeyForProvider throws", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-env-fallback";
    try {
      const key = await resolveOpenRouterApiKey(
        { openRouter: { apiKey: "", councilModels: ["m1", "m2"] } },
        {
          getAvailable: async () => [],
          getApiKeyForProvider: async () => {
            throw new Error("registry unavailable");
          },
        } as never,
      );
      expect(key).toBe("sk-or-v1-env-fallback");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });
});

describe("parseModelOpinionResponse", () => {
  it("parses a well-formed response", () => {
    const text = JSON.stringify({
      stance: "do X",
      recommendedApproach: "X is good",
      steps: ["a", "b"],
      filesToConsider: [],
      risks: [],
      verification: [],
      confidence: "high",
    });
    const { opinion, warnings } = parseModelOpinionResponse(text);
    expect(opinion.stance).toBe("do X");
    expect(opinion.confidence).toBe("high");
    expect(warnings).toEqual([]);
  });

  it("strips markdown fences", () => {
    const text = "```json\n" + JSON.stringify({
      stance: "s",
      recommendedApproach: "r",
      steps: [],
      filesToConsider: [],
      risks: [],
      verification: [],
      confidence: "low",
    }) + "\n```";
    const { opinion } = parseModelOpinionResponse(text);
    expect(opinion.stance).toBe("s");
    expect(opinion.confidence).toBe("low");
  });

  it("falls back to a Direct response when JSON is unparseable", () => {
    const text = "I think the best approach is to refactor the auth module to use a single source of truth.";
    const { opinion, warnings } = parseModelOpinionResponse(text);
    expect(opinion.stance).toBe("Direct response");
    expect(opinion.recommendedApproach).toContain("refactor the auth module");
    expect(warnings).toContain("Response was not structured JSON, showing raw response.");
  });

  it("repairs partial / malformed JSON when possible", () => {
    // Missing confidence, missing filesToConsider — should still produce a valid opinion.
    const text = '{"stance":"s","recommendedApproach":"r","steps":["a"]}';
    const { opinion, warnings } = parseModelOpinionResponse(text);
    expect(opinion.stance).toBe("s");
    expect(opinion.steps).toEqual(["a"]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("callModelWithTimeout", () => {
  it("returns the model response on success", async () => {
    vi.mocked(openrouterClient.callOpenRouterChat).mockResolvedValueOnce("{}");

    const text = await callModelWithTimeout({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      systemPrompt: "sys",
      userPrompt: "usr",
      timeoutMs: 1000,
    });
    expect(text).toBe("{}");
  });

  it("throws with the model name on failure", async () => {
    vi.mocked(openrouterClient.callOpenRouterChat).mockRejectedValueOnce(
      new Error("Network timeout"),
    );

    await expect(
      callModelWithTimeout({
        apiKey: "sk-or-v1-test",
        model: "test/failing-model",
        systemPrompt: "sys",
        userPrompt: "usr",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/test\/failing-model failed/);
  });
});
