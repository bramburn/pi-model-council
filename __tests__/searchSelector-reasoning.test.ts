/**
 * M3 fix: searchableSelect items with reasoning=true render a visible
 * `[reasoning]` badge. This test exercises the non-TUI fallback path
 * (where the picker is a flat-list select) to verify the reasoning
 * flag is passed through correctly to the displayed choices.
 */

import { describe, it, expect, vi } from "vitest";
import { searchableSelect } from "../searchSelector.js";

function makeCtx() {
  return {
    mode: "rpc" as const,
    cwd: "/tmp",
    isProjectTrusted: () => false,
    ui: {
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
      notify: vi.fn(),
    },
    modelRegistry: { getAvailable: vi.fn(), getApiKeyForProvider: vi.fn() },
  } as never;
}

describe("searchableSelect — reasoning badge (M3)", () => {
  it("non-TUI mode: items with reasoning=true are still pickable", async () => {
    // The actual badge rendering is a TUI concern; in non-TUI mode the
    // `ctx.ui.select` shows a flat list. The reasoning flag is
    // metadata, not display logic, so we just verify that a reasoning
    // model is selectable and returned correctly.
    const items = [
      { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", reasoning: true },
      { value: "openai/gpt-4o", label: "GPT-4o", reasoning: false },
    ];
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("Claude 3.5 Sonnet");

    const result = await searchableSelect(ctx, {
      title: "Pick a synthesis model",
      items,
    });
    expect(result?.value).toBe("anthropic/claude-3.5-sonnet");
    expect((result as { reasoning?: boolean } | undefined)?.reasoning).toBe(true);
  });

  it("non-TUI mode: choices passed to ctx.ui.select include reasoning items", async () => {
    // Capture the choices argument so we can verify reasoning items
    // are present in the selection list.
    const items = [
      { value: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7", reasoning: true },
      { value: "openai/gpt-4o", label: "GPT-4o" },
    ];
    const ctx = makeCtx();
    let capturedChoices: string[] | undefined;
    ctx.ui.select.mockImplementationOnce(async (_title, choices) => {
      capturedChoices = choices as string[];
      return "Claude Opus 4.7";
    });

    await searchableSelect(ctx, { title: "Pick", items });
    expect(capturedChoices).toBeDefined();
    expect(capturedChoices).toContain("Claude Opus 4.7");
    expect(capturedChoices).toContain("GPT-4o");
  });
});

/**
 * M6 fix: searchableSelect in non-TUI mode warns the developer when
 * `maxVisible` was set but is being ignored (non-TUI mode dumps all
 * items into ctx.ui.select as a flat list).
 */
describe("searchableSelect — maxVisible warning (M6)", () => {
  it("non-TUI mode: warns when maxVisible < items.length", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      value: `model-${i}`,
      label: `Model ${i}`,
    }));
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("Model 0");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await searchableSelect(ctx, { title: "Pick", items, maxVisible: 5 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("maxVisible=5 ignored in non-TUI mode"),
    );
    warnSpy.mockRestore();
  });

  it("non-TUI mode: does NOT warn when maxVisible >= items.length", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      value: `model-${i}`,
      label: `Model ${i}`,
    }));
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("Model 0");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await searchableSelect(ctx, { title: "Pick", items, maxVisible: 10 });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("non-TUI mode: does NOT warn when maxVisible is unset", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      value: `model-${i}`,
      label: `Model ${i}`,
    }));
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("Model 0");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await searchableSelect(ctx, { title: "Pick", items });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});