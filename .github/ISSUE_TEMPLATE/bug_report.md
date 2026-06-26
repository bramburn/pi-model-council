---
name: Bug report
about: Something is broken or behaves unexpectedly
title: "[bug] "
labels: ["bug"]
assignees: []
---

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Steps to reproduce the behaviour:

1. Run `/council ...` or `/opinion ...` with '...'
2. Click on '...'
3. Scroll down to '...'
4. See error

**Exact command(s) you ran:**

```bash
/council fix "..."
```

## Expected behaviour

A clear and concise description of what you expected to happen.

## Actual behaviour

What actually happened. Include the full error message and stack trace if
there is one.

## Environment

- **Pi version:** (run `pi --version`)
- **Extension version:** (check `package.json` or `pi -e ./path --version`)
- **Node version:** (run `node --version`)
- **OS:** (e.g. macOS 14.4, Ubuntu 24.04, Windows 11)
- **OpenRouter key configured?** (yes / no / via `OPENROUTER_API_KEY` / via `/login openrouter`)
- **Council models configured?** (paste the output of `/council-settings list`)

## Logs

If applicable, attach any relevant output from the Pi session. Be careful to
redact your OpenRouter API key — the format is `sk-or-v1-...`.

## Additional context

Add any other context about the problem here (screenshots, related issues, etc.).