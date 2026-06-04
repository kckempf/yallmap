import { logger } from './logger';

export interface ShutdownableServer {
  close(cb: (err?: Error) => void): void;
  closeAllConnections?(): void;
}

export interface CreateShutdownHandlerInput {
  server: ShutdownableServer;
  shutdownAbort: AbortController;
  telemetryShutdown: () => Promise<void>;
  timeoutMs: number;
  exit: (code: number) => void;
}

export function createShutdownHandler(input: CreateShutdownHandlerInput): () => Promise<void> {
  const { server, shutdownAbort, telemetryShutdown, timeoutMs, exit } = input;
  let running: Promise<void> | undefined;

  return function shutdown(): Promise<void> {
    if (running) {
      logger.warn('shutdown already in progress');
      return running;
    }

    running = (async () => {
      let exitCode = 0;
      try {
        logger.info('[shutdown] aborting in-flight upstream calls');
        shutdownAbort.abort('shutdown');

        logger.info('[shutdown] closing http server');
        await closeServer(server, timeoutMs);
        logger.info('[shutdown] server closed');

        try {
          await telemetryShutdown();
          logger.info('[telemetry] sdk shutdown ok');
        } catch (err) {
          logger.error({ err }, '[telemetry] shutdown error');
          exitCode = 1;
        }
      } catch (err) {
        logger.error({ err }, '[shutdown] unexpected error');
        exitCode = 1;
      } finally {
        exit(exitCode);
      }
    })();

    return running;
  };
}

function closeServer(server: ShutdownableServer, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      logger.warn({ timeoutMs }, '[shutdown] server.close timed out — forcing closeAllConnections');
      try { server.closeAllConnections?.(); } catch (err) {
        logger.error({ err }, '[shutdown] closeAllConnections threw');
      }
      // server.close should now resolve, but in case it doesn't, resolve ourselves.
      finish();
    }, timeoutMs);

    server.close((err) => {
      if (err) logger.error({ err }, '[shutdown] server.close error');
      finish();
    });
  });
}
