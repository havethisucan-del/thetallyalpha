import { startStack } from './support/stack.ts';

/** Starts the stack once for the whole run; the returned function is Playwright's teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return startStack();
}
