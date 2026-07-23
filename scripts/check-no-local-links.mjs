#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const checks = ['check-no-squisq-link.mjs', 'check-no-gilde-link.mjs'];
let failed = false;

for (const check of checks) {
  const result = spawnSync(process.execPath, [join(scriptsDir, check)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
