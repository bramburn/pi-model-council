# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it via:

1. **GitHub Security Advisories** (preferred):
   https://github.com/bramburn/pi-model-council/security/advisories/new

2. **Email**: (TBD - report via GitHub for now)

Please do NOT report security issues via public GitHub issues.

For critical vulnerabilities, we aim to respond within **48 hours** and publish a fix within **7 days**.

## Security Best Practices (for users)

### Protecting Your API Key

- **Never commit your `council-settings.json` to git** — it contains your OpenRouter API key
- The file is already in `.gitignore`, but verify it's not being tracked
- Run `git status` to check before any commit

### Verifying the Extension

Before installing or updating:

1. Review the source code in this repository
2. Check the commit history for any suspicious changes
3. Report concerns via GitHub Security Advisories

### Keeping Dependencies Updated

The extension uses minimal dependencies. Keep them updated:

```bash
npm run audit
npm update
```

Or use the automatic Dependabot PRs that are created weekly.

## Extension Security Notes

### What This Extension Can Do

This extension runs with the same permissions as pi itself:
- Read and write files in your project
- Execute shell commands
- Call LLM APIs with your API keys

### Trust Decision

When you first use this extension in a project, pi will ask if you trust the project. Only trust projects where:
- The `.pi/extensions/` directory is controlled by you
- No untrusted code can modify the extension files
- You're comfortable with the extension having full file system access

## Incident Response

If you believe your API key has been compromised:

1. **Revoke the key immediately** at https://openrouter.ai/keys
2. **Generate a new key** at https://openrouter.ai/keys
3. **Update your settings** via `/council-settings`
4. **Report the incident** via GitHub Security Advisories

## Security Dependencies

This extension is kept intentionally simple with minimal dependencies to reduce attack surface:

- `@sinclair/typebox` — JSON schema validation only
- No network calls except to OpenRouter API
- No shell command execution beyond what pi itself allows
