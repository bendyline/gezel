/**
 * Is the docbench judge measuring anything? Three tests, run on a finished,
 * judged round, before its scores are published and whenever the judge or
 * its prompts change (method and thresholds shared with the strategy
 * benchmark, `strategy/judge-validity.ts`):
 *
 * 1. **Retest**: a fixed sample of outcomes judged again; the judge's score
 *    must not wander (mean standard deviation at most 0.7 on the 0–10 scale).
 * 2. **Second judge**: the same sample judged by a different model; the two
 *    must agree (interval Krippendorff's alpha at least 0.6).
 * 3. **Planted defects**: good outputs damaged in a known way — review
 *    findings swapped for "this sentence is correct", text cut short,
 *    figures changed, a picture's labels removed — must score at least 2
 *    points lower in at least 90% of cases.
 *
 * Damaged copies are judged in memory; nothing in the round changes except
 * `validity.json` and `validity.md` written beside it.
 */

import type { BenchCaseOutcome, BenchTaskInfo } from '@bendyline/gezel/eval';
import {
  DEFECT_MIN_DROP,
  VALIDITY_THRESHOLDS,
  falsifiedFigure,
  krippendorffAlphaInterval,
} from '../strategy/judge-validity.ts';
import {
  DOCBENCH_JUDGE_PROMPT_VERSION,
  type JudgeProvider,
  type SvgRenderer,
  judgeOutcome,
} from './judge.ts';
import { type CaseJudgement, judgeScore } from './score.ts';

export const DEFECT_KINDS = [
  'trivial-findings',
  'truncated',
  'invented-figures',
  'unlabelled-picture',
] as const;
export type DefectKind = (typeof DEFECT_KINDS)[number];

/** A clean output scoring below this leaves no room to show a drop. */
const DEFECT_MIN_CLEAN = 5;

export interface JudgedOutcome {
  readonly key: string;
  readonly outcome: BenchCaseOutcome;
  readonly task: BenchTaskInfo;
  readonly verdict: CaseJudgement;
}

/** The judge's part of a case on the 0–10 scale, or null without a usable verdict. */
export function judgeScore10(verdict: CaseJudgement | null, task: BenchTaskInfo): number | null {
  if (!verdict || !task.judge) return null;
  const score = judgeScore(verdict, task.judge);
  return score === null ? null : score * 10;
}

/** One damaged copy of an outcome, or null when the defect does not apply to it. */
export function plantDefect(outcome: BenchCaseOutcome, kind: DefectKind): BenchCaseOutcome | null {
  const input = outcome.judgeInput;
  const artifact = outcome.artifact;
  if (!input) return null;
  switch (kind) {
    case 'trivial-findings': {
      if (!input.items || input.items.length === 0) return null;
      return {
        ...outcome,
        judgeInput: {
          ...input,
          items: input.items.map((item) => {
            const quote = /^Quote: "([\s\S]*?)"$/mu.exec(item.text)?.[1] ?? '';
            return {
              id: item.id,
              text:
                `Quote: "${quote}"\nCategory: Style (info)\n` +
                `Message: This sentence is correct and reads well.\nReplacement: "${quote}"`,
            };
          }),
        },
      };
    }
    case 'truncated': {
      if (!artifact || input.items || artifact.content.length < 200) return null;
      // A diagram's artifact is the model's spec, then the diagram DocBlocks
      // compiled from it. Cutting the whole text short can leave the spec
      // whole and damage only the compiler's output, which is no defect of the
      // model's: cut the spec, and drop the compiled diagram a cut spec could
      // not produce.
      const compiled = /^Spec:\n([\s\S]*?)\n\nCompiled:\n/u.exec(artifact.content);
      if (compiled) {
        const spec = compiled[1] ?? '';
        return {
          ...outcome,
          artifact: {
            ...artifact,
            content: `Spec:\n${spec.slice(0, Math.floor(spec.length * 0.4))}`,
          },
        };
      }
      const cut = artifact.content.slice(0, Math.floor(artifact.content.length * 0.4));
      return {
        ...outcome,
        artifact: {
          ...artifact,
          content: artifact.kind === 'svg' ? `${cut.replace(/<[^>]*$/u, '')}</svg>` : cut,
        },
      };
    }
    case 'invented-figures': {
      if (!artifact || artifact.kind === 'svg' || input.items) return null;
      const known = new Set(input.context.match(/\d+(?:[.,]\d+)*%?/gu) ?? []);
      let changed = 0;
      const content = artifact.content.replace(
        /(?<![\w./#-])\d+(?:[.,]\d+)*%?(?![\w/])/gu,
        (token) => {
          if (!known.has(token) || token.length < 2) return token;
          changed += 1;
          return falsifiedFigure(token);
        },
      );
      return changed > 0 ? { ...outcome, artifact: { ...artifact, content } } : null;
    }
    case 'unlabelled-picture': {
      if (!artifact || artifact.kind !== 'svg' || !/<text\b/iu.test(artifact.content)) return null;
      return {
        ...outcome,
        artifact: {
          ...artifact,
          content: artifact.content.replace(/<text\b[\s\S]*?<\/text>/giu, ''),
        },
      };
    }
  }
}

/** Every `step`-th item of a stable order: the same sample however often the study reruns. */
export function stableSample<T extends { key: string }>(items: readonly T[], size: number): T[] {
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key));
  if (sorted.length <= size) return sorted;
  const step = sorted.length / size;
  return Array.from({ length: size }, (_, index) => sorted[Math.floor(index * step)]!).filter(
    Boolean,
  );
}

