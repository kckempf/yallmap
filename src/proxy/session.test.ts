import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', () => ({ request: vi.fn() }));

const mockSpan = {
  setAttribute: vi.fn(),
  setAttributes: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  recordException: vi.fn(),
};

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startSpan: () => mockSpan }) },
  context: { active: () => ({}) },
  propagation: { extract: (_ctx: unknown, carrier: Record<string, string>) => carrier },
  SpanKind: { CLIENT: 0 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

import { request } from 'undici';
import { createApp } from '../server';
import { anthropicAdapter } from '../adapters';

const mockRequest = vi.mocked(request);

const NON_STREAMING_RESPONSE = JSON.stringify({
  id: 'msg_test', type: 'message', role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'Hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

function mockUpstream(statusCode: number, body: string) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(body)]),
  };
}

const BASE_REQUEST = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
};

describe('session / trace propagation', () => {
  let app: ReturnType<typeof createApp>;
  const provider = { name: 'anthropic', baseUrl: 'https://api.anthropic.com', adapter: anthropicAdapter };

  beforeEach(() => {
    app = createApp({ router: () => [provider] });
    vi.clearAllMocks();
  });

  it('strips x-session-id from upstream headers', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'test-session-123' },
      body: JSON.stringify(BASE_REQUEST),
    });

    const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((options.headers as Record<string, string>)['x-session-id']).toBeUndefined();
  });

  it('sets session.id span attribute when x-session-id header is present', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'agent-run-abc' },
      body: JSON.stringify(BASE_REQUEST),
    });

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('session.id', 'agent-run-abc');
  });

  it('does not set session.id when x-session-id is absent', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    const sessionCalls = mockSpan.setAttribute.mock.calls.filter(([k]) => k === 'session.id');
    expect(sessionCalls).toHaveLength(0);
  });

  it('strips x-capture-content from upstream headers', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-capture-content': 'true' },
      body: JSON.stringify(BASE_REQUEST),
    });

    const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((options.headers as Record<string, string>)['x-capture-content']).toBeUndefined();
  });

  it('captures gen_ai.prompt + gen_ai.completion when x-capture-content=true', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-capture-content': 'true' },
      body: JSON.stringify(BASE_REQUEST),
    });

    const promptCalls = mockSpan.setAttribute.mock.calls.filter(([k]) => k === 'gen_ai.prompt');
    const completionCalls = mockSpan.setAttribute.mock.calls.filter(([k]) => k === 'gen_ai.completion');
    expect(promptCalls).toHaveLength(1);
    expect(completionCalls).toHaveLength(1);
    // Prompt blob contains the original user message
    expect(promptCalls[0][1]).toContain('Hello');
    // Completion blob contains the model's reply
    expect(completionCalls[0][1]).toContain('Hi');
  });

  it('does not capture content when header is absent and env is off', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    const promptCalls = mockSpan.setAttribute.mock.calls.filter(([k]) => k === 'gen_ai.prompt');
    expect(promptCalls).toHaveLength(0);
  });

  it('header value "false" does not opt in to capture', async () => {
    mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-capture-content': 'false' },
      body: JSON.stringify(BASE_REQUEST),
    });

    const promptCalls = mockSpan.setAttribute.mock.calls.filter(([k]) => k === 'gen_ai.prompt');
    expect(promptCalls).toHaveLength(0);
  });
});
