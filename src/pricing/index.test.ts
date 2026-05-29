import { describe, it, expect } from 'vitest';
import { estimateCost } from './index';

describe('estimateCost', () => {
  it('calculates cost for a known model', () => {
    const cost = estimateCost('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 500 });
    // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('returns null for an unknown model', () => {
    expect(estimateCost('gpt-4o', { input_tokens: 100, output_tokens: 50 })).toBeNull();
  });

  it('returns null for an ollama model', () => {
    expect(estimateCost('ollama/llama3', { input_tokens: 100, output_tokens: 50 })).toBeNull();
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost('claude-sonnet-4-6', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  it('calculates input-only cost correctly', () => {
    const cost = estimateCost('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 0 });
    expect(cost).toBeCloseTo(0.003, 6);
  });

  it('calculates output-only cost correctly', () => {
    const cost = estimateCost('claude-sonnet-4-6', { input_tokens: 0, output_tokens: 1000 });
    expect(cost).toBeCloseTo(0.015, 6);
  });

  it('calculates cost for claude-haiku-4-5', () => {
    const cost = estimateCost('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 1000 });
    // 1000 * 0.000001 + 1000 * 0.000005 = 0.001 + 0.005 = 0.006
    expect(cost).toBeCloseTo(0.006, 6);
  });

  it('calculates cost for claude-opus-4-7', () => {
    const cost = estimateCost('claude-opus-4-7', { input_tokens: 100, output_tokens: 100 });
    // 100 * 0.000005 + 100 * 0.000025 = 0.0005 + 0.0025 = 0.003
    expect(cost).toBeCloseTo(0.003, 6);
  });
});
