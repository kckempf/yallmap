// OTel SDK must start before any tracer.getTracer() call executes.
// Tracers in proxy.ts are obtained lazily (inside the handler function),
// so starting the SDK here is sufficient.
import { initTelemetry } from './telemetry/index';
initTelemetry();

import { serve } from '@hono/node-server';
import { createApp } from './server';
import { router } from './routing/config';

const port = parseInt(process.env.PORT ?? '3000', 10);
const app = createApp({ router });

serve({ fetch: (req) => app.fetch(req), port }, () => {
  console.log(`llm-gateway listening on :${port}`);
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception', err);
  process.exit(1);
});
