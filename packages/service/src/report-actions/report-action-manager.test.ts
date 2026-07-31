import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import { ReportActionManager, ReportNotFoundError } from './report-action-manager.js';

let home: string;
let dataDir: string;
let store: Store;
let tasks: TaskManager;
let manager: ReportActionManager;
let projectId: string;

const REPORT = 'reports/night.md';

function reportWith(...blocks: string[]): string {
  return ['# Night review', '', 'Findings below.', '', ...blocks, ''].join('\n');
}

const CREATE_TASK_BLOCK = [
  '```gezel-action',
  'kind: create-task',
  'id: fix-headers',
  'title: Add security headers',
  'reason: Responses lack a CSP.',
  'prompt: Add the missing headers to every response.',
  'role: software developer',
  '```',
].join('\n');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'report-actions-'));
  dataDir = await mkdtemp(join(tmpdir(), 'report-actions-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  tasks = new TaskManager(store);
  manager = new ReportActionManager({
    home,
    store,
    tasks,
    taskRunner: { enqueueHandoff: () => {} } as unknown as TaskRunner,
    catalog: new CatalogService([new BundledSource({ dataDir, noIndex: true })]),
    chat: null as unknown as ChatManager,
  });
  projectId = (await store.createProject({ name: 'Shop' })).id;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('listForReport', () => {
  it('reports a missing artifact as ReportNotFoundError', async () => {
    await expect(manager.listForReport(projectId, 'reports/nope.md')).rejects.toBeInstanceOf(
      ReportNotFoundError,
    );
  });

  it('starts every parsed action as suggested without writing a record', async () => {
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));
    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions).toHaveLength(1);
    expect(overlay.actions[0]).toMatchObject({ id: 'fix-headers', state: 'suggested' });
    expect(overlay.issues).toHaveLength(0);
    expect(overlay.stale).toHaveLength(0);
    // Virtual until first interaction — listing must not materialize state.
    expect(await store.readProjectArtifact(projectId, REPORT)).toBeTruthy();
    await expect(
      manager.listForReport(projectId, REPORT).then((o) => o.actions[0]?.state),
    ).resolves.toBe('suggested');
  });

  it('surfaces a malformed block as an issue instead of dropping it', async () => {
    const bad = ['```gezel-action', 'kind: create-task', 'title: No prompt at all', '```'].join(
      '\n',
    );
    await store.writeProjectArtifact(projectId, REPORT, reportWith(bad));
    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions).toHaveLength(0);
    expect(overlay.issues).toHaveLength(1);
    expect(overlay.issues[0]?.raw).toContain('No prompt at all');
  });
});

describe('dismiss', () => {
  it('persists the record and reflects it in the overlay', async () => {
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));
    const record = await manager.dismiss(projectId, REPORT, 'fix-headers');
    expect(record).toMatchObject({
      actionId: 'fix-headers',
      state: 'dismissed',
      kind: 'create-task',
    });

    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions[0]?.state).toBe('dismissed');
  });

  it('rejects an id that is not in the report', async () => {
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));
    await expect(manager.dismiss(projectId, REPORT, 'ghost')).rejects.toThrow(
      /^unknown report action/,
    );
  });

  it('flags contentChanged when the block body drifts after the interaction', async () => {
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));
    await manager.dismiss(projectId, REPORT, 'fix-headers');

    const regenerated = CREATE_TASK_BLOCK.replace(
      'Add the missing headers to every response.',
      'Add CSP and X-Content-Type-Options to every response.',
    );
    await store.writeProjectArtifact(projectId, REPORT, reportWith(regenerated));

    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions[0]).toMatchObject({ state: 'dismissed', contentChanged: true });
  });

  it('lists a record whose action vanished from the regenerated report as stale', async () => {
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));
    await manager.dismiss(projectId, REPORT, 'fix-headers');
    await store.writeProjectArtifact(projectId, REPORT, reportWith());

    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions).toHaveLength(0);
    expect(overlay.stale.map((r) => r.actionId)).toEqual(['fix-headers']);
  });
});

