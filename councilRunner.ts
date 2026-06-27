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
import {
  modelOpinionJsonSchema,
  councilDecisionJsonSchema,
  repairModelOpinion,
  repairCouncilDecision,
  validateCouncilDecision,
} from "./structuredOutput.js";
import { withTimeout, retry, isStructuredOutputError } from "./retry.js";
import { renderCouncilDecisionMarkdown } from "./markdown.js";
import { maybePersistCouncilDecision } from "./persistence.js";
import { loadSettings } from "./settings.js";
import { CouncilSetupError } from "./types.js";

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

  const {
    apiKey,
    model1,
    model2,
    model3,
    synthesisModelId,
  } = {
    apiKey: settings.openRouter.apiKey,
    model1: settings.openRouter.models.model1,
    model2: settings.openRouter.models.model2,
    model3: settings.openRouter.models.model3,
    synthesisModelId: settings.synthesis?.modelId ?? settings.openRouter.models.model1,
  };

  // ── Pre-flight: resolve API key (settings → registry → env) ─────────────
  let resolvedApiKey = apiKey;
  if (!resolvedApiKey) {
    if (args.modelRegistry) {
      try {
        const fromRegistry = await args.modelRegistry.getApiKeyForProvider("openrouter");
        if (fromRegistry && fromRegistry.trim().length > 0) {
          resolvedApiKey = fromRegistry.trim();
        }
      } catch {
        // fall through to env
      }
    }
    if (!resolvedApiKey) {
      const fromEnv = process.env.OPENROUTER_API_KEY;
      if (fromEnv && fromEnv.trim().length > 0) {
        resolvedApiKey = fromEnv.trim();
      }
    }
  }

  if (!resolvedApiKey) {
    throw new CouncilSetupError(
      "Council cannot run: no OpenRouter API key found.\n\n" +
      "Set OPENROUTER_API_KEY, run `/login openrouter` in pi, or save a\n" +
      "key via `/council-settings`.",
    );
  }

  // ── Pre-flight: validate API key ─────────────────────────────────────────
  args.onStatus?.("Council: validating API key...");
  const ping = await pingOpenRouter(resolvedApiKey);
  if (!ping.ok) {
    throw new CouncilSetupError(
      `Council cannot run: OpenRouter API key is invalid.\n` +
      `${ping.error}\n\n` +
      `Fix: run \`/council-settings\` to update your API key.`,
    );
  }

  // ── Pre-flight: validate models (registry first, REST fallback) ─────────
  args.onStatus?.("Council: verifying configured models are available...");
  let availableModels: string[] = [];
  if (args.modelRegistry) {
    try {
      const reg = await args.modelRegistry.getAvailable();
      availableModels = reg
        .filter((m) => m.provider === "openrouter")
        .map((m) => m.id);
    } catch {
      // fall through to REST fetch
    }
  }

  if (availableModels.length === 0) {
    try {
      const models = await fetchOpenRouterModels(resolvedApiKey);
      availableModels = models.map(m => m.id);
    } catch {
      // If we can't fetch models, try to continue anyway
    }
  }

  const configuredModels = [model1, model2, model3, synthesisModelId];
  const missingModels = configuredModels.filter(m => availableModels.length > 0 && !availableModels.includes(m));

  if (missingModels.length > 0) {
    throw new CouncilSetupError(
      `Some configured models are no longer available on OpenRouter:\n` +
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

  const COUNCIL_MODELS = [model1, model2, model3];
  // Use the dedicated synthesis model when set, otherwise fall back to model1
  const SYNTHESIZER_MODEL = synthesisModelId;

  // ── Call models ──────────────────────────────────────────────────────────
  args.onStatus?.("Council: querying models...");

  const { systemPrompt: proposalSystem, userPrompt: proposalUser } = buildProposalPrompts(input);

  const modelPromises = COUNCIL_MODELS.map(async (model): Promise<CouncilModelResult> => {
    const started = Date.now();
    let usedStructuredOutput = false;
    let totalAttempts = 0;
    const allWarnings: string[] = [];

    let attemptWithStructuredOutput = USE_STRUCTURED_OUTPUT;

    const callModel = async (attempt: number): Promise<string> => {
      totalAttempts = attempt;

      const options = {
        apiKey: resolvedApiKey,
        model,
        systemPrompt: proposalSystem,
        userPrompt: proposalUser,
        signal: undefined as unknown as AbortSignal,
        structuredOutputSchema: attemptWithStructuredOutput ? modelOpinionJsonSchema : undefined,
        structuredOutputName: "model_opinion",
      };

      return withTimeout(
        (childSignal) => callOpenRouterChat({ ...options, signal: childSignal }),
        MODEL_TIMEOUT_MS,
        args.signal,
      );
    };

    try {
      let rawText: string;

      try {
        rawText = await callModel(1);
        usedStructuredOutput = attemptWithStructuredOutput;
      } catch (firstError) {
        if (attemptWithStructuredOutput && isStructuredOutputError(firstError)) {
          allWarnings.push(`Model ${model} does not support structured output, using fallback mode.`);
          attemptWithStructuredOutput = false;
          const retryResult = await retry({
            attempts: MODEL_RETRY_ATTEMPTS,
            delayMs: MODEL_RETRY_DELAY_MS,
            operation: callModel,
          });
          rawText = retryResult.value;
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
    }
  });

  const modelResults = await Promise.all(modelPromises);

  const allFailed = modelResults.every(r => !r.ok);
  if (allFailed) {
    throw new Error(
      "All three council models failed to respond. " +
      "Check your API key and network connection.",
    );
  }

  // ── Synthesize ──────────────────────────────────────────────────────────
  args.onStatus?.("Council: synthesizing decision...");

  const { systemPrompt: synthesisSystem, userPrompt: synthesisUser } = buildSynthesisPrompts(input, modelResults);

  let decision: CouncilDecision;
  const synthesisWarnings: string[] = [];

  try {
    const attemptSynthesis = async (): Promise<string> => {
      return withTimeout(
        (childSignal) => callOpenRouterChat({
          apiKey: resolvedApiKey,
          model: SYNTHESIZER_MODEL,
          systemPrompt: synthesisSystem,
          userPrompt: synthesisUser,
          signal: childSignal,
          structuredOutputSchema: USE_STRUCTURED_OUTPUT ? councilDecisionJsonSchema : undefined,
          structuredOutputName: "council_decision",
        }),
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
  args.onStatus?.("Council: persisting...");

  const persistence = await maybePersistCouncilDecision({
    input,
    decision,
    rawModelResults: modelResults,
    markdown: "",
    signal: args.signal,
  });

  decision.metadata = {
    ...decision.metadata!,
    persisted: persistence.persisted,
    persistenceError: persistence.error,
  };

  args.onStatus?.("Council: complete");

  const finalMarkdown = renderCouncilDecisionMarkdown(decision);

  return { decision, rawModelResults: modelResults, markdown: finalMarkdown };
}
