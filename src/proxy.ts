import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context } from 'hono';
import { SseCapture } from './telemetry/sse-capture';

const UPSTREAM_BASE = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');

// Headers that must not be forwarded between proxies
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

export async function proxyMessages(c: Context): Promise<Response> {
  // Buffer the request body — it's JSON and always small relative to the response stream
  const rawBody = Buffer.from(await c.req.arrayBuffer());

  // Parse only what we need for telemetry; never rewrite or re-serialize
  let parsedBody: Record<string, unknown> = {};
  try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch { /* pass through whatever was sent */ }

  const model = typeof parsedBody.model === 'string' ? parsedBody.model : 'unknown';
  const isStreaming = parsedBody.stream === true;
  const maxTokens = typeof parsedBody.max_tokens === 'number' ? parsedBody.max_tokens : undefined;

  // Forward all client headers except hop-by-hop; recompute content-length from buffered body
  const upstreamHeaders: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (HOP_BY_HOP.has(key)) continue; // Hono normalises header names to lowercase
    upstreamHeaders[key] = value;
  }
  upstreamHeaders['content-length'] = String(rawBody.byteLength);
  // Force uncompressed — the gateway reads the response stream for telemetry
  upstreamHeaders['accept-encoding'] = 'identity';

  // Tracer obtained lazily so OTel SDK is guaranteed to be initialized first
  const tracer = trace.getTracer('llm-gateway', '0.1.0');
  const span = tracer.startSpan('gen_ai.request', {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': model,
      ...(maxTokens !== undefined ? { 'gen_ai.request.max_tokens': maxTokens } : {}),
    },
  });

  try {
    const upstream = await undiciRequest(`${UPSTREAM_BASE}/v1/messages`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: rawBody,
      headersTimeout: 30_000,
      bodyTimeout: 300_000, // 5 min ceiling for long generations
    });

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (!value || HOP_BY_HOP.has(key)) continue;
      if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
      else responseHeaders.set(key, value);
    }

    if (isStreaming) {
      const capture = new SseCapture((attrs) => {
        if (Object.keys(attrs).length) span.setAttributes(attrs);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      });

      const passthrough = new PassThrough();

      // Run pipeline in background — errors recorded on span, passthrough destroyed automatically
      pipeline(upstream.body, capture, passthrough).catch((err) => {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      });

      return new Response(Readable.toWeb(passthrough) as ReadableStream, {
        status: upstream.statusCode,
        headers: responseHeaders,
      });
    }

    // Non-streaming: collect full response body, record telemetry, then send
    const responseChunks: Buffer[] = [];
    for await (const chunk of upstream.body) responseChunks.push(chunk as Buffer);
    const responseBody = Buffer.concat(responseChunks);

    try {
      const responseJson = JSON.parse(responseBody.toString('utf8')) as Record<string, unknown>;
      if (typeof responseJson.model === 'string') {
        span.setAttribute('gen_ai.response.model', responseJson.model);
      }
      const usage = responseJson.usage as Record<string, number> | undefined;
      if (usage) {
        span.setAttributes({
          'gen_ai.usage.input_tokens': usage.input_tokens ?? 0,
          'gen_ai.usage.output_tokens': usage.output_tokens ?? 0,
        });
      }
      if (typeof responseJson.stop_reason === 'string') {
        span.setAttribute('gen_ai.response.finish_reasons', [responseJson.stop_reason]);
      }
    } catch { /* best-effort telemetry; don't corrupt the response */ }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return new Response(responseBody, { status: upstream.statusCode, headers: responseHeaders });

  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    span.end();
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'upstream request failed' } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }
}
