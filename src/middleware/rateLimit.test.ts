import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rateLimit } from './rateLimit';
import type { MiddlewareContext } from './types';

const OK = new Response('ok', { status: 200 });
const next = async () => OK;

function makeCtx(apiKey = 'sk-test-key'): MiddlewareContext {
  return {
    requestId: 'test',
    model: 'claude-sonnet-4-6',
    isStreaming: false,
    maxTokens: undefined,
    body: {},
    clientHeaders: { 'x-api-key': apiKey },
  };
}

describe('rateLimit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows requests under the limit', async () => {
    const limiter = rateLimit({ requests: 3, windowMs: 60_000 });
    const ctx = makeCtx();
    for (let i = 0; i < 3; i++) {
      const res = await limiter(ctx, next);
      expect(res.status).toBe(200);
    }
  });

  it('blocks request at the limit with 429 and retry-after', async () => {
    const limiter = rateLimit({ requests: 2, windowMs: 60_000 });
    const ctx = makeCtx();
    await limiter(ctx, next);
    await limiter(ctx, next);

    const res = await limiter(ctx, next);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe('rate_limit_exceeded');
  });

  it('resets the window after windowMs elapses', async () => {
    const limiter = rateLimit({ requests: 1, windowMs: 1_000 });
    const ctx = makeCtx();
    await limiter(ctx, next);

    vi.advanceTimersByTime(1_001);

    const res = await limiter(ctx, next);
    expect(res.status).toBe(200);
  });

  it('tracks separate keys independently', async () => {
    const limiter = rateLimit({ requests: 1, windowMs: 60_000 });
    const ctx1 = makeCtx('key-a');
    const ctx2 = makeCtx('key-b');

    await limiter(ctx1, next);
    const res1 = await limiter(ctx1, next); // second request for key-a → blocked
    expect(res1.status).toBe(429);

    const res2 = await limiter(ctx2, next); // first request for key-b → allowed
    expect(res2.status).toBe(200);
  });

  it('uses custom keyFn when provided', async () => {
    const limiter = rateLimit({
      requests: 1,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.model,
    });
    const ctx = makeCtx();

    await limiter(ctx, next);
    const res = await limiter(ctx, next);
    expect(res.status).toBe(429);
  });

  it('defaults to "global" key when x-api-key header is absent', async () => {
    const limiter = rateLimit({ requests: 1, windowMs: 60_000 });
    const ctx: MiddlewareContext = {
      requestId: 'test',
      model: 'claude-sonnet-4-6',
      isStreaming: false,
      maxTokens: undefined,
      body: {},
      clientHeaders: {},
    };
    await limiter(ctx, next);
    const res = await limiter(ctx, next);
    expect(res.status).toBe(429);
  });
});
