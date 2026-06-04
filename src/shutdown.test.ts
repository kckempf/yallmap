import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShutdownHandler } from './shutdown';

interface FakeServer {
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
}

function fakeServer(closeBehavior: 'resolve' | 'hang' | 'error' = 'resolve'): FakeServer {
  const close = vi.fn((cb: (err?: Error) => void) => {
    if (closeBehavior === 'resolve') queueMicrotask(() => cb());
    if (closeBehavior === 'error') queueMicrotask(() => cb(new Error('close failed')));
    // hang: never invokes cb
  });
  return { close, closeAllConnections: vi.fn() };
}

describe('createShutdownHandler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('happy path: aborts, closes server, shuts down telemetry, exits 0 — in order', async () => {
    const sequence: string[] = [];
    const shutdownAbort = new AbortController();
    shutdownAbort.signal.addEventListener('abort', () => sequence.push('abort'));

    const server = fakeServer('resolve');
    server.close.mockImplementation((cb: (err?: Error) => void) => {
      sequence.push('close');
      queueMicrotask(() => cb());
    });

    const telemetryShutdown = vi.fn(async () => { sequence.push('telemetry'); });
    const exit = vi.fn(() => { sequence.push('exit'); }) as unknown as (code: number) => never;

    const handler = createShutdownHandler({ server: server as never, shutdownAbort, telemetryShutdown, timeoutMs: 5000, exit });
    const done = handler();
    await vi.runAllTimersAsync();
    await done;

    expect(sequence).toEqual(['abort', 'close', 'telemetry', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces closeAllConnections when server.close hangs past timeoutMs', async () => {
    const shutdownAbort = new AbortController();
    const server = fakeServer('hang');
    const telemetryShutdown = vi.fn(async () => {});
    const exit = vi.fn() as unknown as (code: number) => never;

    const handler = createShutdownHandler({ server: server as never, shutdownAbort, telemetryShutdown, timeoutMs: 1000, exit });
    const done = handler();

    // Before timeout: closeAllConnections not yet called
    await vi.advanceTimersByTimeAsync(500);
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    // After timeout: forced close
    await vi.advanceTimersByTimeAsync(600);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();
    await done;
    expect(telemetryShutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when telemetryShutdown rejects', async () => {
    const shutdownAbort = new AbortController();
    const server = fakeServer('resolve');
    const telemetryShutdown = vi.fn(async () => { throw new Error('telemetry boom'); });
    const exit = vi.fn() as unknown as (code: number) => never;

    const handler = createShutdownHandler({ server: server as never, shutdownAbort, telemetryShutdown, timeoutMs: 5000, exit });
    const done = handler();
    await vi.runAllTimersAsync();
    await done;

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is idempotent — second call does not re-run shutdown steps', async () => {
    const shutdownAbort = new AbortController();
    const server = fakeServer('resolve');
    const telemetryShutdown = vi.fn(async () => {});
    const exit = vi.fn() as unknown as (code: number) => never;

    const handler = createShutdownHandler({ server: server as never, shutdownAbort, telemetryShutdown, timeoutMs: 5000, exit });
    const first = handler();
    const second = handler();
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    expect(server.close).toHaveBeenCalledOnce();
    expect(telemetryShutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('aborts the shutdownAbort controller before calling server.close', async () => {
    const shutdownAbort = new AbortController();
    const server = fakeServer('resolve');
    let abortedAtCloseTime = false;
    server.close.mockImplementation((cb: (err?: Error) => void) => {
      abortedAtCloseTime = shutdownAbort.signal.aborted;
      queueMicrotask(() => cb());
    });

    const telemetryShutdown = vi.fn(async () => {});
    const exit = vi.fn() as unknown as (code: number) => never;

    const handler = createShutdownHandler({ server: server as never, shutdownAbort, telemetryShutdown, timeoutMs: 5000, exit });
    const done = handler();
    await vi.runAllTimersAsync();
    await done;

    expect(abortedAtCloseTime).toBe(true);
  });
});
