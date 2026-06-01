import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compose } from './compose';
import type { MiddlewareContext } from './types';

function makeCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    requestId: 'test-id',
    model: 'claude-sonnet-4-6',
    isStreaming: false,
    maxTokens: undefined,
    body: { model: 'claude-sonnet-4-6' },
    clientHeaders: {},
    ...overrides,
  };
}

const OK = new Response('ok', { status: 200 });
const handler = vi.fn(async () => OK);

describe('compose', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls handler when middleware array is empty', async () => {
    handler.mockResolvedValueOnce(OK);
    const run = compose([]);
    const res = await run(makeCtx(), handler);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('calls middleware then handler in order', async () => {
    const order: string[] = [];
    const mw1 = vi.fn(async (ctx, next) => {
      order.push('mw1-before');
      const res = await next();
      order.push('mw1-after');
      return res;
    });
    const mw2 = vi.fn(async (ctx, next) => {
      order.push('mw2-before');
      const res = await next();
      order.push('mw2-after');
      return res;
    });
    handler.mockResolvedValueOnce(OK);

    const run = compose([mw1, mw2]);
    await run(makeCtx(), handler);

    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('short-circuits when middleware does not call next()', async () => {
    const earlyResponse = new Response('blocked', { status: 429 });
    const blocker = vi.fn(async () => earlyResponse);
    handler.mockResolvedValueOnce(OK);

    const run = compose([blocker]);
    const res = await run(makeCtx(), handler);

    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it('body mutation by middleware is visible to handler', async () => {
    const ctx = makeCtx();
    const mutator = vi.fn(async (c, next) => {
      c.body = { ...c.body, messages: [{ role: 'user', content: '[REDACTED]' }] };
      return next();
    });

    let capturedBody: Record<string, unknown> | undefined;
    const capturingHandler = vi.fn(async () => {
      capturedBody = ctx.body;
      return OK;
    });

    const run = compose([mutator]);
    await run(ctx, capturingHandler);

    expect(capturedBody?.messages).toEqual([{ role: 'user', content: '[REDACTED]' }]);
  });

  it('throws when next() is called multiple times', async () => {
    const badMiddleware = vi.fn(async (ctx, next) => {
      await next();
      return next(); // second call
    });
    handler.mockResolvedValue(OK);

    const run = compose([badMiddleware]);
    await expect(run(makeCtx(), handler)).rejects.toThrow('next() called multiple times');
  });
});
