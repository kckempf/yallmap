import type { MiddlewareFn, MiddlewareContext } from './types';

export interface RateLimitOptions {
  requests: number;
  windowMs: number;
  keyFn?: (ctx: MiddlewareContext) => string;
}

export function rateLimit({ requests, windowMs, keyFn }: RateLimitOptions): MiddlewareFn {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return async (ctx, next) => {
    const key = keyFn ? keyFn(ctx) : (ctx.clientHeaders['x-api-key'] ?? 'global');
    const now = Date.now();
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
}
