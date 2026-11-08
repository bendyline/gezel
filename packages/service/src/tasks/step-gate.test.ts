import type { NormalizedStepGate, ScriptRun } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { GateWorkspaceReader } from './gate-eval.js';
import { evaluateStepGate, gateMessageFingerprint } from './step-gate.js';

function gate(partial: Partial<NormalizedStepGate>): NormalizedStepGate {
  return {
    at: 'completion',
    checks: [],
    scripts: [],
    maxAttempts: 4,
    legacy: false,
    ...partial,
  };
}

function ws(files: Record<string, string> = {}): GateWorkspaceReader {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

function okRun(output: unknown): ScriptRun {
  return {
    id: 'run-1',
    projectId: 'p',
    scriptName: 's',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'ok',
    trigger: { kind: 'manual', userInitiated: true },
    inputs: {},
    output,
    calls: [],
    logs: '',
  };
}

describe('evaluateStepGate — unresolved launch placeholders', () => {
  it('treats a leftover {{param}} as an infrastructure fault, not a repairable rejection', async () => {
    // Wild-caught on Pull Request Review: the scope gate reached the
    // regex engine as `PR\s*#{{number}}`, so a correctly-written note
    // could never match. Presented as an ordinary rejection, it cost
    // three attempts of the reviewer re-deriving why correct work kept
    // failing, and was finally "passed" by writing the literal template
    // token into the task's permanent audit trail.
    const runScript = vi.fn();
    const outcome = await evaluateStepGate({
      gate: gate({
        scripts: [
          {
            name: 'checkTaskNoteContains',
            inputs: { pattern: '##\\s*Scope\\s*[—-]\\s*PR\\s*#{{number}}' },
          },
        ],
      }),
      ws: ws(),
      runScript,
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.infrastructureError).toBe(true);
    expect(outcome.message).toContain('{{number}}');
    expect(outcome.message).toContain('can never pass');
    // No assignee can fix it, so nothing should be spawned to try.
    expect(runScript).not.toHaveBeenCalled();
  });

  it('finds placeholders nested anywhere in a check, and names the field', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({
        checks: [
          {
            kind: 'corpusCoverage',
            file: 'coverage.json',
            corpusDir: '{{corpusScope}}',
            artifact: true,
          },
        ],
      }),
      ws: ws(),
      runScript: vi.fn(),
    });
    expect(outcome.infrastructureError).toBe(true);
    expect(outcome.message).toContain('corpusDir');
    expect(outcome.message).toContain('{{corpusScope}}');
  });

  it('leaves a fully-interpolated gate alone', async () => {
    // Regex braces must not read as template tokens — `\d{2}` and
    // friends are ordinary quantifiers, and flagging them would break
    // every numeric pattern in the catalog.
    const outcome = await evaluateStepGate({
      gate: gate({
        checks: [
          { kind: 'contains', file: 'review.md', pattern: 'PR #46 \\d{2,4} \\w{3}' },
          { kind: 'minBytes', file: 'review.md', bytes: 1 },
        ],
      }),
      ws: ws({ 'review.md': 'PR #46 1234 abc' }),
      runScript: vi.fn(),
    });
    expect(outcome.infrastructureError).toBeUndefined();
    expect(outcome.decision).toBe('approve');
  });
});

