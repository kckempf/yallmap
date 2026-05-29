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

export function backoffDelay(attempt: number, baseMs: number, random = Math.random): number {
  return random() * baseMs * Math.pow(2, attempt);
}

export function retryAfterDelay(
  headers: Record<string, string | string[] | undefined>
): number | null {
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = parseInt(value, 10);
  if (isNaN(seconds) || seconds <= 0 || seconds > 60) return null;
  return seconds * 1000;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
