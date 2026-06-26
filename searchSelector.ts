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
 * This mirrors the UX of pi's built-in `/model` selector (ModelSelectorComponent)
 * but is parameterised so the same component can pick council members,
 * a synthesis model, or an opinion model from the same registry.
 */

import type { ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Input,
  matchesKey,
  Key,
  SelectList,
  type SelectItem,
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

function buildSelectorComponent(
  theme: Theme,
  args: SearchableSelectArgs,
  done: (result: SearchableSelectResult) => void,
): Component {
  const input = new Input();
  const maxVisible = args.maxVisible ?? 10;

  const selectList = new SelectList(
    args.items.map(toSelectItem),
    maxVisible,
    {
      selectedPrefix: (s) => theme.fg("accent", s),
      selectedText: (s) => theme.fg("accent", s),
      description: (s) => theme.fg("muted", s),
      scrollInfo: (s) => theme.fg("dim", s),
      noMatch: (s) => theme.fg("warning", s),
    },
  );

  // ── Helpers ──
  const commitSelection = (): void => {
    const selected = selectList.getSelectedItem();
    if (!selected) return;
    const original = args.items.find((i) => i.value === selected.value);
    done(original);
  };

  const cancel = (): void => {
    done(undefined);
  };

  const syncFilter = (): void => {
    selectList.setFilter(input.getValue());
  };

  input.onSubmit = () => commitSelection();
  input.onEscape = () => cancel();
  selectList.onSelect = () => commitSelection();

  // ── Key router ──
  // Input owns typing/Enter/Esc routing; SelectList owns Up/Down navigation.
  // We dispatch by key, intercepting the few keys that need special routing.
  const handleInput = (data: string): void => {
    // Up/Down: navigate the SelectList directly.
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      selectList.handleInput(data);
      return;
    }

    // Esc: cancel (Input.onEscape will fire too; both paths do the same thing).
    if (matchesKey(data, Key.escape)) {
      cancel();
      return;
    }

    // Everything else goes to the Input (typing, backspace, enter, etc.).
    input.handleInput(data);

    // After any input mutation, sync the SelectList filter.
    syncFilter();
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

    // List (SelectList handles its own scrolling/info line)
    for (const line of selectList.render(renderWidth)) {
      lines.push(line);
    }

    lines.push("");

    // Footer hint
    addWrappedWithPrefix(
      indent,
      theme.fg(
        "dim",
        args.hint ?? "Type to search  ↑↓ navigate  PgUp/PgDn jump  Enter select  Esc cancel",
      ),
    );

    // Bottom border
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    return lines;
  }

  const invalidate = (): void => {
    cachedLines = undefined;
  };

  // Forward invalidations from children — SelectList and Input call their own
  // invalidate() on mutation, but our render() is cached, so we have to drop
  // the cache when either of them changes.
  const originalSelectInvalidate = selectList.invalidate.bind(selectList);
  selectList.invalidate = () => {
    originalSelectInvalidate();
    cachedLines = undefined;
  };
  const originalInputInvalidate = input.invalidate.bind(input);
  input.invalidate = () => {
    originalInputInvalidate();
    cachedLines = undefined;
  };

  return {
    render,
    handleInput,
    invalidate,
  };
}

function toSelectItem(item: SelectableItem): SelectItem {
  return {
    value: item.value,
    label: item.label,
    ...(item.description !== undefined ? { description: item.description } : {}),
  };
}

// Re-export the ExtensionUIContext for callers that just want to type-hint.
export type { ExtensionUIContext };