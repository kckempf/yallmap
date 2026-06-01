import { describe, it, expect } from 'vitest';
import { costGuard } from './costGuard';
import type { MiddlewareContext } from './types';

const OK = new Response('ok', { status: 200 });
const next = async () => OK;

function makeCtx(model: string, maxTokens?: number): MiddlewareContext {
  return {
    requestId: 'test',
    model,
    isStreaming: false,
    maxTokens,
    body: { model },
    clientHeaders: {},
  };
}

describe('costGuard', () => {
  it('passes through when model is not in pricing table', async () => {
    const guard = costGuard(0.001);
    const res = await guard(makeCtx('ollama/qwen3:8b', 10_000), next);
    expect(res.status).toBe(200);
  });

  it('passes through when estimated cost is within limit', async () => {
    // claude-haiku-4-5: $0.000001/in + $0.000005/out → 1000 tokens worst-case = $0.006
    const guard = costGuard(0.01);
    const res = await guard(makeCtx('claude-haiku-4-5', 1000), next);
    expect(res.status).toBe(200);
  });

  it('rejects 429 when estimated cost exceeds limit', async () => {
    // claude-3-opus-20240229: $0.000015/in + $0.000075/out → 10_000 tokens = $0.90
    const guard = costGuard(0.50);
    const res = await guard(makeCtx('claude-3-opus-20240229', 10_000), next);
    expect(res.status).toBe(429);
    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('cost_limit_exceeded');
  });

  it('treats undefined maxTokens as 0 tokens (cost = $0 — always passes)', async () => {
    const guard = costGuard(0.0001);
    const res = await guard(makeCtx('claude-3-opus-20240229', undefined), next);
    expect(res.status).toBe(200);
  });

  it('error body includes estimated and limit amounts', async () => {
    const guard = costGuard(0.01);
    const res = await guard(makeCtx('claude-3-opus-20240229', 10_000), next);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/0\.9000/);
    expect(body.error.message).toMatch(/0\.0100/);
  });
});
