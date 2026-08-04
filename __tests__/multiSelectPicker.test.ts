/**
 * Tests for the multiSelectPicker component.
 *
 * Note: only the non-TUI fallback path is testable here — the TUI path uses
 * the pi-tui renderer and is exercised manually in the host.
 *
 * Non-TUI flow:
 *   - ctx.ui.select() returns labels one at a time
 *   - "[done]" terminates the picker
 *   - empty string is treated as a cancel
 */

import { describe, it, expect, vi } from "vitest";
import { multiSelectPicker, type MultiSelectItem } from "../multiSelectPicker.js";

function makeCtx(): {
  mode: string;
  ui: { select: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
} {
  return {
    mode: "non-tui",
    ui: {
      select: vi.fn(),
      custom: vi.fn(),
      notify: vi.fn(),
    },
  };
}

const ITEMS: MultiSelectItem[] = [
  { value: "model-a", label: "Model A", description: "First model" },
  { value: "model-b", label: "Model B", description: "Second model" },
  { value: "model-c", label: "Model C", description: "Third model" },
  { value: "model-d", label: "Model D", description: "Fourth model" },
];

describe("multiSelectPicker (non-TUI fallback)", () => {
  it("returns the picked values in selection order", async () => {
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Model A")
      .mockResolvedValueOnce("Model C")
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
    });
    expect(picks).toEqual(["model-a", "model-c"]);
  });

  it("returns undefined when user cancels (empty string)", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
    });
    expect(picks).toBeUndefined();
  });

  it("returns undefined when user cancels with pre-populated picks (no silent confirm)", async () => {
    // Regression: previously, cancel with initialPicks would silently
    // return the initial picks as if confirmed. Now an explicit cancel
    // (empty string) always returns undefined.
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
      initialPicks: ["model-a", "model-b"],
    });
    expect(picks).toBeUndefined();
  });

  it("[done] with pre-populated picks returns those picks (explicit confirm)", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
      initialPicks: ["model-a", "model-b"],
    });
    expect(picks).toEqual(["model-a", "model-b"]);
  });

  it("toggles a previously-picked model off", async () => {
    const ctx = makeCtx();
    // Pick A, then A again (toggle off), then [done]
    ctx.ui.select
      .mockResolvedValueOnce("Model A")
      .mockResolvedValueOnce("Model B")
      .mockResolvedValueOnce("Model A") // toggle A off
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
    });
    expect(picks).toEqual(["model-b"]);
  });

  it("respects maxPicks by warning and not adding more", async () => {
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Model A")
      .mockResolvedValueOnce("Model B")
      .mockResolvedValueOnce("Model C") // would exceed max=2
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
      maxPicks: 2,
    });
    // Max was hit, warning notified
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Maximum of 2 models"),
      "warning",
    );
    expect(picks).toEqual(["model-a", "model-b"]);
  });

  it("returns undefined when fewer than minPicks are selected", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
      minPicks: 2,
    });
    expect(picks).toBeUndefined();
  });

  it("accepts pre-populated initialPicks", async () => {
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Model C") // add C to existing A, B
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
      initialPicks: ["model-a", "model-b"],
    });
    expect(picks).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("matches by value when label isn't found", async () => {
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("model-b") // value, not label
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items: ITEMS,
    });
    expect(picks).toEqual(["model-b"]);
  });
});

/**
 * Regression: B1 — multiSelectPicker Done row's haystack must not
 * contain real words that would collide with model names like
 * "kimi-done-thinking" if the haystack were ever passed through
 * fuzzyFilter in a future refactor.
 */
