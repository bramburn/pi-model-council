import type {
  CouncilInput,
  CouncilModelResult,
  ModelOpinion,
  SecondOpinionInput,
} from "./types.js";

export function buildSecondOpinionPrompt(input: SecondOpinionInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const mode = input.mode ?? "general";
  
  const systemPrompt = `You are a technical coding advisor providing a second opinion.
Give a practical, implementation-oriented response.
Be direct and concise. When uncertain, say so.
Focus on actionable recommendations.
Return valid JSON in the requested shape.`;

  const userPromptParts: string[] = [];

  userPromptParts.push(`# Second Opinion Request`);
  userPromptParts.push(`**Mode:** ${mode.toUpperCase()}`);
  userPromptParts.push("");
  userPromptParts.push("## Problem");
  userPromptParts.push(input.problem);

  if (input.currentUnderstanding) {
    userPromptParts.push("");
    userPromptParts.push("## Current Understanding");
    userPromptParts.push(input.currentUnderstanding);
  }

  if (input.relevantFiles && input.relevantFiles.length > 0) {
    userPromptParts.push("");
    userPromptParts.push("## Relevant Files");
    for (const file of input.relevantFiles) {
      userPromptParts.push(`- **${file.path}**: ${file.summary}`);
      if (file.importantSnippets) {
        userPromptParts.push(`  \`\`\`\n${file.importantSnippets}\n  \`\`\``);
      }
    }
  }

  if (input.constraints && input.constraints.length > 0) {
    userPromptParts.push("");
    userPromptParts.push("## Constraints");
    for (const constraint of input.constraints) {
      userPromptParts.push(`- ${constraint}`);
    }
  }

  if (input.questions && input.questions.length > 0) {
    userPromptParts.push("");
    userPromptParts.push("## Specific Questions");
    for (const question of input.questions) {
      userPromptParts.push(`- ${question}`);
    }
  }

  userPromptParts.push("");
  userPromptParts.push("Return JSON in this exact shape:");
  userPromptParts.push(`{
  "stance": "short position on the approach",
  "recommendedApproach": "short description of recommended approach",
  "steps": ["step 1", "step 2"],
  "filesToConsider": [
    {
      "path": "file path",
      "reason": "why this file is relevant",
      "suggestedAction": "modify|add|read-only|no-change"
    }
  ],
  "risks": ["risk 1", "risk 2"],
  "verification": ["test or check to verify"],
  "confidence": "low|medium|high"
}`);

  return {
    systemPrompt,
    userPrompt: userPromptParts.join("\n"),
  };
}

export function buildProposalPrompts(input: CouncilInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = `You are one member of a three-model coding council.
Your job is to give an independent technical opinion.
You are not editing code.
You are advising the main Pi coding agent.
Be practical, conservative, and implementation-oriented.
Prefer minimal, testable changes for fixes.
For architecture questions, prefer clear boundaries, maintainability, and reversible decisions.
Return ONLY valid JSON matching the requested shape.
Do not wrap JSON in Markdown.`;

  const userPromptParts: string[] = [];

  userPromptParts.push(`# Council Mode: ${input.mode.toUpperCase()}`);
  userPromptParts.push("");
  userPromptParts.push("## Problem");
  userPromptParts.push(input.problem);

  if (input.currentUnderstanding) {
    userPromptParts.push("");
    userPromptParts.push("## Current Understanding");
    userPromptParts.push(input.currentUnderstanding);
  }

  if (input.relevantFiles && input.relevantFiles.length > 0) {
    userPromptParts.push("");
    userPromptParts.push("## Relevant Files");
    for (const file of input.relevantFiles) {
      userPromptParts.push(`- **${file.path}**: ${file.summary}`);
      if (file.importantSnippets) {
        userPromptParts.push(`  \`\`\`\n${file.importantSnippets}\n  \`\`\``);
      }
    }
  }

  if (input.constraints && input.constraints.length > 0) {
    userPromptParts.push("");
    userPromptParts.push("## Constraints");
    for (const constraint of input.constraints) {
      userPromptParts.push(`- ${constraint}`);
    }
  }

  if (input.questionsToCouncil && input.questionsToCouncil.length > 0) {
    userPromptParts.push("");
    userPromptParts.push("## Questions to Council");
    for (const question of input.questionsToCouncil) {
      userPromptParts.push(`- ${question}`);
    }
  }

  userPromptParts.push("");
  userPromptParts.push(`Return JSON in this exact shape:`);
  userPromptParts.push(`{
  "stance": "short position on the approach",
  "recommendedApproach": "short description of recommended approach",
  "steps": ["step 1", "step 2"],
  "filesToConsider": [
    {
      "path": "file path",
      "reason": "why this file is relevant",
      "suggestedAction": "modify|add|read-only|no-change"
    }
  ],
  "risks": ["risk 1", "risk 2"],
  "verification": ["test or check to verify"],
  "confidence": "low|medium|high"
}`);

  return {
    systemPrompt,
    userPrompt: userPromptParts.join("\n"),
  };
}

