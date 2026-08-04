# model-council

Pi extension for multi-model coding decisions via OpenRouter.

Ask three independent AI models for a second opinion, then have a fourth model synthesise them into a single actionable plan. Use the fast `/opinion` command for quick checks, and `/council` for higher-stakes architectural decisions.

## Features

- **Multi-model council** — 1–8 models deliberate independently, then a synthesis model (auto-selected from your council, or pick your own) produces the final decision. Returned as a structured plan you (or Pi) can implement. Models are chosen from Pi's full model registry — OpenRouter, Anthropic, OpenAI, Google, Mistral, Bedrock, or any other provider Pi is configured to talk to.
- **Single-model opinions** — Get a quick second opinion from any model with valid auth, using Pi's built-in model registry (same source as the council picker).
- **Pi-native auth** — Re-uses `OPENROUTER_API_KEY` (or `/login openrouter`) so the OpenRouter API key lives in one place. Non-OpenRouter providers use Pi's per-provider auth.
- **Persistent settings** — Stored in `~/.pi/agent/council-settings.json` (untrusted projects) or `<project>/.pi/council-settings.json` (trusted projects). Includes the council members, the synthesis model, and the opinion model.
- **Secure** — Settings are gitignored, written with `0600` permissions, and never read from the working directory for untrusted projects (no hijack vector). Keys are never logged.
- **Multi-select picker** — Fuzzy search, Tab to toggle all/scoped view, Enter to toggle, Enter on `[ done — save N picks ]` to commit. Mirrors Pi's built-in ModelSelectorComponent UX.

---

## Installation

`pi install` accepts three source types: **npm**, **git**, and **local path**. Pick the one that matches how you want to consume the extension.

### Prerequisites