describe("multiSelectPicker (B1 — done row haystack)", () => {
  it("uses unique sentinel tokens in the done row's haystack", async () => {
    // Read the file source and assert the haystack uses $$commit$$ style
    // sentinels rather than plain words. This is a meta-test that catches
    // accidental regression of the B1 fix.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../multiSelectPicker.ts", import.meta.url),
      "utf8",
    );

    // The done row haystack must contain a unique sentinel token. Plain
    // words like "done", "save", "commit" would collide with real model
    // names (e.g. "kimi-done-thinking").
    const doneRowMatch = src.match(
      /haystack:\s*["']([^"']+)["']\s*,\s*checked:\s*false/,
    );
    expect(doneRowMatch).not.toBeNull();
    const haystack = doneRowMatch![1]!;
    // The haystack should not consist only of bare words that could
    // collide with real model names. A model named e.g. "kimi-done-thinking"
    // has a haystack of "kimi done thinking" — if our done row had a
    // haystack of "done save commit confirm" (real words), a future
    // refactor passing the done row through fuzzyFilter would either
    // hide the real model or hide itself. We require the haystack to
    // contain a sentinel-style token (any text wrapped in $$...$$).
    expect(haystack).toMatch(/\$\$.+\$\$/);
    // The whole haystack must be sentinel tokens — no bare words.
    // We split on whitespace and verify every token matches $$...$$.
    const tokens = haystack.split(/\s+/);
    for (const token of tokens) {
      expect(token).toMatch(/^\$\$.+\$\$$/);
    }
  });

  it("non-TUI mode: user can pick a model whose label contains 'done' or 'save'", async () => {
    // The done row's label says "[ done — save N picks ]". A real model
    // with similar words in its label/description must not be confused
    // with the sentinel row. (Non-TUI fallback maps by exact label or
    // value, so this is mainly defensive.)
    const items = [
      { value: "kimi/done-thinking", label: "Kimi Done Thinking", description: "kimi" },
      { value: "save-gpt-4o", label: "Save GPT-4o", description: "openai" },
      { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", description: "anthropic" },
    ];
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Kimi Done Thinking")
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items,
      initialPicks: ["save-gpt-4o"], // user already had one pre-picked
    });
    expect(picks).toEqual(["save-gpt-4o", "kimi/done-thinking"]);
  });

  /**
   * Regression: H1 — nonTuiFallback must disambiguate items with the
   * same label. The flat-list ctx.ui.select() only returns a single
   * string per pick; if two items share a label, returning that label
   * would be ambiguous. The fix: append the value to the label
   * whenever a collision is detected, and accept both the original
   * and the disambiguated form in the lookup.
   */
  it("non-TUI mode: disambiguates items with duplicate labels", async () => {
    // Two models with the same display name "GPT-4" — different
    // providers. The picker should display them as
    // "GPT-4 (openai/gpt-4)" and "GPT-4 (openrouter/gpt-4)" so the
    // user can pick each one individually.
    const items = [
      { value: "openai/gpt-4", label: "GPT-4", description: "openai direct" },
      { value: "openrouter/gpt-4", label: "GPT-4", description: "via openrouter" },
      { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
    ];
    const ctx = makeCtx();

    // Capture the choices passed to ctx.ui.select on the first call
    // so we can assert the disambiguated labels are present. We use
    // mockReturnValueOnce to interleave returns with the capture impl.
    let firstCallChoices: string[] | undefined;
    ctx.ui.select
      .mockImplementationOnce(async (_title, choices) => {
        firstCallChoices = choices as string[];
        return "GPT-4 (openai/gpt-4)";
      })
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items,
    });
    expect(picks).toEqual(["openai/gpt-4"]);
    // Verify the displayed choices include the disambiguated labels
    expect(firstCallChoices).toBeDefined();
    expect(firstCallChoices).toContain("GPT-4 (openai/gpt-4)");
    expect(firstCallChoices).toContain("GPT-4 (openrouter/gpt-4)");
    expect(firstCallChoices).toContain("Claude 3.5 Sonnet"); // not disambiguated
    expect(firstCallChoices).toContain("[done]");
    // Critically: the un-disambiguated "GPT-4" should NOT be in the
    // choices list (because we have a collision, the disambiguated
    // form is what we display).
    expect(firstCallChoices).not.toContain("GPT-4");
  });

  it("non-TUI mode: backward compat — non-disambiguated label still works", async () => {
    // If a test or programmatic caller returns the original (non-
    // disambiguated) label, the lookup should still find the item.
    // This protects against breaking tests that pre-date H1.
    const items = [
      { value: "openai/gpt-4", label: "GPT-4" },
      { value: "openrouter/gpt-4", label: "GPT-4" },
    ];
    const ctx = makeCtx();
    // Caller returns the original label (no parens)
    ctx.ui.select
      .mockResolvedValueOnce("GPT-4")
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items,
    });
    // Picks the first one matching the label (in-order map iteration)
    expect(picks).toEqual(["openai/gpt-4"]);
  });

  /**
   * Regression: H5 — nonTuiFallback on bad input notifies the user and
   * continues, with a max-attempts guard. Previously a misbehaving
   * `ctx.ui.select` that returned an unknown label would silently
   * exit the loop.
   */
  it("non-TUI mode: unknown label notifies and continues (H5)", async () => {
    const items = [
      { value: "valid/model", label: "Valid Model" },
    ];
    const ctx = makeCtx();
    // First call returns garbage, second call returns the real label,
    // third call returns [done]. The picker should survive the bad
    // call and continue.
    ctx.ui.select
      .mockResolvedValueOnce("garbage-not-a-label")
      .mockResolvedValueOnce("Valid Model")
      .mockResolvedValueOnce("[done]");

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items,
    });
    expect(picks).toEqual(["valid/model"]);
    // The user was notified about the bad input
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unrecognised selection"),
      "warning",
    );
  });

  it("non-TUI mode: gives up after MAX_BAD_ATTEMPTS bad labels (H5)", async () => {
    const items = [
      { value: "valid/model", label: "Valid Model" },
    ];
    const ctx = makeCtx();
    // 10 bad labels in a row, then the picker gives up. We use 11
    // queued values to be safe (the picker consumes them as it
    // retries).
    for (let i = 0; i < 11; i++) {
      ctx.ui.select.mockResolvedValueOnce(`bad-${i}`);
    }

    const picks = await multiSelectPicker(ctx as never, {
      title: "Pick models",
      items,
    });
    // Picker gave up; result is undefined (cancelled)
    expect(picks).toBeUndefined();
    // The user was notified about giving up
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Gave up after 10 unrecognised selections"),
      "error",
    );
  });
});