export interface DefectResult {
  readonly key: string;
  readonly kind: DefectKind;
  readonly clean: number;
  readonly damaged: number | null;
  readonly caught: boolean;
}

export interface DocbenchValidity {
  readonly judge: string;
  readonly secondJudge: string;
  readonly promptVersion: number;
  readonly retest: {
    readonly units: number;
    readonly meanSd: number | null;
    readonly pass: boolean;
  };
  readonly agreement: {
    readonly units: number;
    readonly alpha: number | null;
    readonly pass: boolean;
  };
  readonly defects: {
    readonly planted: number;
    readonly caught: number;
    readonly rate: number | null;
    readonly pass: boolean;
    readonly results: readonly DefectResult[];
  };
  readonly pass: boolean;
}

function sd(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1),
  );
}

export interface ValidityOptions {
  readonly judge: JudgeProvider;
  readonly secondJudge: JudgeProvider;
  readonly renderSvg?: SvgRenderer;
  /** Outcomes in the retest and second-judge sample. */
  readonly sample?: number;
  /** Retest judgings per sampled outcome, beyond the original. */
  readonly retests?: number;
  /** Damaged copies per task and defect kind. */
  readonly defectsPerTask?: number;
  readonly log?: (line: string) => void;
}

export async function runDocbenchValidity(
  judged: readonly JudgedOutcome[],
  options: ValidityOptions,
): Promise<DocbenchValidity> {
  const log = options.log ?? (() => undefined);
  const judgeWith = (provider: JudgeProvider, item: JudgedOutcome, outcome = item.outcome) =>
    judgeOutcome(outcome, item.task, {
      provider,
      ...(options.renderSvg ? { renderSvg: options.renderSvg } : {}),
    });
  const scored = judged.filter((item) => judgeScore10(item.verdict, item.task) !== null);
  const sample = stableSample(scored, options.sample ?? 12);

  // 1. Retest
  const spreads: number[] = [];
  const pairs: number[][] = [];
  for (const item of sample) {
    const scores = [judgeScore10(item.verdict, item.task) ?? 0];
    for (let i = 0; i < (options.retests ?? 2); i += 1) {
      const again = judgeScore10(await judgeWith(options.judge, item), item.task);
      if (again !== null) scores.push(again);
    }
    if (scores.length > 1) spreads.push(sd(scores));
    const second = judgeScore10(await judgeWith(options.secondJudge, item), item.task);
    if (second !== null) pairs.push([scores[0] ?? 0, second]);
    log(
      `[validity] ${item.key}: ${scores.map((score) => score.toFixed(1)).join(' / ')}; second judge ${second?.toFixed(1) ?? '–'}`,
    );
  }
  const meanSd = spreads.length
    ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length
    : null;
  const alpha = krippendorffAlphaInterval(pairs);

  // 3. Planted defects, on outputs good enough to show a drop
  const results: DefectResult[] = [];
  const byTask = new Map<string, JudgedOutcome[]>();
  for (const item of scored) {
    if ((judgeScore10(item.verdict, item.task) ?? 0) < DEFECT_MIN_CLEAN) continue;
    byTask.set(item.task.id, [...(byTask.get(item.task.id) ?? []), item]);
  }
  for (const [taskId, items] of byTask) {
    for (const kind of DEFECT_KINDS) {
      const candidates = stableSample(items, items.length).filter((item) =>
        plantDefect(item.outcome, kind),
      );
      for (const item of candidates.slice(0, options.defectsPerTask ?? 2)) {
        const damaged = plantDefect(item.outcome, kind);
        if (!damaged) continue;
        const clean = judgeScore10(item.verdict, item.task) ?? 0;
        const score = judgeScore10(await judgeWith(options.judge, item, damaged), item.task);
        const caught = score !== null && score <= clean - DEFECT_MIN_DROP;
        results.push({ key: item.key, kind, clean, damaged: score, caught });
        log(
          `[validity] ${taskId} ${kind} ${item.key}: ${clean.toFixed(1)} → ${score?.toFixed(1) ?? '–'}${caught ? '' : ' (missed)'}`,
        );
      }
    }
  }
  const caught = results.filter((result) => result.caught).length;
  const rate = results.length ? caught / results.length : null;

  const retest = {
    units: spreads.length,
    meanSd,
    pass: meanSd !== null && meanSd <= VALIDITY_THRESHOLDS.retestSd,
  };
  const agreement = {
    units: pairs.length,
    alpha,
    pass: alpha !== null && alpha >= VALIDITY_THRESHOLDS.alpha,
  };
  const defects = {
    planted: results.length,
    caught,
    rate,
    pass: rate !== null && rate >= VALIDITY_THRESHOLDS.defectsCaught,
    results,
  };
  return {
    judge: options.judge.model,
    secondJudge: options.secondJudge.model,
    promptVersion: DOCBENCH_JUDGE_PROMPT_VERSION,
    retest,
    agreement,
    defects,
    pass: retest.pass && agreement.pass && defects.pass,
  };
}