describe('fire', () => {
  it('materializes a create-task block into a task and stamps the record', async () => {
    await store.createGezel({ name: 'Ada', role: 'software developer' });
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));

    const result = await manager.fire(projectId, REPORT, 'fix-headers');
    expect(result.taskRef).toBeTruthy();
    expect(result.record).toMatchObject({ state: 'fired', taskRef: result.taskRef });

    const task = await tasks.getByRef(result.taskRef!);
    expect(task?.title).toBe('Add security headers');
    // Model-authored prompt must ride as fenced evidence, never as bare instructions.
    const step = task?.craftbook.steps[0];
    expect(step?.prompt).toContain('<requested-work>');
    expect(step?.prompt).toContain('Add the missing headers to every response.');
    expect(step?.prompt).toContain('untrusted evidence');
  });

  it('refuses a cross-project target that is not a real project', async () => {
    const block = CREATE_TASK_BLOCK.replace('role: software developer', 'projectId: not-a-project');
    await store.writeProjectArtifact(projectId, REPORT, reportWith(block));
    await expect(manager.fire(projectId, REPORT, 'fix-headers')).rejects.toThrow(
      /unknown target project/,
    );
    // Nothing recorded — the card stays fireable.
    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions[0]?.state).toBe('suggested');
  });

  it('fails an apply-edits pack whose sidecar diff is missing, writing nothing', async () => {
    const block = [
      '```gezel-action',
      'kind: apply-edits',
      'id: harden',
      'title: Add headers',
      'edits:',
      '  - path: src/server.ts',
      '    diffArtifact: edits/harden.diff',
      '```',
    ].join('\n');
    await store.writeProjectArtifact(projectId, REPORT, reportWith(block));

    const result = await manager.fire(projectId, REPORT, 'harden');
    expect(result.record.state).toBe('failed');
    expect(result.record.results).toEqual([
      { path: 'src/server.ts', ok: false, error: expect.stringContaining('edits/harden.diff') },
    ]);
    expect(await store.readProjectWorkspaceFile(projectId, 'src/server.ts')).toBeNull();
  });

  it('applies a valid sidecar diff to the workspace', async () => {
    await store.writeProjectWorkspaceFile(projectId, 'greet.txt', 'hello\n');
    const diff = [
      '--- a/greet.txt',
      '+++ b/greet.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+hello world',
      '',
    ].join('\n');
    await store.writeProjectArtifact(projectId, 'edits/greet.diff', diff);
    const block = [
      '```gezel-action',
      'kind: apply-edits',
      'id: greet',
      'title: Friendlier greeting',
      'edits:',
      '  - path: greet.txt',
      '    diffArtifact: edits/greet.diff',
      '```',
    ].join('\n');
    await store.writeProjectArtifact(projectId, REPORT, reportWith(block));

    const result = await manager.fire(projectId, REPORT, 'greet');
    expect(result.record.state).toBe('applied');
    expect(result.taskRef).toBeUndefined();
    expect(await store.readProjectWorkspaceFile(projectId, 'greet.txt')).toBe('hello world\n');
  });
});

describe('settleForTask', () => {
  it('stamps the outcome on a fired record found by taskRef in any project', async () => {
    await store.createGezel({ name: 'Ada', role: 'software developer' });
    await store.writeProjectArtifact(projectId, REPORT, reportWith(CREATE_TASK_BLOCK));
    const fired = await manager.fire(projectId, REPORT, 'fix-headers');

    expect(await manager.settleForTask(fired.taskRef!, 'complete')).toBe(1);
    const overlay = await manager.listForReport(projectId, REPORT);
    expect(overlay.actions[0]).toMatchObject({ state: 'fired', outcome: 'complete' });
    expect(overlay.actions[0]?.settledAt).toBeTruthy();

    // Idempotent: a second settle finds nothing left to stamp.
    expect(await manager.settleForTask(fired.taskRef!, 'canceled')).toBe(0);
  });

  it('ignores task refs it never fired', async () => {
    expect(await manager.settleForTask('shop/999', 'complete')).toBe(0);
  });
});
