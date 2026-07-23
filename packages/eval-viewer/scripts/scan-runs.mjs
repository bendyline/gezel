#!/usr/bin/env node
// CLI wrapper: walks ../../evals/runs and writes src/data/runs-index.json —
// the static snapshot the React app boots from (and the production fallback
// when the live /api/index endpoint isn't available). Run before `vite`
// (handled by the `dev` and `build` scripts in package.json).
//
// The actual scan logic lives in scan-lib.mjs and is shared with the dev
// server's live endpoint (see vite.config.ts) so the two never drift.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './scan-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const runsRoot = resolve(repoRoot, 'evals', 'runs');
const outPath = resolve(__dirname, '..', 'src', 'data', 'runs-index.json');

const index = buildIndex({ runsRoot, repoRoot });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(index, null, 2));
console.log(
  `[scan-runs] wrote ${index.counts.trials} trials (${index.counts.running} running, ${index.counts.scored} scored, ${index.counts.passed} passed) → ${relative(repoRoot, outPath)}`,
);
