/**
 * Minimal Qdrant REST client using fetch.
 */

export async function ensureQdrantCollection(args: {
  baseUrl: string;
  apiKey?: string;
  collection: string;
  vectorSize: number;
  distance?: "Cosine" | "Dot" | "Euclid";
  signal?: AbortSignal;
}): Promise<void> {
  const { baseUrl, apiKey, collection, vectorSize, distance = "Cosine", signal } = args;

  // Check if collection exists
  const checkResponse = await fetch(`${baseUrl}/collections/${collection}`, {
    method: "GET",
    headers: {
      ...(apiKey ? { "api-key": apiKey } : {}),
    },
    signal,
  });

  if (checkResponse.ok) {
    // Collection already exists
    return;
  }

  if (checkResponse.status !== 404) {
    const errorText = await checkResponse.text();
    throw new Error(`Failed to check Qdrant collection: ${checkResponse.status} - ${errorText}`);
  }

  // Create collection
  const createResponse = await fetch(`${baseUrl}/collections/${collection}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance,
      },
    }),
    signal,
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Failed to create Qdrant collection: ${createResponse.status} - ${errorText}`);
  }
}

export async function upsertQdrantPoint(args: {
  baseUrl: string;
  apiKey?: string;
  collection: string;
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<void> {
  const { baseUrl, apiKey, collection, id, vector, payload, signal } = args;

  const response = await fetch(`${baseUrl}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      points: [
        {
          id,
          vector,
          payload,
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upsert Qdrant point: ${response.status} - ${errorText}`);
  }
}
