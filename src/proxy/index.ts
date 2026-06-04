import { request as undiciRequest } from 'undici';
import { trace, context, propagation, SpanKind } from '@opentelemetry/api';
import type { Context } from 'hono';
import { firstMatch, type Router } from '../routing';
import { handleResponse } from './response';
import { defaultRetryOptions, backoffDelay, retryAfterDelay, sleep } from './retry';
import type { RetryOptions } from './retry';
import { readBodyWithLimit } from './body';
import { buildUpstreamOptions, chainSignals } from './upstreamOptions';
import { logger } from '../logger';
import { compose } from '../middleware/compose';
import type { MiddlewareFn, MiddlewareContext } from '../middleware/types';
import { version } from '../version';

const FALLBACK_ROUTER = firstMatch([]);
const CAPTURE_CONTENT = process.env.CAPTURE_CONTENT === 'true';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
  'x-session-id',  // gateway-only header — not forwarded upstream
]);

export async function proxyMessages(
  c: Context,
  router: Router = FALLBACK_ROUTER,
  retryOptions: RetryOptions = defaultRetryOptions(),
  middlewares: MiddlewareFn[] = [],
  shutdownSignal?: AbortSignal,
): Promise<Response> {
  const maxBodyBytes = parseInt(process.env.MAX_BODY_BYTES ?? '4194304', 10);
  const bodyResult = await readBodyWithLimit(c.req.raw.body, maxBodyBytes);
  if (!bodyResult.ok) {
    return new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'request_too_large', message: `body exceeds ${bodyResult.limit} bytes` },
      }),
      { status: 413, headers: { 'content-type': 'application/json' } },
    );
  }
  const rawBody = bodyResult.body;

  let parsedBody: Record<string, unknown> = {};
  try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch { /* pass through */ }

  const model = typeof parsedBody.model === 'string' ? parsedBody.model : 'unknown';
  const isStreaming = parsedBody.stream === true;
  const maxTokens = typeof parsedBody.max_tokens === 'number' ? parsedBody.max_tokens : undefined;

  const requestId: string = (c as Context & { get: (k: string) => string }).get('requestId') ?? 'unknown';
  c.set('model' as never, model as never);

  // Extract W3C trace context from incoming headers so agent-loop spans nest correctly
  const carrier: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) carrier[k] = v;
  const parentCtx = propagation.extract(context.active(), carrier);

  const sessionId = c.req.header('x-session-id');

  const clientHeaders: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (HOP_BY_HOP.has(key)) continue;
    clientHeaders[key] = value;
  }
  clientHeaders['accept-encoding'] = 'identity';

  const ctx: MiddlewareContext = {
    requestId,
    model,
    isStreaming,
    maxTokens,
    body: parsedBody,
    clientHeaders,
  };

  const runProxy = async (): Promise<Response> => {
    if (ctx.auth?.keyId) c.set('keyId' as never, ctx.auth.keyId as never);
    const providers = router({ model: ctx.model, stream: ctx.isStreaming });

    const tracer = trace.getTracer('llm-gateway', version);
    const span = tracer.startSpan('gen_ai.request', {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.request.model': ctx.model,
        ...(ctx.maxTokens !== undefined ? { 'gen_ai.request.max_tokens': ctx.maxTokens } : {}),
      },
    }, parentCtx);

    if (sessionId) span.setAttribute('session.id', sessionId);
    if (ctx.auth?.keyId) span.setAttribute('user.id', ctx.auth.keyId);

    let lastError: unknown;
    const { maxRetries, baseDelayMs, retryOn } = retryOptions;

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const hasNext = i < providers.length - 1;
      const { adapter, modelOverride } = provider;
      const upstreamPath = adapter.path;
      const bodyForAdapter = modelOverride ? { ...ctx.body, model: modelOverride } : ctx.body;
      const upstreamBody = Buffer.from(JSON.stringify(adapter.translateRequest(bodyForAdapter)));

      const upstreamHeaders = {
        ...clientHeaders,
        'content-length': String(upstreamBody.byteLength),
      };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const ac = new AbortController();
        const cleanup = chainSignals(ac, c.req.raw.signal, shutdownSignal);
        try {
          const upstream = await undiciRequest(`${provider.baseUrl}${upstreamPath}`, {
            method: 'POST',
            headers: upstreamHeaders,
            body: upstreamBody,
            ...buildUpstreamOptions({ signal: ac.signal }),
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
          return await handleResponse(upstream, provider, span, ctx.body, ctx.isStreaming, c, CAPTURE_CONTENT);

        } catch (err) {
          lastError = err;
          logger.warn({ requestId, provider: provider.name, err }, 'network error — trying next provider');
          break; // network error — don't retry same provider, try next in chain
        } finally {
          cleanup();
        }
      }
    }

    logger.error({ requestId, model: ctx.model, providers: providers.map((p) => p.name), err: lastError }, 'all providers exhausted — returning 502');
    span.recordException(lastError as Error);
    span.setStatus({ code: 2 /* ERROR */, message: String(lastError) });
    span.end();
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'upstream request failed' } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  };

  return middlewares.length ? compose(middlewares)(ctx, runProxy) : runProxy();
}
