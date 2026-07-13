import type { Context } from 'hono';
import { buildOtlpHeaders } from './index';
import { logger } from '../logger';

// OTLP trace proxy. Downstream services set OTEL_EXPORTER_OTLP_ENDPOINT
// to http://<yallmap>/otel — the standard OTLP HTTP exporter appends
// /v1/traces itself, and this handler forwards those bytes to the real
// Langfuse OTLP endpoint with yallmap's own Langfuse auth (via
// buildOtlpHeaders) injected. Downstream .env files never hold Langfuse
// credentials — one credential source, one place mistakes can be made.
//
// yallmap's own spans (initTelemetry in ./index.ts) still export directly
// to Langfuse via the SDK; they don't loop through this proxy. This route
// exists purely for other services pointing at yallmap.

function forwardUrlFor(path: string): string | null {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return null;
  // Idempotent path handling: OTel convention is that
  // OTEL_EXPORTER_OTLP_ENDPOINT is the base (e.g. .../api/public/otel) and
  // the per-signal path (/v1/traces) is appended by the exporter. But
  // people often set the full traces URL directly. Tolerate both — append
  // only when it's not already there.
  const trimmed = base.replace(/\/$/, '');
  return trimmed.endsWith(path) ? trimmed : trimmed + path;
}

export async function forwardOtlpTraces(c: Context): Promise<Response> {
  const forwardUrl = forwardUrlFor('/v1/traces');
  if (!forwardUrl) {
    // No upstream configured — accept and drop. Keeps downstream
    // exporters from erroring loudly in dev when Langfuse isn't wired up.
    logger.warn('otel_forward_no_upstream');
    return c.body(null, 202);
  }

  const body = await c.req.arrayBuffer();
  const contentType = c.req.header('content-type') ?? 'application/x-protobuf';

  try {
    const upstream = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        ...buildOtlpHeaders(),
        'Content-Type': contentType,
      },
      body,
    });

    if (upstream.status >= 400) {
      logger.error(
        { forwardUrl, status: upstream.status },
        'otel_forward_upstream_error'
      );
    }

    const responseBody = await upstream.arrayBuffer();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'Content-Type':
          upstream.headers.get('Content-Type') ?? 'application/x-protobuf',
      },
    });
  } catch (err) {
    logger.error({ err, forwardUrl }, 'otel_forward_fetch_failed');
    return c.json(
      {
        type: 'error',
        error: { type: 'upstream_error', message: 'otel export failed' },
      },
      502
    );
  }
}
