import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context } from 'hono';
import { SseCapture } from './telemetry/sse-capture';
import { firstMatch, type Router } from './routing';

const FALLBACK_ROUTER = firstMatch([]);

// Headers that must not be forwarded between proxies
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

export async function proxyMessages(c: Context, router: Router = FALLBACK_ROUTER): Promise<Response> {
  // Buffer the request body — it's JSON and always small relative to the response stream
  const rawBody = Buffer.from(await c.req.arrayBuffer());

  // Parse only what we need for routing and telemetry; never rewrite or re-serialize
  let parsedBody: Record<string, unknown> = {};
  try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch { /* pass through whatever was sent */ }

  const model = typeof parsedBody.model === 'string' ? parsedBody.model : 'unknown';
  const isStreaming = parsedBody.stream === true;
  const maxTokens = typeof parsedBody.max_tokens === 'number' ? parsedBody.max_tokens : undefined;

  const providers = router({ model, stream: isStreaming });

  // Build client header map once; content-length is set per-provider below
  const clientHeaders: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (HOP_BY_HOP.has(key)) continue; // Hono normalises header names to lowercase
    clientHeaders[key] = value;
  }
  // Force uncompressed — the gateway reads the response stream for telemetry
  clientHeaders['accept-encoding'] = 'identity';

  // Tracer obtained lazily so OTel SDK is guaranteed to be initialized first
  const tracer = trace.getTracer('llm-gateway', '0.1.0');
  const span = tracer.startSpan('gen_ai.request', {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.request.model': model,
      ...(maxTokens !== undefined ? { 'gen_ai.request.max_tokens': maxTokens } : {}),
    },
  });

  let lastError: unknown;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const hasNext = i < providers.length - 1;
    const { adapter } = provider;
    const upstreamPath = adapter ? adapter.path : '/v1/messages';
    const upstreamBody = adapter
      ? Buffer.from(JSON.stringify(adapter.translateRequest(parsedBody)))
      : rawBody;

    const upstreamHeaders = {
      ...clientHeaders,
      'content-length': String(upstreamBody.byteLength),
    };

    try {
      const upstream = await undiciRequest(`${provider.baseUrl}${upstreamPath}`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: upstreamBody,
        headersTimeout: 30_000,
        bodyTimeout: 300_000, // 5 min ceiling for long generations
      });

      // 5xx with more providers available — drain and try the next one
      if (upstream.statusCode >= 500 && hasNext) {
        for await (const _ of upstream.body) { /* drain to free the connection */ }
        lastError = new Error(`upstream ${provider.name} returned ${upstream.statusCode}`);
        continue;
      }

      // We have a usable response — record which provider handled it
      span.setAttribute('gen_ai.system', provider.name);

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
        const handlePipelineError = (err: unknown) => {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        };

        if (adapter) {
          pipeline(upstream.body, adapter.createStreamTranslator(), capture, passthrough).catch(handlePipelineError);
        } else {
          pipeline(upstream.body, capture, passthrough).catch(handlePipelineError);
        }

        return new Response(Readable.toWeb(passthrough) as ReadableStream, {
          status: upstream.statusCode,
          headers: responseHeaders,
        });
      }

      // Non-streaming: collect full response body, translate if needed, record telemetry, then send
      const responseChunks: Buffer[] = [];
      for await (const chunk of upstream.body) responseChunks.push(chunk as Buffer);
      let responseBody = Buffer.concat(responseChunks);

      if (adapter) {
        try {
          const translated = adapter.translateResponse(JSON.parse(responseBody.toString('utf8')));
          responseBody = Buffer.from(JSON.stringify(translated));
          responseHeaders.set('content-length', String(responseBody.byteLength));
        } catch { /* best-effort; fall through with original body */ }
      }

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
      lastError = err;
      // Network-level error — try the next provider in the chain
    }
  }

  // All providers exhausted
  span.recordException(lastError as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(lastError) });
  span.end();
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'upstream request failed' } }),
    { status: 502, headers: { 'content-type': 'application/json' } }
  );
}
