import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'dev-fresh-runtime.mjs');
const discoveryEntries = [
  'pid',
  'port',
  'auth-token',
  'cert.pem',
  'cert-fingerprint',
  'web-ui-token',
  'service-role',
  'lock',
];

test('clears daemon discovery files without deleting Codex rollouts', () => {
  const home = mkdtempSync(join(tmpdir(), 'gezel-dev-fresh-runtime-'));
  const runtimeDir = join(home, 'runtime');
  const rolloutPath = join(runtimeDir, 'codex-cli', 'project', 'session', 'rollout.jsonl');

  try {
    mkdirSync(dirname(rolloutPath), { recursive: true });
    writeFileSync(rolloutPath, 'persist me\n');
    for (const entry of discoveryEntries) {
      writeFileSync(join(runtimeDir, entry), entry === 'pid' ? '99999999\n' : `${entry}\n`);
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, GEZEL_HOME: home },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(rolloutPath, 'utf8'), 'persist me\n');
    for (const entry of discoveryEntries) {
      assert.equal(existsSync(join(runtimeDir, entry)), false, `${entry} should be removed`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
