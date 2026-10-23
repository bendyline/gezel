import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectBoekwachterVerdictsFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

const PROJECT = 'code';
const lead = {
  severity: 'major' as const,
  category: 'bug',
  message: 'The loop stops one item early, so the last row is never saved.',
  line: 12,
};

describe('verdicts on BW issues', () => {
  let home: string;
  let store: Store;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-bw-verdicts-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code' });
    await store.observeProjectBoekwachterReviews(PROJECT, [
      { path: 'src/save.ts', contentHash: 'h1', issues: [lead], model: 'qwen3.8-27b' },
    ]);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const apply = (
    input: Parameters<Store['boekwachterIssues']['applyIssueVerdicts']>[1][number]['input'],
    fileHash: string | null = 'h1',
    by = { kind: 'app' as const, client: 'claude-code' },
  ) => store.boekwachterIssues.applyIssueVerdicts(PROJECT, [{ input, fileHash }], by);

  it('records the reviewer model on the issue it creates', async () => {
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({
      firstReviewModel: 'qwen3.8-27b',
      lastReviewModel: 'qwen3.8-27b',
    });
  });

  it('dismisses a not-a-bug lead, keeps the note, and logs who said it', async () => {
    const [outcome] = await apply({
      ref: 'BW-1',
      kind: 'not_a_bug',
      reason: 'handled_elsewhere',
      note: 'The caller pads the list with a sentinel row (src/rows.ts:40).',
    });
    expect(outcome).toMatchObject({ outcome: 'applied' });

    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({
      status: 'dismissed',
      dismissalReason: 'not_an_issue',
      latestVerdict: {
        kind: 'not_a_bug',
        reason: 'handled_elsewhere',
        by: { kind: 'app', client: 'claude-code' },
      },
    });

    const [entry] = await store.boekwachterIssues.readIssueVerdicts(PROJECT);
    expect(entry).toMatchObject({
      ref: 'BW-1',
      kind: 'not_a_bug',
      reviewModel: 'qwen3.8-27b',
      message: lead.message,
      fileHash: 'h1',
      preFixHash: 'h1',
    });
  });

  it('keeps a nit apart from a wrong lead, though both close the issue', async () => {
    await apply({ ref: 'BW-1', kind: 'nit', note: 'True, but the list never has one row.' });
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({ status: 'dismissed', dismissalReason: 'wont_fix' });
    expect(issue?.latestVerdict?.kind).toBe('nit');
  });

  it('accepts "fixed" on an unchanged file but marks it unverified', async () => {
    const [outcome] = await apply({ ref: 'BW-1', kind: 'fixed' }, 'h1');
    expect(outcome?.message).toMatch(/hasn't changed/);
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({ status: 'resolved', latestVerdict: { unverified: true } });

    const [changed] = await apply({ ref: 'BW-1', kind: 'fixed' }, 'h2');
    expect(changed?.message).not.toMatch(/hasn't changed/);
  });

  it("refuses an app's verdict on an issue a task is working on, but not the person's", async () => {
    await store.updateProjectBoekwachterIssue(PROJECT, 'BW-1', {
      status: 'in_progress',
      taskRef: 'code/7',
    });
    const [refused] = await apply({ ref: 'BW-1', kind: 'not_a_bug' });
    expect(refused).toMatchObject({ outcome: 'refused' });
    expect(refused?.message).toContain('code/7');

    const [applied] = await apply({ ref: 'BW-1', kind: 'not_a_bug' }, 'h1', {
      kind: 'person',
    } as never);
    expect(applied?.outcome).toBe('applied');
  });

  it('leaves a task alone when an app confirms an issue the task is fixing', async () => {
    await store.updateProjectBoekwachterIssue(PROJECT, 'BW-1', {
      status: 'in_progress',
      taskRef: 'code/7',
    });
    const [outcome] = await apply({ ref: 'BW-1', kind: 'confirmed' }, 'h1', {
      kind: 'person',
    } as never);
    expect(outcome?.outcome).toBe('applied');
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({ status: 'in_progress', taskRef: 'code/7' });
  });

  it('refuses unknown refs and duplicates of issues that do not exist', async () => {
    const outcomes = await store.boekwachterIssues.applyIssueVerdicts(
      PROJECT,
      [
        { input: { ref: 'BW-9', kind: 'confirmed' }, fileHash: null },
        { input: { ref: 'BW-1', kind: 'duplicate', duplicateOf: 'BW-4' }, fileHash: null },
      ],
      { kind: 'person' },
    );
    expect(outcomes.map((o) => o.outcome)).toEqual(['refused', 'refused']);
    expect(await store.boekwachterIssues.readIssueVerdicts(PROJECT)).toEqual([]);
  });

  it('logs a recurrence when a fixed lead comes back on new content', async () => {
    await apply({ ref: 'BW-1', kind: 'fixed' }, 'h2');
    await store.observeProjectBoekwachterReviews(PROJECT, [
      { path: 'src/save.ts', contentHash: 'h3', issues: [lead] },
    ]);
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({ status: 'open', latestVerdict: { kind: 'recurred' } });
    const kinds = (await store.boekwachterIssues.readIssueVerdicts(PROJECT)).map((e) => e.kind);
    expect(kinds).toEqual(['fixed', 'recurred']);
  });

  it('reopens a fixed lead when the file is reverted to the content it was reported on', async () => {
    await apply({ ref: 'BW-1', kind: 'fixed' }, 'h2');
    // The fixed file is reviewed clean...
    await store.observeProjectBoekwachterReviews(PROJECT, [
      { path: 'src/save.ts', contentHash: 'h2', issues: [] },
    ]);
    expect((await store.listProjectBoekwachterIssues(PROJECT))[0]?.status).toBe('resolved');
    // ...then `git checkout` brings back the old content, whose review is cached.
    await store.observeProjectBoekwachterReviews(PROJECT, [
      { path: 'src/save.ts', contentHash: 'h1', issues: [lead] },
    ]);
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({ status: 'open', latestVerdict: { kind: 'recurred' } });
  });

  it('does not reopen an unverified fix while the file stays the same', async () => {
    await apply({ ref: 'BW-1', kind: 'fixed' }, 'h1');
    await store.observeProjectBoekwachterReviews(PROJECT, [
      { path: 'src/save.ts', contentHash: 'h1', issues: [lead] },
    ]);
    expect((await store.listProjectBoekwachterIssues(PROJECT))[0]?.status).toBe('resolved');
  });

  it('logs the person reopening a closed issue as an override', async () => {
    await apply({ ref: 'BW-1', kind: 'not_a_bug' });
    const reopened = await store.boekwachterIssues.reopenIssue(PROJECT, 'BW-1', { kind: 'person' });
    expect(reopened).toMatchObject({ status: 'open', latestVerdict: { kind: 'reopened' } });
    const kinds = (await store.boekwachterIssues.readIssueVerdicts(PROJECT)).map((e) => e.kind);
    expect(kinds).toEqual(['not_a_bug', 'reopened']);
  });

  it('keeps the triage fields across an unrelated write', async () => {
    await apply({ ref: 'BW-1', kind: 'confirmed', note: 'Reproduced with three rows.' });
    await store.updateProjectBoekwachterIssue(PROJECT, 'BW-1', { seen: true });
    const [issue] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(issue).toMatchObject({
      lastReviewModel: 'qwen3.8-27b',
      latestVerdict: { kind: 'confirmed', note: 'Reproduced with three rows.' },
    });
  });

  it('skips a torn line in the verdict log rather than losing the rest', async () => {
    await apply({ ref: 'BW-1', kind: 'confirmed' });
    const file = projectBoekwachterVerdictsFile(home, PROJECT);
    await writeFile(file, `${await readFile(file, 'utf8')}{"id":"torn`);
    expect(await store.boekwachterIssues.readIssueVerdicts(PROJECT)).toHaveLength(1);
  });
});

describe('reworded repeats of earlier leads', () => {
  let home: string;
  let store: Store;
  const P = 'code';
  const observe = (contentHash: string, issues: Array<Record<string, unknown>>) =>
    store.observeProjectBoekwachterReviews(P, [
      { path: 'src/save.ts', contentHash, issues: issues as never },
    ]);
  const first = {
    severity: 'minor',
    category: 'bug',
    message: 'The loop in `saveRows` stops one item early, so the last row is never saved.',
    line: 40,
  };
  const reworded = {
    severity: 'minor',
    category: 'bug',
    message: '`saveRows` loop stops one item early and never saves the last row.',
    line: 42,
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-bw-echo-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code' });
    await observe('h1', [first]);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const byRef = async () =>
    Object.fromEntries((await store.listProjectBoekwachterIssues(P)).map((r) => [r.ref, r]));

  it('closes a repeat of a lead someone judged not a bug, and says what it repeats', async () => {
    await store.boekwachterIssues.applyIssueVerdicts(
      P,
      [{ input: { ref: 'BW-1', kind: 'not_a_bug' }, fileHash: 'h1' }],
      { kind: 'person' },
    );
    await observe('h2', [reworded]);
    const { 'BW-2': repeat } = await byRef();
    expect(repeat).toMatchObject({
      status: 'dismissed',
      dismissalReason: 'duplicate',
      echoOf: 'BW-1',
      latestVerdict: { kind: 'echo', note: 'Repeats BW-1, which was judged not a bug.' },
    });
  });

  it('keeps a major repeat open for a second look', async () => {
    await store.boekwachterIssues.applyIssueVerdicts(
      P,
      [{ input: { ref: 'BW-1', kind: 'not_a_bug' }, fileHash: 'h1' }],
      { kind: 'person' },
    );
    await observe('h2', [{ ...reworded, severity: 'major' }]);
    const { 'BW-2': repeat } = await byRef();
    expect(repeat).toMatchObject({ status: 'open', echoOf: 'BW-1' });
  });

  it('lets a rewording replace an open lead and keep its confirmation', async () => {
    await store.boekwachterIssues.applyIssueVerdicts(
      P,
      [{ input: { ref: 'BW-1', kind: 'confirmed', note: 'Reproduced.' }, fileHash: 'h1' }],
      { kind: 'app', client: 'claude-code' },
    );
    await observe('h2', [reworded]);
    const issues = await byRef();
    expect(issues['BW-1']).toMatchObject({ status: 'open', supersededBy: 'BW-2' });
    expect(issues['BW-2']?.latestVerdict).toMatchObject({ kind: 'confirmed', note: 'Reproduced.' });
  });

  it('never links two different leads reported side by side', async () => {
    await observe('h2', [first, { ...first, message: 'Unhandled rejection in `fetchUser`.' }]);
    const issues = await byRef();
    expect(Object.keys(issues)).toEqual(['BW-1', 'BW-2']);
    expect(issues['BW-1']?.supersededBy).toBeUndefined();
    expect(issues['BW-2']?.echoOf).toBeUndefined();
  });
});
