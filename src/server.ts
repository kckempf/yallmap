import { Hono } from 'hono';
import { proxyMessages } from './proxy/index';
import { type Router } from './routing';
import { type RetryOptions } from './proxy/retry';
import { type MiddlewareFn } from './middleware/types';
import { logger } from './logger';

type Variables = {
  requestId: string;
  model?: string;
  provider?: string;
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
      inputTokens: c.get('inputTokens'),
      outputTokens: c.get('outputTokens'),
      costUsd: c.get('costUsd'),
    });
  });

  app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

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
