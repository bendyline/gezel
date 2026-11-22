import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Point every daemon this app starts at the page libraries that ship inside
 * it (docs/page-libraries.md). A store build cannot download libraries, so
 * its starter set rides in `Resources/page-libraries`, staged by
 * scripts/seed-page-libraries.mjs. Read through the environment so the
 * embedded, utility and spawned hosts all see the same folder. An inherited
 * value is kept: a developer pointing at a shelf of their own wins.
 */
export function stampPageLibrarySeed(args: {
  resourcesPath: string | undefined;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = args.env ?? process.env;
  if (env.GEZEL_PAGE_LIBRARIES_DIR || !args.resourcesPath) return null;
  const seed = join(args.resourcesPath, 'page-libraries');
  if (!existsSync(seed)) return null;
  env.GEZEL_PAGE_LIBRARIES_DIR = seed;
  return seed;
}
