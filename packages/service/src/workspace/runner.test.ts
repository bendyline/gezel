import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { canApplyLinuxSystemdSandbox } from '../sandbox/runner.js';
import { runWorkspaceScript } from './runner.js';

describe('runWorkspaceScript', () => {
  let home: string;
  let store: Store;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-workspace-runner-test-'));
    store = new Store({ home });
    await store.ensureLayout();
    await store.createProject({ name: 'Default' });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('executes a workspace script through an available deny-net boundary', async () => {
    if (process.platform === 'win32') return;
    if (process.platform === 'linux' && !(await canApplyLinuxSystemdSandbox())) return;

    await store.writeProjectWorkspaceFile(
      'default',
      'scripts/clean_data.mjs',
      "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
        "mkdirSync('out', { recursive: true });\n" +
        "writeFileSync('out/result.json', JSON.stringify([{ ok: true }]));\n" +
        "console.log('wrote result');\n",
    );

    const result = await runWorkspaceScript(store, {
      projectId: 'default',
      scriptPath: 'scripts/clean_data.mjs',
    });

    expect(result).toMatchObject({ ok: true, code: 0, timedOut: false });
    expect(result.stdout).toContain('wrote result');
    await expect(store.readProjectWorkspaceFile('default', 'out/result.json')).resolves.toBe(
      '[{"ok":true}]',
    );
  });
});
