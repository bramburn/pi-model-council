import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelOpinion, SecondOpinionInput } from "./types.js";
import { OpinionSetupError } from "./types.js";
import { buildSecondOpinionPrompt } from "./prompts.js";
import { modelOpinionJsonSchema } from "./structuredOutput.js";
import { retry, isStructuredOutputError } from "./retry.js";
import { loadSettings } from "./settings.js";
import {
  callModelWithTimeout,
  callModelDispatchWithTimeout,
  parseModelOpinionResponse,
  resolveOpenRouterApiKey,
} from "./runnerHelpers.js";
import { OPENROUTER_PROVIDER, resolveModel } from "./providerDispatch.js";

export async function runSecondOpinion(args: {
  input: SecondOpinionInput;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  cwd?: string;
  isProjectTrusted?: boolean;
  /** Optional pi extension context — when supplied we use it to resolve
   *  per-provider auth from pi's auth storage and to dispatch non-OpenRouter
   *  models via the pi-ai inference layer. */
  modelRegistry?: ModelRegistry;
}): Promise<{
  opinion: ModelOpinion;
  rawText: string;
  markdown: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const isProjectTrusted = args.isProjectTrusted ?? false;

  // ── Load settings ────────────────────────────────────────────────────────
  const settings = await loadSettings(cwd, isProjectTrusted);

  if (!settings) {
    throw new OpinionSetupError(
      "Second opinion model is not configured.\n\n" +
        "Fix: run `/opinion-settings` (or `/council-settings`, which also\n" +
        "configures the opinion model).",
    );
  }

  // ── Validate input ───────────────────────────────────────────────────────
  if (!args.input.problem || args.input.problem.trim().length === 0) {
    throw new Error("Problem is required and must be non-empty");
  }

  // ── Build the dispatch model id from the saved opinion.provider + opinion.modelId ──────
  // Settings stored as `provider: "openai", modelId: "gpt-4o"` need to be
  // composed into `"openai/gpt-4o"` for providerDispatch. For OpenRouter,
  // the bare form (`gpt-4o`) or `openrouter/<id>` both work. We then ask
  // resolveModel for the canonical provider so the runner picks the right
  // dispatch path.
  const opinionProvider = settings.opinion.provider;
  const opinionModelId = settings.opinion.modelId;
  const dispatchId =
    opinionProvider === OPENROUTER_PROVIDER
      ? opinionModelId
      : `${opinionProvider}/${opinionModelId}`;
  const isOpenRouterOpinion =
    resolveModel(dispatchId, args.modelRegistry).provider === OPENROUTER_PROVIDER;

  args.onStatus?.(`Second opinion: querying ${dispatchId}...`);

  // ── Build prompt ────────────────────────────────────────────────────────
  const { systemPrompt, userPrompt } = buildSecondOpinionPrompt(args.input);

  const useStructuredOutput = settings.options.useStructuredOutput;
  const modelTimeoutMs = settings.options.modelTimeoutMs;
  const retryAttempts = settings.options.retryAttempts;
  const retryDelayMs = settings.options.retryDelayMs;

  // Only OpenRouter supports API-level json_schema structured output.
  // For other providers we always use plain text + the validate/repair
  // pipeline below to recover JSON.
  const useStructuredOutputForThisModel = useStructuredOutput && isOpenRouterOpinion;

  // ── Resolve the OpenRouter API key (only needed for OpenRouter picks) ─────
  // Pi-auth-only users (no key in settings) still need to talk to
  // OpenRouter for OpenRouter opinion picks. We resolve via
  // settings → registry → env at call-time. For direct providers the
  // dispatch layer handles per-provider auth via the modelRegistry
  // (no OpenRouter key required).
  let resolvedApiKey: string | undefined;
  if (isOpenRouterOpinion) {
    args.onStatus?.("Second opinion: resolving OpenRouter API key...");
    resolvedApiKey = await resolveOpenRouterApiKey(settings, args.modelRegistry);
    if (!resolvedApiKey) {
      throw new OpinionSetupError(
        "Second opinion cannot run: no OpenRouter API key found.\n\n" +
          "Fix: set OPENROUTER_API_KEY, run `/login openrouter` in pi, or save a\n" +
          "key via `/council-settings`.",
      );
    }
  }

  // ── Call model (with structured output + retry, matching /council) ──────
  let attemptWithStructuredOutput = useStructuredOutputForThisModel;
  let rawText: string;
  const warnings: string[] = [];

  /** Call the configured model via the right provider, with timeout.
   *  Routes OpenRouter → callModelWithTimeout (structured output capable),
   *  direct providers → callModelDispatchWithTimeout (plain text). */
  const callOnce = (): Promise<string> => {
    if (isOpenRouterOpinion) {
      // For OpenRouter we use the bare callModelWithTimeout path which
      // supports API-level json_schema. Auth is the resolved OpenRouter
      // key (settings → registry → env).
      return callModelWithTimeout({
        apiKey: resolvedApiKey ?? "",
        model: dispatchId,
        systemPrompt,
        userPrompt,
        signal: args.signal,
        timeoutMs: modelTimeoutMs,
        structuredOutputSchema: attemptWithStructuredOutput ? modelOpinionJsonSchema : undefined,
        structuredOutputName: "model_opinion",
      });
    }
    return callModelDispatchWithTimeout({
      rawId: dispatchId,
      systemPrompt,
      userPrompt,
      signal: args.signal,
      timeoutMs: modelTimeoutMs,
      ...(args.modelRegistry !== undefined ? { modelRegistry: args.modelRegistry } : {}),
    });
  };

  try {
    rawText = await callOnce();
  } catch (firstError) {
    if (attemptWithStructuredOutput && isStructuredOutputError(firstError)) {
      warnings.push(
        `Model ${dispatchId} doesn't support structured JSON output - the response was parsed from free-form text (may have errors).`,
      );
      attemptWithStructuredOutput = false;
      const retryResult = await retry({
        attempts: retryAttempts,
        delayMs: retryDelayMs,
        operation: callOnce,
      });
      rawText = retryResult.value;
    } else {
      throw firstError;
    }
  }

  args.onStatus?.("Second opinion: parsing response...");

  // ── Parse + repair (shared with /council) ────────────────────────────────
  const parsed = parseModelOpinionResponse(rawText);
  warnings.push(...parsed.warnings);

  args.onStatus?.("Second opinion: rendering markdown...");

  const markdown = renderSecondOpinionMarkdown(parsed.opinion, args.input, warnings);

  args.onStatus?.("Second opinion: complete");

  // Preserve the legacy return shape (rawText exposed for callers).
  return { opinion: parsed.opinion, rawText, markdown };
}

