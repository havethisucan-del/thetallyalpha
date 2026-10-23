import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Server URL on which each test file creates its own throwaway database. */
    testDatabaseUrl: string;
  }
}

const SERVER_SCRIPT = fileURLToPath(new URL('./ephemeral-postgres.ts', import.meta.url));
const READY_TIMEOUT_MS = 120_000; // initdb + up to three start attempts
const EXIT_TIMEOUT_MS = 20_000;

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', msg, ...extra }));
}

/**
 * Integration tests use TEST_DATABASE_URL when it is set. Otherwise an ephemeral embedded
 * PostgreSQL (temp directory, free loopback port, random password) runs in a child process
 * (see ephemeral-postgres.ts for why) and is removed again on teardown.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env['TEST_DATABASE_URL'];
  if (external !== undefined && external !== '') {
    project.provide('testDatabaseUrl', external);
    log('integration tests use TEST_DATABASE_URL');
    return async () => {};
  }

  const child = spawn(process.execPath, [SERVER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  let stdout = '';
  let timer: NodeJS.Timeout | undefined;
  const ready = await new Promise<{ url: string; port: number } | undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, READY_TIMEOUT_MS);
    void exited.then(() => {
      resolve(undefined);
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline !== -1)
        resolve(JSON.parse(stdout.slice(0, newline)) as { url: string; port: number });
    });
  });
  clearTimeout(timer);

  if (ready === undefined) {
    child.kill();
    await exited;
    throw new Error(`embedded postgres failed to start\n${stderr}`);
  }

  project.provide('testDatabaseUrl', ready.url);
  log('embedded postgres started', { host: '127.0.0.1', port: ready.port });

  return async () => {
    child.stdin.end(); // the child stops Postgres and deletes its directory
    let wait: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => {
        wait = setTimeout(() => {
          resolve('timeout');
        }, EXIT_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(wait);
    if (code === 'timeout') {
      child.kill();
      throw new Error('embedded postgres did not stop in time');
    }
    if (code !== 0)
      throw new Error(`embedded postgres cleanup failed (exit ${String(code)})\n${stderr}`);
    if (stderr !== '') process.stderr.write(stderr); // e.g. orphaned processes that were killed
    log('embedded postgres stopped');
  };
}
