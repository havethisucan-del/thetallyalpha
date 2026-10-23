import { startServer } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  const server = await startServer({ config, logger });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'signal received');
    const force = setTimeout(() => {
      logger.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.shutdown().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        logger.error(
          { err: error instanceof Error ? error.message : 'unknown' },
          'shutdown failed',
        );
        process.exit(1);
      },
    );
  };
  // SIGINT covers Ctrl+C on Windows too; SIGBREAK is Ctrl+Break on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      stop(signal);
    });
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: 'server failed to start',
      err: error instanceof Error ? error.message : 'unknown',
    }),
  );
  process.exit(1);
});
