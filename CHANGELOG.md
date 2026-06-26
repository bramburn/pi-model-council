# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/bramburn/pi-model-council/releases/tag/v1.0.0
[0.1.0]: https://github.com/bramburn/pi-model-council/releases/tag/v0.1.0