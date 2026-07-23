/**
 * gilde-checkout — locate the sibling bendyline/gilde working tree that
 * authoring scripts WRITE into.
 *
 * Why a checkout and not the installed package: catalog content lives in
 * the external gilde repo (published as @bendyline/gilde). Generators and
 * importers mutate content, and mutations belong in a git working tree
 * where they can become gilde PRs — never in node_modules. Runtime READS
 * go through `gildeDataDir()` in src/gilde-data.ts instead, which resolves
 * the installed (or link:ed) package.
 *
 * Resolution: `GILDE_DIR` env var wins; otherwise the repo-sibling
 * `../gilde` (i.e. gezel and gilde cloned next to each other).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GildeCheckout {
  root: string;
  dataDir: string;
}

export function resolveGildeCheckout(): GildeCheckout {
  const override = process.env.GILDE_DIR?.trim();
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const root = override ? resolve(override) : resolve(scriptsDir, '..', '..', '..', '..', 'gilde');
  return { root, dataDir: join(root, 'data') };
}

/**
 * Exit loudly when the checkout is missing or is some other directory —
 * a generator writing into the wrong tree is worse than not running.
 */
export function requireGildeCheckout(): GildeCheckout {
  const checkout = resolveGildeCheckout();
  const pkgPath = join(checkout.root, 'package.json');
  let name: unknown;
  if (existsSync(pkgPath)) {
    try {
      name = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
  }
  if (name !== '@bendyline/gilde') {
    console.error(`[gilde] expected the bendyline/gilde checkout at ${checkout.root}`);
    console.error('[gilde] clone it as a sibling of this repo:');
    console.error('[gilde]   git clone https://github.com/bendyline/gilde.git');
    console.error('[gilde] or point GILDE_DIR at an existing checkout.');
    process.exit(1);
  }
  console.error(
    '[gilde] note: runtime reads come from the pinned @bendyline/gilde package unless you run pnpm link:gilde',
  );
  return checkout;
}
