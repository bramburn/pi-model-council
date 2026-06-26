# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.1]: https://github.com/bramburn/pi-model-council/releases/tag/v1.1.1
[1.1.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.1.0
[1.0.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.0.0
[0.1.0]: https://github.com/bramburn/pi-model-council/releases/tag/v0.1.0