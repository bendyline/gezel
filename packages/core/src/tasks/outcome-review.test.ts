import { describe, expect, it } from 'vitest';
import type { CraftbookContract } from '../schemas/craftbook-contract.js';
import {
  OUTCOME_REVIEW_MAX_FINDINGS,
  outcomeReviewFindingKind,
  parseOutcomeReviewVerdict,
  renderFreshReviewBrief,
  renderOutcomeReviewFindings,
  renderSelfReviewMessage,
} from './outcome-review.js';

const contract: CraftbookContract = {
  goal: 'A cited research report that answers the brief.',
  deliverables: [
    {
      id: 'report',
      path: 'tasks/eval/report.md',
      artifact: true,
      kind: 'markdown',
      role: 'primary',
      description: 'The report',
    },
  ],
  criteria: [
    {
      id: 'cited',
      kind: 'quality',
      text: 'Every claim cites its source',
      enforce: 'gate',
      checks: [{ kind: 'minBytes', file: 'tasks/eval/report.md', bytes: 100, artifact: true }],
    },
    { id: 'judged', kind: 'quality', text: 'Reads well', enforce: 'eval-only', checks: [] },
  ],
} as unknown as CraftbookContract;

describe('outcome review text', () => {
  it('gives both modes the same focus and cap', () => {
    const self = renderSelfReviewMessage(contract);
    const fresh = renderFreshReviewBrief({
      taskRef: 'p/1',
      title: 'Report',
      request: 'Write the report.',
      contract,
    });
    for (const text of [self, fresh]) {
      expect(text).toContain('`tasks/eval/report.md` (artifacts drawer)');
      expect(text).toContain('a name, number, date or quote the sources do not support');
      expect(text).toContain(`at most ${OUTCOME_REVIEW_MAX_FINDINGS} problems`);
    }
    expect(self).toContain('call advance_task_step again');
    for (const text of [self, fresh]) {
      expect(text).toContain('A problem counts only if you can quote the line');
    }
    expect(self).toContain(
      'Never add a fact, name, number, date or quote the sources do not state.',
    );
    expect(fresh).toContain('1. FIX `<file>`');
    expect(fresh).toContain('2. CHECK `<file>`');
    expect(fresh).toContain('A file you could not open is not a problem with the work');
  });

  it('shows the reviewer the contract the owner saw, without its runtime note or eval-only criteria', () => {
    const fresh = renderFreshReviewBrief({
      taskRef: 'p/1',
      title: 'Report',
      request: 'Write the report.',
      contract,
    });
    expect(fresh).toContain('### Task contract');
    expect(fresh).toContain('Every claim cites its source');
    expect(fresh).not.toContain('Reads well');
    expect(fresh).not.toContain('The runtime checks');
    expect(fresh).toContain('Do not change, create or delete any file.');
  });
});

describe('parseOutcomeReviewVerdict', () => {
  it('reads a pass', () => {
    expect(parseOutcomeReviewVerdict('VERDICT: PASS')).toEqual({ verdict: 'pass', findings: [] });
    expect(parseOutcomeReviewVerdict('**Verdict: pass**\n1. nothing')).toEqual({
      verdict: 'pass',
      findings: [],
    });
  });

  it('reads numbered findings under a fail, joining wrapped lines and capping the count', () => {
    const reply = [
      'VERDICT: FAIL',
      '1. `report.md` — Summary — says 12% — the source says 21%',
      '   change it to 21%.',
      '2. `report.md` — Risks — missing — add the vendor risk',
      ...Array.from({ length: 6 }, (_, i) => `${i + 3}. \`report.md\` — extra ${i}`),
    ].join('\n');
    const parsed = parseOutcomeReviewVerdict(reply);
    expect(parsed.verdict).toBe('fail');
    expect(parsed.findings).toHaveLength(OUTCOME_REVIEW_MAX_FINDINGS);
    expect(parsed.findings[0]).toBe(
      '`report.md` — Summary — says 12% — the source says 21% change it to 21%.',
    );
  });

  it('treats findings without a verdict as a fail, and a bare fail as unclear', () => {
    expect(parseOutcomeReviewVerdict('1. `a.md` — fix it').verdict).toBe('fail');
    expect(parseOutcomeReviewVerdict('VERDICT: FAIL').verdict).toBe('unclear');
    expect(parseOutcomeReviewVerdict('Looks fine to me.').verdict).toBe('unclear');
  });

  it('numbers the findings for the owner and asks it to check them first', () => {
    const text = renderOutcomeReviewFindings(['FIX `a.md` — x — y — z', 'CHECK `b.md` — q']);
    expect(text).toContain('1. FIX `a.md` — x — y — z\n2. CHECK `b.md` — q');
    expect(text).toContain('The reviewer can be wrong, so check each finding');
    expect(text).toContain(
      'Change a CHECK finding only where the sources or the request confirm it.',
    );
    expect(text).toContain('call advance_task_step again without changes');
  });

  it('reads whether a finding is backed by evidence', () => {
    expect(outcomeReviewFindingKind('FIX `a.md` — "x" — wrong')).toBe('fix');
    expect(outcomeReviewFindingKind('**CHECK** `a.md` — doubt')).toBe('check');
    expect(outcomeReviewFindingKind('`a.md` — no mark')).toBe('unmarked');
  });
});
