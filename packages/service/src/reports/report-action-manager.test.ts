import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { makeCraftbookResolver } from '../craftbook/resolve.js';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskRunner } from '../tasks/runner.js';
import { ReportActionManager } from './report-action-manager.js';

let home: string;
let dataDir: string;
let store: Store;
let catalog: CatalogService;
let tasks: TaskManager;
let manager: ReportActionManager;

const REPORT_PATH = 'night-shift-report.md';

async function writeCraftbookTemplate(id: string, name: string): Promise<void> {
  const itemDir = join(dataDir, 'craftbook-templates', id.slice(0, 2), id);
  const vdir = join(itemDir, 'versions', '1.0.0');
  await mkdir(vdir, { recursive: true });
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
    join(vdir, 'craftbook.json'),
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

function report(...blocks: string[]): string {
  return [
    '# Night report',
    '',
    'Findings.',
    ...blocks.map((b) => '```gezel-action\n' + b + '\n```'),
    '',
  ].join('\n\n');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'report-actions-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'report-actions-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);
  await writeCraftbookTemplate('a11y-audit', 'Accessibility Audit');
  tasks = new TaskManager(store);
  tasks.setCraftbookResolver(makeCraftbookResolver(store, catalog));
  const taskRunner = new TaskRunner({
    store,
    // Dispatch never actually runs in these tests — the runner only
    // receives enqueueHandoff calls; the tick loop is never started.
    dispatcher: { dispatch: async () => ({ ok: true }) } as never,
    tickIntervalMs: 999_999,
  });
  manager = new ReportActionManager({
    home,
    store,
    tasks,
    taskRunner,
    catalog,
    // create-task's ensureGezel would call the chat for bespoke abouts;
    // tests exercise roster reuse so the chat is never reached.
    chat: null as unknown as ChatManager,
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('ReportActionManager', () => {
  it('lists parsed actions as suggested with parse issues surfaced', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report(
        'kind: fire-craftbook\nid: audit\ntitle: Run audit\ncraftbookId: a11y-audit',
        'kind: mystery\ntitle: Broken',
      ),
    );
    const res = await manager.listForReport(project.id, REPORT_PATH);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({ id: 'audit', state: 'suggested' });
    expect(res.issues).toHaveLength(1);
    expect(res.stale).toHaveLength(0);
  });

  it('fires a fire-craftbook action into a task and is idempotent while the task lives', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report('kind: fire-craftbook\nid: audit\ntitle: Run audit\ncraftbookId: a11y-audit'),
    );
    const fired = await manager.fire(project.id, REPORT_PATH, 'audit');
    expect(fired.record.state).toBe('fired');
    expect(fired.taskRef).toBeDefined();
    const task = await tasks.getByRef(fired.taskRef!);
    expect(task?.craftbook.id).toBe('a11y-audit');
    expect(task?.status).toBe('active');

    const again = await manager.fire(project.id, REPORT_PATH, 'audit');
    expect(again.taskRef).toBe(fired.taskRef);
    const all = await store.listProjectTasks(project.id);
    expect(all).toHaveLength(1);
  });

  it('fires a create-task action to a roster-matched worker with untrusted framing', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.createGezel({
      name: 'Dev',
      role: 'Software Developer',
      about: 'Fixes things.',
    });
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report(
        'kind: create-task\nid: fix-null\ntitle: Fix the null deref\nprompt: Guard parseHeader against null input.',
      ),
    );
    const fired = await manager.fire(project.id, REPORT_PATH, 'fix-null');
    expect(fired.record.state).toBe('fired');
    const task = await tasks.getByRef(fired.taskRef!);
    expect(task?.assignee.kind).toBe('gezel');
    const prompt = task?.craftbook.steps[0]?.prompt ?? '';
    expect(prompt).toContain('<report-suggestion>');
    expect(prompt).toContain('Guard parseHeader');
    expect(prompt).toContain('UNTRUSTED');
  });

  it('applies an edit pack from sidecar diffs, with per-file results', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.writeProjectWorkspaceFile(project.id, 'src/a.txt', 'alpha\nline two\n');
    await store.writeProjectArtifact(
      project.id,
      'night-shift-report/edits/a.diff',
      [
        '--- a/src/a.txt',
        '+++ b/src/a.txt',
        '@@ -1,2 +1,2 @@',
        '-alpha',
        '+ALPHA',
        ' line two',
        '',
      ].join('\n'),
    );
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report(
        [
          'kind: apply-edits',
          'id: shout-alpha',
          'title: Uppercase alpha',
          'edits:',
          '  - path: src/a.txt',
          '    diffArtifact: night-shift-report/edits/a.diff',
        ].join('\n'),
      ),
    );
    const fired = await manager.fire(project.id, REPORT_PATH, 'shout-alpha');
    expect(fired.record.state).toBe('applied');
    expect(fired.record.results).toEqual([{ path: 'src/a.txt', ok: true }]);
    const content = await store.readProjectWorkspaceFile(project.id, 'src/a.txt');
    expect(content).toContain('ALPHA');
  });

  it('fails an edit pack with zero writes when any sidecar is missing or rejected', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.writeProjectWorkspaceFile(project.id, 'src/a.txt', 'alpha\n');
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report(
        [
          'kind: apply-edits',
          'id: broken-pack',
          'title: Broken pack',
          'edits:',
          '  - path: src/a.txt',
          '    diffArtifact: night-shift-report/edits/missing.diff',
        ].join('\n'),
      ),
    );
    const fired = await manager.fire(project.id, REPORT_PATH, 'broken-pack');
    expect(fired.record.state).toBe('failed');
    expect(fired.record.results?.[0]?.ok).toBe(false);
    const content = await store.readProjectWorkspaceFile(project.id, 'src/a.txt');
    expect(content).toBe('alpha\n');
  });

  it('dismisses and reflects the state on the next list', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report('kind: fire-craftbook\nid: audit\ntitle: Run audit\ncraftbookId: a11y-audit'),
    );
    await manager.dismiss(project.id, REPORT_PATH, 'audit');
    const res = await manager.listForReport(project.id, REPORT_PATH);
    expect(res.actions[0]?.state).toBe('dismissed');
  });

  it('flags contentChanged when a regenerated report changes a fired block', async () => {
    const project = await store.createProject({ name: 'Shop' });
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report('kind: fire-craftbook\nid: audit\ntitle: Run audit\ncraftbookId: a11y-audit'),
    );
    await manager.fire(project.id, REPORT_PATH, 'audit');
    await store.writeProjectArtifact(
      project.id,
      REPORT_PATH,
      report(
        'kind: fire-craftbook\nid: audit\ntitle: Run audit AGAIN with focus\ncraftbookId: a11y-audit',
      ),
    );
    const res = await manager.listForReport(project.id, REPORT_PATH);
    expect(res.actions[0]).toMatchObject({ id: 'audit', state: 'fired', contentChanged: true });
  });

  it('reports vanished actions as stale and settles fired records cross-project', async () => {
    const projectA = await store.createProject({ name: 'Default-ish' });
    const projectB = await store.createProject({ name: 'Target' });
    await store.writeProjectArtifact(
      projectA.id,
      REPORT_PATH,
      report(
        `kind: fire-craftbook\nid: audit\ntitle: Run audit\ncraftbookId: a11y-audit\nprojectId: ${projectB.id}`,
      ),
    );
    const fired = await manager.fire(projectA.id, REPORT_PATH, 'audit');
    const created = await tasks.getByRef(fired.taskRef!);
    expect(created?.projectId).toBe(projectB.id);

    // The settle hook passes only the taskRef — records live in project A.
    await manager.settleForTask(fired.taskRef!, 'complete');
    const settledView = await manager.listForReport(projectA.id, REPORT_PATH);
    expect(settledView.actions[0]?.outcome).toBe('complete');

    // Regenerate without the block: the record surfaces as stale.
    await store.writeProjectArtifact(projectA.id, REPORT_PATH, '# Empty report\n\nAll clear.\n');
    const res = await manager.listForReport(projectA.id, REPORT_PATH);
    expect(res.actions).toHaveLength(0);
    expect(res.stale).toHaveLength(1);
    expect(res.stale[0]?.actionId).toBe('audit');
  });
});
