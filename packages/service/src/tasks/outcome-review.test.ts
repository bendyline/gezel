import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutcomeReviewer } from './outcome-review.js';

vi.mock('../gezels/ensure.js', () => ({
  ensureGezel: vi.fn(async () => ({ gezelId: 'reviewer-1' })),
}));

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
  const askGezelAndWait = vi.fn(async () => {
    await edit?.();
    return {
      outcome: 'reply' as const,
      text: reply,
      toGezelId: 'reviewer-1',
      toGezelName: 'Rae',
      sessionId: 'review-session',
    };
  });
  return {
    askGezelAndWait,
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
      catalog: {},
      chat: { askGezelAndWait },
    } as unknown as Parameters<typeof createOutcomeReviewer>[0],
  };
}

const record = async (round = 1) =>
  JSON.parse(
    await readFile(join(artifacts, `outcome-review/3/round-${round}/review.json`), 'utf8'),
  );

describe('createOutcomeReviewer', () => {
  it('asks a fresh reviewer for the owner session, records the round, and holds on findings', async () => {
    const { deps, askGezelAndWait } = fakeDeps(
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
    expect(askGezelAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        fromGezelId: 'owner',
        fromSessionId: 'owner-session',
        toGezelIdOrName: 'reviewer-1',
        subagentFor: { taskRef: 'p/3', ownerSessionId: 'owner-session' },
      }),
    );
    const brief = (askGezelAndWait.mock.calls[0] as unknown as [{ text: string }])[0].text;
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
    const { deps, askGezelAndWait } = fakeDeps('unused');
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
    expect(askGezelAndWait).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ mode: 'self' });
  });
});
