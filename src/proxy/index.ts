import { request as undiciRequest } from 'undici';
import { trace, SpanKind } from '@opentelemetry/api';
import type { Context } from 'hono';
import { firstMatch, type Router } from '../routing';
import { handleResponse } from './response';
import { defaultRetryOptions, backoffDelay, retryAfterDelay, sleep } from './retry';
import type { RetryOptions } from './retry';
import { logger } from '../logger';

const FALLBACK_ROUTER = firstMatch([]);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

export async function proxyMessages(
  c: Context,
  router: Router = FALLBACK_ROUTER,
  retryOptions: RetryOptions = defaultRetryOptions(),
): Promise<Response> {
  const rawBody = Buffer.from(await c.req.arrayBuffer());

  let parsedBody: Record<string, unknown> = {};
  try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch { /* pass through */ }

  const model = typeof parsedBody.model === 'string' ? parsedBody.model : 'unknown';
  const isStreaming = parsedBody.stream === true;
  const maxTokens = typeof parsedBody.max_tokens === 'number' ? parsedBody.max_tokens : undefined;

  const providers = router({ model, stream: isStreaming });
  const requestId: string = (c as Context & { get: (k: string) => string }).get('requestId') ?? 'unknown';
  c.set('model' as never, model as never);

  const clientHeaders: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (HOP_BY_HOP.has(key)) continue;
    clientHeaders[key] = value;
  }
  clientHeaders['accept-encoding'] = 'identity';

  const tracer = trace.getTracer('llm-gateway', '0.1.0');
  const span = tracer.startSpan('gen_ai.request', {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.request.model': model,
      ...(maxTokens !== undefined ? { 'gen_ai.request.max_tokens': maxTokens } : {}),
    },
  });

  let lastError: unknown;
  const { maxRetries, baseDelayMs, retryOn } = retryOptions;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const hasNext = i < providers.length - 1;
    const { adapter } = provider;
    const upstreamPath = adapter.path;
    const upstreamBody = Buffer.from(JSON.stringify(adapter.translateRequest(parsedBody)));

    const upstreamHeaders = {
      ...clientHeaders,
      'content-length': String(upstreamBody.byteLength),
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const upstream = await undiciRequest(`${provider.baseUrl}${upstreamPath}`, {
          method: 'POST',
          headers: upstreamHeaders,
          body: upstreamBody,
          headersTimeout: 30_000,
          bodyTimeout: 300_000,
        });

        if (retryOn(upstream.statusCode)) {
          if (attempt < maxRetries) {
            for await (const _ of upstream.body) { /* drain */ }
            const delayMs = retryAfterDelay(upstream.headers as Record<string, string | string[] | undefined>)
              ?? backoffDelay(attempt, baseDelayMs);
            lastError = new Error(`upstream ${provider.name} returned ${upstream.statusCode}`);
            logger.warn({ requestId, provider: provider.name, attempt, statusCode: upstream.statusCode, delayMs }, 'rate limited — retrying');
            await sleep(delayMs);
            continue;
          }
          // Exhausted retries — if another provider is available, fall through to it
          if (hasNext) {
            for await (const _ of upstream.body) { /* drain */ }
            lastError = new Error(`upstream ${provider.name} returned ${upstream.statusCode}`);
            logger.warn({ requestId, provider: provider.name, statusCode: upstream.statusCode }, 'retries exhausted — trying next provider');
            break;
          }
          // Last provider — forward the response as-is (preserves 429/503/529 to client)
        }

        // Non-retryable 5xx with more providers available — try next provider
        if (upstream.statusCode >= 500 && !retryOn(upstream.statusCode) && hasNext) {
          for await (const _ of upstream.body) { /* drain */ }
          lastError = new Error(`upstream ${provider.name} returned ${upstream.statusCode}`);
          logger.warn({ requestId, provider: provider.name, statusCode: upstream.statusCode }, 'upstream error — trying next provider');
          break;
        }

        c.set('provider' as never, provider.name as never);
        return await handleResponse(upstream, provider, span, parsedBody, isStreaming, c);

      } catch (err) {
        lastError = err;
        logger.warn({ requestId, provider: provider.name, err }, 'network error — trying next provider');
        break; // network error — don't retry same provider, try next in chain
      }
    }
  }

  span.recordException(lastError as Error);
  span.setStatus({ code: 2 /* ERROR */, message: String(lastError) });
  span.end();
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'upstream request failed' } }),
    { status: 502, headers: { 'content-type': 'application/json' } }
  );
}
