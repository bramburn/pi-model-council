import type {
  CouncilDecision,
  CouncilInput,
  CouncilModelResult,
  ModelOpinion,
} from "./types.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  buildProposalPrompts,
  buildSynthesisPrompts,
} from "./prompts.js";
import {
  callOpenRouterChat,
  extractJsonObject,
  pingOpenRouter,
  fetchOpenRouterModels,
} from "./openrouterClient.js";
import { callModelViaDispatch, OPENROUTER_PROVIDER, resolveModel } from "./providerDispatch.js";
import {
  modelOpinionJsonSchema,
  councilDecisionJsonSchema,
  repairModelOpinion,
  repairCouncilDecision,
  validateCouncilDecision,
} from "./structuredOutput.js";
import { withTimeout, retry, isStructuredOutputError } from "./retry.js";
import { renderCouncilDecisionMarkdown } from "./markdown.js";
import { loadSettings } from "./settings.js";
import { CouncilSetupError } from "./types.js";
import { resolveOpenRouterApiKey } from "./runnerHelpers.js";

export function createFallbackDecision(input: CouncilInput, results: CouncilModelResult[]): CouncilDecision {
  const successfulResults = results.filter(r => r.ok && r.parsed);

  const decisionId = `council-${Date.now()}`;
  const confidence: "low" | "medium" | "high" =
    successfulResults.length >= 2 ? "medium" : "low";

  const firstSuccessful = successfulResults[0]?.parsed as ModelOpinion | undefined;

  const agreements: string[] = [];
  if (successfulResults.length > 0) {
    agreements.push("At least one model provided an implementation-oriented recommendation.");
  }

  const disagreements: string[] = [];
  const errors = results.filter(r => !r.ok).map(r => r.error).filter(Boolean);
  if (errors.length > 0) {
    disagreements.push("Some models failed, so disagreements were not fully resolved.");
  }

  const unknowns: string[] = [];
  for (const error of errors) {
    unknowns.push(`API error: ${error}`);
  }

  const recommendedPlanSummary = firstSuccessful?.recommendedApproach
    ?? "Review the raw model outputs before implementation.";

  const recommendedPlanSteps = firstSuccessful?.steps?.length
    ? [...firstSuccessful.steps]
    : [
        "Review the problem and relevant files.",
        "Choose the smallest safe change.",
        "Implement the change.",
        "Run verification checks.",
      ];

  const filesToEditMap = new Map<string, { path: string; reason: string; action: string }>();
  for (const result of successfulResults) {
    const parsed = result.parsed as ModelOpinion;
    for (const file of parsed.filesToConsider ?? []) {
      if (!filesToEditMap.has(file.path)) {
        filesToEditMap.set(file.path, {
          path: file.path,
          reason: file.reason,
          action: file.suggestedAction,
        });
      }
    }
  }

  const testsToRunSet = new Set<string>();
  for (const result of successfulResults) {
    const parsed = result.parsed as ModelOpinion;
    for (const verification of parsed.verification ?? []) {
      testsToRunSet.add(verification);
    }
  }

  const modelNotes = results.map(result => ({
    model: result.model,
    stance: result.ok && result.parsed
      ? (result.parsed as ModelOpinion).stance
      : result.ok && result.rawText
        ? "Unstructured response"
        : "Failed to respond",
    keyRisks: result.ok && result.parsed
      ? (result.parsed as ModelOpinion).risks ?? []
      : result.error ? [result.error] : [],
  }));

  return {
    decisionId,
    mode: input.mode,
    confidence,
    consensus: { agreements, disagreements, unknowns },
    recommendedPlan: { summary: recommendedPlanSummary, steps: recommendedPlanSteps },
    implementationGuidance: {
      filesToEdit: Array.from(filesToEditMap.values()),
      testsToRun: Array.from(testsToRunSet),
      guardrails: [
        "Do not broaden scope beyond the supplied problem.",
        "Prefer minimal, reversible changes.",
        "Run the listed verification commands before reporting success.",
      ],
    },
    modelNotes,
    handoffPrompt: `Review the council's model opinions. The recommended approach is: ${recommendedPlanSummary}. Choose the smallest safe change that addresses the problem. Verify the fix works before reporting success.`,
    metadata: {
      degraded: true,
      fallbackUsed: true,
      warnings: ["Used TypeScript fallback decision due to synthesis failure."],
    },
  };
}

