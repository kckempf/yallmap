import { Readable, PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { anthropicAdapter, type ProviderAdapter } from '../adapters';

function makeSpan() {
  return {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
  };
}

function mockUpstream(
  statusCode: number,
  body: string | Buffer,
  headers: Record<string, string> = {}
) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]),
  };
}

function mockSSEUpstream(events: string[]) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    body: Readable.from(events.map((e) => Buffer.from(e))),
  };
}

const NON_STREAMING_RESPONSE = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'Hi there' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

const PROVIDER = { name: 'anthropic', baseUrl: 'https://api.anthropic.com', adapter: anthropicAdapter };
const STREAMING_BODY = JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] });

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: vi.fn() },
  SpanKind: { CLIENT: 0 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

import { handleResponse } from './response';

describe('handleResponse — non-streaming', () => {
  let span: ReturnType<typeof makeSpan>;

  beforeEach(() => {
    span = makeSpan();
  });

  it('returns the upstream status code', async () => {
    const res = await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE) as never,
      PROVIDER, span as never, {}, false
    );
    expect(res.status).toBe(200);
  });

  it('forwards 4xx status codes unchanged', async () => {
    const error = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } });
    const res = await handleResponse(
      mockUpstream(400, error) as never,
      PROVIDER, span as never, {}, false
    );
    expect(res.status).toBe(400);
  });

  it('returns the response body', async () => {
    const res = await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE) as never,
      PROVIDER, span as never, {}, false
    );
    const json = await res.json() as Record<string, unknown>;
    expect((json.content as Array<{text: string}>)[0].text).toBe('Hi there');
  });

  it('strips hop-by-hop headers from the response', async () => {
    const res = await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE, { 'connection': 'keep-alive', 'transfer-encoding': 'chunked' }) as never,
      PROVIDER, span as never, {}, false
    );
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
  });

  it('sets gen_ai.system on the span', async () => {
    await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE) as never,
      PROVIDER, span as never, {}, false
    );
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
  });

  it('sets response telemetry attributes on the span', async () => {
    await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE) as never,
      PROVIDER, span as never, {}, false
    );
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'gen_ai.response.model': 'claude-sonnet-4-6',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 5,
      })
    );
  });

  it('sets cost attribute on the span for known models', async () => {
    await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE) as never,
      PROVIDER, span as never, {}, false
    );
    // 10 * 0.000003 + 5 * 0.000015 = 0.00003 + 0.000075 = 0.000105
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cost_usd', expect.any(Number));
  });

  it('does not set cost attribute for unknown models', async () => {
    const unknownModelResponse = JSON.stringify({
      ...JSON.parse(NON_STREAMING_RESPONSE),
      model: 'gpt-4o',
    });
    await handleResponse(
      mockUpstream(200, unknownModelResponse) as never,
      PROVIDER, span as never, {}, false
    );
    const costCall = span.setAttribute.mock.calls.find(([k]) => k === 'gen_ai.usage.cost_usd');
    expect(costCall).toBeUndefined();
  });

  it('closes the span with OK status', async () => {
    await handleResponse(
      mockUpstream(200, NON_STREAMING_RESPONSE) as never,
      PROVIDER, span as never, {}, false
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  describe('adapter translation', () => {
    function makeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
      return {
        path: '/v2/translated',
        translateRequest: (b) => b,
        translateResponse: () => JSON.parse(NON_STREAMING_RESPONSE),
        createStreamTranslator: () => new PassThrough(),
        ...overrides,
      };
    }

    it('translates the response body via the adapter', async () => {
      const provider = { ...PROVIDER, adapter: makeAdapter({ translateResponse: () => ({ content: [{ type: 'text', text: 'TRANSLATED' }] }) }) };
      const res = await handleResponse(
        mockUpstream(200, '{"raw":"body"}') as never,
        provider, span as never, {}, false
      );
      const json = await res.json() as Record<string, unknown>;
      expect((json.content as Array<{text: string}>)[0].text).toBe('TRANSLATED');
    });

    it('updates content-length after translation', async () => {
      const shortBody = JSON.stringify({ content: [{ type: 'text', text: 'hi' }] });
      const provider = { ...PROVIDER, adapter: makeAdapter({ translateResponse: () => JSON.parse(shortBody) }) };
      const res = await handleResponse(
        mockUpstream(200, NON_STREAMING_RESPONSE, { 'content-length': '9999' }) as never,
        provider, span as never, {}, false
      );
      expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(shortBody)));
    });

    it('falls back to the original body if translation throws', async () => {
      const provider = { ...PROVIDER, adapter: makeAdapter({ translateResponse: () => { throw new Error('fail'); } }) };
      const res = await handleResponse(
        mockUpstream(200, NON_STREAMING_RESPONSE) as never,
        provider, span as never, {}, false
      );
      const json = await res.json() as Record<string, unknown>;
      expect((json.content as Array<{text: string}>)[0].text).toBe('Hi there');
    });
  });
});

describe('handleResponse — streaming', () => {
  let span: ReturnType<typeof makeSpan>;

  const SSE_EVENTS = [
    `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];

  beforeEach(() => {
    span = makeSpan();
  });

  it('returns 200 immediately without waiting for stream to finish', async () => {
    const res = await handleResponse(
      mockSSEUpstream(SSE_EVENTS) as never,
      PROVIDER, span as never, {}, true
    );
    expect(res.status).toBe(200);
  });

  it('returns the SSE content-type header', async () => {
    const res = await handleResponse(
      mockSSEUpstream(SSE_EVENTS) as never,
      PROVIDER, span as never, {}, true
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('streams the full SSE body to the client', async () => {
    const res = await handleResponse(
      mockSSEUpstream(SSE_EVENTS) as never,
      PROVIDER, span as never, {}, true
    );
    const text = await res.text();
    expect(text).toContain('message_start');
    expect(text).toContain('message_stop');
  });

  it('sets gen_ai.system on the span', async () => {
    const res = await handleResponse(
      mockSSEUpstream(SSE_EVENTS) as never,
      PROVIDER, span as never, {}, true
    );
    await res.text(); // drain stream
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
  });
});
