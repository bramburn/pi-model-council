# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-06-26

### Changed
- **Extracted shared runner helpers into `runnerHelpers.ts`.** The two
  runner files (`councilRunner.ts` and `secondOpinionRunner.ts`) had
  near-identical logic for:
  - 3-source API key resolution (settings → registry → env)
  - parse-then-repair-then-fallback pipeline for model responses
  - "call model + timeout + wrap errors with model name" wrapper

  Per Sandi Metz ("duplication is better than the wrong abstraction"),
  the two runners share these **same-concept** cross-cutting concerns
  while keeping the **different concepts** (fan-out orchestration,
  synthesis step, fallback decision) in their respective files.
  - `resolveOpenRouterApiKey(settings, modelRegistry?)` — shared
  - `parseModelOpinionResponse(rawText)` — shared
  - `callModelWithTimeout(args)` — shared
  - Per-model fan-out, blind-label translation, synthesis prompt
    building → still in `councilRunner.ts`

### Improved (secondOpinionRunner)
- **Now uses structured output + retry**, matching the council runner.
  Previously `/opinion` was the only path that didn't try JSON schema
  first and retry with structured-output-fallback on the `isStructuredOutputError`
  heuristic. Now both runners follow the same "try JSON schema → retry
  without schema on 4xx/structured-output-unsupported" pattern, so
  opinion responses are more reliable on models that have stricter
  schema requirements.
- **Pre-flight status updates** during API key resolution, mirroring
  `/council`'s per-step progress. Previously the only status was
  "Second opinion: querying model..." — now also "resolving API key..."
  and "rendering markdown..." before and after the call.
- **Actionable error format** (`Fix: \`/command\``) for setup errors,
  matching `/council` (v1.2.0). Previously said "Run /opinion-settings";
  now says "Fix: \`/opinion-settings\`".

### Improved (councilRunner)
- **Pre-flight status**: added "Council: resolving API key..." before
  the existing "validating API key..." step so the user sees activity
  during the registry/env lookup.

### Tests
- 12 new tests for `runnerHelpers.ts` covering: API key resolution
  from each of the 3 sources, whitespace trimming, registry-throw
  fallback, env fallback, well-formed JSON parsing, markdown fence
  stripping, fallback shape, partial-JSON repair, success and
  failure paths of `callModelWithTimeout`.
- Total now **111 passing**.

## [1.5.1] - 2026-06-26

### Documentation
- **Added a comprehensive Installation section to the README.** Previously
  the README jumped straight from "Features" to "Workflow" with no
  explanation of how to actually install the extension. The new section
  covers:

  - Prerequisites (Pi version, Node.js 22+, OpenRouter key)
  - A comparison table of all 5 install methods (npm, SSH, HTTPS+PAT,
    local clone, one-shot try) with the destination path each lands in
  - A "pin to a tag" recommendation for reproducibility in shared/CI use
  - Step-by-step walkthroughs for each method, including SSH-vs-HTTPS
    tradeoffs and the fine-grained PAT scope needed for HTTPS
  - The `pi -l` flag for project-scoped (team-shareable) installs
  - `pi list` / `pi config` verification commands
  - `pi update --extensions` and overwrite-to-new-tag for updates
  - `pi remove pi-model-council` for uninstall
  - Where each install lands in the filesystem

  No code changes — docs only.

## [1.5.0] - 2026-06-26

### Security
- **`commandParser.ts` rewritten as a hardened slash-command parser.**
  Slash-command arguments flow directly into LLM prompts, so the parser
  is both a UX surface and a security surface. Hardening (research-
  grounded by the OWASP GenAI guidance and Trail of Bits' agent
  injection writeups):

  - **Unicode NFC normalization** of the full input before any
    comparison or tokenisation, so homoglyphs (e.g. Cyrillic 'а'
    vs Latin 'a') can't bypass the mode allow-list.
  - **Control-character stripping** (null bytes, terminal escape
    sequences, ASCII 0x00–0x1F except newline/tab). Raw control
    bytes pasted into a prompt can break terminal rendering, smuggle
    ANSI escapes, or confuse downstream JSON parsers.
  - **Input length limits** enforced at multiple layers:
    - Max 8000 chars on the problem
    - Max 2000 chars on `--understanding`
    - Max 1000 chars per `--constraint` / `--question`
    - Max 4000 chars per token (early rejection in the tokenizer)
    - Max 200 tokens total per command
    - Max 20 constraints and 20 questions
  - **Error messages on unterminated quotes** instead of silently
    truncating the user's prompt at the next whitespace.
  - **Escaped quotes inside strings** — `"He said \"hello\""` is now
    parsed correctly as `He said "hello"`.
  - **Duplicate `--understanding` detection** (rejected).
  - **Clearer error messages** that always include the full usage
    line so the user can recover without grepping docs.

