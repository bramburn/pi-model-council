import type {
  CouncilDecision,
  CouncilInput,
  CouncilMode,
  ModelOpinion,
} from "./types.js";

// JSON Schema for model opinion response
export const modelOpinionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "stance",
    "recommendedApproach",
    "steps",
    "filesToConsider",
    "risks",
    "verification",
    "confidence"
  ],
  properties: {
    stance: { type: "string" },
    recommendedApproach: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    filesToConsider: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason", "suggestedAction"],
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          suggestedAction: { type: "string" }
        }
      }
    },
    risks: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  }
} as const;

// JSON Schema for council decision response
export const councilDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decisionId",
    "mode",
    "confidence",
    "consensus",
    "recommendedPlan",
    "implementationGuidance",
    "modelNotes",
    "handoffPrompt"
  ],
  properties: {
    decisionId: { type: "string" },
    mode: { type: "string", enum: ["fix", "ask", "architecture"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    consensus: {
      type: "object",
      additionalProperties: false,
      required: ["agreements", "disagreements", "unknowns"],
      properties: {
        agreements: { type: "array", items: { type: "string" } },
        disagreements: { type: "array", items: { type: "string" } },
        unknowns: { type: "array", items: { type: "string" } }
      }
    },
    recommendedPlan: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "steps"],
      properties: {
        summary: { type: "string" },
        steps: { type: "array", items: { type: "string" } }
      }
    },
    implementationGuidance: {
      type: "object",
      additionalProperties: false,
      required: ["filesToEdit", "testsToRun", "guardrails"],
      properties: {
        filesToEdit: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason", "action"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
              action: { type: "string" }
            }
          }
        },
        testsToRun: { type: "array", items: { type: "string" } },
        guardrails: { type: "array", items: { type: "string" } }
      }
    },
    modelNotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["model", "stance", "keyRisks"],
        properties: {
          model: { type: "string" },
          stance: { type: "string" },
          keyRisks: { type: "array", items: { type: "string" } }
        }
      }
    },
    handoffPrompt: { type: "string" }
  }
} as const;

type ParseStatus = "valid" | "repaired" | "fallback";

interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  warnings: string[];
}

interface RepairResult<T> {
  value: T;
  parseStatus: ParseStatus;
  warnings: string[];
}

/**
 * Validate a model opinion object against required fields.
 */
export function validateModelOpinion(value: unknown): ValidationResult<ModelOpinion> {
  const warnings: string[] = [];

  if (typeof value !== "object" || value === null) {
    return { ok: false, warnings: ["Model opinion is not an object"] };
  }

  const obj = value as Record<string, unknown>;

  // Check required fields
  const requiredFields: (keyof ModelOpinion)[] = [
    "stance",
    "recommendedApproach",
    "steps",
    "filesToConsider",
    "risks",
    "verification",
    "confidence"
  ];

  for (const field of requiredFields) {
    if (!(field in obj)) {
      warnings.push(`Missing required field: ${field}`);
    }
  }

  // Validate confidence
  const validConfidence = ["low", "medium", "high"];
  if (obj.confidence && !validConfidence.includes(obj.confidence as string)) {
    warnings.push(`Invalid confidence value: ${obj.confidence}`);
  }

  // Check if all required fields are present and valid
  const hasStance = typeof obj.stance === "string";
  const hasApproach = typeof obj.recommendedApproach === "string";
  const hasSteps = Array.isArray(obj.steps);

  if (hasStance && hasApproach && hasSteps) {
    return {
      ok: true,
      value: {
        stance: obj.stance as string,
        recommendedApproach: obj.recommendedApproach as string,
        steps: obj.steps as string[],
        filesToConsider: Array.isArray(obj.filesToConsider) ? obj.filesToConsider as ModelOpinion["filesToConsider"] : [],
        risks: Array.isArray(obj.risks) ? obj.risks as string[] : [],
        verification: Array.isArray(obj.verification) ? obj.verification as string[] : [],
        confidence: validConfidence.includes(obj.confidence as string)
          ? obj.confidence as ModelOpinion["confidence"]
          : "medium",
      },
      warnings,
    };
  }

  return { ok: false, warnings };
}

/**
 * Repair a model opinion object, filling in missing fields with defaults.
 */
