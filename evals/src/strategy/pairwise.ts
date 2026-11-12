/**
 * A blind comparison of two versions of one trial's deliverables: the work as
 * it stood before a review, and as it was handed in after. Scoring each
 * version on its own moved an unchanged deliverable by up to 0.4 points
 * between two judgings (review pilot, 2026-11-10), as large as the effect
 * being measured. Asked which of two versions is better, the judge compares
 * the very sentences that changed. Each sample shows the versions in a fixed
 * order, alternating across samples, so a preference for whichever comes
 * first cancels out.
 */
import { JUDGE_MODEL, type JudgeBundle, callJudgeCli } from './judge.ts';

export const PAIRWISE_SAMPLES = 4;

export const PAIRWISE_SCHEMA = {
  type: 'object',
  properties: {
    better: { type: 'string', enum: ['A', 'B', 'tie'] },
    reasons: { type: 'string' },
  },
  required: ['better', 'reasons'],
  additionalProperties: false,
} as const;

export interface PairwiseSample {
  /** Which version the judge saw first. */
  order: 'before-first' | 'after-first';
  better: 'before' | 'after' | 'tie';
  reasons: string;
}

export interface PairwiseReport {
  model: string;
  samples: PairwiseSample[];
  /** Mean preference for the after version: +1 after, -1 before, 0 tie. */
  score: number;
  errors: string[];
}

/** The prompt for one sample. Deliverables the two versions share are shown once. */
export function pairwisePrompt(a: JudgeBundle, b: JudgeBundle): string {
  const shared: string[] = [];
  const differing: Array<{ label: string; a: string; b: string }> = [];
  a.deliverables.forEach((d, i) => {
    const other = b.deliverables[i];
    if (other && other.text === d.text) shared.push(`### ${d.label}\n\n${d.text}`);
    else differing.push({ label: d.label, a: d.text, b: other?.text ?? '[missing]' });
  });
  return [
    'Two versions of the work a team delivered for a person are shown below, A and B. They differ only where shown. Decide which version better serves the person. Judge only what is shown here.',
    '',
    '## The request',
    a.request,
    '',
    '## The goal and quality bar the work was held to',
    a.goal,
    ...a.bar.map((line) => `- ${line}`),
    '',
    ...(shared.length > 0
      ? ['## Deliverables that are the same in both versions', '', ...shared, '']
      : []),
    '## Where the versions differ',
    '',
    ...differing.flatMap((d) => [
      `### ${d.label}: version A`,
      '',
      d.a,
      '',
      `### ${d.label}: version B`,
      '',
      d.b,
      '',
    ]),
    a.sources.length > 0
      ? `## The sources the work had\n\n${a.sources.map((s) => `### Source: ${s.label}\n\n${s.text}`).join('\n\n')}`
      : '## The sources the work had\n\nNone were supplied.',
    '',
    'Weigh fitness to the request, completeness against the bar, grounding (every name, number, date and quote supported by the sources, nothing invented) and craft. Answer `better` as A, B, or tie when the differences do not make one better for the person. In `reasons`, name the differences that decided it, in at most 80 words.',
  ].join('\n');
}

export function parsePairwiseOutput(stdout: string): {
  better: 'A' | 'B' | 'tie';
  reasons: string;
} {
  const outer = JSON.parse(stdout) as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
  };
  if (outer.is_error) throw new Error(`judge call failed: ${String(outer.result).slice(0, 200)}`);
  const raw =
    (outer.structured_output as Record<string, unknown> | undefined) ??
    (JSON.parse(outer.result ?? '') as Record<string, unknown>);
  const better = raw.better;
  if (better !== 'A' && better !== 'B' && better !== 'tie') {
    throw new Error(`judge returned an invalid choice: ${String(better)}`);
  }
  return { better, reasons: String(raw.reasons ?? '') };
}

/** Compare a trial's before and after bundles, alternating which comes first. */
export function judgePairwise(
  before: JudgeBundle,
  after: JudgeBundle,
  opts: { cliPath?: string; samples?: number; model?: string } = {},
): PairwiseReport {
  const model = opts.model ?? JUDGE_MODEL;
  const samples: PairwiseSample[] = [];
  const errors: string[] = [];
  for (let i = 0; i < (opts.samples ?? PAIRWISE_SAMPLES); i++) {
    const order = i % 2 === 0 ? 'before-first' : 'after-first';
    const [a, b] = order === 'before-first' ? [before, after] : [after, before];
    try {
      const out = parsePairwiseOutput(
        callJudgeCli(pairwisePrompt(a, b), PAIRWISE_SCHEMA, opts.cliPath ?? 'claude', model),
      );
      const better =
        out.better === 'tie'
          ? 'tie'
          : (out.better === 'A') === (order === 'before-first')
            ? 'before'
            : 'after';
      samples.push({ order, better, reasons: out.reasons });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  const score =
    samples.reduce((n, s) => n + (s.better === 'after' ? 1 : s.better === 'before' ? -1 : 0), 0) /
    Math.max(1, samples.length);
  return { model, samples, score, errors };
}