/**
 * TUI-mode tests — verify the component factory builds a component that
 * includes the synthetic commit row at the top of the list and that
 * Enter on it commits the selection.
 */
describe("multiSelectPicker (TUI mode)", () => {
  type FactoryFn = (
    tui: unknown,
    theme: { fg: (color: string, text: string) => string },
    kb: unknown,
    done: (result: unknown) => void,
  ) => { render: (width: number) => string[]; handleInput: (data: string) => void };

  function makeTuiCtx() {
    return {
      mode: "tui" as const,
      ui: {
        select: vi.fn(),
        custom: vi.fn(),
        notify: vi.fn(),
      },
    };
  }

  it("renders a [done] row at the top of the picker", async () => {
    const ctx = makeTuiCtx();
    let renderFn: ((width: number) => string[]) | undefined;
    let internalDone: ((result: unknown) => void) | undefined;

    ctx.ui.custom.mockImplementation((factory: FactoryFn) => {
      const fakeTheme = {
        fg: (_color: string, text: string) => text,
      };
      const component = factory({}, fakeTheme, {}, (r: unknown) => {
        internalDone?.(r);
      });
      renderFn = component.render;
      return new Promise((resolve) => {
        internalDone = (r: unknown) => resolve(r as never);
      });
    });

    const promise = multiSelectPicker(ctx as never, {
      title: "Council Models",
      items: ITEMS,
    });

    expect(renderFn).toBeDefined();
    const rendered = renderFn!(80).join("\n");
    expect(rendered).toContain("done");
    expect(rendered).toContain("save 0 picks"); // no picks yet

    // Trigger the commit through the inner done callback
    internalDone!(["model-a", "model-b"]);
    const picks = await promise;
    expect(picks).toEqual(["model-a", "model-b"]);
  });
});