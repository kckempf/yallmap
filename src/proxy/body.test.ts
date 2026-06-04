import { describe, it, expect } from 'vitest';
import { readBodyWithLimit } from './body';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('readBodyWithLimit', () => {
  it('returns an empty buffer for a null stream', async () => {
    const res = await readBodyWithLimit(null, 1024);
    expect(res).toEqual({ ok: true, body: Buffer.alloc(0) });
  });

  it('returns the full body for a single small chunk', async () => {
    const res = await readBodyWithLimit(streamOf(bytes('hello')), 1024);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.toString('utf8')).toBe('hello');
  });

  it('concatenates multiple chunks under the limit', async () => {
    const res = await readBodyWithLimit(
      streamOf(bytes('foo'), bytes('bar'), bytes('baz')),
      1024,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.toString('utf8')).toBe('foobarbaz');
  });

  it('rejects when a single chunk alone exceeds the limit', async () => {
    const big = new Uint8Array(100);
    const res = await readBodyWithLimit(streamOf(big), 50);
    expect(res).toEqual({ ok: false, reason: 'too-large', limit: 50 });
  });

  it('rejects when accumulated chunks exceed the limit', async () => {
    const chunk = new Uint8Array(30);
    const res = await readBodyWithLimit(streamOf(chunk, chunk, chunk), 50);
    expect(res).toEqual({ ok: false, reason: 'too-large', limit: 50 });
  });

  it('cancels the reader after overflow so we stop pulling from the client', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await readBodyWithLimit(stream, 50);
    expect(res.ok).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('exactly-at-the-limit is allowed (off-by-one guard)', async () => {
    const res = await readBodyWithLimit(streamOf(new Uint8Array(50)), 50);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.byteLength).toBe(50);
  });
});
