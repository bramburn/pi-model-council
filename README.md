# model-council

Pi extension for multi-model coding decisions via OpenRouter.

Ask three independent AI models for a second opinion, then have a fourth model synthesise them into a single actionable plan. Use the fast `/opinion` command for quick checks, and `/council` for higher-stakes architectural decisions.

## Features

- **Multi-model council** — Three OpenRouter models deliberate independently, then a fourth model (you pick) synthesises the final decision. Returned as a structured plan you (or Pi) can implement.
- **Single-model opinions** — Get a quick second opinion from any model with valid auth, using Pi's built-in model registry.
- **Pi-native auth** — Re-uses `OPENROUTER_API_KEY` (or `/login openrouter`) so the API key lives in one place. No separate key prompt required when Pi already knows OpenRouter.
- **Persistent settings** — Stored in `~/.pi/agent/council-settings.json` (or project-scoped when trusted). Includes the three council members, the synthesis model, and the opinion model.
- **Secure** — Settings are gitignored; keys never logged.

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

The UI uses a **typeahead-searchable, scrollable picker** (same UX as `/model`), so you can filter through hundreds of OpenRouter models by typing a few characters — fuzzy-matched across model name and id. Up/Down to navigate, Enter to select, Esc to cancel.

The UI walks you through:

1. **Council Model 1 of 3** — first dissenting voice
2. **Council Model 2 of 3** — second dissenting voice (already-picked models are filtered out)
3. **Council Model 3 of 3** — third dissenting voice
4. **Synthesis Model** — reads all three opinions and writes the final plan. Defaults to "Council Model 1" since you already trust it; pick any OpenRouter model you like.
5. **Second Opinion Model** — the model used by `/opinion` for quick checks
6. **Structured Output** — JSON schema for faster parsing (recommended: yes)

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
# Three deliberating models + one synthesis model
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
├── openrouterClient.ts     # OpenRouter REST client
├── qdrantClient.ts         # Qdrant persistence (optional)
├── prompts.ts              # Proposal + synthesis prompts
├── structuredOutput.ts     # JSON schemas + repair
├── markdown.ts             # Decision report formatter
├── persistence.ts          # Qdrant persistence layer
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