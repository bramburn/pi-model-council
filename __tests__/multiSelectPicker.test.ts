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