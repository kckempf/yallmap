export interface UpstreamOptionsInput {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Per-provider hints — used when no env-var override is set. */
  provider?: { headersTimeoutMs?: number; bodyTimeoutMs?: number };
}

export interface UpstreamOptions {
  headersTimeout: number;
  bodyTimeout: number;
  signal: AbortSignal;
}

const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 300_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Precedence for each timeout value: env var (global user override) wins, then
 * provider hint (knows its own characteristics), then a conservative default.
 */
export function buildUpstreamOptions(input: UpstreamOptionsInput): UpstreamOptions {
  const env = input.env ?? process.env;
  const providerHeaders = input.provider?.headersTimeoutMs;
  const providerBody = input.provider?.bodyTimeoutMs;
  return {
    headersTimeout: parsePositiveInt(
      env.UPSTREAM_HEADERS_TIMEOUT_MS,
      providerHeaders ?? DEFAULT_HEADERS_TIMEOUT_MS,
    ),
    bodyTimeout: parsePositiveInt(
      env.UPSTREAM_BODY_TIMEOUT_MS,
      providerBody ?? DEFAULT_BODY_TIMEOUT_MS,
    ),
    signal: input.signal,
  };
}

export function chainSignals(
  target: AbortController,
  ...sources: (AbortSignal | undefined)[]
): () => void {
  const cleanups: Array<() => void> = [];

  for (const source of sources) {
    if (!source) continue;
    if (source.aborted) {
      target.abort((source as AbortSignal & { reason?: unknown }).reason);
      continue;
    }
    const onAbort = () => {
      target.abort((source as AbortSignal & { reason?: unknown }).reason);
    };
    source.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => source.removeEventListener('abort', onAbort));
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}
