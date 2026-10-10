import { describe, it, expect, vi } from 'vitest';
import { estimateCost } from './index';

// Fixed prices so the arithmetic tests don't break when the auto-generated table drops or reprices a model.
vi.mock('./anthropic', () => ({
  ANTHROPIC_PRICING: {
    'test-mid': { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    'test-cheap': { inputCostPerToken: 0.000001, outputCostPerToken: 0.000005 },
  },
}));

describe('estimateCost', () => {
  it('calculates cost for a known model', () => {
    const cost = estimateCost('test-mid', { input_tokens: 1000, output_tokens: 500 });
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
    expect(estimateCost('test-mid', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  it('calculates input-only cost correctly', () => {
    const cost = estimateCost('test-mid', { input_tokens: 1000, output_tokens: 0 });
    expect(cost).toBeCloseTo(0.003, 6);
  });

  it('calculates output-only cost correctly', () => {
    const cost = estimateCost('test-mid', { input_tokens: 0, output_tokens: 1000 });
    expect(cost).toBeCloseTo(0.015, 6);
  });

  it('uses each model\'s own prices', () => {
    const cost = estimateCost('test-cheap', { input_tokens: 1000, output_tokens: 1000 });
    // 1000 * 0.000001 + 1000 * 0.000005 = 0.001 + 0.005 = 0.006
    expect(cost).toBeCloseTo(0.006, 6);
  });
});

// Checks the real generated table by shape only, so a routine price update passes but a broken generator run fails.
describe('ANTHROPIC_PRICING (generated)', async () => {
  const { ANTHROPIC_PRICING } = await vi.importActual<typeof import('./anthropic')>('./anthropic');
  const entries = Object.entries(ANTHROPIC_PRICING);

  it('is not empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s has positive finite prices', (_model, pricing) => {
    for (const price of [pricing.inputCostPerToken, pricing.outputCostPerToken]) {
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThan(0);
    }
  });
});
