import { describe, expect, it, vi } from 'vitest';
import { MobileCanonicalGrader } from './canonical-grader.ts';
import { MobileFeedbackMailbox } from './feedback.ts';
import { type MobileCanonicalFixture, canonicalMobileFixtures } from './fixtures.ts';
import { type MobileReport, type MobileTrial, mobileTrialFacts } from './report.ts';

function seededTrial(f: MobileCanonicalFixture): MobileTrial {
  return {
    id: f.id,
    status: 'running',
    gezelId: 'developer',
    meesterId: 'meester',
    projectId: 'project',
    projects: [{ id: 'project', name: f.project!.name }],
    gezels: [
      { id: 'developer', ...f.gezel },
      { id: 'meester', name: 'Mira', role: 'Meester' },
    ],
    inflight: [],
    assertions: [],
    canonicalFixture: {
      id: f.id,
      sourceFile: f.sourceFile,
      sourceSha256: f.sourceSha256,
      output: f.output,
    },
    artifacts: f.files.map((file) => ({ projectId: 'project', area: 'workspace', ...file })),
    seeds: f.files.map((file) => ({ projectId: 'project', ...file })),
    sessions: [
      {
        id: 'session',
        gezelId: 'developer',
        projectId: 'project',
        title: 'Canonical brief',
        createdAt: '2026-09-20T00:00:00Z',
        lastActivityAt: '2026-09-20T00:00:01Z',
        messages: [{ id: 'user', role: 'user', at: '2026-09-20T00:00:00Z', content: f.prompts[0] }],
      },
    ] as MobileTrial['sessions'],
  };
}
function report(trial: MobileTrial): MobileReport {
  return {
    schemaVersion: 1,
    runId: 'fixture-contract',
    suite: 'contract',
    startedAt: '2026-09-20T00:00:00Z',
    complete: false,
    identity: {},
    trials: [trial],
    canonicalCoreCoverage: [],
  };
}

describe('unchanged canonical mobile grading', () => {
  it('grades all five added canonical seed snapshots without inventing mobile runtime requirements', async () => {
    const fixtures = await canonicalMobileFixtures();
    for (const fixture of fixtures.slice(5)) {
      const trial = seededTrial(fixture);
      const grade = await new MobileCanonicalGrader(true).grade(trial);
      expect(grade.success, fixture.id).toBe(false);
      expect(
        grade.logs.some((line) => /unadapted API|harness error/i.test(line)),
        grade.logs.join('\n'),
      ).toBe(false);
      for (const message of grade.feedback) {
        expect(message.gezelId).toBe('developer');
        if (message.kind === 'messageGezel') {
          expect(message.body.fromGezelId).toBe('meester');
          expect(message.body.suppressReply).toBe(true);
          expect(message.body.projectId).toBe('project');
        }
      }
    }
  }, 120000);
  it('preserves exact canonical feedback metadata and rejects non-idle or escaping snapshots', async () => {
    const fixture = (await canonicalMobileFixtures()).find((f) => f.id === 'plan-and-estimate')!;
    const trial = seededTrial(fixture);
    trial.artifacts.push({
      projectId: 'project',
      area: 'workspace',
      path: 'plan.md',
      content: '# Objective\nMove the office.',
    });
    const grade = await new MobileCanonicalGrader(true).grade(trial);
    expect(grade.feedback.length, grade.logs.join('\n')).toBeGreaterThan(0);
    const feedback = grade.feedback[0]!;
    expect(feedback.kind).toBe('messageGezel');
    if (feedback.kind === 'messageGezel') {
      expect(feedback.body.expectedDeliverable).toMatchObject({
        kind: 'file',
        filePath: 'plan.md',
      });
      expect(feedback.body.text).toContain('plan.md');
    }
    await expect(
      new MobileCanonicalGrader(true).grade({ ...trial, inflight: [{ sessionId: 'session' }] }),
    ).rejects.toThrow('idle native snapshot');
    await expect(
      new MobileCanonicalGrader().grade({
        ...trial,
        artifacts: [{ projectId: 'project', area: 'workspace', path: '../escape', content: 'bad' }],
      }),
    ).rejects.toThrow('Unsafe native workspace path');
  });
  it('deduplicates mailbox receipts and persists a grader failure as a failed receipt', async () => {
    const fixture = (await canonicalMobileFixtures()).find((f) => f.id === 'plan-and-estimate')!;
    const trial = { ...seededTrial(fixture), gradeRequest: { id: 'request-1' } };
    const spy = vi.spyOn(MobileCanonicalGrader.prototype, 'grade');
    try {
      const mailbox = new MobileFeedbackMailbox();
      const first = await mailbox.process(report(trial));
      expect(await mailbox.process(report(trial))).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      const bad = {
        ...trial,
        gradeRequest: { id: 'request-2' },
        canonicalFixture: { ...trial.canonicalFixture!, sourceSha256: 'wrong' },
      };
      expect(await mailbox.process(report(bad))).toMatchObject({
        requestId: 'request-2',
        error: expect.stringContaining('source changed'),
      });
    } finally {
      spy.mockRestore();
    }
  });
  it('counts changed seeded source files as authored deliverables without crediting untouched input', async () => {
    const fixture = (await canonicalMobileFixtures()).find((f) => f.id === 'symptom-debug')!;
    const trial = seededTrial(fixture);
    expect(mobileTrialFacts(report(trial), trial, '/tmp/contract').artifacts.otherFileCount).toBe(
      0,
    );
    trial.artifacts.find((file) => file.path === 'lib/paginate.mjs')!.content +=
      '\n// candidate edit';
    expect(mobileTrialFacts(report(trial), trial, '/tmp/contract').artifacts.otherFileCount).toBe(
      1,
    );
  });
});
