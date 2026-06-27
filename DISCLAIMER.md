# Disclaimer

> **tl;dr** — This extension asks third-party AI models for coding advice. That advice can be wrong, it costs real money, and your prompts leave your machine. Read the full disclaimer below before using `/council` or `/opinion`.

## What this extension does

`pi-model-council` is a Pi extension that asks one or more AI models for a second opinion on coding decisions. It does not write code itself — it returns suggestions that you (or your primary Pi agent) review and apply.

## AI-generated advice is not guaranteed to be correct

The output of `/council` and `/opinion` is produced by large language models accessed through [OpenRouter](https://openrouter.ai). These models:

- **Can be confidently wrong.** Code suggestions may compile but be incorrect, insecure, outdated, or unfit for your use case.
- **Have knowledge cutoffs.** They may miss recent API changes, CVEs, or best practices.
- **Hallucinate.** They may invent function names, library APIs, or configuration flags that do not exist.

**Always review the suggestion before applying it.** Treat the output as one input among many — not as an instruction.

## You are responsible for what you apply

This extension does not gate, lint, or sanity-check model output. You are solely responsible for:

- Verifying that the suggested code or approach is correct for your project.
- Running your existing test suite, type checker, and linter after applying any change.
- Reviewing for security regressions, data loss, or breaking changes.
- Complying with the licenses of any third-party code the models may have reproduced.

## It costs real money

Every invocation calls the OpenRouter API, which charges per token. The full `/council` command makes **at least four** model calls (three council members plus one synthesis call), and may retry on failure. Pricing varies by model.

- Check your OpenRouter credit balance before running large deliberations.
- Use cheaper models for routine decisions; reserve expensive models for high-stakes questions.
- Revoke your API key immediately if you suspect it has been leaked (see [SECURITY.md](SECURITY.md)).

The authors of this extension receive **no portion** of your API spend.

## Your data leaves your machine

When you run `/council` or `/opinion`, the following data is sent to OpenRouter (and from there to the configured model providers):

- The prompt you typed.
- File contents that Pi attaches as context for the prompt.
- The system prompt used by this extension (which does **not** contain your API key).

**Do not include secrets, credentials, or production data in prompts.** Strip them from any attached files first. Review [OpenRouter's privacy policy](https://openrouter.ai/privacy) for how they handle your data.

## Third-party terms apply

Your use of OpenRouter and the underlying model providers is governed by their respective terms of service, acceptable-use policies, and pricing. This extension is a thin client over their APIs and does not endorse or guarantee the behaviour of any specific model.

## No warranty

This software is provided under the MIT License (see [LICENSE](LICENSE)), "as is", without warranty of any kind, express or implied. The authors are not liable for any claim, damages, or other liability arising from the use of this extension or the AI-generated content it returns.

## Not professional advice

Nothing produced by this extension constitutes legal, financial, medical, or other professional advice. For questions in those domains, consult a qualified professional.

---

If anything in this disclaimer is unclear, please open an issue or pull request to improve it.