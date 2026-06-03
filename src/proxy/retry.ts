export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  retryOn: (statusCode: number) => boolean;
}

export function defaultRetryOptions(): RetryOptions {
  return {
    maxRetries: parseInt(process.env.MAX_RETRIES ?? '3', 10),
    baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS ?? '1000', 10),
    retryOn: (s) => s === 429 || s === 503 || s === 529,
  };
}

// Equal jitter: wait at least half the exponential cap, then jitter the rest
// within [cap/2, cap]. Unlike full jitter (random * cap), the delay grows
// monotonically with the attempt number, so a low random draw can't make a
// later retry fire sooner than an earlier one — which is what let retries
// hammer the upstream back-to-back and exhaust the budget in ~3s.
export function backoffDelay(attempt: number, baseMs: number, random = Math.random): number {
  const cap = baseMs * Math.pow(2, attempt);
  const floor = cap / 2;
  return floor + random() * floor;
}

// Upper bound on how long we'll honor an upstream Retry-After. Anthropic can
// return values well over a minute on 429s; clamp rather than discard so we
// still back off for the right order of magnitude instead of falling back to
// sub-second jitter that ignores the server's instruction entirely.
const RETRY_AFTER_MAX_MS = parseInt(process.env.RETRY_AFTER_MAX_MS ?? '300000', 10);

export function retryAfterDelay(
  headers: Record<string, string | string[] | undefined>,
  maxMs = RETRY_AFTER_MAX_MS
): number | null {
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = parseInt(value, 10);
  if (isNaN(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, maxMs);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