export function renderValidityMarkdown(validity: DocbenchValidity, runId: string): string {
  const mark = (pass: boolean) => (pass ? 'pass' : '**fail**');
  const kinds = DEFECT_KINDS.map((kind) => {
    const of = validity.defects.results.filter((result) => result.kind === kind);
    return `| ${kind} | ${String(of.length)} | ${String(of.filter((result) => result.caught).length)} |`;
  });
  return [
    `# docbench judge validity: ${runId}`,
    '',
    `Judge ${validity.judge} (prompt v${String(validity.promptVersion)}); second judge ${validity.secondJudge}.`,
    '',
    `**${validity.pass ? 'The judge passes' : 'The judge does not pass'}**: scores from it are ${validity.pass ? '' : 'not '}fit to publish.`,
    '',
    '| Test | Result | Threshold | |',
    '| --- | --- | --- | --- |',
    `| Retest spread (mean SD, 0–10) over ${String(validity.retest.units)} outputs | ${validity.retest.meanSd?.toFixed(2) ?? '–'} | ≤ ${String(VALIDITY_THRESHOLDS.retestSd)} | ${mark(validity.retest.pass)} |`,
    `| Agreement with the second judge (alpha) over ${String(validity.agreement.units)} outputs | ${validity.agreement.alpha?.toFixed(2) ?? '–'} | ≥ ${String(VALIDITY_THRESHOLDS.alpha)} | ${mark(validity.agreement.pass)} |`,
    `| Planted defects caught (${String(validity.defects.caught)} of ${String(validity.defects.planted)}) | ${validity.defects.rate === null ? '–' : `${Math.round(validity.defects.rate * 100)}%`} | ≥ ${String(VALIDITY_THRESHOLDS.defectsCaught * 100)}% | ${mark(validity.defects.pass)} |`,
    '',
    '| Defect | Planted | Caught (≥ 2 points lower) |',
    '| --- | --- | --- |',
    ...kinds,
    '',
    ...validity.defects.results
      .filter((result) => !result.caught)
      .map(
        (result) =>
          `- Missed: ${result.kind} on ${result.key} (${result.clean.toFixed(1)} → ${result.damaged?.toFixed(1) ?? 'no verdict'})`,
      ),
    '',
  ].join('\n');
}
