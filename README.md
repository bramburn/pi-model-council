# model-council

Pi extension for multi-model coding decisions via OpenRouter.

## Features

- **Multi-model council**: Ask three OpenRouter models for a second opinion on fixes, technical questions, and architecture decisions
- **Single-model opinions**: Get a quick second opinion from any available model
- **Configurable**: Use `/council-settings` and `/opinion-settings` to configure your preferred models
- **Persistent**: Settings are stored in `~/.pi/agent/council-settings.json`
- **Secure**: API keys are stored locally, never committed to git

## Setup

```bash
# Install via pi (when published)
pi install git:github.com/bramburn/pi-model-council

# Or for local development
pi install ./pi-model-council
```

### First-Time Configuration

After installing, run:

```bash
# Configure the full council (OpenRouter API key + 3 models)
/council-settings

# Configure the second opinion model
/opinion-settings
```

## Commands

### `/council`

Ask the model council for a second opinion on a coding decision.

```bash
/council fix "The login fails on mobile devices"
/council ask "Should we use hooks or context for state?"
/council architecture "Where should auth state live?"
```

### `/opinion`

Get a quick single-model second opinion.

```bash
/opinion "How should I refactor this function?"
/opinion fix "The lesson progress resets after navigation"
```

### `/council-settings`

Configure the OpenRouter API key and council models.

```bash
/council-settings          # Open the settings UI
/council-settings list     # Show current settings (API key redacted)
/council-settings reset    # Reset all council settings
```

### `/opinion-settings`

Configure the model used for `/opinion`.

```bash
/opinion-settings          # Open the settings UI
/opinion-settings list     # Show current model
/opinion-settings reset   # Reset to default
```

## Models

### Council (Full Multi-Model Deliberation)

The council uses 3 OpenRouter models that you configure via `/council-settings`. Recommended models:

- `qwen/qwen3.7-max`
- `z-ai/glm-5.2`
- `deepseek/deepseek-v4-pro`

A fourth model synthesizes the final decision.

### Second Opinion

Any model available in pi with a valid API key can be used for `/opinion`.

## Architecture

```
pi-model-council/
├── index.ts              # Extension entry point
├── councilRunner.ts      # Full council logic
├── secondOpinionRunner.ts # Single opinion logic
├── settings.ts           # Settings persistence
├── settings-ui.ts        # Settings TUI components
├── openrouterClient.ts   # OpenRouter API client
├── qdrantClient.ts       # Qdrant persistence (optional)
└── ...
```

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

# Audit dependencies
npm run audit
```

## Security

See [SECURITY.md](SECURITY.md) for the security policy and reporting vulnerabilities.

### API Key Storage

API keys are stored in `~/.pi/agent/council-settings.json` (or project-level `.pi/council-settings.json` if the project is trusted). This file is gitignored and should never be committed.

## License

MIT
