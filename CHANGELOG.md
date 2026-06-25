# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
