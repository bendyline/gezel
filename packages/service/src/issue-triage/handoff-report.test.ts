import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoekwachterIssue, IssueVerdictEntry } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  ISSUE_HANDOFF_REPORT_PATH,
  type IssueHandoffDocumentDeps,
  countUnimportedAnswers,
  writeIssueHandoffReport,
} from './handoff-report.js';

const PROJECT = 'code';
const lead = (n: number, over: Partial<BoekwachterIssue> = {}): BoekwachterIssue => ({
  id: `i${n}`,
  ref: `BW-${n}`,
  fingerprint: `f${n}`,
  path: 'src/save.ts',
  line: n,
  severity: 'minor',
  category: 'bug',
  message: `lead ${n}`,
  status: 'open',
  seen: false,
  stale: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('the nightly issue handoff report', () => {
  let home: string;
  let store: Store;
  let issues: BoekwachterIssue[];
  let logged: IssueVerdictEntry[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-issue-handoff-report-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code' });
    issues = [lead(1), lead(2)];
    logged = [];
    // The issue registry and verdict log, as the index and imports leave them.
    store.listProjectBoekwachterIssues = async () => issues as never;
    (
      store.boekwachterIssues as {
        readIssueVerdicts: (id: string) => Promise<IssueVerdictEntry[]>;
      }
    ).readIssueVerdicts = async () => logged;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const night = (day: number) => new Date(`2026-10-${day}T06:00:00Z`);
  const report = async () =>
    (await store.readProjectArtifact(PROJECT, ISSUE_HANDOFF_REPORT_PATH)) ?? '';

  const deps = (random = () => 0): IssueHandoffDocumentDeps =>
    ({
      store,
      contentIndex: {
        listFileIssues: async () => ({
          issues,
          counts: { total: issues.length, bySeverity: {}, byCategory: {} },
          truncated: false,
          indexed: true,
        }),
        fileSummary: async (_projectId: string, path: string) =>
          path === 'src/save.ts'
            ? '# save.ts\n\nWrites the **document** to disk. Retries once.\n\nMore.'
            : null,
      },
      diffpacks: { list: async () => [] },
      random,
    }) as unknown as IssueHandoffDocumentDeps;

  it('writes the open issues with absolute paths and a response block each', async () => {
    expect(await writeIssueHandoffReport(deps(), PROJECT, night(22))).toEqual({
      path: ISSUE_HANDOFF_REPORT_PATH,
      wrote: true,
    });
    const text = await report();
    const workspace = await store.projectWorkspaceDir(PROJECT);
    expect(text).toContain('# Issues for review: Code');
    expect(text).toContain(`${join(workspace, 'src/save.ts')}:1`);
    expect(text).toContain('<!-- gezel:response BW-2 -->');
  });

  it('shows the code at each line and what the file is for', async () => {
    const workspace = await store.projectWorkspaceDir(PROJECT);
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src/save.ts'), 'const a = 1;\nsave(a);\nexport {};\n');
    issues = [lead(2), lead(3, { stale: true })];
    await writeIssueHandoffReport(deps(), PROJECT, night(22));
    const text = await report();
    expect(text).toContain('_Writes the document to disk._');
    expect(text).toContain('```ts\n  1 | const a = 1;\n> 2 | save(a);\n  3 | export {};\n```');
    // The stale lead's line has moved: no excerpt for it.
    expect(text.slice(text.indexOf('### BW-3'))).not.toContain('```');
  });

  it('leaves the file alone when only the night changed, and writes nothing with no issues', async () => {
    const unchanged = { path: ISSUE_HANDOFF_REPORT_PATH, wrote: false };
    await writeIssueHandoffReport(deps(), PROJECT, night(22));
    expect(await writeIssueHandoffReport(deps(), PROJECT, night(23))).toEqual(unchanged);
    issues = [];
    expect(await writeIssueHandoffReport(deps(), PROJECT, night(24))).toEqual(unchanged);
  });

  it('keeps its batch until one of its issues is settled, however the picks fall', async () => {
    issues = Array.from({ length: 40 }, (_, i) => lead(i + 1, { category: `c${i % 5}` }));
    await writeIssueHandoffReport(
      deps(() => 0),
      PROJECT,
      night(22),
    );
    const first = await report();
    const listed = [...first.matchAll(/^### (BW-\d+)/gm)].map((m) => m[1]);
    expect(listed).toHaveLength(20);

    // New leads tonight only move the count of what is waiting.
    issues.push(lead(41), lead(42));
    expect(
      (
        await writeIssueHandoffReport(
          deps(() => 0.99),
          PROJECT,
          night(23),
        )
      ).wrote,
    ).toBe(false);

    const settled = listed[3];
    issues = issues.map((i) => (i.ref === settled ? { ...i, status: 'dismissed' as const } : i));
    expect(
      (
        await writeIssueHandoffReport(
          deps(() => 0.99),
          PROJECT,
          night(24),
        )
      ).wrote,
    ).toBe(true);
    const next = [...(await report()).matchAll(/^### (BW-\d+)/gm)].map((m) => m[1]);
    expect(next).toHaveLength(20);
    expect(next).not.toContain(settled);
    expect(next).toEqual(expect.arrayContaining(listed.filter((ref) => ref !== settled)));
  });

  it('never replaces answers nobody has imported', async () => {
    await writeIssueHandoffReport(deps(), PROJECT, night(22));
    const answered = (await report()).replace(
      '<!-- gezel:response BW-1 -->\nVerdict:\nReason:\nNotes:',
      '<!-- gezel:response BW-1 -->\nVerdict: confirmed\nReason:\nNotes: The loop runs one short.',
    );
    await store.writeProjectArtifact(PROJECT, ISSUE_HANDOFF_REPORT_PATH, answered);

    // A settled issue would rewrite the batch; the unimported answer holds it.
    issues = [lead(1), lead(2, { status: 'dismissed' }), lead(3)];
    expect(await writeIssueHandoffReport(deps(), PROJECT, night(23))).toEqual({
      path: ISSUE_HANDOFF_REPORT_PATH,
      wrote: false,
      unimportedAnswers: 1,
    });
    expect(await report()).toBe(answered);

    logged = [
      {
        issueId: 'i1',
        ref: 'BW-1',
        kind: 'confirmed',
        note: 'The loop runs one short.',
        category: 'bug',
        severity: 'minor',
        by: { kind: 'person' },
      } as IssueVerdictEntry,
    ];
    expect((await writeIssueHandoffReport(deps(), PROJECT, night(24))).wrote).toBe(true);
  });

  it('does not count an answer an import would refuse', async () => {
    const doc = [
      '<!-- gezel:response BW-99 -->',
      'Verdict: nit',
      '<!-- /gezel:response -->',
      '<!-- gezel:response BW-1 -->',
      'Verdict: duplicate',
      'Reason: BW-98',
      '<!-- /gezel:response -->',
    ].join('\n');
    expect(await countUnimportedAnswers({ store }, PROJECT, doc)).toBe(0);
  });
});
