import { describe, it, expect } from 'vitest';
import { backoffDelay, retryAfterDelay, defaultRetryOptions } from './retry';

describe('backoffDelay', () => {
  const fixed = (n: number) => () => n;

  it('returns 0 when random returns 0', () => {
    expect(backoffDelay(0, 1000, fixed(0))).toBe(0);
  });

  it('scales with attempt number (exponential)', () => {
    // attempt 0: max = base * 2^0 = base
    // attempt 1: max = base * 2^1 = 2*base
    // attempt 2: max = base * 2^2 = 4*base
    expect(backoffDelay(0, 1000, fixed(1))).toBe(1000);
    expect(backoffDelay(1, 1000, fixed(1))).toBe(2000);
    expect(backoffDelay(2, 1000, fixed(1))).toBe(4000);
  });

  it('applies full jitter via the random function', () => {
    expect(backoffDelay(1, 1000, fixed(0.5))).toBe(1000);
  });

  it('uses Math.random by default (returns a number)', () => {
    const delay = backoffDelay(0, 1000);
    expect(typeof delay).toBe('number');
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(1000);
  });
});

describe('retryAfterDelay', () => {
  it('returns delay in ms for a valid Retry-After header', () => {
    expect(retryAfterDelay({ 'retry-after': '5' })).toBe(5000);
  });

  it('returns null when the header is absent', () => {
    expect(retryAfterDelay({})).toBeNull();
  });

  it('returns null for a non-numeric value', () => {
    expect(retryAfterDelay({ 'retry-after': 'Wed, 21 Oct 2025 07:28:00 GMT' })).toBeNull();
  });

  it('returns null for zero seconds', () => {
    expect(retryAfterDelay({ 'retry-after': '0' })).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(retryAfterDelay({ 'retry-after': '-1' })).toBeNull();
  });

  it('returns null for values above 60 seconds', () => {
    expect(retryAfterDelay({ 'retry-after': '61' })).toBeNull();
  });

  it('returns delay for the maximum sane value (60s)', () => {
    expect(retryAfterDelay({ 'retry-after': '60' })).toBe(60000);
  });

  it('handles array header values (takes first)', () => {
    expect(retryAfterDelay({ 'retry-after': ['10', '20'] })).toBe(10000);
  });
});

describe('defaultRetryOptions', () => {
  it('retryOn returns true for 429', () => {
    expect(defaultRetryOptions().retryOn(429)).toBe(true);
  });

  it('retryOn returns true for 503', () => {
    expect(defaultRetryOptions().retryOn(503)).toBe(true);
  });

  it('retryOn returns true for 529', () => {
    expect(defaultRetryOptions().retryOn(529)).toBe(true);
  });

  it('retryOn returns false for 500', () => {
    expect(defaultRetryOptions().retryOn(500)).toBe(false);
  });

  it('retryOn returns false for 502', () => {
    expect(defaultRetryOptions().retryOn(502)).toBe(false);
  });

  it('retryOn returns false for 200', () => {
    expect(defaultRetryOptions().retryOn(200)).toBe(false);
  });
});
