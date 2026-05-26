import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', () => ({ request: vi.fn() }));

import { request } from 'undici';
import { createApp } from './server';

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

    it('forwards upstream 529 (overloaded) to the client', async () => {
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
