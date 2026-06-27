# Contributing to `pi-model-council`

Thanks for your interest in improving `pi-model-council`! This document explains how to set up the project locally, the standards we expect from pull requests, and how the review process works.

## Code of Conduct

By participating in this project, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

## Reporting issues

Before opening an issue:

1. Search existing issues to avoid duplicates.
2. Try the latest version on `main` to see if the bug still reproduces.
3. Collect relevant details: Pi version, Node version, OS, model names, and a minimal reproduction.

Use the issue templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) when filing:

- **Bug report** — something is broken or behaves unexpectedly.
- **Feature request** — propose a new capability.

For security vulnerabilities, do **not** open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Development setup

### Prerequisites

- **Node.js 22+** (matches the CI runner; older versions may work but are untested)
- **npm 10+** (ships with Node 22)
- A Pi install for end-to-end smoke testing (`pi install ./pi-model-council`)

### Clone and install

```bash
git clone https://github.com/bramburn/pi-model-council.git
cd pi-model-council
npm install
```

### Available scripts

| Script | Purpose |
|---|---|
| `npm run typecheck` | Run `tsc --noEmit`; must pass before review. |
| `npm run lint` | Run ESLint with zero warnings allowed. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Vitest in watch mode for local development. |
| `npm run test:coverage` | Vitest with V8 coverage report. |
| `npm run audit` | `npm audit --audit-level=high` for dependency vulnerabilities. |

All four of `typecheck`, `lint`, `test`, and `audit` run in CI on every push and pull request. PRs that fail any of them will not be merged.

## Making changes

### Branch and commit

1. Create a topic branch off `main`:
   ```bash
   git checkout -b feat/short-description
   # or
   git checkout -b fix/short-description
   ```
2. Keep commits focused. One logical change per commit is ideal.
3. Use the [Conventional Commits](https://www.conventionalcommits.org/) format for commit messages:
   ```
   feat: add per-model timeout override
   fix: redact API key in /council-settings list output
   docs: clarify DISCLAIMER.md cost section
   chore: bump @sinclair/typebox to 0.34.1
   ```

### Code style

- TypeScript strict mode is enforced — no `any` unless you add a comment explaining why.
- Prefer named exports; avoid default exports except for the Pi extension entry point (`index.ts`).
- Keep functions small and focused. If a function grows past ~80 lines, consider splitting it.
- Do not add new runtime dependencies without discussion in the issue first.
- Use the existing `schemas.ts` (TypeBox) for any new tool parameter validation.
- Keep the dependency footprint minimal — see [SECURITY.md](SECURITY.md#security-dependencies).

### Tests

- New behaviour **must** include tests. The Vitest suite lives in `__tests__/`.
- For new settings logic, follow the pattern in `__tests__/settings.test.ts`.
- For new UI flows, follow `__tests__/settings-ui.test.ts` (mock the UI surface).
- For new tools/commands or wiring changes, add a case to `__tests__/smoke.test.ts`.
- Aim to keep coverage roughly flat or higher; large drops will be flagged in review.

### Documentation

- If you change a user-facing command or flag, update `README.md` in the same PR.
- If you add a new env-var or setting, update `.env.example` and `README.md`.
- If you change the security posture, update `SECURITY.md`.
- If your change touches AI-generated content or external APIs, update `DISCLAIMER.md`.

## Pull request process

1. Push your branch and open a PR against `main`.
2. Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
3. Ensure all CI checks pass (typecheck, lint, test, audit).
4. Address review feedback by pushing additional commits — do not force-push during review.
5. Once approved, a maintainer will squash-merge your PR.

### PR title format

Use the same Conventional Commits prefix as your commits:

```
feat: add model discovery fallback to /council-settings
fix: handle missing opinion provider gracefully
docs: clarify README setup steps
```

The PR title becomes the squash commit message, which feeds into the changelog.

## Release process

Releases are cut from `main` by the maintainer. Each release:

1. Bumps the version in `package.json` (semver).
2. Adds a dated section to `CHANGELOG.md` summarising user-facing changes.
3. Tags the commit and publishes to npm.

You do not need to bump versions or edit `CHANGELOG.md` in your PR — that happens at release time.

## Questions?

Open a discussion or issue if anything in this guide is unclear. We would rather answer a question than have a contribution blocked by a missing detail.