export function buildSynthesisPrompts(input: CouncilInput, results: CouncilModelResult[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = `You are the chair of a coding model council.
You will receive the original problem and the opinions of three models.
Synthesize one practical decision for the main Pi coding agent.
Do not blindly majority vote.
Prefer approaches that are minimal, testable, reversible, and consistent with the supplied constraints.
Explicitly capture agreements, disagreements, and unknowns.
Return ONLY valid JSON matching the requested CouncilDecision shape.
Do not wrap JSON in Markdown.`;

  const userPromptParts: string[] = [];

  userPromptParts.push("# Original Problem");
  userPromptParts.push(`**Mode:** ${input.mode}`);
  userPromptParts.push(`**Problem:** ${input.problem}`);

  if (input.currentUnderstanding) {
    userPromptParts.push(`**Current Understanding:** ${input.currentUnderstanding}`);
  }

  if (input.constraints && input.constraints.length > 0) {
    userPromptParts.push("**Constraints:**");
    for (const constraint of input.constraints) {
      userPromptParts.push(`- ${constraint}`);
    }
  }

  userPromptParts.push("");
  userPromptParts.push("# Model Opinions");
  userPromptParts.push("");

  for (const result of results) {
    userPromptParts.push(`## ${result.model}`);
    if (result.ok && result.parsed) {
      const parsed = result.parsed as ModelOpinion;
      userPromptParts.push(`**Stance:** ${parsed.stance}`);
      userPromptParts.push(`**Recommended Approach:** ${parsed.recommendedApproach}`);
      userPromptParts.push(`**Steps:**`);
      for (const step of parsed.steps) {
        userPromptParts.push(`  ${parsed.steps.indexOf(step) + 1}. ${step}`);
      }
      if (parsed.filesToConsider.length > 0) {
        userPromptParts.push(`**Files to Consider:**`);
        for (const file of parsed.filesToConsider) {
          userPromptParts.push(`  - ${file.path}: ${file.suggestedAction} — ${file.reason}`);
        }
      }
      userPromptParts.push(`**Risks:** ${parsed.risks.join(", ") || "none"}`);
      userPromptParts.push(`**Verification:** ${parsed.verification.join(", ") || "none"}`);
      userPromptParts.push(`**Confidence:** ${parsed.confidence}`);
    } else if (result.ok && result.rawText) {
      userPromptParts.push("**Response (unstructured):**");
      userPromptParts.push(result.rawText.substring(0, 500) + (result.rawText.length > 500 ? "..." : ""));
    } else if (!result.ok && result.error) {
      userPromptParts.push(`**Error:** ${result.error}`);
    }
    userPromptParts.push("");
  }

  userPromptParts.push("");
  userPromptParts.push("# Synthesize Council Decision");
  userPromptParts.push("");
  userPromptParts.push(`Generate a decisionId using a timestamp-like format (e.g., "council-${Date.now()}").`);
  userPromptParts.push("");
  userPromptParts.push(`Return JSON in this exact shape:`);
  userPromptParts.push(`{
  "decisionId": "council-<timestamp>",
  "mode": "${input.mode}",
  "confidence": "low|medium|high",
  "consensus": {
    "agreements": ["agreed point 1", "agreed point 2"],
    "disagreements": ["disagreement 1", "disagreement 2"],
    "unknowns": ["unknown 1", "unknown 2"]
  },
  "recommendedPlan": {
    "summary": "one-sentence summary of the recommended plan",
    "steps": ["step 1", "step 2", "step 3"]
  },
  "implementationGuidance": {
    "filesToEdit": [
      {
        "path": "file path",
        "reason": "why to edit this file",
        "action": "specific action to take"
      }
    ],
    "testsToRun": ["test command or check"],
    "guardrails": ["constraint or warning to follow"]
  },
  "modelNotes": [
    {
      "model": "model name",
      "stance": "one-line stance summary",
      "keyRisks": ["risk 1", "risk 2"]
    }
  ],
  "handoffPrompt": "Concise instruction for the main Pi coding agent: what to do next, what to avoid, and what success looks like."
}`);

  return {
    systemPrompt,
    userPrompt: userPromptParts.join("\n"),
  };
}