export async function callOpenRouterChat(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  structuredOutputSchema?: unknown;
  structuredOutputName?: string;
}): Promise<string> {
  const {
    apiKey,
    model,
    systemPrompt,
    userPrompt,
    signal,
    // 15k tokens for longer responses with file snippets
    maxTokens = 15000,
    temperature = 0.2,
    structuredOutputSchema,
    structuredOutputName,
  } = args;

  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  // Add structured output if schema is provided
  if (structuredOutputSchema) {
    requestBody.response_format = {
      type: "json_schema",
      json_schema: {
        name: structuredOutputName ?? "structured_response",
        strict: true,
        schema: structuredOutputSchema,
      },
    };
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "Pi Model Council",
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };

  const content = data.choices?.[0]?.message?.content;

  if (content === null || content === undefined) {
    throw new Error("No content in response");
  }

  // Handle array of content parts
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: string } =>
        typeof part === "object" && part !== null && part.type === "text"
      )
      .map(part => part.text ?? "")
      .join("");
  }

  return content;
}

export function extractJsonObject(text: string): unknown {
  // First try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Continue to fallback methods
  }

  // Remove markdown code fences
  const withoutFences = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(withoutFences);
  } catch {
    // Continue to substring extraction
  }

  // Find first { and last }
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonSubstring = withoutFences.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonSubstring);
    } catch {
      throw new Error(`Failed to parse JSON from text. Extracted substring length: ${jsonSubstring.length}`);
    }
  }

  throw new Error("No JSON object found in text");
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// --- OpenRouter discovery & validation ---

export async function fetchOpenRouterModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    data: Array<{ id: string; name?: string; created?: number }>;
  };

  return data.data.map(m => ({
    id: m.id,
    name: m.name ?? m.id,
  }));
}

export async function pingOpenRouter(apiKey: string): Promise<{
  ok: boolean;
  error?: string;
  quota?: string;
}> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      if (response.status === 401) return { ok: false, error: "Invalid API key" };
      if (response.status === 403) return { ok: false, error: "Forbidden — check API key permissions" };
      if (response.status === 429) return { ok: false, error: "Rate limited — try again later" };
      return { ok: false, error: `HTTP ${response.status}` };
    }

    // Parse quota from x-current-credits header
    const quotaHeader = response.headers.get("x-current-credits");
    const quota = quotaHeader ? `$${parseFloat(quotaHeader).toFixed(2)} remaining` : undefined;

    return { ok: true, quota };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network error" };
  }
}