export function repairModelOpinion(value: unknown, rawText: string): RepairResult<ModelOpinion> {
  const warnings: string[] = [];

  if (typeof value !== "object" || value === null) {
    warnings.push("Model opinion is not an object, creating fallback");
    return {
      value: createFallbackOpinion(rawText),
      parseStatus: "fallback",
      warnings,
    };
  }

  const obj = value as Record<string, unknown>;

  // Repair stance
  let stance = "Unclear stance";
  if (typeof obj.stance === "string" && obj.stance.length > 0) {
    stance = obj.stance;
  } else {
    warnings.push("Missing or invalid stance, using default");
  }

  // Repair recommendedApproach
  let recommendedApproach = rawText.substring(0, 300);
  if (typeof obj.recommendedApproach === "string" && obj.recommendedApproach.length > 0) {
    recommendedApproach = obj.recommendedApproach;
  } else {
    warnings.push("Missing or invalid recommendedApproach, using raw text");
  }

  // Repair steps
  let steps: string[] = [];
  if (Array.isArray(obj.steps)) {
    steps = obj.steps.filter((s): s is string => typeof s === "string");
  } else if (typeof obj.steps === "string") {
    steps = [obj.steps];
    warnings.push("steps was a string, converted to array");
  } else {
    warnings.push("Missing or invalid steps, using empty array");
  }

  // Repair filesToConsider
  let filesToConsider: ModelOpinion["filesToConsider"] = [];
  if (Array.isArray(obj.filesToConsider)) {
    filesToConsider = obj.filesToConsider
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
      .filter((f) => typeof f.path === "string")
      .map((f) => ({
        path: f.path as string,
        reason: typeof f.reason === "string" ? f.reason : "",
        suggestedAction: typeof f.suggestedAction === "string" ? f.suggestedAction : "",
      }));
  } else {
    warnings.push("Missing or invalid filesToConsider");
  }

  // Repair risks
  let risks: string[] = [];
  if (Array.isArray(obj.risks)) {
    risks = obj.risks.filter((r): r is string => typeof r === "string");
  } else if (typeof obj.risks === "string") {
    risks = [obj.risks];
  } else {
    warnings.push("Missing or invalid risks");
  }

  // Repair verification
  let verification: string[] = [];
  if (Array.isArray(obj.verification)) {
    verification = obj.verification.filter((v): v is string => typeof v === "string");
  } else if (typeof obj.verification === "string") {
    verification = [obj.verification];
    warnings.push("verification was a string, converted to array");
  } else {
    warnings.push("Missing or invalid verification");
  }

  // Repair confidence
  const validConfidence = ["low", "medium", "high"] as const;
  let confidence: ModelOpinion["confidence"] = "medium";
  if (typeof obj.confidence === "string" && validConfidence.includes(obj.confidence as "low" | "medium" | "high")) {
    confidence = obj.confidence as "low" | "medium" | "high";
  } else {
    warnings.push("Missing or invalid confidence, defaulting to medium");
  }

  return {
    value: {
      stance,
      recommendedApproach,
      steps,
      filesToConsider,
      risks,
      verification,
      confidence,
    },
    parseStatus: warnings.length > 0 ? "repaired" : "valid",
    warnings,
  };
}

/**
 * Validate a council decision object against required fields.
 */
export function validateCouncilDecision(value: unknown): ValidationResult<CouncilDecision> {
  const warnings: string[] = [];

  if (typeof value !== "object" || value === null) {
    return { ok: false, warnings: ["Council decision is not an object"] };
  }

  const obj = value as Record<string, unknown>;

  // Check required top-level fields
  if (!obj.decisionId) warnings.push("Missing required field: decisionId");
  if (!obj.recommendedPlan) warnings.push("Missing required field: recommendedPlan");
  if (!obj.implementationGuidance) warnings.push("Missing required field: implementationGuidance");

  // Validate consensus structure if present
  if (obj.consensus && typeof obj.consensus === "object") {
    const consensus = obj.consensus as Record<string, unknown>;
    if (!Array.isArray(consensus.agreements)) warnings.push("consensus.agreements should be an array");
    if (!Array.isArray(consensus.disagreements)) warnings.push("consensus.disagreements should be an array");
    if (!Array.isArray(consensus.unknowns)) warnings.push("consensus.unknowns should be an array");
  }

  // Check if we have enough to construct a valid decision
  if (obj.decisionId && obj.recommendedPlan && obj.implementationGuidance) {
    return {
      ok: true,
      value: normalizeCouncilDecision(obj, undefined),
      warnings,
    };
  }

  return { ok: false, warnings };
}

/**
 * Repair a council decision object, filling in missing fields with defaults.
 */
export function repairCouncilDecision(value: unknown, input: CouncilInput): RepairResult<CouncilDecision> {
  const warnings: string[] = [];

  // Handle string input (raw text fallback)
  if (typeof value === "string") {
    warnings.push("Council decision is raw text, creating fallback");
    return {
      value: createFallbackDecisionRepaired(input),
      parseStatus: "fallback",
      warnings,
    };
  }

  if (typeof value !== "object" || value === null) {
    warnings.push("Council decision is not an object, creating fallback");
    return {
      value: createFallbackDecisionRepaired(input),
      parseStatus: "fallback",
      warnings,
    };
  }

  const obj = value as Record<string, unknown>;

  // Add warnings for missing fields
  if (!obj.decisionId) warnings.push("Missing decisionId, generating new one");
  if (!obj.consensus) warnings.push("Missing consensus, using empty arrays");
  if (!obj.modelNotes) warnings.push("Missing modelNotes");

  return {
    value: normalizeCouncilDecision(obj, input),
    parseStatus: warnings.length > 0 ? "repaired" : "valid",
    warnings,
  };
}

