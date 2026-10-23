import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoekwachterIssue } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  ISSUE_HANDOFF_REPORT_PATH,
  type IssueHandoffDocumentDeps,
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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-issue-handoff-report-'));
    store = new Store({ home });
    await store.createProject({ name: 'Code' });
    issues = [lead(1), lead(2)];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const deps = (): IssueHandoffDocumentDeps =>
    ({
      store,
      contentIndex: {
        listFileIssues: async () => ({
          issues,
          counts: { total: issues.length, bySeverity: {}, byCategory: {} },
          truncated: false,
          indexed: true,
        }),
      },
      diffpacks: { list: async () => [] },
      random: () => 0,
    }) as unknown as IssueHandoffDocumentDeps;

  it('writes the open issues with absolute paths and a response block each', async () => {
    const path = await writeIssueHandoffReport(deps(), PROJECT, new Date('2026-10-22T06:00:00Z'));
    expect(path).toBe(ISSUE_HANDOFF_REPORT_PATH);
    const text = await store.readProjectArtifact(PROJECT, ISSUE_HANDOFF_REPORT_PATH);
    const workspace = await store.projectWorkspaceDir(PROJECT);
    expect(text).toContain('# Issues for review: Code');
    expect(text).toContain(`${join(workspace, 'src/save.ts')}:1`);
    expect(text).toContain('<!-- gezel:response BW-2 -->');
  });

  it('leaves the file alone when only the night changed, and writes nothing with no issues', async () => {
    await writeIssueHandoffReport(deps(), PROJECT, new Date('2026-10-22T06:00:00Z'));
    expect(
      await writeIssueHandoffReport(deps(), PROJECT, new Date('2026-10-23T06:00:00Z')),
    ).toBeNull();
    issues = [];
    expect(
      await writeIssueHandoffReport(deps(), PROJECT, new Date('2026-10-24T06:00:00Z')),
    ).toBeNull();
  });
});
