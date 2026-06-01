import { Readable, Transform, PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', () => ({ request: vi.fn() }));

import { request } from 'undici';
import { createApp } from '../server';
import type { ProviderAdapter, Provider, Router } from '../routing';
import { anthropicAdapter } from '../adapters';

const mockRequest = vi.mocked(request);

// Build a minimal mock undici response
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

// Build a mock SSE upstream response
function mockSSEUpstream(events: string[]) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    body: Readable.from(events.map((e) => Buffer.from(e))),
  };
}

const BASE_REQUEST = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
};

const NON_STREAMING_RESPONSE = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'Hi there' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('POST /v1/messages', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  describe('header handling', () => {
    it('strips hop-by-hop headers before forwarding to upstream', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-test',
          'connection': 'keep-alive',       // hop-by-hop — must be stripped
          'transfer-encoding': 'chunked',   // hop-by-hop — must be stripped
          'host': 'localhost',              // hop-by-hop — must be stripped
        },
        body: JSON.stringify(BASE_REQUEST),
      });

      const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
      const forwarded = options.headers as Record<string, string>;
      expect(forwarded['connection']).toBeUndefined();
      expect(forwarded['transfer-encoding']).toBeUndefined();
      expect(forwarded['host']).toBeUndefined();
    });

    it('forwards x-api-key unchanged', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-abc123' },
        body: JSON.stringify(BASE_REQUEST),
      });

      const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
      expect((options.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-abc123');
    });

    it('forwards anthropic-version and anthropic-beta headers', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify(BASE_REQUEST),
      });

      const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
      const forwarded = options.headers as Record<string, string>;
      expect(forwarded['anthropic-version']).toBe('2023-06-01');
      expect(forwarded['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    });

    it('forces accept-encoding: identity regardless of what client sends', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
        body: JSON.stringify(BASE_REQUEST),
      });

      const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
      expect((options.headers as Record<string, string>)['accept-encoding']).toBe('identity');
    });

    it('recomputes content-length from buffered body', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      const body = JSON.stringify(BASE_REQUEST);
      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '9999' }, // wrong
        body,
      });

      const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
      expect((options.headers as Record<string, string>)['content-length']).toBe(
        String(Buffer.byteLength(body))
      );
    });
  });

  describe('non-streaming responses', () => {
    it('returns the upstream status code', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      expect(res.status).toBe(200);
    });

    it('forwards upstream 4xx status codes to the client', async () => {
      const errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } });
      mockRequest.mockResolvedValueOnce(mockUpstream(400, errorBody) as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.type).toBe('invalid_request_error');
    });

    it('forwards upstream 529 (overloaded) to the client when no retries remain', async () => {
      app = createApp({ retryOptions: { maxRetries: 0, baseDelayMs: 0, retryOn: () => false } });
      mockRequest.mockResolvedValueOnce(mockUpstream(529, '{"error":"overloaded"}') as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      expect(res.status).toBe(529);
    });

    it('returns the response body unchanged', async () => {
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      const json = await res.json();
      expect(json.content[0].text).toBe('Hi there');
    });

    it('strips hop-by-hop headers from the response', async () => {
      mockRequest.mockResolvedValueOnce(
        mockUpstream(200, NON_STREAMING_RESPONSE, { 'connection': 'keep-alive', 'transfer-encoding': 'chunked' }) as never
      );
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      expect(res.headers.get('connection')).toBeNull();
      expect(res.headers.get('transfer-encoding')).toBeNull();
    });
  });

  describe('streaming responses', () => {
    const SSE_EVENTS = [
      `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];

    it('returns 200 for a streaming request', async () => {
      mockRequest.mockResolvedValueOnce(mockSSEUpstream(SSE_EVENTS) as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BASE_REQUEST, stream: true }),
      });
      expect(res.status).toBe(200);
    });

    it('returns the SSE content-type header', async () => {
      mockRequest.mockResolvedValueOnce(mockSSEUpstream(SSE_EVENTS) as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BASE_REQUEST, stream: true }),
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });

    it('streams the full SSE body to the client', async () => {
      mockRequest.mockResolvedValueOnce(mockSSEUpstream(SSE_EVENTS) as never);
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BASE_REQUEST, stream: true }),
      });
      const text = await res.text();
      expect(text).toContain('message_start');
      expect(text).toContain('message_stop');
    });
  });

  describe('error handling', () => {
    it('returns 502 when upstream connection fails', async () => {
      mockRequest.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error.type).toBe('proxy_error');
    });

    it('returns 502 on upstream timeout', async () => {
      mockRequest.mockRejectedValueOnce(Object.assign(new Error('Headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }));
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });
      expect(res.status).toBe(502);
    });
  });

  describe('routing', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await app.request('/v1/completions', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('returns 404 for GET /v1/messages', async () => {
      const res = await app.request('/v1/messages', { method: 'GET' });
      expect(res.status).toBe(404);
    });
  });

  describe('provider routing', () => {
    const makeProvider = (name: string, baseUrl: string): Provider => ({ name, baseUrl, adapter: anthropicAdapter });

    it('uses the URL returned by the router', async () => {
      const customProvider = makeProvider('custom', 'https://custom.example.com');
      const router: Router = () => [customProvider];
      app = createApp({ router });
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });

      const [url] = mockRequest.mock.calls[0] as [string, unknown];
      expect(url).toBe('https://custom.example.com/v1/messages');
    });

    it('routes to ollama when model starts with ollama/', async () => {
      const ollamaProvider = makeProvider('ollama', 'http://localhost:11434');
      const router: Router = (ctx) =>
        ctx.model.startsWith('ollama/') ? [ollamaProvider] : [makeProvider('anthropic', 'https://api.anthropic.com')];
      app = createApp({ router });
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BASE_REQUEST, model: 'ollama/llama3' }),
      });

      const [url] = mockRequest.mock.calls[0] as [string, unknown];
      expect(url).toBe('http://localhost:11434/v1/messages');
    });

    it('routes to anthropic fallback for non-ollama models', async () => {
      const ollamaProvider = makeProvider('ollama', 'http://localhost:11434');
      const router: Router = (ctx) =>
        ctx.model.startsWith('ollama/') ? [ollamaProvider] : [makeProvider('anthropic', 'https://api.anthropic.com')];
      app = createApp({ router });
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });

      const [url] = mockRequest.mock.calls[0] as [string, unknown];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
    });

    it('passes stream flag to the router', async () => {
      let capturedStream: boolean | undefined;
      const router: Router = (ctx) => { capturedStream = ctx.stream; return [makeProvider('anthropic', 'https://api.anthropic.com')]; };
      app = createApp({ router });
      mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

      await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BASE_REQUEST, stream: false }),
      });

      expect(capturedStream).toBe(false);
    });
  });

  describe('fallback chains', () => {
    const makeProvider = (name: string, baseUrl: string): Provider => ({ name, baseUrl, adapter: anthropicAdapter });
    // Disable retries for fallback tests — retry behaviour is tested separately
    const noRetry = { maxRetries: 0, baseDelayMs: 0, retryOn: () => false };

    it('falls back to the second provider when the first has a network error', async () => {
      const primary = makeProvider('primary', 'https://primary.example.com');
      const secondary = makeProvider('secondary', 'https://secondary.example.com');
      const router: Router = () => [primary, secondary];
      app = createApp({ router, retryOptions: noRetry });

      mockRequest
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });

      expect(res.status).toBe(200);
      const [url] = mockRequest.mock.calls[1] as [string, unknown];
      expect(url).toBe('https://secondary.example.com/v1/messages');
    });

    it('falls back to the second provider when the first returns 5xx', async () => {
      const primary = makeProvider('primary', 'https://primary.example.com');
      const secondary = makeProvider('secondary', 'https://secondary.example.com');
      const router: Router = () => [primary, secondary];
      app = createApp({ router, retryOptions: noRetry });

      mockRequest
        .mockResolvedValueOnce(mockUpstream(503, '{"error":"unavailable"}') as never)
        .mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });

      expect(res.status).toBe(200);
      const [, secondUrl] = mockRequest.mock.calls.map(([url]) => url) as string[];
      expect(secondUrl).toBe('https://secondary.example.com/v1/messages');
    });

    it('returns 502 when all providers fail', async () => {
      const router: Router = () => [
        makeProvider('p1', 'https://p1.example.com'),
        makeProvider('p2', 'https://p2.example.com'),
      ];
      app = createApp({ router, retryOptions: noRetry });

      mockRequest
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });

      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error.type).toBe('proxy_error');
    });

    it('does not retry on 4xx — forwards the error response directly', async () => {
      const primary = makeProvider('primary', 'https://primary.example.com');
      const secondary = makeProvider('secondary', 'https://secondary.example.com');
      const router: Router = () => [primary, secondary];
      app = createApp({ router, retryOptions: noRetry });

      const errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } });
      mockRequest.mockResolvedValueOnce(mockUpstream(400, errorBody) as never);

      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BASE_REQUEST),
      });

      expect(res.status).toBe(400);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('falls back to secondary for 5xx even when streaming', async () => {
      const primary = makeProvider('primary', 'https://primary.example.com');
      const secondary = makeProvider('secondary', 'https://secondary.example.com');
      const router: Router = () => [primary, secondary];
      app = createApp({ router, retryOptions: noRetry });

      const SSE_EVENTS = [
        `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ];
      mockRequest
        .mockResolvedValueOnce(mockUpstream(503, '{"error":"unavailable"}') as never)
        .mockResolvedValueOnce(mockSSEUpstream(SSE_EVENTS) as never);

      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BASE_REQUEST, stream: true }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('message_stop');
    });
  });

  describe('adapter integration', () => {
    function makeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
      return {
        path: '/v2/translated',
        translateRequest: (body) => ({ ...body, _translated: true }),
        translateResponse: (body) => ({
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          model: 'translated-model',
          content: [{ type: 'text', text: 'TRANSLATED' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          ...body,
        }),
        createStreamTranslator: () => new PassThrough(),
        ...overrides,
      };
    }

    function providerWithAdapter(adapter: ProviderAdapter): Provider {
      return { name: 'test', baseUrl: 'https://test.example.com', adapter };
    }

    beforeEach(() => {
      app = createApp({ router: () => [providerWithAdapter(makeAdapter())] });
    });

    describe('request translation', () => {
      it('sends the translated request body to upstream', async () => {
        mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
        await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(BASE_REQUEST),
        });

        const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
        const sentBody = JSON.parse((options.body as Buffer).toString('utf8'));
        expect(sentBody._translated).toBe(true);
      });

      it('uses adapter.path instead of /v1/messages', async () => {
        mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);
        await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(BASE_REQUEST),
        });

        const [url] = mockRequest.mock.calls[0] as [string, unknown];
        expect(url).toBe('https://test.example.com/v2/translated');
      });

      it('recomputes content-length for the translated body', async () => {
        const largeBody = { ...BASE_REQUEST, _extra: 'x'.repeat(500) };
        const adapter = makeAdapter({
          translateRequest: (body) => ({ ...body, _extra: 'x'.repeat(500) }),
        });
        app = createApp({ router: () => [providerWithAdapter(adapter)] });
        mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

        await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '9999' },
          body: JSON.stringify(largeBody),
        });

        const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
        const sentBody = (options.body as Buffer);
        const forwarded = options.headers as Record<string, string>;
        expect(forwarded['content-length']).toBe(String(sentBody.byteLength));
      });

      it('anthropicAdapter is identity — body reaches upstream untranslated', async () => {
        app = createApp({ router: () => [{ name: 'anthropic', baseUrl: 'https://api.anthropic.com', adapter: anthropicAdapter }] });
        mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

        await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(BASE_REQUEST),
        });

        const [, options] = mockRequest.mock.calls[0] as [unknown, Record<string, unknown>];
        const sentBody = JSON.parse((options.body as Buffer).toString('utf8'));
        expect(sentBody._translated).toBeUndefined();
        expect(sentBody.model).toBe(BASE_REQUEST.model);
      });
    });

    describe('non-streaming response translation', () => {
      it('returns the adapter-translated response to the client', async () => {
        const translatedResponse = JSON.stringify({
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          model: 'translated-model',
          content: [{ type: 'text', text: 'TRANSLATED' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        const adapter = makeAdapter({
          translateResponse: () => JSON.parse(translatedResponse),
        });
        app = createApp({ router: () => [providerWithAdapter(adapter)] });
        mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

        const res = await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(BASE_REQUEST),
        });

        const json = await res.json() as Record<string, unknown>;
        expect((json.content as Array<{ text: string }>)[0].text).toBe('TRANSLATED');
      });

      it('updates content-length to match the translated body size', async () => {
        const shortBody = JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hi' }] });
        const adapter = makeAdapter({ translateResponse: () => JSON.parse(shortBody) });
        app = createApp({ router: () => [providerWithAdapter(adapter)] });
        mockRequest.mockResolvedValueOnce(
          mockUpstream(200, NON_STREAMING_RESPONSE, { 'content-length': '9999' }) as never
        );

        const res = await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(BASE_REQUEST),
        });

        expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(shortBody)));
      });

      it('returns the original response if translation throws', async () => {
        const adapter = makeAdapter({
          translateResponse: () => { throw new Error('translation failed'); },
        });
        app = createApp({ router: () => [providerWithAdapter(adapter)] });
        mockRequest.mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

        const res = await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(BASE_REQUEST),
        });

        expect(res.status).toBe(200);
        const json = await res.json() as Record<string, unknown>;
        expect((json.content as Array<{ text: string }>)[0].text).toBe('Hi there');
      });
    });

    describe('streaming response translation', () => {
      it('pipes the upstream body through the adapter stream translator', async () => {
        const SSE_EVENTS = [
          `event: message_start\ndata: {"type":"message_start","message":{"model":"adapter-model","usage":{"input_tokens":1,"output_tokens":0}}}\n\n`,
          `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
        ];
        const adapter = makeAdapter({
          createStreamTranslator: () => {
            let emitted = false;
            return new Transform({
              transform(_chunk, _enc, cb) {
                if (!emitted) {
                  emitted = true;
                  for (const e of SSE_EVENTS) this.push(e);
                }
                cb();
              },
              flush(cb) { cb(); },
            });
          },
        });
        app = createApp({ router: () => [providerWithAdapter(adapter)] });

        const upstreamChunks = ['data: upstream-chunk\n\n'];
        mockRequest.mockResolvedValueOnce({
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: Readable.from(upstreamChunks.map((e) => Buffer.from(e))),
        } as never);

        const res = await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...BASE_REQUEST, stream: true }),
        });

        const text = await res.text();
        expect(text).toContain('adapter-model');
        expect(text).toContain('message_stop');
      });
    });
  });
});

describe('retry behaviour', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => { vi.clearAllMocks(); });

  const makeProvider = (name: string, baseUrl: string): Provider => ({ name, baseUrl, adapter: anthropicAdapter });

  it('retries the same provider on 429 and succeeds on next attempt', async () => {
    const router = () => [makeProvider('anthropic', 'https://api.anthropic.com')];
    app = createApp({
      router,
      retryOptions: { maxRetries: 2, baseDelayMs: 0, retryOn: (s) => s === 429 },
    });

    mockRequest
      .mockResolvedValueOnce(mockUpstream(429, '{"error":"rate_limit"}', { 'retry-after': '0' }) as never)
      .mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    expect(res.status).toBe(200);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [url1] = mockRequest.mock.calls[0] as [string, unknown];
    const [url2] = mockRequest.mock.calls[1] as [string, unknown];
    expect(url1).toBe('https://api.anthropic.com/v1/messages');
    expect(url2).toBe('https://api.anthropic.com/v1/messages');
  });

  it('retries the same provider on 503', async () => {
    const router = () => [makeProvider('anthropic', 'https://api.anthropic.com')];
    app = createApp({
      router,
      retryOptions: { maxRetries: 1, baseDelayMs: 0, retryOn: (s) => s === 503 },
    });

    mockRequest
      .mockResolvedValueOnce(mockUpstream(503, '{"error":"unavailable"}') as never)
      .mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    expect(res.status).toBe(200);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('forwards the retryable status after exhausting all attempts on a single provider', async () => {
    const router = () => [makeProvider('anthropic', 'https://api.anthropic.com')];
    app = createApp({
      router,
      retryOptions: { maxRetries: 1, baseDelayMs: 0, retryOn: (s) => s === 529 },
    });

    mockRequest
      .mockResolvedValueOnce(mockUpstream(529, '{"error":"overloaded"}') as never)
      .mockResolvedValueOnce(mockUpstream(529, '{"error":"overloaded"}') as never);

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    expect(res.status).toBe(529);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('retries successfully when Retry-After is absent (falls back to baseDelayMs=0)', async () => {
    const router = () => [makeProvider('anthropic', 'https://api.anthropic.com')];
    app = createApp({
      router,
      retryOptions: { maxRetries: 1, baseDelayMs: 0, retryOn: (s) => s === 429 },
    });

    mockRequest
      .mockResolvedValueOnce(mockUpstream(429, '{"error":"rate_limit"}') as never)
      .mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    expect(res.status).toBe(200);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('falls through to next provider after exhausting retries', async () => {
    const primary = makeProvider('primary', 'https://primary.example.com');
    const secondary = makeProvider('secondary', 'https://secondary.example.com');
    const router = () => [primary, secondary];
    app = createApp({
      router,
      retryOptions: { maxRetries: 1, baseDelayMs: 0, retryOn: (s) => s === 429 },
    });

    mockRequest
      .mockResolvedValueOnce(mockUpstream(429, '{"error":"rate_limit"}', { 'retry-after': '0' }) as never)
      .mockResolvedValueOnce(mockUpstream(429, '{"error":"rate_limit"}', { 'retry-after': '0' }) as never)
      .mockResolvedValueOnce(mockUpstream(200, NON_STREAMING_RESPONSE) as never);

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE_REQUEST),
    });

    expect(res.status).toBe(200);
    expect(mockRequest).toHaveBeenCalledTimes(3);
    const [thirdUrl] = mockRequest.mock.calls[2] as [string, unknown];
    expect(thirdUrl).toBe('https://secondary.example.com/v1/messages');
  });
});

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.version).toBe('0.1.0');
  });
});
