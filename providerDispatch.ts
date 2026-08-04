/**
 * Provider dispatch — routes model calls to the right API.
 *
 * Background:
 *   Until v1.6.x the runner only called OpenRouter REST. Now that the
 *   settings UI lets the user pick from pi's full model registry
 *   (anthropic, openai, google, mistral, bedrock, …), the runner needs to
 *   route to each provider's native API instead of forcing everything
 *   through OpenRouter.
 *
 * Strategy:
 *   - Resolve a stored model ID to `{provider, id}` via pi's ModelRegistry
 *     (preferred — canonical source of truth for what's available).
 *   - Fall back to a format heuristic: if the ID starts with `openrouter/`
 *     or contains no slash, treat as OpenRouter; else split on first `/`.
 *   - For `openrouter`: use the existing `callOpenRouterChat` (REST).
 *   - For everything else: delegate to `@earendil-works/pi-ai/compat`'s
 *     `completeSimple`, which dispatches to the right provider handler
 *     (anthropic-messages, openai-completions, google-generative-ai, …).
 *
 * Why pi-ai/compat and not raw HTTP per provider?
 *   - One import; 9 providers registered automatically (anthropic, openai,
 *     openai-responses, openai-codex, azure-openai, google-generative-ai,
 *     google-vertex, mistral, bedrock).
 *   - Handles auth resolution, headers, request shaping, retries internally.
 *   - Matches what the rest of pi's TUI/agent uses — single inference path.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, Context } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { callOpenRouterChat } from "./openrouterClient.js";

/** Providers that should route through OpenRouter REST, not the inference layer. */
export const OPENROUTER_PROVIDER = "openrouter";

/**
 * Known direct providers (i.e. NOT OpenRouter). Model IDs prefixed with
 * one of these route through the corresponding native API (e.g.
 * `anthropic/claude-3.5-sonnet` → Anthropic Messages API). OpenRouter
 * models use either the bare form (`qwen/qwen3.7-max`) or the explicit
 * `openrouter/` prefix (`openrouter/qwen/qwen3.7-max`).
 *
 * M2 fix: the set is now derived from pi's `ModelRegistry` at call-time
 * when a registry is supplied. The hardcoded list below is only used
 * as a fallback when no registry is available (e.g. in unit tests
 * that mock out the registry).
 */
const FALLBACK_DIRECT_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-responses",
  "openai-codex",
  "azure-openai",
  "google",
  "google-vertex",
  "mistral",
  "bedrock",
  "xai",
  "groq",
  "deepseek",
]);

/**
 * Build the set of direct providers we route to the native API. When a
 * ModelRegistry is supplied, we use whatever providers it knows about
 * (excluding openrouter). Otherwise we fall back to the hardcoded list
 * above.
 */
function buildDirectProviders(modelRegistry?: ModelRegistry): Set<string> {
  if (modelRegistry) {
    try {
      const all = modelRegistry.getAll();
      const fromRegistry = new Set<string>();
      for (const m of all) {
        if (m.provider !== OPENROUTER_PROVIDER) {
          fromRegistry.add(m.provider);
        }
      }
      // Only use the registry-derived set if it has at least one entry.
      // An empty registry (e.g. before pi has loaded its catalog) would
      // otherwise route everything to OpenRouter, which is wrong.
      if (fromRegistry.size > 0) return fromRegistry;
    } catch {
      // fall through to fallback
    }
  }
  return FALLBACK_DIRECT_PROVIDERS;
}

/** Result of resolving a stored model ID into its canonical pieces. */
export interface ResolvedModel {
  /** Canonical provider name as pi's registry reports it. */
  provider: string;
  /** Model id without the provider prefix. */
  id: string;
}

/**
 * Resolve a stored model ID into its provider + id parts.
 *
 * Resolution order:
 *   1. If a ModelRegistry is supplied, look up the model by the raw ID
 *      first (handles bare OpenRouter IDs like `qwen/qwen3.7-max`).
 *   2. If that fails and the ID contains a `/`, split on the first `/`
 *      and try `registry.find(provider, id)`.
 *   3. If that fails, fall back to treating the whole thing as an
 *      OpenRouter ID (the historical default).
 *
 * The returned `provider` is whatever the registry said, or our heuristic
 * guess if no registry was supplied.
 */
export function resolveModel(
  rawId: string,
  modelRegistry?: ModelRegistry,
): ResolvedModel {
  const trimmed = rawId.trim();
  if (!trimmed) {
    throw new Error(`Cannot resolve empty model ID`);
  }

  // M2: build the direct-providers set dynamically from the registry
  // when available; fall back to the hardcoded list otherwise.
  const directProviders = buildDirectProviders(modelRegistry);

  // 1. Try the raw id against every provider in the registry — exact match
  if (modelRegistry) {
    try {
      const all = modelRegistry.getAll();
      const exact = all.find((m) => m.id === trimmed);
      if (exact) {
        return { provider: exact.provider, id: exact.id };
      }
    } catch {
      // registry call failed; fall through to heuristic
    }
  }

  // 2. Try splitting on `/` if present
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1);

    // Explicit `openrouter/` prefix: always OpenRouter
    if (prefix === OPENROUTER_PROVIDER) {
      return { provider: OPENROUTER_PROVIDER, id: rest };
    }

    // Known direct provider prefix (anthropic, openai, google, …): native API
    if (directProviders.has(prefix)) {
      // Still consult the registry if available — it may want to canonicalise
      // the model id (e.g., add version suffix).
      if (modelRegistry) {
        try {
          const found = modelRegistry.find(prefix, rest);
          if (found) {
            return { provider: found.provider, id: found.id };
          }
        } catch {
          // fall through
        }
      }
      return { provider: prefix, id: rest };
    }

    // Otherwise it's an OpenRouter bare id like `qwen/qwen3.7-max`
    // (vendor/model format). The prefix is the vendor, NOT the provider.
    if (modelRegistry) {
      try {
        const all = modelRegistry.getAll();
        const orMatch = all.find(
          (m) => m.provider === OPENROUTER_PROVIDER && m.id === trimmed,
        );
        if (orMatch) {
          return { provider: OPENROUTER_PROVIDER, id: orMatch.id };
        }
      } catch {
        // fall through
      }
    }
    return { provider: OPENROUTER_PROVIDER, id: trimmed };
  }

  // 3. No `/` — historical OpenRouter bare id (e.g. "gpt-4o")
  return { provider: OPENROUTER_PROVIDER, id: trimmed };
}

