import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateCouncilSettings } from "../settings-ui.js";
import type { PingResult, OpenRouterModel } from "../openrouterClient.js";

describe("validateCouncilSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMockPing(result: PingResult) {
    return vi.fn().mockResolvedValue(result);
  }

  function makeMockFetch(models: OpenRouterModel[]) {
    return vi.fn().mockResolvedValue(models);
  }

  it("rejects missing API key", async () => {
    const result = await validateCouncilSettings({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("OpenRouter API key is required");
  });

  it("rejects invalid API key format", async () => {
    const ping = makeMockPing({ ok: false, error: "Invalid format" });
    const fetch = makeMockFetch([]);

    const result = await validateCouncilSettings(
      {
        openRouter: { apiKey: "invalid-key", councilModels: ["a", "b", "c"] },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("must start with 'sk-or-v1'"))).toBe(true);
  });

  it("rejects API key when ping fails", async () => {
    const ping = makeMockPing({ ok: false, error: "Invalid API key" });
    const fetch = makeMockFetch([]);

    const result = await validateCouncilSettings(
      {
        openRouter: { apiKey: "sk-or-v1-test", councilModels: ["a", "b", "c"] },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Invalid API key"))).toBe(true);
  });

  it("accepts valid API key with ping success", async () => {
    const ping = makeMockPing({ ok: true, quota: "$2.50 remaining" });
    const fetch = makeMockFetch([
      { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max" },
      { id: "z-ai/glm-5.2", name: "GLM-5.2" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ]);

    const result = await validateCouncilSettings(
      {
        openRouter: {
          apiKey: "sk-or-v1-test",
          councilModels: [
            "qwen/qwen3.7-max",
            "z-ai/glm-5.2",
            "deepseek/deepseek-v4-pro",
          ],
        },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(true);
    expect(result.warnings?.some(w => w.includes("$2.50"))).toBe(true);
  });

  it("rejects duplicate models", async () => {
    const ping = makeMockPing({ ok: true });
    const fetch = makeMockFetch([
      { id: "qwen/qwen3.7-max", name: "Qwen" },
      { id: "z-ai/glm-5.2", name: "GLM" },
    ]);

    const result = await validateCouncilSettings(
      {
        openRouter: {
          apiKey: "sk-or-v1-test",
          councilModels: ["qwen/qwen3.7-max", "qwen/qwen3.7-max", "z-ai/glm-5.2"],
        },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("distinct"))).toBe(true);
  });

  it("rejects models not in available list", async () => {
    const ping = makeMockPing({ ok: true });
    const fetch = makeMockFetch([{ id: "qwen/qwen3.7-max", name: "Qwen" }]);

    const result = await validateCouncilSettings(
      {
        openRouter: {
          apiKey: "sk-or-v1-test",
          councilModels: ["qwen/qwen3.7-max", "nonexistent/model", "other/model"],
        },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("not available on OpenRouter"))).toBe(true);
  });

  it("rejects when no council models selected", async () => {
    const ping = makeMockPing({ ok: true });
    const fetch = makeMockFetch([]);

    const result = await validateCouncilSettings(
      {
        openRouter: {
          apiKey: "sk-or-v1-test",
          councilModels: [],
        },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("At least one council model"))).toBe(true);
  });

  it("warns but accepts when model list fetch fails but API key is valid", async () => {
    const ping = makeMockPing({ ok: true });
    const fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await validateCouncilSettings(
      {
        openRouter: {
          apiKey: "sk-or-v1-test",
          councilModels: ["qwen/qwen3.7-max", "z-ai/glm-5.2", "deepseek/deepseek-v4-pro"],
        },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(true);
  });

  it("accepts single model (minimum of 1)", async () => {
    const ping = makeMockPing({ ok: true });
    const fetch = makeMockFetch([{ id: "qwen/qwen3.7-max", name: "Qwen" }]);

    const result = await validateCouncilSettings(
      {
        openRouter: {
          apiKey: "sk-or-v1-test",
          councilModels: ["qwen/qwen3.7-max"],
        },
      },
      undefined,
      ping,
      fetch,
    );

    expect(result.valid).toBe(true);
  });
});
