import type { MiddlewareFn, MiddlewareContext } from './types';

export interface RateLimitOptions {
  requests: number;
  windowMs: number;
  keyFn?: (ctx: MiddlewareContext) => string;
}

type Window = { count: number; resetAt: number };
const WINDOWS = new WeakMap<MiddlewareFn, Map<string, Window>>();

export function rateLimit({ requests, windowMs, keyFn }: RateLimitOptions): MiddlewareFn {
  const windows = new Map<string, Window>();
  // Sweep stale entries at most once per windowMs to bound the map's growth
  // from one-shot clients that never return.
  let nextSweepAt = 0;

  const middleware: MiddlewareFn = async (ctx, next) => {
    const key = keyFn
      ? keyFn(ctx)
      : (ctx.auth?.keyId ?? ctx.clientHeaders['x-api-key'] ?? 'global');
    const now = Date.now();

    if (now >= nextSweepAt) {
      for (const [k, w] of windows) {
        if (now >= w.resetAt) windows.delete(k);
      }
      nextSweepAt = now + windowMs;
    }

    let win = windows.get(key);
    if (!win || now >= win.resetAt) {
      win = { count: 0, resetAt: now + windowMs };
      windows.set(key, win);
    }
    if (win.count >= requests) {
      const retryAfter = Math.ceil((win.resetAt - now) / 1000);
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_exceeded',
            message: `Rate limit: ${requests} requests per ${windowMs / 1000}s`,
          },
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
        }
      );
    }
    win.count++;
    return next();
  };

  WINDOWS.set(middleware, windows);
  return middleware;
}

export const __rateLimitInternal = {
  getWindows(mw: MiddlewareFn): Map<string, Window> {
    const w = WINDOWS.get(mw);
    if (!w) throw new Error('not a rateLimit middleware');
    return w;
  },
};
