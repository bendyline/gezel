import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { createOutcomeReviewRestore, createOutcomeReviewer } from './outcome-review.js';

let root: string;
let artifacts: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-outcome-review-'));
  artifacts = join(root, 'artifacts');
  workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'out'), { recursive: true });
  await writeFile(join(workspace, 'out/summary.md'), '# Summary\n\nGrowth was 12%.\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const step = { id: 'outcome', assignee: { kind: 'gezel', gezelId: 'owner' } } as TaskCraftbookStep;
const task = {
  ref: 'p/3',
  num: 3,
  title: 'Summarize',
  description: 'Summarize the brief.',
  assignee: { kind: 'gezel', gezelId: 'owner' },
  craftbook: {
    renderedAs: 'outcome',
    steps: [step],
    contract: {
      goal: 'A summary.',
      deliverables: [
        { id: 'summary', path: 'out/summary.md', kind: 'markdown', description: 'The summary' },
      ],
      criteria: [],
    },
  },
} as unknown as Task;

function fakeDeps(reply: string, edit?: () => Promise<void>) {
  const write = async (_projectId: string, rel: string, body: string | Buffer) => {
    const abs = join(artifacts, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  };
  const askFreshEyes = vi.fn(async () => {
    await edit?.();
    return {
      outcome: 'reply' as const,
      text: reply,
      toGezelId: 'owner',
      toGezelName: 'Rae',
      sessionId: 'review-session',
    };
  });
  return {
    askFreshEyes,
    deps: {
      store: {
        projectArtifactsDir: () => artifacts,
        projectWorkspaceDir: async () => workspace,
        writeProjectArtifact: write,
        writeProjectArtifactBinary: write,
        listSessions: async () => [
          { id: 'side', taskRef: 'p/3', lastActivityAt: '2026-11-10T02:00:00Z' },
          { id: 'owner-session', taskRef: 'p/3', lastActivityAt: '2026-11-10T01:00:00Z' },
          { id: 'other', taskRef: 'p/9', lastActivityAt: '2026-11-10T03:00:00Z' },
        ],
        getSession: async (_gezelId: string, id: string) =>
          id === 'side' ? { id, consultationMode: true } : id === 'owner-session' ? { id } : null,
      },
      chat: { askFreshEyes },
    } as unknown as Parameters<typeof createOutcomeReviewer>[0],
  };
}

const record = async (round = 1) =>
  JSON.parse(
    await readFile(join(artifacts, `outcome-review/3/round-${round}/review.json`), 'utf8'),
  );

describe('createOutcomeReviewer', () => {
  it('has the owner review again in a new session, records the round, and holds on findings', async () => {
    const { deps, askFreshEyes } = fakeDeps(
      'VERDICT: FAIL\n1. `out/summary.md` — Summary — 12% — the source says 21%',
    );
    const verdict = await createOutcomeReviewer(deps)({
      projectId: 'p',
      task,
      step,
      round: 1,
      mode: 'fresh',
    });
    expect(verdict.kind).toBe('hold');
    if (verdict.kind !== 'hold') throw new Error('expected a hold');
    expect(verdict.message).toContain('1. `out/summary.md` — Summary — 12% — the source says 21%');
    expect(askFreshEyes).toHaveBeenCalledWith(
      expect.objectContaining({
        gezelId: 'owner',
        projectId: 'p',
        fromSessionId: 'owner-session',
        subagentFor: { taskRef: 'p/3', ownerSessionId: 'owner-session' },
      }),
    );
    const brief = (askFreshEyes.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(brief).toContain('Summarize the brief.');
    expect(brief).toContain('`out/summary.md`');
    expect(
      await readFile(
        join(artifacts, 'outcome-review/3/round-1/before/workspace/out/summary.md'),
        'utf8',
      ),
    ).toContain('Growth was 12%');
    expect(await record()).toMatchObject({
      mode: 'fresh',
      verdict: 'fail',
      findings: ['`out/summary.md` — Summary — 12% — the source says 21%'],
      changedByReviewer: [],
      reviewerSessionId: 'review-session',
    });
  });

  it('lets the task finish on a pass, and records a reviewer that edited the work', async () => {
    const { deps } = fakeDeps('VERDICT: PASS', () =>
      writeFile(join(workspace, 'out/summary.md'), '# Rewritten by the reviewer\n'),
    );
    const verdict = await createOutcomeReviewer(deps)({
      projectId: 'p',
      task,
      step,
      round: 1,
      mode: 'fresh',
    });
    expect(verdict.kind).toBe('pass');
    expect(await record()).toMatchObject({
      verdict: 'pass',
      changedByReviewer: ['workspace/out/summary.md'],
    });
  });

  it('hands the owner the focused prompt for a self-review, without a reviewer', async () => {
    const { deps, askFreshEyes } = fakeDeps('unused');
    const verdict = await createOutcomeReviewer(deps)({
      projectId: 'p',
      task,
      step,
      round: 1,
      mode: 'self',
    });
    expect(verdict.kind).toBe('hold');
    if (verdict.kind !== 'hold') throw new Error('expected a hold');
    expect(verdict.message).toContain('review your deliverables as an independent reviewer would');
    expect(askFreshEyes).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ mode: 'self' });
  });
});

describe('createOutcomeReviewRestore', () => {
  let home: string;
  let store: Store;

  const folderTask = {
    ...task,
    craftbook: {
      ...task.craftbook,
      contract: {
        goal: 'Invoices.',
        deliverables: [
          { id: 'invoices', path: 'invoices', kind: 'html-page', description: 'One per client' },
          {
            id: 'summary',
            path: 'tasks/3/summary.md',
            artifact: true,
            kind: 'markdown',
            description: 'The run summary',
          },
        ],
        criteria: [],
      },
    },
  } as unknown as Task;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-outcome-restore-'));
    store = new Store({ home });
    await store.ensureLayout();
    await store.createProject({ name: 'Website' });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const review = () =>
    createOutcomeReviewer({ store, chat: {} as never })({
      projectId: 'website',
      task: folderTask,
      step,
      round: 1,
      mode: 'self',
    });

  it('puts back the work from before the review, removes what the revision added, and can undo', async () => {
    await store.writeProjectWorkspaceFile('website', 'invoices/a.html', '<p>A</p>');
    await store.writeProjectArtifact('website', 'tasks/3/summary.md', 'Two invoices.');
    await review();
    await store.writeProjectWorkspaceFile('website', 'invoices/a.html', '<p>A, revised</p>');
    await store.writeProjectWorkspaceFile('website', 'invoices/b.html', '<p>B</p>');

    const restore = await createOutcomeReviewRestore({ store })({
      projectId: 'website',
      task: folderTask,
      round: 1,
    });
    if ('refused' in restore) throw new Error(restore.refused);
    expect(restore.restored).toEqual(['workspace/invoices/a.html']);
    expect(restore.removed).toEqual(['workspace/invoices/b.html']);
    expect(await store.readProjectWorkspaceFile('website', 'invoices/a.html')).toBe('<p>A</p>');
    expect(await store.readProjectWorkspaceFile('website', 'invoices/b.html')).toBeNull();
    expect(await store.readProjectArtifact('website', 'tasks/3/summary.md')).toBe('Two invoices.');

    await restore.undo();
    expect(await store.readProjectWorkspaceFile('website', 'invoices/a.html')).toBe(
      '<p>A, revised</p>',
    );
    expect(await store.readProjectWorkspaceFile('website', 'invoices/b.html')).toBe('<p>B</p>');
  });

  it('refuses, changing nothing, without a complete copy from before the review', async () => {
    await store.writeProjectWorkspaceFile('website', 'invoices/a.html', '<p>A</p>');
    await review();
    await store.writeProjectArtifact(
      'website',
      'outcome-review/3/round-1/before.json',
      JSON.stringify({ files: ['workspace/invoices/a.html'], complete: false }),
    );
    await store.writeProjectWorkspaceFile('website', 'invoices/a.html', '<p>A, revised</p>');
    const restore = await createOutcomeReviewRestore({ store })({
      projectId: 'website',
      task: folderTask,
      round: 2,
    });
    expect(restore).toEqual({ refused: 'there is no record of the work before the review' });
    const incomplete = await createOutcomeReviewRestore({ store })({
      projectId: 'website',
      task: folderTask,
      round: 1,
    });
    expect(incomplete).toEqual({ refused: 'the copy from before the review is incomplete' });
    expect(await store.readProjectWorkspaceFile('website', 'invoices/a.html')).toBe(
      '<p>A, revised</p>',
    );
  });
});
