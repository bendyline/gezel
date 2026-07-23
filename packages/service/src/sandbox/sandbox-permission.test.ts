import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInSandbox, selectNodePermissionFlag } from './runner.js';

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Node permission flag compatibility', () => {
  it('selects the experimental spelling advertised by Node 22', () => {
    expect(
      selectNodePermissionFlag(`
  --experimental-permission
                              enable the permission system
  --experimental-strip-types
`),
    ).toBe('--experimental-permission');
  });

  it('prefers the stabilized spelling when both appear', () => {
    expect(
      selectNodePermissionFlag(`
  --experimental-permission  legacy alias
  --permission               enable the permission system
`),
    ).toBe('--permission');
  });

  it('runs a script with the permission flag supported by the selected Node binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-sandbox-permission-test-'));
    scratchDirs.push(dir);
    const workspace = join(dir, 'workspace');
    await mkdir(workspace);
    const entry = join(workspace, 'main.mjs');
    await writeFile(entry, `process.stdout.write('sandbox-ok')`, 'utf8');

    const result = await runInSandbox({
      entry,
      cwd: workspace,
      input: '',
      timeoutMs: 10_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('sandbox-ok');
  });
});