### Changed
- **DRY'd the two slash-command parsers into one shared implementation.**
  `parseCouncilCommandArgs` and `parseSecondOpinionCommandArgs` were
  ~95% duplicate before. They now share a single `parseCommon()`
  function parameterised by mode allow-list, default mode, question
  field name, and usage string. The single source of truth makes it
  much harder to drift the two parsers out of sync on a future
  change.

### Tests
- 22 new tests for the command parser covering: quoted/unquoted
  problems, mode aliases (`arch` → `architecture`), short flag aliases
  (`-c`/`-q`/`-u`), escaped quotes, unterminated quotes, missing flag
  values, unknown flags, control-char stripping, oversized problem,
  oversized token, duplicate `--understanding`, constraint/question
  count limits, mode token recognition for opinion vs council.
- Total now **99 passing**.

## [1.4.0] - 2026-06-26

### Removed
- **Qdrant persistence layer.** The `qdrantClient.ts` and
  `persistence.ts` files (~290 lines of code) have been removed
  along with the `CouncilDecision.metadata.persisted` and
  `persistenceError` fields. Removed the `COUNCIL_PERSISTENCE_ENABLED`,
  `QDRANT_URL`, `QDRANT_API_KEY`, and `QDRANT_COUNCIL_COLLECTION`
  environment variable lookups.

### Why
The original v0.1.0 intent was to use Qdrant as a vector store for
semantic retrieval over past council decisions. The implementation
never delivered on that promise:

- `createDecisionVector` produced a placeholder 8-dim vector of
  mostly constants (one-hot mode, one-hot confidence, etc.) instead
  of a real semantic embedding.
- No retrieval path existed — nothing ever read from Qdrant to
  influence future council runs.
- The feature was opt-in via an undocumented env var, off by default,
  and not described in the README setup steps.

Per the research-grounded review for v1.4.0, this was dead code
that added attack surface (a network client) and maintenance burden
without delivering any user-visible value. Removal simplifies the
codebase, reduces dependency footprint, and eliminates the
misleading "Qdrant persistence (optional)" mention in the docs.

If semantic retrieval over past decisions becomes a real feature
request in the future, it should be built as a separate extension
(`pi-model-council-memory` or similar) with proper embeddings and a
documented setup flow.

### Migration
If you somehow had `COUNCIL_PERSISTENCE_ENABLED=true` set, just
unset it. Nothing else changes.

## [1.3.0] - 2026-06-26

### Changed
- **Synthesis prompt now uses blind labels (Opinion A/B/C) for council
  members.** Previously the chairman saw model names directly, which
  research shows causes "anchor and prestige bias" — the chairman tends
  to over-weight opinions from the most-recognised model regardless of
  the actual content. The new flow:
  1. Council members are presented anonymously as Opinion A, B, C...
  2. The chairman synthesises one decision using only the blind labels
  3. After the synthesis, the runner resolves each blind label back to
     the actual model id so the final report's `modelNotes` show real
     model names

  This is the same pattern recommended for LLM-judge ensembles in
  evaluation research and matches what tools like `llm-council` and
  academic ensemble systems use.
- **Synthesis system prompt rewritten with explicit decision rules**
  (research-grounded):
  - "Compare options on evidence, not on which model said them"
  - "Do NOT blend incompatible views into a mushy compromise"
  - "Do NOT copy any single opinion verbatim"
  - "When confidence is mixed, lower the overall confidence"
  Each rule directly counters a known failure mode from the literature
  (winner-take-all, averaging, hidden disagreement).
- **Per-model progress indicator during fan-out.** Previously the
  footer showed a single static "Council: querying models..." line.
  Now it updates to e.g. `Council: 2/3 models responded (waiting on
  qwen/qwen3.7-max)` so the user sees real activity.

