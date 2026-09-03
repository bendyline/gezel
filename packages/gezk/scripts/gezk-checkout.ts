/**
 * Locate the sibling bendyline/gezk working tree — the public home of the
 * format's specification, JSON Schemas, conformance fixtures and reference
 * readers. Generators in this monorepo WRITE into it (schemas and fixtures
 * are derived from the TypeScript implementation, never hand-edited); the
 * result becomes a gezk PR. `GEZK_DIR` wins; otherwise `../gezk`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveGezkCheckout(): string {
  const override = process.env.GEZK_DIR?.trim();
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  return override ? resolve(override) : resolve(scriptsDir, '..', '..', '..', '..', 'gezk');
}

export function requireGezkCheckout(): string {
  const root = resolveGezkCheckout();
  if (!existsSync(root) || !existsSync(resolve(root, '.git'))) {
    console.error(`[gezk] expected the bendyline/gezk checkout at ${root}`);
    console.error('[gezk] clone it as a sibling of this repo:');
    console.error('[gezk]   git clone https://github.com/bendyline/gezk.git');
    console.error('[gezk] or point GEZK_DIR at an existing checkout.');
    process.exit(1);
  }
  return root;
}