- **Pi** installed (`pi --version` should print ≥ 1.0)
- **Node.js 22+** (matches the extension's CI runner)
- An **OpenRouter API key** — get one at [openrouter.ai/keys](https://openrouter.ai/keys)

### Pick the install method

| Use case | Command | Where it lands |
|---|---|---|
| **npm** (recommended once published) | `pi install npm:pi-model-council` | `~/.pi/agent/npm/pi-model-council` |
| **GitHub via SSH** (most common) | `pi install git:github.com/bramburn/pi-model-council` | `~/.pi/agent/git/github.com/bramburn/pi-model-council` |
| **GitHub via HTTPS + PAT** (private repos, CI) | `pi install https://x-access-token:<TOKEN>@github.com/bramburn/pi-model-council.git` | `~/.pi/agent/git/github.com/bramburn/pi-model-council` |
| **Local clone** (development) | `pi install ./pi-model-council` | registered in-place, not copied |
| **Try without installing** (one-shot) | `pi -e git:github.com/bramburn/pi-model-council` | temp directory |

Pin to a specific tag for reproducibility (recommended for shared / CI use):

```bash
pi install git:github.com/bramburn/pi-model-council@v1.5.0
```

### Detailed walkthroughs

#### Option 1 — npm (once the package is published)

```bash
pi install npm:pi-model-council
```

Updates use the regular npm flow: `pi update --extensions`.

#### Option 2 — GitHub via SSH

If you've already added an SSH key to your GitHub account (the same key you'd use for `git push` to this repo), Pi uses it automatically:

```bash
pi install git:github.com/bramburn/pi-model-council
# Or pinned to a tag:
pi install git:github.com/bramburn/pi-model-council@v1.5.0
```

The clone is placed under `~/.pi/agent/git/github.com/bramburn/pi-model-council/`.

#### Option 3 — GitHub via HTTPS with a Personal Access Token

Use this when SSH isn't an option. Create a **fine-grained** token at <https://github.com/settings/tokens?type=beta> with **read** access scoped to just `bramburn/pi-model-council`:

```bash
pi install https://x-access-token:<TOKEN>@github.com/bramburn/pi-model-council.git
```

> The PAT will be embedded in `~/.pi/agent/settings.json`. The settings file is created with `0600` permissions, but treat it as a secret and don't commit it.

#### Option 4 — Local clone (recommended for development)

```bash
# Clone once anywhere
git clone https://github.com/bramburn/pi-model-council.git ~/code/pi-model-council
cd ~/code/pi-model-council
npm install

# Register the local path with pi (no copy — edits take effect immediately)
pi install ./pi-model-council
```

To update later:

```bash
cd ~/code/pi-model-council
git pull && npm install
# The next pi launch picks up the new code automatically; no reinstall needed.
# If you changed pi-extension metadata, force a refresh:
pi update --self --force
```

#### Option 5 — Try without installing (one-shot smoke test)

```bash
pi -e git:github.com/bramburn/pi-model-council
```

Pi clones to a temp directory and uses the extension for the current run only. Nothing is written to your settings.

### Project-scoped install (team sharing)

By default, `pi install` writes to **user** settings (`~/.pi/agent/settings.json`). To write to **project** settings (`.pi/settings.json`) so the install is checked into your team's repo and auto-applied when a teammate opens the project:

```bash
pi install -l git:github.com/bramburn/pi-model-council@v1.5.0
```

After this, commit `.pi/settings.json` to your project. When a teammate clones and Pi trusts the project, the extension installs automatically.

### Verify the install

```bash
pi list                # shows installed packages and their sources
pi config              # toggle the extension on/off
```

You should see `pi-model-council` listed and enabled. Then launch Pi and try:

```bash
pi
> /council-settings
```

If the council UI opens, the extension is loaded correctly.

### Updating an installed version

```bash
# Update every installed extension to the ref pinned in settings
pi update --extensions

# Update only this one to a new tag/commit
pi install git:github.com/bramburn/pi-model-council@v1.6.0   # overwrites
```

### Uninstalling

```bash
pi remove pi-model-council
```

Or manually delete the entry from `~/.pi/agent/settings.json` and remove the clone under `~/.pi/agent/git/github.com/bramburn/pi-model-council/`. Your settings file (`council-settings.json`) is kept — re-installing will pick them back up.

---

## Workflow: Getting Started in 3 Steps

The whole setup takes about a minute. Follow this order — each step builds on the previous one.

### Step 1 — Authenticate with OpenRouter (one-time)

Pi already ships with an OpenRouter provider. Give it your API key once and Pi will list every supported OpenRouter model under `provider === "openrouter"`.

```bash
# Option A — environment variable (recommended for CI / dotfiles)
export OPENROUTER_API_KEY="sk-or-v1-..."

# Option B — interactive login (stores in ~/.pi/agent/auth.json with 0600 perms)
# Inside Pi, run:
/login openrouter
```

Get a key from [openrouter.ai/keys](https://openrouter.ai/keys).

Verify Pi sees the models:

```bash
pi --list-models
# Look for entries like:
#   openrouter/anthropic/claude-3.5-sonnet
#   openrouter/openai/gpt-4o
#   openrouter/qwen/qwen3.7-max
```

### Step 2 — Configure the extension

Run the council settings UI. Pi will detect OpenRouter in your model registry and skip the API-key prompt entirely.

```bash
/council-settings
```

The UI uses a **multi-select picker** (same UX as Pi's ModelSelectorComponent), so you can filter through every model in your Pi registry by typing a few characters — fuzzy-matched across provider name, model name, and id. Up/Down to navigate, Enter to toggle a pick, Tab to toggle the all/scoped scope, Esc to cancel, Enter on the `[ done — save N picks ]` row at the top of the list to commit.

The UI walks you through:

1. **Council Models** — pick 1–8 models to serve on the council. Pre-populated from your saved settings when re-running; starts empty on first run. Mix providers freely (e.g. 2 OpenRouter + 1 Anthropic + 1 OpenAI).
2. **Synthesis Model** — reads the council opinions and writes the final plan. Defaults to the first council model since you already trust it; pick any model from your registry.
3. **Second Opinion Model** — the model used by `/opinion` for quick checks
4. **Structured Output** — JSON schema for faster parsing (recommended: yes)

If Pi doesn't see OpenRouter yet (because you skipped Step 1), the UI falls back to a manual flow: it asks for an API key, pings OpenRouter to verify, fetches the live model list, and proceeds the same way.

Re-run anytime to swap models:

```bash
/council-settings list    # show current config
/council-settings reset   # wipe and reconfigure
```

For just the opinion model:

```bash
/opinion-settings
```

### Step 3 — Use the council

```bash
# N deliberating models + one synthesis model (1–8 models, default 3)
/council fix "The login fails on mobile devices"
/council ask "Should we use hooks or context for state?"
/council architecture "Where should auth state live?"

# Single-model quick check (uses your /opinion model)
/opinion "How should I refactor this function?"
/opinion fix "Lesson progress resets after navigation"
```

The full report is saved to `.pi/council/last-decision.md` (and `.pi/council/last-opinion.md` for `/opinion`). The Pi agent can read this file when continuing the conversation.

---

## How Model Selection Works

The extension uses two layers:

| Layer | Source | Purpose |
|---|---|---|
| **Discovery** | `ctx.modelRegistry.getAvailable()` | Lists every OpenRouter model Pi knows about (the curated list ships with Pi). Filtered to `provider === "openrouter"`. |
| **Validation** | Same registry, then OpenRouter `/models` fallback | Confirms each chosen model ID still exists at runtime. |
| **Inference** | Direct OpenRouter REST call (`openrouterClient.ts`) | Sends the council prompts to each model and the synthesis prompt to the chosen synthesiser. |

This means:

- If Pi already knows about OpenRouter (Step 1 above), `ctx.modelRegistry.getAvailable()` provides the model list — no extra HTTP call.
- If the registry is empty (e.g. fresh install, no API key yet), the UI prompts for a key and fetches the live model list directly from OpenRouter.
- The chosen model IDs are stored in `council-settings.json` and used to make the actual inference calls. They are not changed when you swap Pi providers.

### Why a separate Synthesis Model?

The three council members argue from different angles; the synthesis model is the judge that weighs them and produces a single plan. By default it's "Council Model 1" because you already trust that model. For higher-stakes decisions, pick a model known for careful reasoning (e.g. `anthropic/claude-3.5-sonnet`, `openai/o1`) — it's a 4th API call on top of the three council calls.

### The 4-Model Orchestration Flow

When you run `/council`, a single `council_decide` tool call internally fans out to four models. Pi sees only the final synthesised report — all sub-calls are hidden behind one logical tool:

```
                       /council fix "..."         (slash command)
                              │
                              ▼
              ┌───────────────────────────────┐
              │   council_decide tool         │   (single Pi tool call)
              │   councilRunner.ts            │
              └───────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
      ┌──────────┐       ┌──────────┐       ┌──────────┐
      │ Model 1  │       │ Model 2  │       │ Model 3  │   ← Promise.all
      │ (council)│       │ (council)│       │ (council)│     parallel
      └────┬─────┘       └────┬─────┘       └────┬─────┘     fan-out
           │                  │                  │
           ▼                  ▼                  ▼
       opinion A          opinion B          opinion C        (JSON)
           │                  │                  │
           └──────────────────┼──────────────────┘
                              ▼
                       ┌──────────────┐
                       │  Model 4     │                         ← synthesis step
                       │  (synthesis) │                            reads 3 opinions
                       └──────┬───────┘                            writes 1 decision
                              ▼
                       ┌──────────────┐
                       │  Pi receives │   ← tool result returned to agent
                       │  Markdown    │
                       │  report      │
                       └──────────────┘
```

**Key properties:**

- All four calls happen **inside one tool execution**, so the agent sees a single tool call in its reasoning graph — no multi-turn coordination overhead.
- The three council calls run **in parallel** via `Promise.all`. Each call has its own `withTimeout` + `retry` wrapper, so a slow or failing model doesn't block the others.
- If 1 of 3 council models fails, the synthesis step still proceeds with the 2 successful opinions. If all 3 fail, the runner surfaces a clear error.
- The synthesis call has a longer timeout (`synthesisTimeoutMs`) because the synthesis prompt includes all three opinions.
- `ctx.signal` is threaded through every downstream `fetch()`, so pressing Esc during a long council cancels all in-flight calls (Pi's `withTimeout` helper combines the parent signal with per-call timeouts).

### Where the API Key Comes From

Resolution order:

1. `council-settings.json` → `openRouter.apiKey` (the legacy explicit-prompt flow)
2. Pi's auth storage → `modelRegistry.getApiKeyForProvider("openrouter")` (when you've set `OPENROUTER_API_KEY` or run `/login openrouter`)
3. `process.env.OPENROUTER_API_KEY`

If none of these resolve, `/council` and `/opinion` both fail fast with a setup error pointing you at `/council-settings`.

---

## Commands

### `/council`

Three OpenRouter models + one synthesis model.

```bash
/council fix "The login fails on mobile devices"
/council ask "Should we use hooks or context for state?"
/council architecture "Where should auth state live?"
```

Modes:

- `fix` — debug a known problem
- `ask` — open technical question
- `architecture` — design-level decision
- (default) — generic second opinion

### `/opinion`

Single-model quick check.

```bash
/opinion "How should I refactor this function?"
/opinion fix "The lesson progress resets after navigation"
```

Modes: `fix`, `ask`, `architecture`, `general`.

### `/council-settings`

Configure the OpenRouter setup.

```bash
/council-settings          # Open the settings UI (3 council + 1 synthesis + opinion)
/council-settings list     # Show current settings (API key redacted)
/council-settings reset    # Reset all council settings
```

### `/opinion-settings`

Configure just the `/opinion` model.

```bash
/opinion-settings          # Open the settings UI
/opinion-settings list     # Show current model
/opinion-settings reset    # Reset to default
```

---

## Models

### Council (3 Members)

The three models you pick in `/council-settings` for independent deliberation. Recommended starting set (all available on OpenRouter):

- `anthropic/claude-3.5-sonnet` — careful reasoning, code quality
- `openai/gpt-4o` — broad knowledge, multimodal
- `qwen/qwen3.7-max` — strong code model, cost-effective

Pick models that disagree productively. If they all share a training cutoff, you get correlated blind spots.

### Synthesis Model

The fourth model that reads the three opinions and writes the single recommendation. Defaults to "Council Model 1". For high-stakes decisions, consider a reasoning-tuned model:

- `openai/o1` — strong step-by-step reasoning
- `anthropic/claude-3.5-sonnet` — careful, balanced
- `deepseek/deepseek-r1` — reasoning model with low cost

### Second Opinion (`/opinion`)

Any model with valid auth works. Pi's `modelRegistry.getAvailable()` is the source of truth, so any provider you've configured (Anthropic, OpenAI, Google, OpenRouter, etc.) is selectable.

---

## Architecture

```
pi-model-council/
├── index.ts                # Extension entry point
├── councilRunner.ts        # 3-model + synthesis logic
├── secondOpinionRunner.ts  # Single-model logic
├── settings.ts             # Settings persistence
├── settings-ui.ts          # Settings TUI components (registry-aware)
├── openrouterClient.ts     # OpenRouter REST client + JSON repair
├── prompts.ts              # Proposal + synthesis prompts (blind-label)
├── structuredOutput.ts     # JSON schemas + repair
├── markdown.ts             # Decision report formatter
├── searchSelector.ts       # Searchable model picker (custom TUI)
├── retry.ts                # Timeout + retry helpers
├── schemas.ts              # TypeBox tool parameter schemas
├── commandParser.ts        # CLI argument parsers
└── types.ts                # Shared TypeScript types
```

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Lint
npm run lint

# Run tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage

# Audit dependencies
npm run audit
```

---

## Security

See [SECURITY.md](SECURITY.md) for the security policy and reporting vulnerabilities.

API keys are stored in `council-settings.json` (when set explicitly) or in Pi's `~/.pi/agent/auth.json` (when set via env var or `/login`). Both files use `0600` permissions and are gitignored. The extension never logs keys, but does echo a redacted preview when listing settings.

## Disclaimer

This extension sends your prompts to OpenRouter and the model providers behind it. AI-generated suggestions can be wrong, outdated, or unsafe — always review before applying. See [DISCLAIMER.md](DISCLAIMER.md) for the full text.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the PR process.

## Code of Conduct

By participating, you agree to the Contributor Covenant in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Support

Open an issue using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). See [SUPPORT.md](SUPPORT.md) for where to ask questions.

## License

MIT — see [LICENSE](LICENSE).