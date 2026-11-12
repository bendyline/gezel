import { describe, expect, it } from 'vitest';
import {
  BENCH_EVENT_PREFIX,
  BenchCaseOutcomeSchema,
  BenchPackManifestSchema,
  parseBenchEventLine,
} from './bench-pack.js';

/** Shaped like DocBlocks' `docbench-pack describe`, trimmed to one task. */
const manifest = {
  schemaVersion: 1,
  id: 'docbench',
  version: '0.1.0',
  families: [
    { id: 'review', label: 'Review and feedback', weight: 0.25 },
    { id: 'writing', label: 'Writing and rewriting', weight: 0.75 },
  ],
  tasks: [
    {
      id: 'review-resume',
      family: 'review',
      label: 'Resume feedback',
      description: 'The Review panel in its Resume style.',
      trials: 1,
      scoring: { checks: 0.15, judge: 0.85 },
      judge: {
        rubricId: 'review-matcher@1',
        mode: 'matcher',
        matchWeight: 0.8,
        instructions: 'Match findings against the answer key.',
        axes: [{ id: 'helpfulness', label: 'Helpfulness', description: 'How much it helps.' }],
      },
      cases: [{ id: 'junior-developer', label: 'junior developer' }],
    },
  ],
};

const outcome = {
  schemaVersion: 1,
  packVersion: '0.1.0',
  taskId: 'review-resume',
  caseId: 'junior-developer',
  trial: 0,
  seed: 1000,
  model: 'llama-cpp:lfm3-1.7b-q4',
  contextWindow: 262144,
  usable: true,
  checks: [
    { id: 'readable', label: 'The panel could read the review', score: 1, weight: 2 },
    {
      id: 'quotes-locate',
      label: 'Quotes match',
      score: 0.3333,
      weight: 2,
      detail: '2/6',
    },
  ],
  artifact: { kind: 'json', content: '[]' },
  judgeInput: {
    rubricId: 'review-matcher@1',
    context: '<document>…</document>',
    answerKey: [{ id: 'duty', quote: 'Responsible for', issue: 'A duty, not an achievement.' }],
    items: [{ id: 'f1', text: 'Quote: "Responsible for…"' }],
  },
  calls: [{ promptTokens: 677, completionTokens: 834, finishReason: 'stop', ms: 5912 }],
  error: null,
  notes: ['6 findings in 1 requests over 1 parts'],
  ms: 5930,
};

describe('bench pack contract', () => {
  it("accepts DocBlocks' manifest and outcome shapes", () => {
    expect(BenchPackManifestSchema.parse(manifest).tasks[0]?.judge?.mode).toBe('matcher');
    expect(BenchCaseOutcomeSchema.parse(outcome).calls[0]?.completionTokens).toBe(834);
  });

  it('rejects a pack from a newer contract, and malformed checks', () => {
    expect(BenchPackManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(
      false,
    );
    const badCheck = {
      ...outcome,
      checks: [{ id: 'x', label: 'x', score: 1.5, weight: 1 }],
    };
    expect(BenchCaseOutcomeSchema.safeParse(badCheck).success).toBe(false);
  });

  it('reads progress lines and ignores everything else', () => {
    const line = `${BENCH_EVENT_PREFIX}${JSON.stringify({
      type: 'case-done',
      taskId: 'review-resume',
      caseId: 'junior-developer',
      usable: false,
      error: 'infra',
      ms: 12,
      file: '/runs/x.json',
    })}`;
    expect(parseBenchEventLine(line)).toMatchObject({ type: 'case-done', error: 'infra' });
    expect(parseBenchEventLine('Warning: something on stdout')).toBeNull();
    expect(parseBenchEventLine(`${BENCH_EVENT_PREFIX}{not json`)).toBeNull();
    expect(parseBenchEventLine(`${BENCH_EVENT_PREFIX}{"type":"mystery"}`)).toBeNull();
  });
});