describe('evaluateStepGate', () => {
  it('rejects on a failed check WITHOUT running any script', async () => {
    const runScript = vi.fn();
    const outcome = await evaluateStepGate({
      gate: gate({
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
        scripts: [{ name: 'never-runs' }],
      }),
      ws: ws({ 'index.html': 'tiny' }),
      runScript,
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toContain('index.html is 4 bytes');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('first script reject short-circuits with its message and goto', async () => {
    const calls: string[] = [];
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
      ws: ws(),
      runScript: async (ref) => {
        calls.push(ref.name);
        if (ref.name === 'b') {
          return okRun({ decision: 'reject', message: 'fix the title screen', goto: 'design' });
        }
        return okRun({ decision: 'approve' });
      },
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toBe('fix the title screen');
    expect(outcome.goto).toBe('design');
    expect(calls).toEqual(['a', 'b']);
  });

  it('all approve → approve; LAST goto and handoff win', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'a' }, { name: 'b' }] }),
      ws: ws(),
      runScript: async (ref) =>
        ref.name === 'a'
          ? okRun({ decision: 'approve', goto: 'x', handoff: { message: 'first' } })
          : okRun({ decision: 'approve', goto: 'y', handoff: { message: 'second' } }),
    });
    expect(outcome.decision).toBe('approve');
    expect(outcome.goto).toBe('y');
    expect(outcome.handoff?.message).toBe('second');
  });

  it('script error and invalid output fail closed as infrastructure errors', async () => {
    const errored = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'boom' }] }),
      ws: ws(),
      runScript: async () => ({
        ...okRun(undefined),
        status: 'error',
        error: 'exploded',
        logs: '[stderr] detailed failure',
      }),
    });
    expect(errored.decision).toBe('reject');
    expect(errored.message).toContain('boom');
    expect(errored.message).toContain('exploded');
    expect(errored.infrastructureError).toBe(true);
    expect(errored.runs[0]).toMatchObject({
      scriptName: 'boom',
      runId: 'run-1',
      error: 'exploded',
      logsTail: '[stderr] detailed failure',
    });

    const invalid = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'weird' }] }),
      ws: ws(),
      runScript: async () => okRun({ totally: 'not a gate result' }),
    });
    expect(invalid.decision).toBe('reject');
    expect(invalid.message).toContain('invalid result');
    expect(invalid.infrastructureError).toBe(true);
  });

  it('a reject without a message is fail-closed too (schema enforces message)', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'mute' }] }),
      ws: ws(),
      runScript: async () => okRun({ decision: 'reject' }),
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toContain('invalid result');
  });

  it('skipped scripts fail-open: approve with the skips reported', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({
        checks: [{ kind: 'minBytes', file: 'a.txt', bytes: 1 }],
        scripts: [{ name: 'user-script' }, { name: 'std', scope: 'standard' }],
      }),
      ws: ws({ 'a.txt': 'content' }),
      runScript: async (ref) =>
        ref.scope === 'standard' ? okRun({ decision: 'approve' }) : 'skipped',
    });
    expect(outcome.decision).toBe('approve');
    expect(outcome.skipped).toEqual(['user-script']);
  });

  it('runScript throwing rejects with a diagnostic', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'missing', scope: 'standard' }] }),
      ws: ws(),
      runScript: async () => {
        throw new Error('ENOENT: no such script');
      },
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toContain('could not run');
    expect(outcome.infrastructureError).toBe(true);
  });
});

describe('gateMessageFingerprint', () => {
  it('is stable for equal text and differs for different text', () => {
    expect(gateMessageFingerprint('abc')).toBe(gateMessageFingerprint('abc'));
    expect(gateMessageFingerprint('abc')).not.toBe(gateMessageFingerprint('abd'));
  });
});

