export type CouncilMode = "fix" | "ask" | "architecture";

export type SecondOpinionMode = "fix" | "ask" | "architecture" | "general";

export type SecondOpinionInput = {
  problem: string;
  mode?: SecondOpinionMode;
  currentUnderstanding?: string;
  relevantFiles?: CouncilRelevantFile[];
  constraints?: string[];
  questions?: string[];
};

export type CouncilRelevantFile = {
  path: string;
  summary: string;
  importantSnippets?: string;
};

export type CouncilInput = {
  mode: CouncilMode;
  problem: string;
  currentUnderstanding?: string;
  relevantFiles?: CouncilRelevantFile[];
  constraints?: string[];
  questionsToCouncil?: string[];
};

export type CouncilModelResult = {
  model: string;
  ok: boolean;
  rawText?: string;
  parsed?: ModelOpinion;
  error?: string;
  metadata?: {
    attemptCount?: number;
    durationMs?: number;
    usedStructuredOutput?: boolean;
    parseStatus?: "ok" | "repaired" | "fallback" | "failed";
    warnings?: string[];
  };
};

export type ModelOpinion = {
  stance: string;
  recommendedApproach: string;
  steps: string[];
  filesToConsider: Array<{
    path: string;
    reason: string;
    suggestedAction: string;
  }>;
  risks: string[];
  verification: string[];
  confidence: "low" | "medium" | "high";
};

export type CouncilDecision = {
  decisionId: string;
  mode: CouncilMode;
  confidence: "low" | "medium" | "high";
  consensus: {
    agreements: string[];
    disagreements: string[];
    unknowns: string[];
  };
  recommendedPlan: {
    summary: string;
    steps: string[];
  };
  implementationGuidance: {
    filesToEdit: Array<{
      path: string;
      reason: string;
      action: string;
    }>;
    testsToRun: string[];
    guardrails: string[];
  };
  modelNotes: Array<{
    model: string;
    stance: string;
    keyRisks: string[];
  }>;
  handoffPrompt: string;
  metadata?: {
    degraded?: boolean;
    fallbackUsed?: boolean;
    warnings?: string[];
  };
};

// --- Settings constants ---

/** Minimum number of models required in the council. */
export const MIN_COUNCIL_MODELS = 1;

/** Default number of models in a council. */
export const DEFAULT_COUNCIL_SIZE = 3;

// --- Settings types ---

export interface OpenRouterModel {
  id: string;
  name: string;
  /** True if the model supports extended thinking / reasoning. Optional — only
   *  populated when sourced from pi's model registry, since OpenRouter's REST
   *  /models endpoint doesn't expose it. */
  reasoning?: boolean;
  /** Context window size in tokens, if known. */
  contextWindow?: number;
}

export interface CouncilSettings {
  version: 1;
  openRouter: {
    /** May be empty when the API key is sourced from pi's auth storage
     *  (`ctx.modelRegistry.getApiKeyForProvider("openrouter")`). */
    apiKey: string;
    /** Ordered list of models that form the council. The synthesis model
     *  reads all their opinions and produces the final decision. */
    councilModels: string[];
  };
  opinion: {
    provider: string;
    modelId: string;
  };
  /** Optional override for the synthesis model. When omitted, the council
   *  runner falls back to the first council model. */
  synthesis?: {
    modelId: string;
  };
  options: {
    useStructuredOutput: boolean;
    modelTimeoutMs: number;
    synthesisTimeoutMs: number;
    retryAttempts: number;
    retryDelayMs: number;
  };
  lastUpdated: string;
}

/** Legacy v1 schema for backward-compat migration. */
export interface CouncilSettingsV1 {
  version: 1;
  openRouter: {
    apiKey: string;
    models: {
      model1: string;
      model2: string;
      model3: string;
    };
  };
  opinion: {
    provider: string;
    modelId: string;
  };
  synthesis?: { modelId: string };
  options: {
    useStructuredOutput: boolean;
    modelTimeoutMs: number;
    synthesisTimeoutMs: number;
    retryAttempts: number;
    retryDelayMs: number;
  };
  lastUpdated: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface PingResult {
  ok: boolean;
  error?: string;
  quota?: string;
}

export interface ModelOption {
  provider: string;
  models: Array<{
    id: string;
    name: string;
  }>;
}

export class CouncilSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilSetupError";
  }
}

export class OpinionSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpinionSetupError";
  }
}
