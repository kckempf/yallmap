import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../server';

// fetch() is used inside forwardOtlpTraces to reach the upstream (Langfuse)
// OTLP endpoint. Tests replace it with a spy so no network egress happens.
const originalFetch = global.fetch;

function encodeCredsToBase64(pub: string, sec: string): string {
  return Buffer.from(`${pub}:${sec}`).toString('base64');
}

describe('POST /otel/v1/traces (OTLP proxy)', () => {
  let app: ReturnType<typeof createApp>;

  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const originalPub = process.env.LANGFUSE_PUBLIC_KEY;
  const originalSec = process.env.LANGFUSE_SECRET_KEY;
  const originalHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  beforeEach(() => {
    app = createApp();
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    process.env.LANGFUSE_PUBLIC_KEY = originalPub;
    process.env.LANGFUSE_SECRET_KEY = originalSec;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = originalHeaders;
    global.fetch = originalFetch;
  });

  it('forwards body bytes to the configured upstream and injects Langfuse Basic auth', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.test/api/public/otel';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';

    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const res = await app.request('/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe('http://langfuse.test/api/public/otel/v1/traces');
    expect(capturedInit?.method).toBe('POST');

    const headers = capturedInit?.headers as Record<string, string>;
    const expectedAuth = `Basic ${encodeCredsToBase64('pk-test', 'sk-test')}`;
    expect(headers['Authorization']).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/x-protobuf');

    // Body bytes forwarded unchanged
    const forwardedBody = new Uint8Array(capturedInit?.body as ArrayBuffer);
    expect(Array.from(forwardedBody)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('returns 202 (accepted) when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const res = await app.request('/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('appends /v1/traces to the base endpoint (strips trailing slash first)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.test/api/public/otel/';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';

    let capturedUrl: string | URL | Request | undefined;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = url;
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    await app.request('/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([1]),
    });

    expect(capturedUrl).toBe('http://langfuse.test/api/public/otel/v1/traces');
  });

  it('does not double-append when the endpoint already ends with /v1/traces', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      'http://langfuse.test/api/public/otel/v1/traces';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';

    let capturedUrl: string | URL | Request | undefined;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = url;
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    await app.request('/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([1]),
    });

    expect(capturedUrl).toBe('http://langfuse.test/api/public/otel/v1/traces');
  });

  it('passes upstream status code through (401 → 401)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.test/api/public/otel';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';

    global.fetch = vi.fn(async () =>
      new Response(new Uint8Array(), { status: 401 })
    ) as typeof fetch;

    const res = await app.request('/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([1]),
    });

    expect(res.status).toBe(401);
  });

  it('returns 502 when the upstream fetch throws', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.test/api/public/otel';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';

    global.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;

    const res = await app.request('/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([1]),
    });

    expect(res.status).toBe(502);
  });
});