/** Extract the text content from an AssistantMessage (concat text blocks). */
export function extractTextFromAssistantMessage(msg: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/**
 * Look up the canonical `Model<Api>` in the registry. Returns undefined
 * if no registry was supplied or the model isn't registered.
 */
function findModelInRegistry(
  provider: string,
  id: string,
  modelRegistry?: ModelRegistry,
): Model<"openai-completions"> | undefined {
  if (!modelRegistry) return undefined;
  try {
    const found = modelRegistry.find(provider, id);
    if (!found) return undefined;
    // The returned Model<Api> is union-narrowed at runtime by the provider
    // lookup. The Model type from pi-ai/compat is structurally compatible
    // with Model<Api> for any Api subtype, so we coerce through unknown.
    return found as unknown as Model<"openai-completions">;
  } catch {
    return undefined;
  }
}

/**
 * Call a model via the right provider.
 *
 * For `openrouter`: uses `callOpenRouterChat` (existing path).
 * For everything else: builds a `Context` and calls pi-ai's
 * `completeSimple`, which dispatches to the right provider handler.
 *
 * The `signal` is forwarded as the AbortSignal for cancellation.
 *
 * Throws with a clear "Model <id> failed: <reason>" message on error.
 */
export async function callModelViaDispatch(args: {
  rawId: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  /** OpenRouter API key (only used when the model resolves to OpenRouter). */
  apiKey?: string;
  /** Pi's ModelRegistry — used both to resolve the provider and to
   *  supply the auth headers/keys for non-OpenRouter calls. */
  modelRegistry?: ModelRegistry;
  /** Optional temperature override. Defaults to 0.2 (council default). */
  temperature?: number;
  /** Optional max tokens override. Defaults to 15000 (council default). */
  maxTokens?: number;
}): Promise<string> {
  const resolved = resolveModel(args.rawId, args.modelRegistry);

  if (resolved.provider === OPENROUTER_PROVIDER) {
    if (!args.apiKey) {
      throw new Error(
        `OpenRouter API key is required to call OpenRouter model ${args.rawId}`,
      );
    }
    return callOpenRouterChat({
      apiKey: args.apiKey,
      model: args.rawId, // preserve bare-id form for OpenRouter REST
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      temperature: args.temperature ?? 0.2,
      maxTokens: args.maxTokens ?? 15000,
    });
  }

  // Non-OpenRouter path: delegate to pi-ai/compat.
  const model = findModelInRegistry(resolved.provider, resolved.id, args.modelRegistry);
  if (!model) {
    throw new Error(
      `Model ${args.rawId} (${resolved.provider}/${resolved.id}) is not registered. ` +
        `Make sure ${resolved.provider} is configured in pi.`,
    );
  }

  const context: Context = {
    systemPrompt: args.systemPrompt,
    messages: [
      {
        role: "user",
        content: args.userPrompt,
        timestamp: Date.now(),
      },
    ],
  };

  // P1 fix: resolve auth credentials from the modelRegistry instead of
  // leaving them undefined. Without this, direct-provider calls (anthropic,
  // openai, google, etc.) for users who authenticated via /login (no env
  // var, no key in settings) would go out unauthenticated and fail with
  // a 401/403 from the provider. The OpenRouter path already resolves
  // auth via the registry inside callOpenRouterChat, but the dispatch
  // path was never wired up.
  let apiKey: string | undefined;
  let headers: Record<string, string> | undefined;
  if (args.modelRegistry) {
    try {
      // eslint-disable-next-line no-console
      console.log('DEBUG providerDispatch calling getApiKeyAndHeaders with model:', JSON.stringify({ id: model.id, provider: model.provider, hasHeaders: !!headers }));
      const auth = await args.modelRegistry.getApiKeyAndHeaders(model);
      // eslint-disable-next-line no-console
      console.log('DEBUG got auth:', JSON.stringify({ ok: auth.ok, apiKey: auth.apiKey, headers: auth.headers, modelId: model.id }));
      if (auth.ok) {
        apiKey = auth.apiKey;
        headers = auth.headers;
      }
    } catch {
      // Registry may not be available in all contexts; the call will
      // proceed without auth and fail with a provider-specific error
      // message that the user can act on.
    }
  }

  try {
    const message = await completeSimple(model, context, {
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
      temperature: args.temperature ?? 0.2,
      maxTokens: args.maxTokens ?? 15000,
    });
    return extractTextFromAssistantMessage(message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Model ${args.rawId} failed: ${reason}`, { cause: error });
  }
}