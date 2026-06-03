import { Hono } from 'hono';
import { proxyMessages } from './proxy/index';
import { type Router } from './routing';
import { type RetryOptions } from './proxy/retry';
import { type MiddlewareFn } from './middleware/types';
import { logger } from './logger';
import { version } from './version';

type Variables = {
  requestId: string;
  model?: string;
  provider?: string;
  keyId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export function createApp(options?: { router?: Router; retryOptions?: RetryOptions; middlewares?: MiddlewareFn[] }): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    c.set('requestId', requestId);
    const start = Date.now();
    await next();
    logger.info({
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latencyMs: Date.now() - start,
      model: c.get('model'),
      provider: c.get('provider'),
      keyId: c.get('keyId'),
      inputTokens: c.get('inputTokens'),
      outputTokens: c.get('outputTokens'),
      costUsd: c.get('costUsd'),
    });
  });

  app.get('/health', (c) => c.json({ status: 'ok', version }));

  app.use('/v1/messages', async (c, next) => {
    const len = parseInt(c.req.header('content-length') ?? '0', 10);
    const max = parseInt(process.env.MAX_BODY_BYTES ?? '4194304', 10);
    if (len > max) {
      return c.json(
        { type: 'error', error: { type: 'request_too_large', message: `body exceeds ${max} bytes` } },
        413
      );
    }
    return next();
  });

  app.post('/v1/messages', (c) => proxyMessages(c, options?.router, options?.retryOptions, options?.middlewares));

  app.notFound((c) =>
    c.json({ type: 'error', error: { type: 'not_found', message: 'route not found' } }, 404)
  );

  app.onError((err, c) => {
    logger.error({ err }, 'unhandled server error');
    return c.json({ type: 'error', error: { type: 'internal_error', message: 'internal server error' } }, 500);
  });

  return app;
}
