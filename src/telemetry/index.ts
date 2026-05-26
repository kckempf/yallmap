import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export function initTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.warn('[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set — spans will be discarded');
  }

  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: buildOtlpHeaders(),
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'llm-gateway',
      [ATTR_SERVICE_VERSION]: '0.1.0',
    }),
    traceExporter: exporter,
    // No auto-instrumentations — we emit gen_ai.* spans explicitly
    instrumentations: [],
  });

  sdk.start();

  const shutdown = () => {
    sdk.shutdown()
      .then(() => process.exit(0))
      .catch((err) => { console.error('[telemetry] shutdown error', err); process.exit(1); });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export function buildOtlpHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // Parse standard OTEL_EXPORTER_OTLP_HEADERS="key=value,key2=value2"
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (rawHeaders) {
    for (const pair of rawHeaders.split(',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }

  // Langfuse-specific convenience: build Basic auth from public/secret keys
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (pub && sec) {
    headers['Authorization'] = `Basic ${Buffer.from(`${pub}:${sec}`).toString('base64')}`;
  }

  return headers;
}
