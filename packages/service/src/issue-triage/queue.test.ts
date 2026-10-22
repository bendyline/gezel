import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoekwachterIssue, IssueVerdictEntry } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { type IssueHandoffDeps, buildIssueHandoffQueue } from './queue.js';

const PROJECT = 'code';
let n = 0;
function issue(over: Partial<BoekwachterIssue> = {}): BoekwachterIssue {
  n += 1;
  return {
    id: `i${n}`,
    ref: `BW-${n}`,
    fingerprint: `f${n}`,
    path: `src/file${n}.ts`,
    line: n,
    severity: 'minor',
    category: 'bug',
    message: `lead ${n}`,
    status: 'open',
    seen: false,
    stale: false,
    createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('the issue handoff queue', () => {
  let home: string;
  let store: Store;
  let issues: BoekwachterIssue[];
  let packs: Array<{ status: string; files: Array<{ path: string }> }>;

  beforeEach(async () => {
    n = 0;
    home = await mkdtemp(join(tmpdir(), 'gezel-issue-queue-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code' });
    issues = [];
    packs = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const deps = (): IssueHandoffDeps => ({
    contentIndex: {
      listFileIssues: async () => ({
        issues,
        counts: { total: issues.length, bySeverity: {}, byCategory: {} },
        truncated: false,
        indexed: true,
      }),
    } as unknown as IssueHandoffDeps['contentIndex'],
    diffpacks: { list: async () => packs } as unknown as IssueHandoffDeps['diffpacks'],
    store,
    random: () => 0,
  });

  /** Enough decided verdicts that batches stop sampling. */
  async function settleCalibration() {
    const verdicts = store.boekwachterIssues as unknown as {
      readIssueVerdicts: (id: string) => Promise<IssueVerdictEntry[]>;
    };
    const fake = Array.from(
      { length: 25 },
      (_, i) =>
        ({
          issueId: `old${i}`,
          kind: 'nit',
          category: 'style',
          by: { kind: 'person' },
        }) as IssueVerdictEntry,
    );
    verdicts.readIssueVerdicts = async () => fake;
  }

  const refs = (res: Awaited<ReturnType<typeof buildIssueHandoffQueue>>) =>
    res.files.flatMap((f) => f.issues.map((i) => i.ref));

  it('leaves out what is claimed, proposed, informational, settled or held by another app', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    issues = [
      issue(),
      issue({ taskRef: 'code/3', status: 'in_progress' }),
      issue({ path: 'src/proposed.ts' }),
      issue({ severity: 'info' }),
      issue({ latestVerdict: { kind: 'confirmed', by: { kind: 'person' }, at: 'x' } }),
      issue({ handoff: { client: 'codex', until: later } }),
      issue({ echoOf: 'BW-1', status: 'dismissed' }),
      issue({ supersededBy: 'BW-1' }),
    ];
    packs = [{ status: 'ready', files: [{ path: 'src/proposed.ts' }] }];
    const res = await buildIssueHandoffQueue(deps(), PROJECT, {}, { client: 'claude-code' });
    expect(refs(res)).toEqual(['BW-1']);
    expect(res.remaining).toBe(0);
  });

  it('gives a new project a sampled first batch: majors, then a spread of categories', async () => {
    issues = [
      ...Array.from({ length: 6 }, () => issue({ category: 'smell' })),
      issue({ severity: 'major' }),
      issue({ severity: 'major', stale: true }),
      ...Array.from({ length: 6 }, () => issue({ category: 'error handling' })),
      issue({ category: 'clarity' }),
    ];
    const res = await buildIssueHandoffQueue(deps(), PROJECT, { limit: 5 });
    expect(res.firstBatch).toBe(true);
    const picked = res.files.flatMap((f) => f.issues);
    expect(picked).toHaveLength(5);
    expect(picked.filter((i) => i.severity === 'major').map((i) => i.ref)).toContain('BW-7');
    expect(new Set(picked.map((i) => i.category)).size).toBeGreaterThanOrEqual(3);
  });

  it('takes a file’s other issues along once batches stop sampling', async () => {
    await settleCalibration();
    issues = [
      issue({ severity: 'major', path: 'src/a.ts' }),
      issue({ path: 'src/b.ts' }),
      issue({ path: 'src/a.ts' }),
      issue({ path: 'src/c.ts' }),
    ];
    const res = await buildIssueHandoffQueue(deps(), PROJECT, { limit: 3 });
    expect(res.firstBatch).toBe(false);
    expect(res.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(refs(res)).toEqual(['BW-1', 'BW-3', 'BW-2']);
    expect(res.remaining).toBe(1);
  });

  it('puts confirmed issues first when the app is asked to fix', async () => {
    issues = [
      issue({ severity: 'major' }),
      issue({
        latestVerdict: { kind: 'confirmed', by: { kind: 'person' }, at: 'x', note: 'Real.' },
      }),
    ];
    const res = await buildIssueHandoffQueue(deps(), PROJECT, { mode: 'fix' });
    expect(refs(res)).toEqual(['BW-2', 'BW-1']);
    expect(res.files[0]?.issues[0]).toMatchObject({ verdict: 'confirmed', verdictNote: 'Real.' });
  });

  it('holds the issues it hands an app for that app', async () => {
    await store.observeProjectBoekwachterReviews(PROJECT, [
      {
        path: 'src/file1.ts',
        contentHash: 'h',
        issues: [{ severity: 'minor', category: 'bug', message: 'lead 1' }],
      },
    ]);
    issues = [issue({ path: 'src/file1.ts' })];
    await buildIssueHandoffQueue(deps(), PROJECT, {}, { client: 'claude-code' });
    const [record] = await store.listProjectBoekwachterIssues(PROJECT);
    expect(record?.handoffLease?.client).toBe('claude-code');
  });
});
