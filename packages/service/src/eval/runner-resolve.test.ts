import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEvalBinaryFrom } from './runner.js';

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
}

/** A directory that looks like a gezel checkout root to the walk. */
function plantHarness(root: string): void {
  touch(join(root, 'pnpm-workspace.yaml'));
  touch(join(root, 'evals', 'src', 'bin', 'run.ts'));
  touch(join(root, 'node_modules', '.bin', 'tsx'));
}

describe('resolveEvalBinaryFrom', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gezel-eval-resolve-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the harness from a gezel source checkout', () => {
    plantHarness(root);
    const module = join(root, 'packages', 'service', 'dist', 'index.js');
    touch(module);
    const found = resolveEvalBinaryFrom(module);
    expect(found?.cwd).toBe(root);
    expect(found?.cmd).toBe(join(root, 'node_modules', '.bin', 'tsx'));
  });

  it('ignores a workspace root above an installed package', () => {
    // An npm install of gezel-service inside some other pnpm workspace, or a
    // pnpm-workspace.yaml planted in a shared parent directory, must never
    // have its tsx spawned with the daemon's environment.
    plantHarness(root);
    const module = join(
      root,
      'app',
      'node_modules',
      '@bendyline',
      'gezel-service',
      'dist',
      'index.js',
    );
    touch(module);
    expect(resolveEvalBinaryFrom(module)).toBeNull();
  });
});