describe('line-based reviewer verdict enforcement', () => {
  const checks: NormalizedStepGate['checks'] = [
    { kind: 'contains', file: 'verdict.md', pattern: '\\bPASS\\s*$', flags: 'm', artifact: true },
    {
      kind: 'notContains',
      file: 'verdict.md',
      pattern: '\\bFAIL\\s*$',
      flags: 'm',
      artifact: true,
    },
  ];
  const evaluate = (text: string) =>
    evaluateStepGate({
      gate: gate({ checks }),
      ws: {
        ...ws({ 'verdict.md': 'Misleading workspace copy PASS' }),
        readArtifact: async () => text,
      },
      runScript: vi.fn(),
    });
  it('rejects the recorded prefix FAIL even when another line ends PASS', async () => {
    const result = await evaluate(
      'Amounts reconcile PASS\nFAIL — report total 5440 does not match the ledger total 5415.',
    );
    expect(result.decision).toBe('reject');
    expect(result.message).toContain('reports FAIL');
  });
  it.each([
    'Amounts PASS\nDates were not reviewed',
    'Amounts PASS\n  FAIL — bad date',
    '# Verdict',
    '',
    '## Sources\n\n[1] ledger.json',
  ])('rejects malformed or incomplete verdict text: %s', async (text) => {
    expect((await evaluate(text)).decision).toBe('reject');
  });
  it('accepts separate unambiguous passing criteria', async () => {
    expect(
      (await evaluate('Amounts reconcile PASS\nNumbers continue PASS\nDue dates match terms PASS'))
        .decision,
    ).toBe('approve');
  });
  // A rejected review routes back to its revise step, which on invoice-run
  // re-spawns the whole fanout crew; three of these and the task pauses.
  it.each([
    ['a heading', '# Verdict\n\nAmounts reconcile PASS\nDue dates match terms PASS'],
    [
      'a heading that carries the verdict',
      '## Verdict: PASS\n\n1. Amounts reconcile — PASS\n2. Due dates match terms — PASS',
    ],
    [
      'bold labels and decisions',
      '**Verdict**\n\n- **Amounts reconcile:** **PASS**\n- **Due dates match terms:** __PASS__\n\n**Overall: PASS**',
    ],
    ['"fail" explaining a passing line', 'Amounts reconcile PASS - no checks fail'],
    [
      'explanation after the decision',
      '- Amounts reconcile: PASS — every invoice traces to billables.json\n- Numbers continue: PASS (2026-041 through 2026-044)',
    ],
    ['a leading decision', 'PASS — amounts look right'],
    ['several passing criteria on one line', 'Amounts PASS Numbering PASS Dates PASS'],
    [
      'a table',
      '| Criterion | PASS/FAIL |\n| --- | :---: |\n| Amounts reconcile | PASS |\n| Due dates match terms | PASS |',
    ],
    [
      'a detail line using "fail" in prose',
      'Amounts reconcile PASS\n  none of the amounts fail to trace\nDue dates match terms PASS',
    ],
    ['a detail line ending in "failed"', 'Amounts reconcile PASS\n  - checked four; none failed'],
    ['lower-case decisions', 'Amounts reconcile: pass\nDue dates match terms: passed.'],
    [
      'a code fence and a rule',
      '```\nAmounts reconcile PASS\n---\nDue dates match terms PASS\n```',
    ],
    // The evidence ledger appends this list to a factual-mode verdict that
    // cites [n]; it paused qwen3.8-27b's invoice-run three reviews running
    // with every criterion PASS (2026-11-07).
    [
      'the Sources list the evidence ledger appends',
      'Amounts trace to the ledger [1][2] PASS\nDue dates follow the terms [3] PASS\n\n## Sources\n\n[1] ledger.json\n[2] invoices/2026-042.html\n[3] clients.json\n',
    ],
    [
      'a source whose title reads as a decision',
      'Amounts reconcile [1] PASS\n\n### References\n\n- [1] Failing invoices in July — notes/ci.md\n',
    ],
    [
      'a labeled source list',
      'Amounts reconcile [1] PASS\n\n**Sources:**\n[1] ledger.json\n[2] clients.json',
    ],
    [
      'an unnumbered reference whose title reads as a decision',
      'Amounts reconcile PASS\n\n## References\n\n- Smith, Failing Forward (2019)\n',
    ],
    [
      'a passing criterion under a Sources heading',
      '## Accuracy\n\n- Numbers match: PASS\n\n## Sources\n\n- Every claim cites a dated source: PASS\n\n[1] ledger.json',
    ],
  ])('accepts a passing verdict written with %s', async (_shape, text) => {
    const result = await evaluate(text);
    expect(result.message).toBeUndefined();
    expect(result.decision).toBe('approve');
  });
  it.each([
    ['a line ending in FAIL', 'Amounts reconcile PASS\nDue dates match terms FAIL'],
    [
      'a bold FAIL with its gap on the same line',
      'Amounts reconcile PASS\n- **Due dates match terms:** **FAIL** — 2026-043 is due on the 15th',
    ],
    [
      'a FAIL followed by an explanation',
      'Amounts reconcile PASS\nDue dates match terms: FAIL (2026-043 is due on the 15th)',
    ],
    ['a heading that carries FAIL', '## Verdict: FAIL\n\nAmounts reconcile PASS'],
    [
      'a FAIL table cell',
      '| Criterion | Result |\n|---|---|\n| Amounts reconcile | PASS |\n| Due dates | FAIL |',
    ],
    ['a lower-case fail as the decision', 'Amounts reconcile PASS\nDue dates match terms: fail'],
    ['a capitalized Failed', 'Amounts reconcile PASS\nDue dates: Failed — 2026-043'],
    ['PASS and FAIL on one line', 'Amounts reconcile PASS — the earlier FAIL is fixed'],
    ['a negated lower-case pass', 'Amounts reconcile PASS\nDue dates match terms: did not pass'],
    ['a contracted negation', "Amounts reconcile PASS\nDue dates match terms: doesn't pass"],
    ['a negated PASS', 'Amounts reconcile PASS\nDue dates match terms: NOT PASS'],
    [
      'a FAIL after the source list ends',
      'Amounts reconcile [1] PASS\n\n## Sources\n\n[1] ledger.json\n\n## Due dates\n\nDue dates match terms FAIL',
    ],
    [
      'a FAIL after a labeled source list',
      'Amounts reconcile [1] PASS\nSources:\n[1] ledger.json\nDue dates match terms FAIL',
    ],
    ['a criterion heading that names citations', 'Amounts reconcile PASS\n## Citations: FAIL'],
    [
      'a FAIL criterion under a Sources heading',
      '## Accuracy\n\n- Numbers match: PASS\n\n## Sources\n\n- Every claim cites a dated source: FAIL',
    ],
    [
      'a FAIL criterion under a References heading',
      'Amounts reconcile PASS\n\n### References\n\n- API references current: **FAIL** — two links 404',
    ],
  ])('rejects a verdict with %s', async (_shape, text) => {
    const result = await evaluate(text);
    expect(result.decision).toBe('reject');
    expect(result.message).toContain('FAIL');
  });
  it('leaves ordinary text regex gates alone', async () => {
    const result = await evaluateStepGate({
      gate: gate({ checks: [{ kind: 'contains', file: 'guide.md', pattern: 'PASS' }] }),
      ws: ws({ 'guide.md': 'Explain PASS and FAIL diagnostics.' }),
      runScript: vi.fn(),
    });
    expect(result.decision).toBe('approve');
  });
});