### Fixed
- **`extractJsonObject` is now robust to common LLM JSON mistakes.**
  Previously the parser used a naive "first { to last }" substring
  extraction, which could:
  - Mistake a `}` inside a string literal for the closing brace
  - Fail when JSON was truncated mid-stream (e.g. `max_tokens` hit
    before the close brace)
  - Reject otherwise-valid JSON containing Python literals like
    `True` / `False` / `None` or trailing commas before `}` / `]`
  The new implementation:
  - Walks brace-balance forward from the first `{`, ignoring braces
    inside string literals and respecting escaped quotes
  - Falls back to a minimal repair pass for `True`/`False`/`None` and
    trailing commas before parsing
  - Returns a clearer error message including the substring length
    when all repair attempts fail

### Tests
- 9 new tests for `extractJsonObject` (brace balance, escaped quotes,
  Python literal repair, trailing comma repair, truncated JSON).
- 1 new test for the blind-label transformation in `buildSynthesisPrompts`.
- Total now **77 passing**.

## [1.2.0] - 2026-06-26

### Fixed
- **`saveLatestCouncilReport` / `saveLatestSecondOpinion` now use `ctx.cwd` instead of `process.cwd()`.** Previously, when the extension was launched from a directory other than the project root (e.g. via `cd /elsewhere && pi`), the report was written under `/elsewhere/.pi/council/` instead of `<project>/.pi/council/`. Now it always lands in the project Pi is running in.
- **`council_decide` tool now also saves the report to disk.** Previously only the `/council` slash command did — when the LLM invoked the tool directly (which is the primary entry point from the agent's perspective), no `.pi/council/last-decision.md` artifact was produced. The behaviour is now consistent regardless of which entry point is used.
- **Status-key collision between `/council` and `/opinion`.** Both commands previously used the same `setStatus("model-council", ...)` key, so a long-running council and a quick opinion would clobber each other's footer message when invoked concurrently. Split into `"model-council:run"` and `"model-council:opinion"`.
- **`/council-settings reset` now only resets council settings**, not the opinion model too. The command name implied a narrower scope. The confirm prompt was updated to reflect what actually gets cleared.
- **`/opinion-settings reset` no longer hardcodes the default model.** It now sources the default from `createDefaultSettings()` so the command stays in lock-step with the rest of the codebase (no drift if the default model ever changes).

### Added
- **Pre-flight status updates.** `runCouncil` now calls `onStatus` during pre-flight so the user sees `Council: validating API key...` and `Council: verifying configured models are available...` instead of an unresponsive spinner during the OpenRouter ping + model fetch.
- **Reasoning-capable badge in the model picker.** Models from pi's registry that support extended thinking now display a `[reasoning]` suffix in their second-line description, making it easier to pick a reasoning-tuned model for the synthesis role. (OpenRouter's REST `/models` endpoint doesn't expose this, so the badge only appears when models come from pi's built-in registry.)
- **Actionable error messages.** Pre-flight errors now start with `Fix: \`/command\`` (e.g. `Fix: \`/council-settings\` to pick replacements.`) following the actionable-error pattern (context + diagnosis + next step) — instead of the more passive `Run /command`.

### Tests
- 2 new tests for reasoning + contextWindow propagation through the
  registry helper. Total now **67 passing**.

## [1.1.1] - 2026-06-26

### Fixed
- **Search picker now actually filters as you type.** v1.1.0 used
  `SelectList.setFilter()` internally, which filters with
  `value.startsWith(query)`. Typing "claude" failed to match
  `value: "anthropic/claude-3.5-sonnet"` (the value doesn't *start* with
  "claude"), so the list filtered to empty and looked like typing was
  broken. v1.1.1 manages the filtered list itself using `fuzzyFilter`
  from `@earendil-works/pi-tui` (the same primitive pi's built-in
  `/model` selector uses), so queries now match across the model
  name, id, and any provider tag in the search haystack.

### Changed
- `searchSelector.ts` no longer depends on `SelectList` (which only
  supports `startsWith` filtering). It renders the list directly with
  `Text` + `Container` children, so any visible-vs-scrolled logic is
  local and easy to follow.

