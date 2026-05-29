import { describe, it, expect } from 'vitest';
import { extractResponseAttributes } from './telemetry';

describe('extractResponseAttributes', () => {
  it('extracts gen_ai.response.model', () => {
    const attrs = extractResponseAttributes({ model: 'claude-sonnet-4-6' });
    expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
  });

  it('omits gen_ai.response.model when absent', () => {
    const attrs = extractResponseAttributes({});
    expect(attrs['gen_ai.response.model']).toBeUndefined();
  });

  it('omits gen_ai.response.model when not a string', () => {
    const attrs = extractResponseAttributes({ model: 42 });
    expect(attrs['gen_ai.response.model']).toBeUndefined();
  });

  it('extracts input and output token counts from usage', () => {
    const attrs = extractResponseAttributes({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(attrs['gen_ai.usage.input_tokens']).toBe(100);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
  });

  it('defaults missing token counts to 0', () => {
    const attrs = extractResponseAttributes({ usage: {} });
    expect(attrs['gen_ai.usage.input_tokens']).toBe(0);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(0);
  });

  it('omits token counts when usage is absent', () => {
    const attrs = extractResponseAttributes({});
    expect(attrs['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(attrs['gen_ai.usage.output_tokens']).toBeUndefined();
  });

  it('extracts stop_reason as finish_reasons array', () => {
    const attrs = extractResponseAttributes({ stop_reason: 'end_turn' });
    expect(attrs['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  it('omits finish_reasons when stop_reason is absent', () => {
    const attrs = extractResponseAttributes({});
    expect(attrs['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('omits finish_reasons when stop_reason is not a string', () => {
    const attrs = extractResponseAttributes({ stop_reason: null });
    expect(attrs['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('extracts all fields together', () => {
    const attrs = extractResponseAttributes({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
    expect(attrs['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  it('returns an empty object for an empty response', () => {
    expect(extractResponseAttributes({})).toEqual({});
  });
});
