import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { makeCraftbookResolver } from '../craftbook/resolve.js';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import { ReportActionManager, ReportNotFoundError } from './report-action-manager.js';

let home: string;
let dataDir: string;
let store: Store;
let catalog: CatalogService;
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

async function writeCraftbookTemplate(id: string, name: string): Promise<void> {
  const itemDir = join(dataDir, 'craftbook-templates', id.slice(0, 2), id);
  const versionDir = join(itemDir, 'versions', '1.0.0');
  await mkdir(versionDir, { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'craftbook-template',
      id,
      name,
      description: `${name} test book.`,
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    }),
  );
  await writeFile(
    join(versionDir, 'craftbook.json'),
    JSON.stringify({
      name,
      description: `${name} test book.`,
      entryStepId: 'run',
      steps: [{ id: 'run', name: 'Run', prompt: 'Do the run.', terminal: true }],
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
    }),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'report-actions-'));
  dataDir = await mkdtemp(join(tmpdir(), 'report-actions-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);
  tasks = new TaskManager(store);
  tasks.setCraftbookResolver(makeCraftbookResolver(store, catalog));
  manager = new ReportActionManager({
    home,
    store,
    tasks,
    taskRunner: { enqueueHandoff: () => {} } as unknown as TaskRunner,
    catalog,
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

  it('fires an unchanged task-backed action only once across concurrent calls and retries', async () => {
    await writeCraftbookTemplate('a11y-audit', 'Accessibility Audit');
    const block = [
      '```gezel-action',
      'kind: fire-craftbook',
      'id: audit',
      'title: Run accessibility audit',
      'craftbookId: a11y-audit',
      '```',
    ].join('\n');
    await store.writeProjectArtifact(projectId, REPORT, reportWith(block));

    const [first, concurrent] = await Promise.all([
      manager.fire(projectId, REPORT, 'audit'),
      manager.fire(projectId, REPORT, 'audit'),
    ]);
    const retry = await manager.fire(projectId, REPORT, 'audit');

    expect(concurrent.taskRef).toBe(first.taskRef);
    expect(retry.taskRef).toBe(first.taskRef);
    expect((await tasks.getByRef(first.taskRef!))?.craftbook.id).toBe('a11y-audit');
    expect(await store.listProjectTasks(projectId)).toHaveLength(1);
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

  it('fails an invalid edit pack atomically and reports every skipped file', async () => {
    await store.writeProjectWorkspaceFile(projectId, 'src/existing.ts', 'const safe = true;\n');
    await store.writeProjectArtifact(
      projectId,
      'edits/existing.diff',
      [
        '--- a/src/existing.ts',
        '+++ b/src/existing.ts',
        '@@ -1 +1 @@',
        '-const safe = true;',
        '+const safe = false;',
        '',
      ].join('\n'),
    );
    const block = [
      '```gezel-action',
      'kind: apply-edits',
      'id: harden',
      'title: Add headers',
      'edits:',
      '  - path: src/existing.ts',
      '    diffArtifact: edits/existing.diff',
      '  - path: src/server.ts',
      '    diffArtifact: edits/harden.diff',
      '```',
    ].join('\n');
    await store.writeProjectArtifact(projectId, REPORT, reportWith(block));

    const result = await manager.fire(projectId, REPORT, 'harden');
    expect(result.record.state).toBe('failed');
    expect(result.record.results).toEqual([
      {
        path: 'src/existing.ts',
        ok: false,
        error: 'skipped — pack validation failed',
      },
      { path: 'src/server.ts', ok: false, error: expect.stringContaining('edits/harden.diff') },
    ]);
    expect(await store.readProjectWorkspaceFile(projectId, 'src/existing.ts')).toBe(
      'const safe = true;\n',
    );
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
