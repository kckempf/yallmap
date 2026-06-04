import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { version } from '../version';

export interface TelemetryHandle {
  shutdown: () => Promise<void>;
}

export function initTelemetry(): TelemetryHandle {
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
      [ATTR_SERVICE_VERSION]: version,
    }),
    traceExporter: exporter,
    // No auto-instrumentations — we emit gen_ai.* spans explicitly
    instrumentations: [],
    textMapPropagator: new W3CTraceContextPropagator(),
  });

  sdk.start();

  return { shutdown: () => sdk.shutdown() };
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
