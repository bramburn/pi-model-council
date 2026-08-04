/**
 * MultiSelectPicker — searchable multi-model picker for the council settings UI.
 *
 * UX contract (mirrors pi's ModelSelectorComponent):
 *   - Fuzzy typeahead search filters the model list as you type
 *   - ↑/↓ navigates the filtered list; Enter toggles selection
 *   - Tab toggles the scope between "all" and "scoped" (picked) views
 *   - Esc cancels and returns undefined
 *   - Enter on an already-confirmed picker (or a dedicated "Done" key) commits
 *
 * Two views:
 *   "all" — browsable catalog of all available models, checked items are
 *            already-picked (shown at the top of the list with a ✓).
 *   "scoped" — shows only the currently-picked models, so the user can
 *               review and prune the selection before confirming.
 *
 * Designed to be composable: pass `initialPicks` to pre-populate the selection.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  matchesKey,
  Key,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface MultiSelectItem {
  /** Unique model identifier, e.g. "openrouter/qwen/qwen3.7-max". */
  value: string;
  /** Display name, e.g. "Qwen 3.7 Max". */
  label: string;
  /** Optional secondary line shown under the label in muted colour. */
  description?: string;
  /**
   * Optional extra search target. When absent the picker searches across
   * `label` + `value`. Use this to inject the provider name so typing
   * "openrouter" matches all models from that provider.
   */
  searchHaystack?: string;
  /** True if the model supports extended thinking / reasoning. */
  reasoning?: boolean;
}

export interface MultiSelectPickerArgs {
  /** Title shown at the top of the picker. */
  title: string;
  /** Subtitle / hint shown under the title. */
  subtitle?: string;
  /** All available items to choose from. */
  items: MultiSelectItem[];
  /**
   * Initially-selected values. Used when re-opening the settings UI with
   * pre-existing picks, and when the user confirms a pick and re-opens
   * to add more.
   */
  initialPicks?: string[];
  /**
   * Minimum number of picks required. Validation error shown on commit if
   * the user has not selected enough. Defaults to 1.
   */
  minPicks?: number;
  /**
   * Maximum number of picks allowed. When the limit is reached new selections
   * are rejected until the user deselects something. Defaults to unlimited.
   */
  maxPicks?: number;
  /** Hint shown below the list. */
  hint?: string;
  /** Placeholder text inside the search input. */
  searchPlaceholder?: string;
  /** When true the search input is pre-focused on open. Default: true. */
  autofocus?: boolean;
}

export type MultiSelectResult = string[] | undefined;

/**
 * Open the multi-select picker. Returns the final picked values (ordered by
 * selection time), or `undefined` if the user pressed Esc.
 *
 * Falls back to ctx.ui.select() in non-TUI mode so the extension still
 * works in headless / RPC environments.
 */
export async function multiSelectPicker(
  ctx: ExtensionCommandContext,
  args: MultiSelectPickerArgs,
): Promise<MultiSelectResult> {
  // ── Non-TUI fallback ──────────────────────────────────────────────────────
  // We cannot do true multi-select via the flat ctx.ui.select() dialog,
  // so fall back to a simple "pick one at a time" loop that mirrors the
  // old 3-pick sequential flow. The TUI path is the primary experience.
  if (ctx.mode !== "tui") {
    return nonTuiFallback(ctx, args);
  }

  return ctx.ui.custom<MultiSelectResult>((tui, theme, _kb, done) => {
    return buildMultiSelectComponent(theme, args, done, tui);
  });
}

// ─── Non-TUI fallback (headless / RPC) ────────────────────────────────────────

/**
 * Minimal multi-select for headless environments.
 * Since `ctx.ui.select()` only supports single-pick, we simulate a loop:
 * pick models one-by-one, type "done" or press Esc to finish.
 *
 * When `ctx.ui.select()` returns a label (the common case in tests), we
 * map it back to the matching item by label or value, then push the item's
 * `value` into the picks list. This lets tests simply mock `select` to
 * return label strings without needing to know model IDs.
 */
async function nonTuiFallback(
  ctx: ExtensionCommandContext,
  args: MultiSelectPickerArgs,
): Promise<MultiSelectResult> {
  const picks: string[] = [...(args.initialPicks ?? [])];
  // Build a lookup table: label → item and value → item, so either form works
  const byLabel = new Map(args.items.map((i) => [i.label, i]));
  const byValue = new Map(args.items.map((i) => [i.value, i]));

  while (true) {
    const choices = [...args.items.map((i) => i.label), "[done]"];
    const choice = await ctx.ui.select(args.title, choices);
    if (!choice || choice === "[done]") break;

    // Map the returned label back to an item (fall back to value if label not found)
    const item = byLabel.get(choice) ?? byValue.get(choice);
    if (!item) break;

    if (picks.includes(item.value)) {
      picks.splice(picks.indexOf(item.value), 1);
    } else {
      if (args.maxPicks !== undefined && picks.length >= args.maxPicks) {
        ctx.ui.notify(
          `Maximum of ${args.maxPicks} models reached. Deselect one first.`,
          "warning",
        );
        continue;
      }
      picks.push(item.value);
    }
  }

  if (picks.length === 0) return undefined;
  if (args.minPicks !== undefined && picks.length < args.minPicks) {
    ctx.ui.notify(
      `Select at least ${args.minPicks} model${args.minPicks === 1 ? "" : "s"}.`,
      "warning",
    );
    return undefined;
  }
  return picks;
}

