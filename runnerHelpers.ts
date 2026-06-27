/**
 * Shared helpers used by both the council runner (multi-model fan-out) and
 * the second-opinion runner (single-model call). Extracted in v1.6.0 so
 * the two runners share the same auth resolution, parse-then-repair
 * pipeline, and call-with-timeout wrapping.
 *
 * Per Sandi Metz: these are "the same idea" (cross-cutting concerns:
 * auth, parsing, timeout) so they belong in one place. The orchestration
 * differences (fan-out vs single-call, synthesis step, fallback decision)
 * remain in the respective runner files where they belong.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CouncilSettings, ModelOpinion } from "./types.js";
import { callOpenRouterChat } from "./openrouterClient.js";
import { extractJsonObject } from "./openrouterClient.js";
import { repairModelOpinion, validateModelOpinion } from "./structuredOutput.js";
import { withTimeout } from "./retry.js";

/**
 * Resolve the OpenRouter API key from three sources, in priority order:
 *
 *   1. Settings file (`council-settings.json`)
 *   2. Pi's auth storage (`ctx.modelRegistry.getApiKeyForProvider("openrouter")`)
 *   3. `process.env.OPENROUTER_API_KEY`
 *
 * Returns the trimmed key, or `undefined` if no source yields a key.
 */
export async function resolveOpenRouterApiKey(
  settings: Pick<CouncilSettings, "openRouter">,
  modelRegistry?: ModelRegistry,
): Promise<string | undefined> {
  const fromSettings = settings.openRouter.apiKey?.trim();
  if (fromSettings) return fromSettings;

  if (modelRegistry) {
    try {
      const fromRegistry = await modelRegistry.getApiKeyForProvider("openrouter");
      const trimmed = fromRegistry?.trim();
      if (trimmed) return trimmed;
    } catch {
      // Registry may not be available in all contexts; fall through.
    }
  }

  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  return undefined;
}

/**
 * Parse a model's raw text response into a `ModelOpinion`, running through
 * validate → repair → fallback. This consolidates the parse pipeline that
 * both runners used to inline.
 *
 * Returns the parsed opinion and any non-fatal warnings about how it was
 * recovered. The fallback shape (when even repair fails) preserves the
 * raw text snippet so the user can still see what the model said.
 */
export function parseModelOpinionResponse(rawText: string): {
  opinion: ModelOpinion;
  warnings: string[];
} {
  try {
    const jsonObj = extractJsonObject(rawText);
    const validation = validateModelOpinion(jsonObj);

    if (validation.ok && validation.value) {
      return { opinion: validation.value, warnings: validation.warnings ?? [] };
    }

    const repaired = repairModelOpinion(jsonObj, rawText);
    return { opinion: repaired.value, warnings: repaired.warnings ?? [] };
  } catch {
    // Last-ditch fallback: surface the raw text so the user can still see
    // what the model said, but flag it clearly as unstructured.
    return {
      opinion: {
        stance: "Direct response",
        recommendedApproach: rawText.substring(0, 500),
        steps: [],
        filesToConsider: [],
        risks: [],
        verification: [],
        confidence: "medium",
      },
      warnings: ["Response was not structured JSON, showing raw response."],
    };
  }
}

/**
 * Call OpenRouter with a hard timeout that combines the parent abort
 * signal (from Pi's extension context) with a per-call deadline.
 *
 * Throws with a clear message identifying which model failed, so the
 * user can distinguish "slow model" from "bad API key" from "network
 * error" in the runner logs.
 */
export async function callModelWithTimeout(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  timeoutMs: number;
  structuredOutputSchema?: unknown;
  structuredOutputName?: string;
}): Promise<string> {
  try {
    return await withTimeout(
      (childSignal) =>
        callOpenRouterChat({
          apiKey: args.apiKey,
          model: args.model,
          systemPrompt: args.systemPrompt,
          userPrompt: args.userPrompt,
          signal: childSignal,
          structuredOutputSchema: args.structuredOutputSchema,
          structuredOutputName: args.structuredOutputName,
        }),
      args.timeoutMs,
      args.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Model ${args.model} failed: ${message}`, { cause: error });
  }
}