export async function runCouncil(args: {
  input: CouncilInput;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  cwd?: string;
  isProjectTrusted?: boolean;
  /** Optional pi extension context — when supplied we use it to (a) discover
   *  the OpenRouter API key from pi's auth storage if the settings file
   *  doesn't carry one and (b) validate the chosen model IDs against the
   *  live pi model registry. */
  modelRegistry?: ModelRegistry;
}): Promise<{
  decision: CouncilDecision;
  rawModelResults: CouncilModelResult[];
  markdown: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const isProjectTrusted = args.isProjectTrusted ?? false;

  // ── Load settings ────────────────────────────────────────────────────────
  const settings = await loadSettings(cwd, isProjectTrusted);

  if (!settings) {
    throw new CouncilSetupError(
      "Model Council is not configured.\n\n" +
      "Run /council-settings to:\n" +
      "  1. Enter your OpenRouter API key (or set OPENROUTER_API_KEY so pi\n" +
      "     picks it up automatically)\n" +
      "  2. Select your 3 council models\n" +
      "  3. Optionally pick a 4th synthesis model\n" +
      "  4. Save settings\n\n" +
      "Get your API key at: https://openrouter.ai/keys",
    );
  }

  const councilModels = settings.openRouter.councilModels ?? [];
  if (councilModels.length === 0) {
    throw new CouncilSetupError(
      "No council models configured.\n\n" +
      "Run /council-settings to select at least one model for the council.",
    );
  }
  // Use || instead of ?? so an empty-string synthesis override (which can
  // happen via a hand-edited settings file) falls back to the first
  // council model rather than producing model: '' downstream.
  const synthesisModelId = settings.synthesis?.modelId || councilModels[0];

  // ── Detect whether the council needs an OpenRouter key at all ────────────
  // If every model is a direct provider (anthropic, openai, etc.) we don't
  // need an OpenRouter key — the dispatcher resolves per-provider auth via
  // pi's registry. This is what enables /council to work for pi-auth-only
  // users who never set up OpenRouter.
  const allResolved = [synthesisModelId, ...councilModels].map((m) =>
    resolveModel(m, args.modelRegistry),
  );
  const needsOpenRouter = allResolved.some(
    (r) => r.provider === OPENROUTER_PROVIDER,
  );

  // ── Pre-flight: resolve API key (settings → registry → env) ─────────────
  let resolvedApiKey: string | undefined;
  if (needsOpenRouter) {
    args.onStatus?.("Council: resolving OpenRouter API key...");
    resolvedApiKey = await resolveOpenRouterApiKey(settings, args.modelRegistry);

    if (!resolvedApiKey) {
      throw new CouncilSetupError(
        "Council cannot run: no OpenRouter API key found.\n\n" +
        "Fix: set OPENROUTER_API_KEY, run `/login openrouter` in pi, or save a\n" +
        "key via `/council-settings`.",
      );
    }

    // ── Pre-flight: validate API key ──────────────────────────────────────
    args.onStatus?.("Council: validating API key...");
    const ping = await pingOpenRouter(resolvedApiKey);
    if (!ping.ok) {
      throw new CouncilSetupError(
        `Council cannot run: OpenRouter API key is invalid.\n` +
      `${ping.error}\n\n` +
      `Fix: run \`/council-settings\` to update your API key.`,
    );
  }
  } // end if (needsOpenRouter)

  // ── Pre-flight: validate models (registry first, REST fallback) ─────────
  args.onStatus?.("Council: verifying configured models are available...");
  // Build a set of "provider/modelId" strings the runner can match against.
  // Includes both OpenRouter REST ids (bare form like `qwen/qwen3.7-max`)
  // and direct provider ids (`anthropic/claude-3.5-sonnet`).
  const availableModels = new Set<string>();
  if (args.modelRegistry) {
    try {
      const reg = args.modelRegistry.getAvailable();
      for (const m of reg) {
        availableModels.add(`${m.provider}/${m.id}`);
        // OpenRouter models from the registry may also be reachable via
        // their bare-id form on the REST API.
        if (m.provider === OPENROUTER_PROVIDER) {
          availableModels.add(m.id);
        }
      }
    } catch {
      // fall through to REST fetch
    }
  }

  // For OpenRouter bare-id models, also fetch the live catalog so we
  // catch models that pi doesn't ship with but OpenRouter does expose.
  // Skip this entirely if there's no OpenRouter key configured (pure
  // direct-provider council).
  if (resolvedApiKey) {
    const orOnlyIds = [...availableModels]
      .filter((k) => k.startsWith(`${OPENROUTER_PROVIDER}/`))
      .map((k) => k.slice(OPENROUTER_PROVIDER.length + 1));
    if (orOnlyIds.length === 0) {
      try {
        const models = await fetchOpenRouterModels(resolvedApiKey);
        for (const m of models) {
          availableModels.add(`${OPENROUTER_PROVIDER}/${m.id}`);
          availableModels.add(m.id);
        }
      } catch {
        // If we can't fetch models, try to continue anyway
      }
    }
  }

  // Dedupe configuredModels before validating — synthesis defaults to
  // councilModels[0] so the same id often appears twice.
  const configuredModels = [...new Set([...councilModels, synthesisModelId])];
  const missingModels = configuredModels.filter(m => {
    if (availableModels.size === 0) return false; // degraded: skip check
    // Match either bare form or provider/id form
    return !availableModels.has(m) && !availableModels.has(`${OPENROUTER_PROVIDER}/${m}`);
  });

  if (missingModels.length > 0) {
    throw new CouncilSetupError(
      `Some configured models are not currently available:\n` +
      `${missingModels.map(m => `  - ${m}`).join("\n")}\n\n` +
      `Fix: run \`/council-settings\` to pick replacements.`,
    );
  }

  // ── Normalize input ─────────────────────────────────────────────────────
  const input: CouncilInput = {
    mode: args.input.mode,
    problem: args.input.problem.trim(),
    currentUnderstanding: args.input.currentUnderstanding?.trim(),
    relevantFiles: args.input.relevantFiles ?? [],
    constraints: args.input.constraints ?? [],
    questionsToCouncil: args.input.questionsToCouncil ?? [],
  };

  if (!input.problem || input.problem.length === 0) {
    throw new Error("Problem is required and must be non-empty");
  }

  if (!["fix", "ask", "architecture"].includes(input.mode)) {
    throw new Error(`Invalid mode: ${input.mode}. Must be one of: fix, ask, architecture`);
  }

  // ── Config from settings ─────────────────────────────────────────────────
  const MODEL_TIMEOUT_MS = settings.options.modelTimeoutMs;
  const SYNTHESIS_TIMEOUT_MS = settings.options.synthesisTimeoutMs;
  const MODEL_RETRY_ATTEMPTS = settings.options.retryAttempts;
  const MODEL_RETRY_DELAY_MS = settings.options.retryDelayMs;
  const USE_STRUCTURED_OUTPUT = settings.options.useStructuredOutput;

  const COUNCIL_MODELS = councilModels;
  // Use the dedicated synthesis model when set, otherwise fall back to model1
  const SYNTHESIZER_MODEL = synthesisModelId;

  // ── Call models ──────────────────────────────────────────────────────────
  const { systemPrompt: proposalSystem, userPrompt: proposalUser } = buildProposalPrompts(input);

  // Track per-model progress so the footer shows e.g.
  //   "Council: 2/3 models responded (waiting on anthropic/claude-3.5-sonnet)"
  const responded = new Set<string>();
  const announceProgress = (): void => {
    const pending = COUNCIL_MODELS.filter((m) => !responded.has(m));
    args.onStatus?.(
      `Council: ${responded.size}/${COUNCIL_MODELS.length} models responded` +
        (pending.length > 0 ? ` (waiting on ${pending.join(", ")})` : ""),
    );
  };
  announceProgress();

  const modelPromises = COUNCIL_MODELS.map(async (model): Promise<CouncilModelResult> => {
    const started = Date.now();
    let usedStructuredOutput = false;
    let totalAttempts = 0;
    const allWarnings: string[] = [];

    let attemptWithStructuredOutput = USE_STRUCTURED_OUTPUT;

    const callModel = async (attempt: number): Promise<string> => {
      totalAttempts = attempt;

      // Determine which provider this model belongs to.
      // - OpenRouter: callOpenRouterChat supports structured output (json_schema)
      //   so we use that path directly to keep the API-level schema enforcement.
      // - All other providers: dispatch via providerDispatch → pi-ai/compat.
      //   pi-ai's simple stream doesn't expose OpenRouter-style json_schema,
      //   so we rely on the validate/repair pipeline to recover JSON.
      const resolved = resolveModel(model, args.modelRegistry);
      const isOpenRouter = resolved.provider === OPENROUTER_PROVIDER;

      // Only OpenRouter supports structured output via the API. For other
      // providers we always request plain text.
      const useStructuredOutput = attemptWithStructuredOutput && isOpenRouter;

      return withTimeout(
        async (childSignal) => {
          if (isOpenRouter) {
            return callOpenRouterChat({
              apiKey: resolvedApiKey ?? "",
              model,
              systemPrompt: proposalSystem,
              userPrompt: proposalUser,
              signal: childSignal,
              structuredOutputSchema: useStructuredOutput ? modelOpinionJsonSchema : undefined,
              structuredOutputName: "model_opinion",
            });
          }
          // Direct providers — go through pi-ai/compat's completeSimple.
          return callModelViaDispatch({
            rawId: model,
            systemPrompt: proposalSystem,
            userPrompt: proposalUser,
            ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {}),
            ...(args.modelRegistry !== undefined ? { modelRegistry: args.modelRegistry } : {}),
            signal: childSignal,
          });
        },
        MODEL_TIMEOUT_MS,
        args.signal,
      );
    };

    try {
      let rawText: string;

      // Wrap the initial call in retry() so transient errors (network
      // blips, 429 rate limits, brief API downtime) get the configured
      // retryAttempts before failing the model. Previously only the
      // structured-output fallback path was wrapped, leaving the first
      // attempt vulnerable to a single transient error failing the
      // model entirely.
      try {
        const retryResult = await retry({
          attempts: MODEL_RETRY_ATTEMPTS,
          delayMs: MODEL_RETRY_DELAY_MS,
          operation: callModel,
        });
        rawText = retryResult.value;
        usedStructuredOutput = attemptWithStructuredOutput;
      } catch (firstError) {
        // After exhausting retries on the structured-output path, check
        // if the failure was a structured-output-specific error. If so,
        // fall back to unstructured mode and retry once more.
        if (attemptWithStructuredOutput && isStructuredOutputError(firstError)) {
          allWarnings.push(`Model ${model} does not support structured output, using fallback mode.`);
          attemptWithStructuredOutput = false;
          const fallbackResult = await retry({
            attempts: MODEL_RETRY_ATTEMPTS,
            delayMs: MODEL_RETRY_DELAY_MS,
            operation: callModel,
          });
          rawText = fallbackResult.value;
          usedStructuredOutput = false;
        } else {
          throw firstError;
        }
      }

      try {
        const parsedRaw = extractJsonObject(rawText);
        const repaired = repairModelOpinion(parsedRaw, rawText);
        allWarnings.push(...repaired.warnings);

        return {
          model,
          ok: true,
          rawText,
          parsed: repaired.value,
          metadata: {
            attemptCount: totalAttempts,
            durationMs: Date.now() - started,
            usedStructuredOutput,
            parseStatus: (repaired.parseStatus === "valid" ? "ok" : repaired.parseStatus) as "ok" | "repaired" | "fallback" | "failed",
            warnings: repaired.warnings,
          },
        };
      } catch {
        return {
          model,
          ok: true,
          rawText,
          parsed: {
            stance: "Unstructured response",
            recommendedApproach: rawText.substring(0, 200),
            steps: [],
            filesToConsider: [],
            risks: [],
            verification: [],
            confidence: "medium" as const,
          },
          metadata: {
            attemptCount: totalAttempts,
            durationMs: Date.now() - started,
            usedStructuredOutput,
            parseStatus: "fallback" as const,
            warnings: ["Failed to parse model opinion, using raw text fallback."],
          },
        };
      }
    } catch (apiError) {
      return {
        model,
        ok: false,
        error: apiError instanceof Error ? apiError.message : String(apiError),
        metadata: {
          attemptCount: totalAttempts,
          durationMs: Date.now() - started,
          usedStructuredOutput,
          parseStatus: "failed" as const,
          warnings: allWarnings,
        },
      };
    } finally {
      // Track that this model is done (success or failure) so the footer
      // status reflects aggregate progress.
      responded.add(model);
      announceProgress();
    }
  });

  const modelResults = await Promise.all(modelPromises);

  const allFailed = modelResults.every(r => !r.ok);
  if (allFailed) {
    throw new Error(
      `All ${COUNCIL_MODELS.length} council models failed to respond. ` +
      "Check your API key and network connection.",
    );
  }

  // ── Synthesize ──────────────────────────────────────────────────────────
  args.onStatus?.("Council: synthesizing decision...");

  const { systemPrompt: synthesisSystem, userPrompt: synthesisUser, labelMap } = buildSynthesisPrompts(input, modelResults);

  let decision: CouncilDecision;
  const synthesisWarnings: string[] = [];

  try {
    const attemptSynthesis = async (): Promise<string> => {
      // Same dispatch logic as the council call: OpenRouter gets structured
      // output, other providers get plain text + validate/repair.
      const resolvedSynth = resolveModel(SYNTHESIZER_MODEL, args.modelRegistry);
      const isOpenRouterSynth = resolvedSynth.provider === OPENROUTER_PROVIDER;
      const useStructuredSynth = USE_STRUCTURED_OUTPUT && isOpenRouterSynth;

      return withTimeout(
        async (childSignal) => {
          if (isOpenRouterSynth) {
            return callOpenRouterChat({
              apiKey: resolvedApiKey ?? "",
              model: SYNTHESIZER_MODEL,
              systemPrompt: synthesisSystem,
              userPrompt: synthesisUser,
              signal: childSignal,
              structuredOutputSchema: useStructuredSynth ? councilDecisionJsonSchema : undefined,
              structuredOutputName: "council_decision",
            });
          }
          return callModelViaDispatch({
            rawId: SYNTHESIZER_MODEL,
            systemPrompt: synthesisSystem,
            userPrompt: synthesisUser,
            ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {}),
            ...(args.modelRegistry !== undefined ? { modelRegistry: args.modelRegistry } : {}),
            signal: childSignal,
          });
        },
        SYNTHESIS_TIMEOUT_MS,
        args.signal,
      );
    };

    let synthesisRaw: string;

    try {
      synthesisRaw = await attemptSynthesis();
    } catch (synthesisError) {
      if (USE_STRUCTURED_OUTPUT && isStructuredOutputError(synthesisError)) {
        synthesisWarnings.push("Synthesis does not support structured output, using fallback mode.");
        const retryResult = await retry({
          attempts: 2,
          delayMs: MODEL_RETRY_DELAY_MS,
          operation: attemptSynthesis,
        });
        synthesisRaw = retryResult.value;
      } else {
        throw synthesisError;
      }
    }

    try {
      const parsedRaw = extractJsonObject(synthesisRaw);
      const validation = validateCouncilDecision(parsedRaw);

      if (validation.ok) {
        decision = validation.value!;
      } else {
        const repaired = repairCouncilDecision(parsedRaw, input);
        decision = repaired.value;
        synthesisWarnings.push(...repaired.warnings);
      }
    } catch {
      const repaired = repairCouncilDecision(synthesisRaw, input);
      decision = repaired.value;
      synthesisWarnings.push(...repaired.warnings);
    }
  } catch {
    decision = createFallbackDecision(input, modelResults);
  }

  // ── Finalize metadata ───────────────────────────────────────────────────
  const anyModelFailed = modelResults.some(r => !r.ok);
  const anyModelRepaired = modelResults.some(
    r => r.metadata?.parseStatus === "repaired" || r.metadata?.parseStatus === "fallback",
  );
  const fallbackUsed = decision.metadata?.fallbackUsed ?? false;
  const degraded = anyModelFailed || anyModelRepaired || fallbackUsed;

  const allWarnings = [
    ...synthesisWarnings,
    ...(decision.metadata?.warnings ?? []),
  ];

  if (anyModelFailed) {
    const failedModels = modelResults.filter(r => !r.ok).map(r => r.model);
    allWarnings.push(`Models that failed: ${failedModels.join(", ")}`);
  }

  decision.metadata = { degraded, fallbackUsed, warnings: allWarnings };

  // ── Persist ─────────────────────────────────────────────────────────────
  // Translate blind labels back to model ids. The synthesis prompt uses
  // blind labels (Opinion A/B/C) to avoid model prestige bias. The
  // chairman's modelNotes and other fields may reference those labels;
  // now that we know which label mapped to which model, resolve them so
  // the downstream report shows real model names.
  if (labelMap && labelMap.length > 0) {
    const lookup = new Map(labelMap.map((entry) => [entry.label, entry.model]));
    for (const note of decision.modelNotes) {
      const resolved = lookup.get(note.model);
      if (resolved) note.model = resolved;
    }
  }

  args.onStatus?.("Council: complete");

  const finalMarkdown = renderCouncilDecisionMarkdown(decision);

  return { decision, rawModelResults: modelResults, markdown: finalMarkdown };
}
