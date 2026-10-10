import { describe, it, expect, vi } from 'vitest';
import { costGuard } from './costGuard';
import type { MiddlewareContext } from './types';

// Fixed prices so these tests don't break when the auto-generated table drops or reprices a model.
vi.mock('../pricing/anthropic', () => ({
  ANTHROPIC_PRICING: {
    'test-cheap': { inputCostPerToken: 0.000001, outputCostPerToken: 0.000005 },
    'test-expensive': { inputCostPerToken: 0.000015, outputCostPerToken: 0.000075 },
  },
}));

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
    // test-cheap: $0.000001/in + $0.000005/out → 1000 tokens worst-case = $0.006
    const guard = costGuard(0.01);
    const res = await guard(makeCtx('test-cheap', 1000), next);
    expect(res.status).toBe(200);
  });

  it('rejects 429 when estimated cost exceeds limit', async () => {
    // test-expensive: $0.000015/in + $0.000075/out → 10_000 tokens = $0.90
    const guard = costGuard(0.50);
    const res = await guard(makeCtx('test-expensive', 10_000), next);
    expect(res.status).toBe(429);
    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('cost_limit_exceeded');
  });

  it('treats undefined maxTokens as 0 tokens (cost = $0 — always passes)', async () => {
    const guard = costGuard(0.0001);
    const res = await guard(makeCtx('test-expensive', undefined), next);
    expect(res.status).toBe(200);
  });

  it('error body includes estimated and limit amounts', async () => {
    const guard = costGuard(0.01);
    const res = await guard(makeCtx('test-expensive', 10_000), next);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/0\.9000/);
    expect(body.error.message).toMatch(/0\.0100/);
  });
});