## [1.1.0] - 2026-06-26

### Added
- **Typeahead-searchable, scrollable model picker** for both
  `/council-settings` and `/opinion-settings`. Replaces the flat
  `ctx.ui.select()` list with a custom component that:
  - Fuzzy-filters the model list as you type (matches model name, id,
    and provider all at once)
  - Scrolls with Up/Down (PageUp/PageDown jump a viewport)
  - Shows the model id as a muted secondary line under the model name
  - Excludes already-picked council members from later steps
  - Falls back to `ctx.ui.select()` in non-TUI modes (RPC, JSON, print)
    so headless environments still work
- **`searchSelector.ts`** — reusable helper exported for other
  Pi extensions. Renders via `ctx.ui.custom()` with the same
  `Input` + `SelectList` primitives as pi's built-in `/model` selector.

### Changed
- `/council-settings` flow now shows the searchable picker for all five
  model-selection steps (3 council, 1 synthesis, 1 opinion) plus the
  number of models remaining at each step.
- `/opinion-settings` collapses the previous two-step (Provider → Model)
  flow into a single searchable picker that searches across all
  configured providers.

## [1.0.0] - 2026-06-26

### Added
- **First public release.**
- **Pi-native model discovery** — `/council-settings` now uses
  `ctx.modelRegistry.getAvailable()` filtered by `provider === "openrouter"`
  to list available models. Skips the API-key prompt entirely when Pi
  already knows about OpenRouter (via `OPENROUTER_API_KEY` or `/login openrouter`).
- **4th synthesis model selection** — when configuring the council, you can
  now pick a separate model that reads the three council opinions and writes
  the final decision. Defaults to "Council Model 1".
- **Registry-aware API key resolution** — runners now resolve the OpenRouter
  key from three sources in order: `council-settings.json` →
  `modelRegistry.getApiKeyForProvider("openrouter")` → `process.env.OPENROUTER_API_KEY`.
- **Comprehensive Quick Start workflow in README** — 3-step setup
  (authenticate → configure → use), the 4-model orchestration flow diagram,
  and a clear API-key resolution order.
- **DISCLAIMER.md** — covers AI accuracy, cost, and third-party terms
  (OpenRouter, model providers, optional Qdrant persistence).
- **CONTRIBUTING.md** — dev setup, Conventional Commits, PR process.
- **CODE_OF_CONDUCT.md** — Contributor Covenant v2.1.
- **SUPPORT.md** — where to ask questions, response times.
- **Issue and PR templates** — bug report, feature request, PR checklist.
- **7 new tests** for the registry-based settings path. Suite is now
  60 tests total.

### Changed
- `openCouncilSettingsUI` rewritten to prefer the pi model registry.
  The legacy API-key-prompt flow remains as a fallback when the registry
  exposes fewer than 3 OpenRouter models.
- `CouncilSettings` gains an optional `synthesis.modelId` field (defaults
  to `models.model1` when omitted — fully backward compatible).
- `formatSettingsForDisplay` shows the synthesis model and the "(using
  pi auth — no key stored locally)" indicator when the settings file
  carries no API key.
- `package.json` `files` array explicitly ships all 8 markdown docs so
  they're included when the package is installed via npm.

## [0.1.0] - 2024-06-25

### Added
- Initial private release
- `/council` command for multi-model coding decisions (3 OpenRouter models)
- `/opinion` command for single-model second opinions
- `/council-settings` command for configuring OpenRouter API key and council models
- `/opinion-settings` command for configuring the second opinion model
- Settings persistence via `~/.pi/agent/council-settings.json`
- OpenRouter model discovery and validation
- Qdrant persistence for council decisions (optional)
- Full test suite with Vitest
- Security CI/CD with Gitleaks and npm audit

[1.6.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.6.0
[1.5.1]: https://github.com/bramburn/pi-model-council/releases/tag/v1.5.1
[1.5.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.5.0
[1.4.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.4.0
[1.3.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.3.0
[1.2.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.2.0
[1.1.1]: https://github.com/bramburn/pi-model-council/releases/tag/v1.1.1
[1.1.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.1.0
[1.0.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.0.0
[0.1.0]: https://github.com/bramburn/pi-model-council/releases/tag/v0.1.0