// ─── Internal types ────────────────────────────────────────────────────────────

interface InternalItem extends MultiSelectItem {
  haystack: string;
  checked: boolean;
}

type PickerScope = "all" | "scoped";

// ─── Component factory ─────────────────────────────────────────────────────────

function buildMultiSelectComponent(
  theme: Theme,
  args: MultiSelectPickerArgs,
  done: (result: MultiSelectResult) => void,
  _tui: unknown,
): Component {
  const minPicks = args.minPicks ?? 1;
  const maxPicks = args.maxPicks ?? Infinity;

  // Pre-compute haystacks and initialise checked state.
  const checkedSet = new Set<string>(args.initialPicks ?? []);

  const allItems: InternalItem[] = args.items.map((item) => ({
    ...item,
    haystack: (item.searchHaystack ?? `${item.label} ${item.value}`).toLowerCase(),
    checked: checkedSet.has(item.value),
  }));

  // Split into checked (picked) and unchecked views.
  function getCheckedItems(): InternalItem[] {
    return allItems.filter((i) => i.checked);
  }

  function getUncheckedItems(): InternalItem[] {
    return allItems.filter((i) => !i.checked);
  }

  // Mutable state.
  let query = "";
  let scope: PickerScope = "all";
  let filtered: InternalItem[] = [...allItems]; // starts in "all" scope
  let selectedIndex = 0;
  const picks: Set<string> = new Set(checkedSet);
  let cachedLines: string[] | undefined;
  let validationError: string | undefined;

  // ── Input ──────────────────────────────────────────────────────────────────
  const input = new Input();
  if (args.autofocus !== false) {
    input.focused = true;
  }

  // ── Key handlers ─────────────────────────────────────────────────────────
  const cancel = (): void => done(undefined);

  const commit = (): void => {
    if (picks.size < minPicks) {
      validationError = `Select at least ${minPicks} model${minPicks === 1 ? "" : "s"}.`;
      cachedLines = undefined;
      return;
    }
    done(Array.from(picks));
  };

  const toggleAt = (index: number): void => {
    const item = filtered[index];
    if (!item) return;

    if (picks.has(item.value)) {
      picks.delete(item.value);
    } else {
      if (picks.size >= maxPicks) {
        validationError = `Maximum of ${maxPicks} models. Deselect one first.`;
        cachedLines = undefined;
        return;
      }
      picks.add(item.value);
    }
    validationError = undefined;

    // Sync checked flag on all items
    for (const i of allItems) {
      i.checked = picks.has(i.value);
    }

    // If in scoped view, re-filter; in all view, just re-sort so checked float up.
    recomputeFilter();
  };

  const recomputeFilter = (): void => {
    const q = query.trim().toLowerCase();
    validationError = undefined;

    if (scope === "scoped") {
      filtered = getCheckedItems();
    } else {
      // "all" view: checked items float to the top (in selection order),
      // unchecked items are fuzzy-filtered below.
      const checked = getCheckedItems();
      const unchecked = q.length > 0
        ? fuzzyFilter(
            allItems.filter((i) => !i.checked),
            query,
            (i) => i.haystack,
          )
        : getUncheckedItems();

      // Interleave: checked first, then unchecked. Track absolute index into
      // allItems for selectedIndex.
      filtered = [...checked, ...unchecked];
    }

    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, filtered.length - 1)));
    cachedLines = undefined;
  };

  recomputeFilter();

  // ── Input lifecycle ───────────────────────────────────────────────────────
  input.onSubmit = () => commit();
  input.onEscape = () => cancel();

  const handleInput = (data: string): void => {
    const kb = getKeybindings();

    // Tab: toggle scope
    if (kb.matches(data, "tui.input.tab")) {
      scope = scope === "all" ? "scoped" : "all";
      recomputeFilter();
      return;
    }

    // Esc: cancel
    if (matchesKey(data, Key.escape)) {
      cancel();
      return;
    }

    // ↑/↓: navigate
    if (matchesKey(data, Key.up)) {
      if (filtered.length === 0) return;
      selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
      cachedLines = undefined;
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (filtered.length === 0) return;
      selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
      cachedLines = undefined;
      return;
    }

    // Enter: toggle selection
    if (matchesKey(data, Key.enter)) {
      toggleAt(selectedIndex);
      return;
    }

    // Everything else: type in search
    input.handleInput(data);
    query = input.getValue();
    recomputeFilter();
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const lines: string[] = [];
    const rw = Math.max(1, width);
    const indent = "  ";

    function addWrapped(text: string) {
      lines.push(...wrapTextWithAnsi(text, rw));
    }

    function addWithPrefix(prefix: string, text: string) {
      const pw = visibleWidth(prefix);
      if (pw >= rw) {
        addWrapped(prefix + text);
        return;
      }
      const wrapped = wrapTextWithAnsi(text, rw - pw);
      const cont = " ".repeat(pw);
      wrapped.forEach((l, i) => lines.push(`${i === 0 ? prefix : cont}${l}`));
    }

    // ── Top border ──────────────────────────────────────────────────────────
    lines.push(theme.fg("accent", "─".repeat(rw)));

    // ── Title + subtitle ────────────────────────────────────────────────────
    addWithPrefix(indent, theme.fg("accent", args.title));
    if (args.subtitle) {
      addWithPrefix(indent, theme.fg("muted", args.subtitle));
    }
    lines.push("");

    // ── Scope indicator ─────────────────────────────────────────────────────
    const allLabel = scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
    const scopedLabel = scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
    const scopeLine = `${indent}${theme.fg("muted", "Scope: ")}${allLabel}${theme.fg("muted", " | ")}${scopedLabel}  ${theme.fg("dim", "[tab] toggle  ·  picks: ")}${theme.fg("accent", String(picks.size))}${maxPicks !== Infinity ? `/${maxPicks}` : ""}`;
    lines.push(scopeLine);
    lines.push("");

    // ── Search input ────────────────────────────────────────────────────────
    for (const line of input.render(Math.max(1, rw - indent.length * 2))) {
      lines.push(`${indent}${line}`);
    }
    lines.push("");

    // ── Validation error ────────────────────────────────────────────────────
    if (validationError) {
      addWithPrefix(indent, theme.fg("error", validationError));
      lines.push("");
    }

    // ── Model list ─────────────────────────────────────────────────────────
    const MAX_VISIBLE = 10;
    if (filtered.length === 0) {
      if (scope === "scoped" && picks.size === 0) {
        addWithPrefix(indent, theme.fg("muted", "(no models selected)"));
      } else if (query.length > 0) {
        addWithPrefix(indent, theme.fg("warning", `No matches for "${query}"`));
      } else {
        addWithPrefix(indent, theme.fg("muted", "(empty list)"));
      }
    } else {
      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE),
      );
      const end = Math.min(start + MAX_VISIBLE, filtered.length);

      for (let i = start; i < end; i++) {
        const item = filtered[i];
        if (!item) continue;
        const isSelected = i === selectedIndex;
        const isChecked = item.checked;

        // Checkbox character: ✓ (checked) or ☐ (unchecked)
        const checkChar = isChecked ? theme.fg("success", "✓") : " ";
        const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";

        // Label line
        const label = isSelected
          ? theme.fg("accent", item.label)
          : theme.fg("text", item.label);
        addWithPrefix(`${indent}${prefix}${checkChar} `, label);

        // Description / id line
        if (item.description) {
          const desc = isSelected
            ? theme.fg("accent", item.description)
            : theme.fg("muted", item.description);
          addWithPrefix(indent + "    ", desc);
        }
      }

      // Scroll indicator
      if (filtered.length > MAX_VISIBLE) {
        addWithPrefix(
          indent,
          theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length} · ${allItems.length} total)`),
        );
      } else {
        addWithPrefix(
          indent,
          theme.fg("dim", `  (${filtered.length}/${allItems.length})`),
        );
      }
    }

    lines.push("");

    // ── Pick count badge ────────────────────────────────────────────────────
    if (picks.size > 0) {
      const pickNames = Array.from(picks)
        .map((v) => allItems.find((i) => i.value === v)?.label ?? v)
        .join(", ");
      addWithPrefix(indent, `${theme.fg("success", `Picked (${picks.size}):`)} ${theme.fg("muted", pickNames)}`);
      lines.push("");
    }

    // ── Footer hint ────────────────────────────────────────────────────────
    addWithPrefix(
      indent,
      theme.fg(
        "dim",
        args.hint ??
          `↑↓ navigate  Enter toggle  [tab] scope  Esc cancel  Enter to commit`,
      ),
    );

    // ── Bottom border ───────────────────────────────────────────────────────
    lines.push(theme.fg("accent", "─".repeat(rw)));

    cachedLines = lines;
    return lines;
  }

  const invalidate = (): void => {
    cachedLines = undefined;
  };

  const wrappedHandleInput = (data: string): void => {
    handleInput(data);
    cachedLines = undefined;
  };

  // Input doesn't call invalidate() on every keystroke; drop the cache
  // whenever input changes.
  input.invalidate = () => {
    cachedLines = undefined;
  };

  return { render, handleInput: wrappedHandleInput, invalidate };
}

// Re-export for callers that only need the type.
export type { ExtensionCommandContext };
