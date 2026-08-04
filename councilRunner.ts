import type {
  CouncilDecision,
  CouncilInput,
  CouncilModelResult,
  CouncilSettings,
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

  // ── Pre-flight: resolve + validate OpenRouter API key (if needed) ──────
  // M1 fix: extracted into a small helper. The old in-place `if/throw`
  // block left a trailing `} // end if (needsOpenRouter)` that the
  // reader had to track across 30+ lines. Now the conditional is
  // contained in one place with a clear single-purpose return value.
  const resolvedApiKey = await resolveAndValidateOpenRouterKey(
    needsOpenRouter,
    settings,
    args.modelRegistry,
    args.onStatus,
  );

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

  // ── Pre-flight: validate models (registry first, REST fallback) ─────────
  args.onStatus?.("Council: verifying configured models are available...");

  // B3 fix: always validate configured models against the available
  // set, regardless of whether the council uses OpenRouter or direct
  // providers. Previously the missing-models check was implicitly
  // gated by `if (resolvedApiKey) { ... }` because the OpenRouter REST
  // catalog fetch was the only way to populate `availableModels` for
  // pure direct-provider councils. That meant a stale synthesis model
  // id (e.g. one that was renamed in the provider's catalog) would
  // only fail at synthesis time, not at startup.
  //
  // We now extract the check into a helper that:
  //   1. Builds an available set from the registry (no key needed).
  //   2. Optionally augments with the live OpenRouter catalog (only
  //      when an OpenRouter key is available — this is the only
  //      network call and it's free to skip for direct-only councils).
  //   3. Validates each configured model id against the set, accepting
  //      both bare (`qwen/qwen3.7-max`) and prefixed (`openrouter/qwen/...`)
  //      forms for OpenRouter, and bare-vs-prefixed for direct providers.
  const availability = await buildAvailableModelsSet(
    args.modelRegistry,
    resolvedApiKey,
  );

  const configuredModels = [...new Set([...councilModels, synthesisModelId])];
  const missingModels = configuredModels.filter((m) =>
    isModelMissing(m, availability),
  );

  if (missingModels.length > 0) {
    throw new CouncilSetupError(
      `Some configured models are not currently available:\n` +
      `${missingModels.map(m => `  - ${m}`).join("\n")}\n\n` +
      `Fix: run \`/council-settings\` to pick replacements.`,
    );
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
          // M7 fix: clarify the warning message. The previous wording
          // ("Model X does not support structured output, using
          // fallback mode") left users wondering what "fallback mode"
          // means. New wording: explain that JSON was parsed from
          // free-form text rather than generated as a schema-compliant
          // document. The user can now decide whether to swap the
          // model or accept the parse-and-repair output.
          allWarnings.push(
            `Model ${model} doesn't support structured JSON output — the response was parsed from free-form text (may have errors).`,
          );
          args.onStatus?.(`Council: ${model} fallback to plain-text parsing...`);
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
            // M7 fix: include allWarnings (which has the structured-
            // output fallback warning) PLUS the parser warnings.
            // Previously only the parser warnings were exposed here.
            warnings: [...allWarnings, ...repaired.warnings],
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
            // M7 fix: also include any prior warnings (e.g. structured-
            // output fallback that led to this parse-failure path).
            warnings: [...allWarnings, "Failed to parse model opinion, using raw text fallback."],
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
        // M7 fix: clearer warning for synthesis fallback too. Same
        // rationale as the council-call fallback: tell the user that
        // the output is parsed from free-form text.
        synthesisWarnings.push(
          `Synthesis model doesn't support structured JSON output — the response was parsed from free-form text (may have errors).`,
        );
        args.onStatus?.(`Council: synthesis fallback to plain-text parsing...`);
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

  // M7 fix: also surface per-model warnings (e.g. structured-output
  // fallback) into the final decision metadata. Previously they lived
  // only on each model result's metadata, which the user would have to
  // dig into to find. The council decision is the user-facing artifact
  // so the warnings belong here.
  const perModelWarnings = modelResults.flatMap(
    (r) => r.metadata?.warnings ?? [],
  );
  const allWarnings = [
    ...synthesisWarnings,
    ...perModelWarnings,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve + validate the OpenRouter API key when the council needs one.
 *
 * Returns `undefined` when `needsOpenRouter` is false (direct-provider
 * council; no OpenRouter key required). When the council DOES need
 * OpenRouter, this function:
 *   1. Resolves the key via `resolveOpenRouterApiKey` (settings → registry
 *      → env).
 *   2. Pings OpenRouter to verify the key works.
 *   3. Throws `CouncilSetupError` with a clear remediation message on
 *      either failure.
 *
 * Extracted from `runCouncil` to keep the bracket structure flat —
 * the old in-place `if/throw` block left a trailing `} // end if
 * (needsOpenRouter)` that the reader had to track across 30+ lines.
 */
async function resolveAndValidateOpenRouterKey(
  needsOpenRouter: boolean,
  settings: CouncilSettings,
  modelRegistry: ModelRegistry | undefined,
  onStatus: ((message: string) => void) | undefined,
): Promise<string | undefined> {
  if (!needsOpenRouter) return undefined;

  onStatus?.("Council: resolving OpenRouter API key...");
  const apiKey = await resolveOpenRouterApiKey(settings, modelRegistry);
  if (!apiKey) {
    throw new CouncilSetupError(
      "Council cannot run: no OpenRouter API key found.\n\n" +
        "Fix: set OPENROUTER_API_KEY, run `/login openrouter` in pi, or save a\n" +
        "key via `/council-settings`.",
    );
  }

  onStatus?.("Council: validating API key...");
  const ping = await pingOpenRouter(apiKey);
  if (!ping.ok) {
    throw new CouncilSetupError(
      `Council cannot run: OpenRouter API key is invalid.\n` +
        `${ping.error}\n\n` +
        `Fix: run \`/council-settings\` to update your API key.`,
    );
  }
  return apiKey;
}

/**
 * Available-model catalog used by the startup validation check.
 *
 * Two layers:
 *   - registry: every model pi knows about (no key required to query)
 *   - openrouterCatalog: the live OpenRouter REST catalog (key required;
 *     skipped for direct-provider-only councils)
 *
 * The set is normalised so both bare (`qwen/qwen3.7-max`) and prefixed
 * (`openrouter/qwen/qwen3.7-max`) forms match. For direct providers
 * the registry provides `anthropic/claude-3.5-sonnet`; we also accept
 * the bare `claude-3.5-sonnet` form so users who saved the bare id
 * (e.g. via a hand-edited settings file) still match.
 */
interface AvailableModels {
  /** All provider/id combos the runner can recognise. */
  readonly exact: ReadonlySet<string>;
  /** All bare model ids the runner can recognise (no provider prefix). */
  readonly bare: ReadonlySet<string>;
  /** True if we had at least one source of model data. */
  readonly hasData: boolean;
}

async function buildAvailableModelsSet(
  modelRegistry: ModelRegistry | undefined,
  openrouterApiKey: string | undefined,
): Promise<AvailableModels> {
  const exact = new Set<string>();
  const bare = new Set<string>();

  // Layer 1: pi's ModelRegistry (always available when supplied)
  if (modelRegistry) {
    try {
      const reg = modelRegistry.getAvailable();
      for (const m of reg) {
        exact.add(`${m.provider}/${m.id}`);
        bare.add(m.id);
      }
    } catch {
      // fall through; degraded mode below
    }
  }

  // Layer 2: live OpenRouter REST catalog. Only call when we actually
  // have an OpenRouter key — saves a network call for direct-only
  // councils and avoids a confusing 401 error.
  if (openrouterApiKey) {
    try {
      const models = await fetchOpenRouterModels(openrouterApiKey);
      for (const m of models) {
        exact.add(`${OPENROUTER_PROVIDER}/${m.id}`);
        bare.add(m.id);
      }
    } catch {
      // network failure: skip OpenRouter catalog; degraded mode below
    }
  }

  return {
    exact,
    bare,
    hasData: exact.size > 0 || bare.size > 0,
  };
}

/**
 * Decide whether a configured model id is missing from the available
 * catalog. Accepts both bare and prefixed forms.
 *
 * Returns `true` when the model is genuinely missing, `false` when it's
 * present OR when we have no catalog data (degraded mode — we can't
 * tell, so we let the call attempt proceed and fail at call-time).
 */
function isModelMissing(modelId: string, avail: AvailableModels): boolean {
  if (!avail.hasData) return false; // degraded: skip check

  // Try matching both the bare form and the prefixed form, without
  // any heuristic splitting. The bare set is populated with every
  // model id the registry / catalog reports (no provider prefix);
  // the exact set is populated with provider/id for every model.
  // So a model id of any of these forms will match:
  //   - bare:    "qwen/qwen3.7-max"        (matches `bare`)
  //   - bare:    "claude-3.5-sonnet"      (matches `bare` from registry)
  //   - prefixed: "openrouter/qwen/qwen3.7-max" (matches `exact`)
  //   - prefixed: "anthropic/claude-3.5-sonnet" (matches `exact`)
  //
  // We try BOTH the input as-is and a stripped version, so users who
  // saved either form are accepted.
  const stripped = modelId.startsWith(`${OPENROUTER_PROVIDER}/`)
    ? modelId.slice(OPENROUTER_PROVIDER.length + 1)
    : modelId;

  // For input like "anthropic/claude-3.5-sonnet" the bare-form
  // alternative is "claude-3.5-sonnet"; for input like
  // "qwen/qwen3.7-max" (OpenRouter bare) the bare-form alternative
  // is itself.
  const bareAlt = modelId.includes("/")
    ? modelId.split("/").slice(1).join("/")
    : modelId;

  return (
    !avail.bare.has(modelId) &&
    !avail.exact.has(modelId) &&
    !avail.bare.has(stripped) &&
    !avail.exact.has(stripped) &&
    !avail.bare.has(bareAlt) &&
    !avail.exact.has(bareAlt)
  );
}
