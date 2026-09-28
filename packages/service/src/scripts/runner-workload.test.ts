import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptExecutor } from '@bendyline/gezel-script-runtime';
import { projectScriptRunsDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { ScriptRunner } from './runner.js';
import { readProjectScriptRun } from './runs.js';

const success = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-script-workload-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
});
afterEach(() => rm(home, { recursive: true, force: true }));

const runner = (execute: ScriptExecutor['execute']) =>
  new ScriptRunner({ store, chat: {} as ChatManager, executor: { execute } });

async function expectSettledAudit(runId: string): Promise<void> {
  const inFlight = await readdir(join(projectScriptRunsDir(home, 'default'), '.in-flight'));
  expect(inFlight).toEqual([]);
  expect(await readProjectScriptRun(home, 'default', runId)).toMatchObject({ status: 'ok' });
}

describe('record-scale script workloads', () => {
  it('lists a folder-per-record store of 1,200 records through the real dispatcher', async () => {
    const root = join(await store.projectWorkspaceDir('default'), 'records');
    const ids = Array.from({ length: 1_200 }, (_, index) => `r${String(index).padStart(4, '0')}`);
    for (const id of ids) {
      await mkdir(join(root, id), { recursive: true });
      await writeFile(join(root, id, 'record.json'), JSON.stringify({ version: 1, id, n: 1 }));
    }
    // What storeRecords' `list` does: one listing, then one read per record.
    const scripts = runner(async (options) => {
      const entries = (await options.onRequest('fs.list', { path: 'records' })) as Array<{
        name: string;
        isDirectory: boolean;
      }>;
      const records: unknown[] = [];
      for (const entry of entries.filter((e) => e.isDirectory)) {
        const raw = await options.onRequest('fs.read', {
          path: `records/${entry.name}/record.json`,
        });
        records.push({ id: entry.name, ...(JSON.parse(raw as string) as object) });
      }
      options.onNotification('script.output', {
        value: { ok: true, action: 'list', id: null, record: null, records, total: records.length },
      });
      return success;
    });
    const run = await scripts.run({
      projectId: 'default',
      scriptName: 'storeRecords',
      scope: 'standard',
      trigger: { kind: 'manual', userInitiated: true },
      inputs: { action: 'list', root: 'records', mode: 'folder-per-record' },
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('ok');
    expect((run.output as { total: number }).total).toBe(1_200);
    await expectSettledAudit(run.id);
  }, 120_000);

  it('lets an authored connector script write one artifact per record past 1,000', async () => {
    const source = `export const meta = { name: 'fanout', description: 'One artifact per record', requires: ['artifacts.write'] };`;
    const scripts = runner(async (options) => {
      for (let index = 0; index < 1_100; index += 1)
        await options.onRequest('artifact.write', {
          path: `records/${index}.md`,
          content: `record ${index}`,
        });
      return success;
    });
    const run = await scripts.run({
      projectId: 'default',
      scriptName: 'fanout',
      inlineSource: source,
      trigger: { kind: 'connector', typeId: 'example', bindingId: 'binding' },
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('ok');
    expect(run.calls).toHaveLength(1_100);
    expect(await store.readProjectArtifact('default', 'records/1099.md')).toBe('record 1099');
    await expectSettledAudit(run.id);
  }, 120_000);
});
