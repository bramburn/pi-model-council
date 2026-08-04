/**
 * Searchable, scrollable model picker — used by the council/opinion settings UIs.
 *
 * In TUI mode this renders a custom component with:
 *   - a typeahead search box that fuzzy-filters the list as you type
 *   - a scrollable, viewport-bounded list (max ~10 visible items)
 *   - ↑/↓ to navigate, Enter to select, Esc to cancel
 *
 * In non-TUI modes (RPC, JSON, print) it falls back to the flat `ctx.ui.select()`
 * dialog so the extension still works in headless environments.
 *
 * This mirrors the UX of pi's built-in `/model` selector (ModelSelectorComponent).
 *
 * Why we don't use `SelectList.setFilter` directly: SelectList filters with
 * `value.startsWith(query)` (case-insensitive), which would make typing
 * "claude" fail to match `value: "anthropic/claude-3.5-sonnet"` because the
 * value doesn't start with "claude". We need real fuzzy matching across
 * label + value + optional haystack, so we manage the filtered list ourselves.
 */

import type { ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  Key,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface SelectableItem {
  value: string;
  label: string;
  /** Optional secondary line — shown under the label in muted colour. */
  description?: string;
  /**
   * Optional fuzzy-search hint. If absent, the picker searches across
   * `label` + `value`. Set this when you want a richer search target
   * (e.g. include the provider name alongside the model id).
   */
  searchHaystack?: string;
  /**
   * M3 fix: when true, the item is rendered with a visible
   * `[reasoning]` badge so the user knows the model supports
   * extended thinking / chain-of-thought. Important for picking a
   * synthesis model — reasoning-tuned models produce better
   * council decisions on hard problems.
   */
  reasoning?: boolean;
}

export interface SearchableSelectArgs {
  title: string;
  /** Short footer hint shown below the list. Falls back to the default key-hint line. */
  hint?: string;
  items: SelectableItem[];
  /** Number of visible rows. Defaults to 10 (matches /model). */
  maxVisible?: number;
  /** Hint shown above the search input (e.g. "Type to filter…"). */
  searchPlaceholder?: string;
}

export type SearchableSelectResult = SelectableItem | undefined;

/**
 * Show a searchable picker. Resolves to the selected item, or `undefined`
 * if the user pressed Escape.
 */
export async function searchableSelect(
  ctx: ExtensionCommandContext,
  args: SearchableSelectArgs,
): Promise<SearchableSelectResult> {
  // Non-TUI fallback — flat list, no search, but still works headless.
  if (ctx.mode !== "tui") {
    // M6 fix: warn the developer if they asked for a paginated experience
    // (`maxVisible`) but we're in non-TUI mode where it can't be
    // honoured. Without this, callers who care about long lists in
    // headless contexts would silently get the full list dumped into
    // `ctx.ui.select` regardless of their cap.
    if (args.maxVisible !== undefined && args.items.length > args.maxVisible) {
      // eslint-disable-next-line no-console
      console.warn(
        `[searchableSelect] maxVisible=${args.maxVisible} ignored in non-TUI mode: ` +
          `${args.items.length} items will be shown in a single flat list. ` +
          `The cap only applies to the TUI scrollable view.`,
      );
    }
    const labels = args.items.map((i) => i.label);
    const choice = await ctx.ui.select(args.title, labels);
    if (!choice) return undefined;
    return args.items.find((i) => i.label === choice);
  }

  return ctx.ui.custom<SearchableSelectResult>((_tui, theme, _kb, done) => {
    return buildSelectorComponent(theme, args, done);
  });
}

// ─── Internal component factory ────────────────────────────────────────────────

interface InternalItem extends SelectableItem {
  haystack: string;
}

function buildSelectorComponent(
  theme: Theme,
  args: SearchableSelectArgs,
  done: (result: SearchableSelectResult) => void,
): Component {
  const maxVisible = Math.max(3, args.maxVisible ?? 10);

  // Pre-compute the search haystack for each item so we don't rebuild
  // it on every keystroke.
  const allItems: InternalItem[] = args.items.map((item) => ({
    ...item,
    haystack: (item.searchHaystack ?? `${item.label} ${item.value}`).toLowerCase(),
  }));

  // Mutable state
  let query = "";
  let filtered: InternalItem[] = allItems;
  let selectedIndex = 0;

  // ── Search input (typing) ──
  const input = new Input();

  const commitSelection = (): void => {
    const selected = filtered[selectedIndex];
    if (!selected) return;
    const original = args.items.find((i) => i.value === selected.value);
    done(original);
  };

  const cancel = (): void => {
    done(undefined);
  };

  const recomputeFilter = (): void => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      filtered = allItems;
    } else {
      // Use pi-tui's fuzzyFilter (same primitive used by ModelSelectorComponent
      // and the built-in /model selector). It returns a ranked subset.
      filtered = fuzzyFilter(
        allItems,
        query,
        (item) => item.haystack,
      );
    }
    // Keep selection in bounds.
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, filtered.length - 1)));
  };

  input.onSubmit = () => commitSelection();
  input.onEscape = () => cancel();

  // ── Key router ──
  // Input owns typing/Enter/Esc routing; we own Up/Down for navigation.
  const handleInput = (data: string): void => {
    // Up/Down: navigate the list directly.
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (matchesKey(data, Key.up)) {
        if (filtered.length === 0) return;
        selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
      } else {
        if (filtered.length === 0) return;
        selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
      }
      return;
    }

    // Esc: cancel. Intercept before the Input so cancel semantics are
    // predictable regardless of input focus.
    if (matchesKey(data, Key.escape)) {
      cancel();
      return;
    }

    // Everything else (typing, backspace, enter, etc.) goes to the Input.
    input.handleInput(data);

    // After any input mutation, sync the query and refilter.
    query = input.getValue();
    recomputeFilter();
  };

  // ── Render ──
  let cachedLines: string[] | undefined;

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const lines: string[] = [];
    const renderWidth = Math.max(1, width);
    const indent = "  ";

    function addWrapped(text: string) {
      lines.push(...wrapTextWithAnsi(text, renderWidth));
    }

    function addWrappedWithPrefix(prefix: string, text: string) {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        addWrapped(prefix + text);
        return;
      }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuationPrefix = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
      }
    }

    // Top border
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    // Title
    addWrappedWithPrefix(indent, theme.fg("accent", args.title));
    if (args.searchPlaceholder) {
      addWrappedWithPrefix(indent, theme.fg("muted", args.searchPlaceholder));
    }
    lines.push("");

    // Search input
    for (const line of input.render(Math.max(1, renderWidth - indent.length * 2))) {
      lines.push(`${indent}${line}`);
    }

    lines.push("");

    // List (viewport-bounded, scrollable, with item count + match count)
    if (filtered.length === 0) {
      if (query.length > 0) {
        addWrappedWithPrefix(
          indent,
          theme.fg("warning", `No matches for "${query}"`),
        );
      } else {
        addWrappedWithPrefix(indent, theme.fg("muted", "No items"));
      }
    } else {
      const startIndex = Math.max(
        0,
        Math.min(
          selectedIndex - Math.floor(maxVisible / 2),
          filtered.length - maxVisible,
        ),
      );
      const endIndex = Math.min(startIndex + maxVisible, filtered.length);

      for (let i = startIndex; i < endIndex; i++) {
        const item = filtered[i];
        if (!item) continue;
        const isSelected = i === selectedIndex;
        const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
        // M3 fix: render a visible [reasoning] badge for items that
        // support extended thinking. Helps the user pick a synthesis
        // model that can reason about hard problems.
        const reasoningBadge = item.reasoning
          ? ` ${theme.fg("success", "[reasoning]")}`
          : "";
        const labelText = isSelected
          ? theme.fg("accent", item.label)
          : theme.fg("text", item.label);
        const labelLine = `${prefix}${labelText}${reasoningBadge}`;
        addWrappedWithPrefix(indent, labelLine);

        if (item.description) {
          addWrappedWithPrefix(
            indent + "    ",
            theme.fg("muted", item.description),
          );
        }
      }

      // Scroll / count line
      if (filtered.length > maxVisible) {
        addWrappedWithPrefix(
          indent,
          theme.fg(
            "dim",
            `  (${selectedIndex + 1}/${filtered.length} · ${allItems.length} total)`,
          ),
        );
      } else if (allItems.length > 0) {
        addWrappedWithPrefix(
          indent,
          theme.fg("dim", `  (${filtered.length}/${allItems.length})`),
        );
      }
    }

    lines.push("");

    // Footer hint
    addWrappedWithPrefix(
      indent,
      theme.fg(
        "dim",
        args.hint ?? "Type to search  ↑↓ navigate  Enter select  Esc cancel",
      ),
    );

    // Bottom border
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    return lines;
  }

  // Drop the cache whenever the input or the filtered list changes.
  // Input doesn't call invalidate() on every keystroke, so we drop it here.
  input.invalidate = () => {
    cachedLines = undefined;
  };

  // The TUI calls our handleInput, which mutates state. After it returns,
  // the TUI calls requestRender() — we just need to make sure cachedLines
  // is unset whenever state has changed.
  const invalidate = (): void => {
    cachedLines = undefined;
  };

  // Wrap handleInput so every invocation invalidates the render cache.
  const wrappedHandleInput = (data: string): void => {
    handleInput(data);
    cachedLines = undefined;
  };

  return {
    render,
    handleInput: wrappedHandleInput,
    invalidate,
  };
}

// Re-export the ExtensionUIContext for callers that just want to type-hint.
export type { ExtensionUIContext };