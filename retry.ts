/**
 * Timeout and retry helpers for council model calls.
 */

/**
 * Execute a promise with a timeout.
 */
export async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();

  // If parent signal aborts, abort child
  const parentAbortHandler = () => {
    controller.abort();
  };

  if (parentSignal) {
    parentSignal.addEventListener("abort", parentAbortHandler);
  }

  // Set timeout
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await promiseFactory(controller.signal);
    return result;
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", parentAbortHandler);
    }
  }
}

/**
 * Retry an operation with a delay between attempts.
 */
export async function retry<T>(args: {
  attempts: number;
  delayMs: number;
  operation: (attempt: number) => Promise<T>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}): Promise<{ value: T; attemptCount: number }> {
  const { attempts, delayMs, operation, shouldRetry } = args;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await operation(attempt);
      return { value, attemptCount: attempt };
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetryThis = shouldRetry?.(error, attempt) ?? true;

      if (shouldRetryThis && attempt < attempts) {
        // Delay before next attempt
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // All attempts failed
  throw lastError;
}

/**
 * Check if an error is likely due to structured output not being supported.
 */
export function isStructuredOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const indicators = [
    "response_format",
    "json_schema",
    "structured",
    "unsupported",
    "does not support",
    "400",
    "invalid request",
  ];

  return indicators.some((indicator) => message.includes(indicator));
}
