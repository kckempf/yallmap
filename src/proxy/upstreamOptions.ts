export interface UpstreamOptionsInput {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
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

export function buildUpstreamOptions(input: UpstreamOptionsInput): UpstreamOptions {
  const env = input.env ?? process.env;
  return {
    headersTimeout: parsePositiveInt(env.UPSTREAM_HEADERS_TIMEOUT_MS, DEFAULT_HEADERS_TIMEOUT_MS),
    bodyTimeout: parsePositiveInt(env.UPSTREAM_BODY_TIMEOUT_MS, DEFAULT_BODY_TIMEOUT_MS),
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
