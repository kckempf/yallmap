import { Hono } from 'hono';
import { proxyMessages } from './proxy';
import { type Router } from './routing';

export function createApp(options?: { router?: Router }): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

  app.post('/v1/messages', (c) => proxyMessages(c, options?.router));

  app.notFound((c) =>
    c.json({ type: 'error', error: { type: 'not_found', message: 'route not found' } }, 404)
  );

  app.onError((err, c) => {
    console.error('[server] unhandled error', err);
    return c.json({ type: 'error', error: { type: 'internal_error', message: 'internal server error' } }, 500);
  });

  return app;
}
