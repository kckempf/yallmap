import { describe, it, expect, vi } from 'vitest';
import { apiKeyAuth, parseApiKeys } from './apiKeyAuth';
import type { MiddlewareContext } from './types';

const OK = new Response('ok', { status: 200 });
const next = async () => OK;

function makeCtx(headers: Record<string, string> = {}): MiddlewareContext {
  return {
    requestId: 'test',
    model: 'claude-sonnet-4-6',
    isStreaming: false,
    maxTokens: undefined,
    body: {},
    clientHeaders: headers,
  };
}

describe('apiKeyAuth', () => {
  const keys = new Map([['secret123', 'alice'], ['secret456', 'bob']]);

  it('returns 401 when the gateway header is missing', async () => {
    const auth = apiKeyAuth({ keys });
    const res = await auth(makeCtx(), next);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe('unauthorized');
  });

  it('returns 401 when the presented key is unknown', async () => {
    const auth = apiKeyAuth({ keys });
    const res = await auth(makeCtx({ 'x-gateway-key': 'wrong' }), next);
    expect(res.status).toBe(401);
  });

  it('passes through with a valid key and sets ctx.auth.keyId', async () => {
    const auth = apiKeyAuth({ keys });
    const ctx = makeCtx({ 'x-gateway-key': 'secret123' });
    const res = await auth(ctx, next);
    expect(res.status).toBe(200);
    expect(ctx.auth).toEqual({ keyId: 'alice' });
  });

  it('uses a custom header name when configured', async () => {
    const auth = apiKeyAuth({ keys, headerName: 'authorization' });
    const ctx = makeCtx({ 'authorization': 'secret456' });
    const res = await auth(ctx, next);
    expect(res.status).toBe(200);
    expect(ctx.auth).toEqual({ keyId: 'bob' });
  });

  it('does not call next() when rejected', async () => {
    const auth = apiKeyAuth({ keys });
    const tracked = vi.fn(next);
    await auth(makeCtx(), tracked);
    expect(tracked).not.toHaveBeenCalled();
  });
});

describe('parseApiKeys', () => {
  it('returns an empty map when input is undefined', () => {
    expect(parseApiKeys(undefined).size).toBe(0);
  });

  it('returns an empty map when input is empty string', () => {
    expect(parseApiKeys('').size).toBe(0);
  });

  it('parses a single label:secret pair', () => {
    const map = parseApiKeys('alice:secret123');
    expect(map.get('secret123')).toBe('alice');
    expect(map.size).toBe(1);
  });

  it('parses multiple comma-separated pairs', () => {
    const map = parseApiKeys('alice:secret123,bob:secret456');
    expect(map.get('secret123')).toBe('alice');
    expect(map.get('secret456')).toBe('bob');
  });

  it('trims whitespace around labels and secrets', () => {
    const map = parseApiKeys('  alice : secret123 ,bob:secret456');
    expect(map.get('secret123')).toBe('alice');
    expect(map.get('secret456')).toBe('bob');
  });

  it('drops malformed pairs without a colon', () => {
    const map = parseApiKeys('alice:secret123,malformed,bob:secret456');
    expect(map.size).toBe(2);
    expect(map.get('secret123')).toBe('alice');
    expect(map.get('secret456')).toBe('bob');
  });

  it('drops pairs missing a label or secret', () => {
    const map = parseApiKeys(':secret,alice:,bob:secret456');
    expect(map.size).toBe(1);
    expect(map.get('secret456')).toBe('bob');
  });

  it('preserves a secret that contains colons after the first one', () => {
    const map = parseApiKeys('alice:base64:abc+def==');
    expect(map.get('base64:abc+def==')).toBe('alice');
  });
});
