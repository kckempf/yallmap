import { describe, it, expect } from 'vitest';
import { backoffDelay, retryAfterDelay, defaultRetryOptions } from './retry';

describe('backoffDelay (equal jitter)', () => {
  const fixed = (n: number) => () => n;

  it('returns half the exponential cap when random returns 0 (the floor)', () => {
    // floor = base * 2^attempt / 2
    expect(backoffDelay(0, 1000, fixed(0))).toBe(500);
    expect(backoffDelay(1, 1000, fixed(0))).toBe(1000);
    expect(backoffDelay(2, 1000, fixed(0))).toBe(2000);
  });

  it('returns the full exponential cap when random returns 1', () => {
    expect(backoffDelay(0, 1000, fixed(1))).toBe(1000);
    expect(backoffDelay(1, 1000, fixed(1))).toBe(2000);
    expect(backoffDelay(2, 1000, fixed(1))).toBe(4000);
  });

  it('jitters within [cap/2, cap]', () => {
    expect(backoffDelay(1, 1000, fixed(0.5))).toBe(1500);
  });

  it('never waits less than the previous attempt (floor >= prev cap)', () => {
    const prevMax = backoffDelay(1, 1000, fixed(1)); // 2000
    const nextMin = backoffDelay(2, 1000, fixed(0)); // 2000
    expect(nextMin).toBeGreaterThanOrEqual(prevMax);
  });

  it('uses Math.random by default and stays within [cap/2, cap]', () => {
    const delay = backoffDelay(0, 1000);
    expect(delay).toBeGreaterThanOrEqual(500);
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

  it('honors values above 60 seconds (no longer discarded)', () => {
    expect(retryAfterDelay({ 'retry-after': '120' })).toBe(120000);
  });

  it('clamps very large values to the max budget (default 300s)', () => {
    expect(retryAfterDelay({ 'retry-after': '3600' })).toBe(300000);
  });

  it('respects a custom max cap', () => {
    expect(retryAfterDelay({ 'retry-after': '120' }, 60000)).toBe(60000);
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
