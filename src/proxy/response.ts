import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import type { Dispatcher } from 'undici';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { Context } from 'hono';
import { SseCapture } from '../telemetry/sse-capture';
import { extractResponseAttributes } from './telemetry';
import { estimateCost } from '../pricing';
import type { Provider } from '../routing';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

export async function handleResponse(
  upstream: Dispatcher.ResponseData,
  provider: Provider,
  span: Span,
  parsedBody: Record<string, unknown>,
  isStreaming: boolean,
  c?: Context,
  captureContent = false,
): Promise<Response> {
  const { adapter } = provider;

  span.setAttribute('gen_ai.system', provider.name);

  if (captureContent) {
    const messages = Array.isArray(parsedBody.messages) ? parsedBody.messages : [];
    const prompt = typeof parsedBody.system === 'string'
      ? [{ role: 'system', content: parsedBody.system }, ...messages]
      : messages;
    span.setAttribute('gen_ai.prompt', JSON.stringify(prompt));
  }

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!value || HOP_BY_HOP.has(key)) continue;
    if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
    else responseHeaders.set(key, value);
  }

  if (isStreaming) {
    const capture = new SseCapture((attrs) => {
      if (Object.keys(attrs).length) {
        span.setAttributes(attrs);
        c?.set('inputTokens' as never, attrs['gen_ai.usage.input_tokens'] as never);
        c?.set('outputTokens' as never, attrs['gen_ai.usage.output_tokens'] as never);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    }, captureContent);

    const passthrough = new PassThrough();
    const handlePipelineError = (err: unknown) => {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    };

    pipeline(upstream.body, adapter.createStreamTranslator(), capture, passthrough).catch(handlePipelineError);

    return new Response(Readable.toWeb(passthrough) as ReadableStream, {
      status: upstream.statusCode,
      headers: responseHeaders,
    });
  }

  // Non-streaming: collect full body, translate if needed, record telemetry
  const responseChunks: Buffer[] = [];
  for await (const chunk of upstream.body) responseChunks.push(chunk as Buffer);
  let responseBody = Buffer.concat(responseChunks);

  try {
    const translated = adapter.translateResponse(JSON.parse(responseBody.toString('utf8')));
    responseBody = Buffer.from(JSON.stringify(translated));
    responseHeaders.set('content-length', String(responseBody.byteLength));
  } catch { /* best-effort; fall through with original body */ }

  try {
    const responseJson = JSON.parse(responseBody.toString('utf8')) as Record<string, unknown>;
    const attrs = extractResponseAttributes(responseJson);
    if (Object.keys(attrs).length) span.setAttributes(attrs);

    if (captureContent && responseJson.content !== undefined) {
      span.setAttribute('gen_ai.completion', JSON.stringify(responseJson.content));
    }

    const usage = responseJson.usage as { input_tokens: number; output_tokens: number } | undefined;
    const model = typeof responseJson.model === 'string' ? responseJson.model : undefined;
    if (usage) {
      c?.set('inputTokens' as never, usage.input_tokens as never);
      c?.set('outputTokens' as never, usage.output_tokens as never);
      if (model) {
        const cost = estimateCost(model, usage);
        if (cost !== null) {
          span.setAttribute('gen_ai.usage.cost_usd', cost);
          c?.set('costUsd' as never, cost as never);
        }
      }
    }
  } catch { /* best-effort telemetry; don't corrupt the response */ }

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  return new Response(responseBody, { status: upstream.statusCode, headers: responseHeaders });
}
