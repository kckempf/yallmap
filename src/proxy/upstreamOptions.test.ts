import { describe, it, expect } from 'vitest';
import { buildUpstreamOptions, chainSignals } from './upstreamOptions';

describe('buildUpstreamOptions', () => {
  const ac = new AbortController();

  it('uses sensible defaults when env is empty', () => {
    const opts = buildUpstreamOptions({ signal: ac.signal, env: {} });
    expect(opts.headersTimeout).toBe(30_000);
    expect(opts.bodyTimeout).toBe(300_000);
  });

  it('reads UPSTREAM_HEADERS_TIMEOUT_MS from env', () => {
    const opts = buildUpstreamOptions({
      signal: ac.signal,
      env: { UPSTREAM_HEADERS_TIMEOUT_MS: '5000' },
    });
    expect(opts.headersTimeout).toBe(5_000);
    expect(opts.bodyTimeout).toBe(300_000);
  });

  it('reads UPSTREAM_BODY_TIMEOUT_MS from env', () => {
    const opts = buildUpstreamOptions({
      signal: ac.signal,
      env: { UPSTREAM_BODY_TIMEOUT_MS: '120000' },
    });
    expect(opts.headersTimeout).toBe(30_000);
    expect(opts.bodyTimeout).toBe(120_000);
  });

  it('falls back to default on unparseable values', () => {
    const opts = buildUpstreamOptions({
      signal: ac.signal,
      env: { UPSTREAM_HEADERS_TIMEOUT_MS: 'abc', UPSTREAM_BODY_TIMEOUT_MS: '' },
    });
    expect(opts.headersTimeout).toBe(30_000);
    expect(opts.bodyTimeout).toBe(300_000);
  });

  it('falls back to default on non-positive values', () => {
    const opts = buildUpstreamOptions({
      signal: ac.signal,
      env: { UPSTREAM_HEADERS_TIMEOUT_MS: '0', UPSTREAM_BODY_TIMEOUT_MS: '-1' },
    });
    expect(opts.headersTimeout).toBe(30_000);
    expect(opts.bodyTimeout).toBe(300_000);
  });

  it('passes the AbortSignal through unchanged', () => {
    const opts = buildUpstreamOptions({ signal: ac.signal, env: {} });
    expect(opts.signal).toBe(ac.signal);
  });
});

describe('chainSignals', () => {
  it('aborting any source aborts the target controller', () => {
    const a = new AbortController();
    const b = new AbortController();
    const target = new AbortController();
    chainSignals(target, a.signal, b.signal);

    expect(target.signal.aborted).toBe(false);
    b.abort('shutdown');
    expect(target.signal.aborted).toBe(true);
  });

  it('treats already-aborted sources as immediate cancellation', () => {
    const a = new AbortController();
    a.abort('client gone');
    const target = new AbortController();
    chainSignals(target, a.signal);
    expect(target.signal.aborted).toBe(true);
  });

  it('ignores undefined sources', () => {
    const target = new AbortController();
    const cleanup = chainSignals(target, undefined, undefined);
    expect(target.signal.aborted).toBe(false);
    cleanup();
  });

  it('the returned cleanup function detaches listeners (no abort after cleanup)', () => {
    const a = new AbortController();
    const target = new AbortController();
    const cleanup = chainSignals(target, a.signal);
    cleanup();
    a.abort();
    expect(target.signal.aborted).toBe(false);
  });
});
