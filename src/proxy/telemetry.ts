import type { SpanAttributes } from '@opentelemetry/api';

export function extractResponseAttributes(
  responseJson: Record<string, unknown>
): SpanAttributes {
  const attrs: SpanAttributes = {};

  if (typeof responseJson.model === 'string')
    attrs['gen_ai.response.model'] = responseJson.model;

  const usage = responseJson.usage as Record<string, number> | undefined;
  if (usage) {
    attrs['gen_ai.usage.input_tokens'] = usage.input_tokens ?? 0;
    attrs['gen_ai.usage.output_tokens'] = usage.output_tokens ?? 0;
  }

  if (typeof responseJson.stop_reason === 'string')
    attrs['gen_ai.response.finish_reasons'] = [responseJson.stop_reason];

  return attrs;
}
