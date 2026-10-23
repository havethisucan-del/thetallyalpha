import { startStaticSite } from './support/static-site.ts';

/** Builds and serves the static site once for the run; the returned function is the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return startStaticSite();
}
