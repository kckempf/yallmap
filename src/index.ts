// OTel SDK must start before any tracer.getTracer() call executes.
// Tracers in proxy.ts are obtained lazily (inside the handler function),
// so starting the SDK here is sufficient.
import { initTelemetry } from './telemetry/index';
const telemetry = initTelemetry();

import { serve } from '@hono/node-server';
import { createApp } from './server';
import { router } from './routing/config';
import { middlewares } from './middleware/config';
import { createShutdownHandler } from './shutdown';
import { logger } from './logger';

const port = parseInt(process.env.PORT ?? '3000', 10);
const shutdownAbort = new AbortController();
const app = createApp({ router, middlewares, shutdownSignal: shutdownAbort.signal });

const server = serve({ fetch: (req) => app.fetch(req), port }, () => {
  console.log(`llm-gateway listening on :${port}`);
});

const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '25000', 10);
const shutdown = createShutdownHandler({
  server,
  shutdownAbort,
  telemetryShutdown: telemetry.shutdown,
  timeoutMs: shutdownTimeoutMs,
  exit: (code) => process.exit(code),
});

process.on('SIGTERM', () => { logger.info('SIGTERM received'); void shutdown(); });
process.on('SIGINT', () => { logger.info('SIGINT received'); void shutdown(); });

process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception', err);
  process.exit(1);
});