function createFallbackOpinion(rawText: string): ModelOpinion {
  return {
    stance: "Unstructured response",
    recommendedApproach: rawText.substring(0, 300),
    steps: [],
    filesToConsider: [],
    risks: [],
    verification: [],
    confidence: "medium",
  };
}

function createFallbackDecisionRepaired(input: CouncilInput): CouncilDecision {
  return {
    decisionId: `council-${Date.now()}`,
    mode: input.mode,
    confidence: "medium",
    consensus: {
      agreements: [],
      disagreements: [],
      unknowns: ["Council decision could not be parsed"],
    },
    recommendedPlan: {
      summary: "Review the council outputs and implement the safest minimal plan.",
      steps: [
        "Review relevant files.",
        "Implement the smallest safe change.",
        "Run verification.",
      ],
    },
    implementationGuidance: {
      filesToEdit: [],
      testsToRun: [],
      guardrails: ["Prefer minimal, reversible changes."],
    },
    modelNotes: [],
    handoffPrompt: "Implement the recommended plan cautiously and verify before reporting success.",
  };
}

function normalizeCouncilDecision(
  obj: Record<string, unknown>,
  input?: CouncilInput
): CouncilDecision {
  const validModes: CouncilMode[] = ["fix", "ask", "architecture"];
  const validConfidence = ["low", "medium", "high"];

  return {
    decisionId: typeof obj.decisionId === "string" ? obj.decisionId : `council-${Date.now()}`,
    mode: validModes.includes(obj.mode as CouncilMode)
      ? obj.mode as CouncilMode
      : (input?.mode ?? "ask"),
    confidence: validConfidence.includes(obj.confidence as string)
      ? obj.confidence as CouncilDecision["confidence"]
      : "medium",
    consensus: normalizeConsensus(obj.consensus),
    recommendedPlan: normalizeRecommendedPlan(obj.recommendedPlan),
    implementationGuidance: normalizeImplementationGuidance(obj.implementationGuidance),
    modelNotes: normalizeModelNotes(obj.modelNotes),
    handoffPrompt: typeof obj.handoffPrompt === "string"
      ? obj.handoffPrompt
      : "Review and implement the recommended plan.",
  };
}

function normalizeConsensus(consensus: unknown): CouncilDecision["consensus"] {
  if (typeof consensus !== "object" || consensus === null) {
    return { agreements: [], disagreements: [], unknowns: [] };
  }
  const c = consensus as Record<string, unknown>;
  return {
    agreements: Array.isArray(c.agreements) ? c.agreements.filter((s): s is string => typeof s === "string") : [],
    disagreements: Array.isArray(c.disagreements) ? c.disagreements.filter((s): s is string => typeof s === "string") : [],
    unknowns: Array.isArray(c.unknowns) ? c.unknowns.filter((s): s is string => typeof s === "string") : [],
  };
}

function normalizeRecommendedPlan(plan: unknown): CouncilDecision["recommendedPlan"] {
  if (typeof plan !== "object" || plan === null) {
    return {
      summary: "Review the council outputs and implement the safest minimal plan.",
      steps: ["Review relevant files.", "Implement the smallest safe change.", "Run verification."],
    };
  }
  const p = plan as Record<string, unknown>;
  return {
    summary: typeof p.summary === "string" ? p.summary : "Review the council outputs and implement the safest minimal plan.",
    steps: Array.isArray(p.steps) ? p.steps.filter((s): s is string => typeof s === "string") : [],
  };
}

function normalizeImplementationGuidance(guidance: unknown): CouncilDecision["implementationGuidance"] {
  if (typeof guidance !== "object" || guidance === null) {
    return { filesToEdit: [], testsToRun: [], guardrails: ["Prefer minimal, reversible changes."] };
  }
  const g = guidance as Record<string, unknown>;

  const filesToEdit = Array.isArray(g.filesToEdit)
    ? g.filesToEdit
        .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
        .filter((f) => typeof f.path === "string")
        .map((f) => ({
          path: f.path as string,
          reason: typeof f.reason === "string" ? f.reason : "",
          action: typeof f.action === "string" ? f.action : "",
        }))
    : [];

  return {
    filesToEdit,
    testsToRun: Array.isArray(g.testsToRun) ? g.testsToRun.filter((s): s is string => typeof s === "string") : [],
    guardrails: Array.isArray(g.guardrails) ? g.guardrails.filter((s): s is string => typeof s === "string") : ["Prefer minimal, reversible changes."],
  };
}

function normalizeModelNotes(notes: unknown): CouncilDecision["modelNotes"] {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null)
    .filter((n) => typeof n.model === "string")
    .map((n) => ({
      model: n.model as string,
      stance: typeof n.stance === "string" ? n.stance : "",
      keyRisks: Array.isArray(n.keyRisks) ? n.keyRisks.filter((r): r is string => typeof r === "string") : [],
    }));
}
