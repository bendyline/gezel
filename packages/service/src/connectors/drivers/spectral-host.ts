/**
 * Spawns the connectors-spectral `run-action.js` entry in the sandbox with a
 * DISTINCT posture: network ON, workspace OFF, env scrubbed, the connection
 * (with its secret) arriving over stdin. The untrusted Prismatic component gets
 * network but cannot read the corpus or exfiltrate files; the trusted parent
 * (here) normalizes the returned `{ data }`. The service never imports spectral
 * — it only resolves the entry path and spawns it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInSandbox } from '../../sandbox/runner.js';

const require = createRequire(import.meta.url);

export interface SpectralJob {
  component: string;
  action: string;
  connectionInput: string;
  connection: unknown;
  inputs: Record<string, unknown>;
}

export async function runSpectralAction(job: SpectralJob): Promise<{ data: unknown }> {
  const entry = require.resolve('@bendyline/gezel-connectors-spectral/run-action');
  const pkgRoot = dirname(dirname(entry)); // dist/run-action.js → package root (holds node_modules/spectral)
  const cwd = await mkdtemp(join(tmpdir(), 'gezel-spectral-'));
  try {
    const res = await runInSandbox({
      entry,
      cwd,
      input: JSON.stringify(job),
      denyNet: false, // network ON — the reason for the separate posture
      extraReadPaths: [pkgRoot], // read the compiled action tree + its spectral install
      timeoutMs: 60_000,
      maxOldSpaceMb: 1024,
    });
    if (res.exitCode !== 0) {
      throw new Error(`spectral action failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }
    const out = JSON.parse(res.stdout.trim() || '{}') as { data?: unknown };
    return { data: out.data };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