function renderSecondOpinionMarkdown(
  opinion: ModelOpinion,
  input: SecondOpinionInput,
  warnings: string[],
): string {
  const lines: string[] = [];

  lines.push("# Second Opinion");
  lines.push("");
  lines.push(`Generated by: ${input.mode ?? "general"} model (model-council)`);
  lines.push("");

  if (warnings.length > 0) {
    for (const warning of warnings) {
      lines.push(`> **Note:** ${warning}`);
    }
    lines.push("");
  }

  lines.push(`**Problem:** ${input.problem}`);
  if (input.currentUnderstanding) {
    lines.push(`**Your Understanding:** ${input.currentUnderstanding}`);
  }
  lines.push(`**Confidence:** ${opinion.confidence}`);
  lines.push("");

  if (opinion.stance) {
    lines.push("## Stance");
    lines.push(opinion.stance);
    lines.push("");
  }

  lines.push("## Recommended Approach");
  lines.push(opinion.recommendedApproach);
  lines.push("");

  if (opinion.steps.length > 0) {
    lines.push("## Steps");
    for (let i = 0; i < opinion.steps.length; i++) {
      lines.push(`${i + 1}. ${opinion.steps[i]}`);
    }
    lines.push("");
  }

  if (opinion.filesToConsider.length > 0) {
    lines.push("## Files to Consider");
    for (const file of opinion.filesToConsider) {
      lines.push(`- \`${file.path}\`: ${file.suggestedAction} — ${file.reason}`);
    }
    lines.push("");
  }

  if (opinion.risks.length > 0) {
    lines.push("## Key Risks");
    for (const risk of opinion.risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  if (opinion.verification.length > 0) {
    lines.push("## Verification");
    for (const verification of opinion.verification) {
      lines.push(`- ${verification}`);
    }
    lines.push("");
  }

  lines.push("***");
  lines.push("");
  lines.push("This is a single-model second opinion. For multi-perspective analysis, use /council.");

  return lines.join("\n");
}