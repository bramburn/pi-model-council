import type {
  CouncilDecision,
  CouncilInput,
  CouncilModelResult,
} from "./types.js";
import {
  ensureQdrantCollection,
  upsertQdrantPoint,
} from "./qdrantClient.js";

/**
 * Persist a council decision to Qdrant if persistence is enabled.
 * This is optional and will not fail the council decision if persistence fails.
 */
export async function maybePersistCouncilDecision(args: {
  input: CouncilInput;
  decision: CouncilDecision;
  rawModelResults: CouncilModelResult[];
  markdown: string;
  signal?: AbortSignal;
}): Promise<{
  persisted: boolean;
  error?: string;
}> {
  // Check if persistence is enabled
  if (process.env.COUNCIL_PERSISTENCE_ENABLED !== "true") {
    return { persisted: false };
  }

  const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6333";
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const collection = process.env.QDRANT_COUNCIL_COLLECTION ?? "pi_council_decisions";

  try {
    // Ensure collection exists
    await ensureQdrantCollection({
      baseUrl: qdrantUrl,
      apiKey: qdrantApiKey,
      collection,
      vectorSize: 8,
      distance: "Cosine",
      signal: args.signal,
    });

    // Create payload (without full raw model outputs)
    const payload: Record<string, unknown> = {
      kind: "pi_model_council_decision",
      version: 1,
      decisionId: args.decision.decisionId,
      mode: args.decision.mode,
      confidence: args.decision.confidence,
      problem: args.input.problem,
      currentUnderstanding: args.input.currentUnderstanding ?? null,
      constraints: args.input.constraints ?? [],
      questionsToCouncil: args.input.questionsToCouncil ?? [],
      relevantFiles: args.input.relevantFiles ?? [],
      recommendedSummary: args.decision.recommendedPlan.summary,
      recommendedSteps: args.decision.recommendedPlan.steps,
      agreements: args.decision.consensus.agreements,
      disagreements: args.decision.consensus.disagreements,
      unknowns: args.decision.consensus.unknowns,
      filesToEdit: args.decision.implementationGuidance.filesToEdit,
      testsToRun: args.decision.implementationGuidance.testsToRun,
      guardrails: args.decision.implementationGuidance.guardrails,
      modelNotes: args.decision.modelNotes,
      handoffPrompt: args.decision.handoffPrompt,
      markdown: args.markdown,
      createdAt: new Date().toISOString(),
      rawModelMetadata: args.rawModelResults.map(r => ({
        model: r.model,
        ok: r.ok,
        error: r.error ?? null,
        metadata: r.metadata ?? null,
      })),
    };

    // Create placeholder vector (8-dim, deterministic)
    const vector = createDecisionVector(args.decision);

    // Upsert to Qdrant
    await upsertQdrantPoint({
      baseUrl: qdrantUrl,
      apiKey: qdrantApiKey,
      collection,
      id: args.decision.decisionId,
      vector,
      payload,
      signal: args.signal,
    });

    return { persisted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { persisted: false, error: message };
  }
}

/**
 * Create a deterministic 8-dim placeholder vector based on decision content.
 * This is not semantic search yet - just a storage placeholder.
 */
function createDecisionVector(decision: CouncilDecision): number[] {
  const seed = decision.decisionId.length + decision.recommendedPlan.summary.length;
  return [
    1, // constant
    decision.mode === "fix" ? 1 : 0,
    decision.mode === "ask" ? 1 : 0,
    decision.mode === "architecture" ? 1 : 0,
    decision.confidence === "high" ? 1 : 0,
    decision.confidence === "medium" ? 1 : 0,
    decision.implementationGuidance.filesToEdit.length,
    seed % 10,
  ];
}
