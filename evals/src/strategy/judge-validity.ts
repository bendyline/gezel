import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JUDGE_AXES,
  JUDGE_MODEL,
  JUDGE_PROMPT_VERSION,
  type JudgeAxis,
  type JudgeBundle,
  type JudgeReport,
  buildJudgeBundle,
  isCurrentJudgeReport,
  judgeBundle,
  judgeTrial,
} from './judge.ts';
import type { StrategyTrialRow } from './summary.ts';

/**
 * The judge's validity checks, which the pre-registration requires to pass
 * in the pilot before the full run (docs/evals/strategy-prereg-2026-10-22.md):
 *
 *  - test-retest: the pooled SD of a trial's three samples is at most 0.7;
 *  - planted defects: of deliverables the judge scored well, at least 90% of
 *    deliberately damaged copies lose 2+ points on the axis the damage hits;
 *  - inter-judge: a second model scores 25% of judged trials, and interval
 *    Krippendorff's alpha between the two judges' means is at least 0.6.
 *
 * Damaged copies are judged in memory: nothing in a trial directory changes
 * except the reports written beside it.
 */

export const SECOND_JUDGE_MODEL =
  process.env.GEZEL_STRATEGY_SECOND_JUDGE_MODEL ?? 'claude-sonnet-5-5';
export const VALIDITY_THRESHOLDS = { retestSd: 0.7, defectsCaught: 0.9, alpha: 0.6 } as const;
/** A defect is caught when its axis falls at least this far below the clean score. */
export const DEFECT_MIN_DROP = 2;
const SECOND_JUDGE_SHARE = 0.25;
/** Room for the drop: a clean axis below this cannot show a defect reliably. */
const DEFECT_MIN_CLEAN_AXIS = 6;
const DEFECT_MAX_TRIALS = 10;

export const DEFECT_KINDS = [
  'falsified-figures',
  'fabricated-claim',
  'truncated',
  'flattened',
] as const;
export type DefectKind = (typeof DEFECT_KINDS)[number];
export const DEFECT_AXIS: Record<DefectKind, JudgeAxis> = {
  'falsified-figures': 'grounding',
  'fabricated-claim': 'grounding',
  truncated: 'completeness',
  flattened: 'craft',
};

/** Deliverables that are prose for a reader, where every defect applies. */
function isProse(kind: string | undefined): boolean {
  return /^(markdown-|slide-deck|security-report)/.test(kind ?? '');
}

/**
 * The deliverable a defect goes into: the longest present one, preferring
 * prose (a readout's JSON twin carries the same figures with less to judge).
 */
function primaryIndex(bundle: JudgeBundle): number {
  let best = -1;
  for (const [i, d] of bundle.deliverables.entries()) {
    if (d.text === '[missing]' || d.text.trim().length === 0) continue;
    const current = best >= 0 ? bundle.deliverables[best]! : null;
    if (
      !current ||
      (isProse(d.kind) && !isProse(current.kind)) ||
      (isProse(d.kind) === isProse(current.kind) && d.text.length > current.text.length)
    ) {
      best = i;
    }
  }
  return best;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A different value in the same format: `14.2%` → `19.5%`, `1,200` → `1,644`. */
export function falsifiedFigure(token: string): string {
  const percent = token.endsWith('%') ? '%' : '';
  const body = percent ? token.slice(0, -1) : token;
  const decimals = body.includes('.') ? body.split('.')[1]!.length : 0;
  const value = Number(body.replace(/,/g, ''));
  const shifted = decimals > 0 ? value * 1.37 : value + Math.max(3, Math.round(value * 0.37));
  let text = shifted.toFixed(decimals);
  if (body.includes(',')) {
    const [whole, fraction] = text.split('.');
    text = `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
  }
  return `${text}${percent}`;
}

const FIGURE = /(?<![\w./#-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w/])/g;

/**
 * One damaged copy of the bundle, or null when the defect does not apply:
 * figures need numbers the sources also state, a fabricated claim needs a
 * source to misattribute it to, and the prose defects need prose.
 */
export function plantDefect(bundle: JudgeBundle, kind: DefectKind): JudgeBundle | null {
  const index = primaryIndex(bundle);
  if (index < 0) return null;
  const target = bundle.deliverables[index]!;
  const prose = isProse(target.kind);
  let text: string | null = null;
  if (kind === 'falsified-figures' && prose) {
    const tokens: string[] = [];
    for (const match of target.text.matchAll(FIGURE)) {
      const token = match[0];
      const significant = token.length >= 2 && !/^0+$/.test(token.replace(/[,.%]/g, ''));
      if (!significant || tokens.includes(token)) continue;
      if (!bundle.sources.some((s) => s.text.includes(token))) continue;
      tokens.push(token);
      if (tokens.length === 3) break;
    }
    if (tokens.length > 0) {
      text = target.text;
      for (const token of tokens) {
        text = text.replace(
          new RegExp(`(?<![\\w./#-])${escapeRegExp(token)}(?![\\w/%]|\\.\\d)`, 'g'),
          falsifiedFigure(token),
        );
      }
    }
  } else if (kind === 'fabricated-claim' && prose && bundle.sources.length > 0) {
    const claim = `A follow-up review found that 37% of the 412 affected accounts were resolved within 9 days, saving an estimated $1.8 million (source: ${bundle.sources[0]!.label}).`;
    const lines = target.text.split('\n');
    // After the first paragraph of body text, so it reads as part of the work.
    let at = lines.findIndex((line, i) => {
      const prev = lines[i - 1] ?? '';
      return i > 0 && line.trim() === '' && prev.trim() !== '' && !prev.trim().startsWith('#');
    });
    if (at < 0) at = lines.length;
    lines.splice(at, 0, '', claim);
    text = lines.join('\n');
  } else if (kind === 'truncated') {
    const lines = target.text.split('\n');
    if (lines.length >= 4) text = lines.slice(0, Math.ceil(lines.length * 0.45)).join('\n');
  } else if (kind === 'flattened' && prose) {
    text = target.text
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
          .replace(/\|/g, ' ')
          .replace(/^\s*:?-{3,}:?(?:\s+:?-{3,}:?)*\s*$/, '')
          .trim(),
      )
      .filter(Boolean)
      .join(' ');
  }
  if (text === null || text === target.text) return null;
  return {
    ...bundle,
    deliverables: bundle.deliverables.map((d, i) => (i === index ? { ...d, text } : d)),
  };
}

/**
 * Interval Krippendorff's alpha. Each unit is the values its raters gave;
 * units with fewer than two values are not pairable and are skipped.
 */
export function krippendorffAlphaInterval(units: ReadonlyArray<readonly number[]>): number | null {
  const pairable = units.filter((u) => u.length >= 2);
  const values = pairable.flat();
  const n = values.length;
  if (n < 2) return null;
  let observed = 0;
  for (const unit of pairable) {
    let sum = 0;
    for (const a of unit) for (const b of unit) sum += (a - b) ** 2;
    observed += sum / (unit.length - 1);
  }
  observed /= n;
  let expected = 0;
  for (const a of values) for (const b of values) expected += (a - b) ** 2;
  expected /= n * (n - 1);
  return expected === 0 ? null : 1 - observed / expected;
}

/** A fixed quarter of the trials, the same however often the analysis reruns. */
export function secondJudgeSample(trialIds: readonly string[]): Set<string> {
  const ranked = [...trialIds].sort((a, b) => {
    const ha = createHash('sha256').update(a).digest('hex');
    const hb = createHash('sha256').update(b).digest('hex');
    return ha.localeCompare(hb);
  });
  return new Set(ranked.slice(0, Math.ceil(ranked.length * SECOND_JUDGE_SHARE)));
}

async function readReport<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface DefectResult {
  trialId: string;
  craftbookId: string;
  defect: DefectKind;
  axis: JudgeAxis;
  clean: number;
  damaged: number | null;
  caught: boolean | null;
  reasons?: string;
}

export interface JudgeValidity {
  retest: { trials: number; pooledSd: number | null; pass: boolean | null };
  defects: {
    model: string;
    planted: number;
    caught: number;
    rate: number | null;
    pass: boolean | null;
    byKind: Record<DefectKind, { planted: number; caught: number }>;
    items: DefectResult[];
  };
  interJudge: {
    model: string;
    trials: number;
    alpha: number | null;
    alphaByAxis: Record<JudgeAxis, number | null>;
    meanDifference: number | null;
    pass: boolean | null;
  };
}

/** Rounds the order books are drawn in, so one book cannot fill the defect sample. */
function defectTrials(
  judged: ReadonlyArray<{ row: StrategyTrialRow; report: JudgeReport }>,
): Array<{ row: StrategyTrialRow; report: JudgeReport }> {
  const byBook = new Map<string, Array<{ row: StrategyTrialRow; report: JudgeReport }>>();
  for (const entry of judged) {
    if (entry.report.mean < DEFECT_MIN_CLEAN_AXIS) continue;
    const list = byBook.get(entry.row.craftbookId) ?? [];
    list.push(entry);
    byBook.set(entry.row.craftbookId, list);
  }
  for (const list of byBook.values()) list.sort((a, b) => b.report.mean - a.report.mean);
  const picked: Array<{ row: StrategyTrialRow; report: JudgeReport }> = [];
  for (let round = 0; picked.length < DEFECT_MAX_TRIALS; round++) {
    let added = false;
    for (const book of [...byBook.keys()].sort()) {
      const entry = byBook.get(book)![round];
      if (!entry || picked.length >= DEFECT_MAX_TRIALS) continue;
      picked.push(entry);
      added = true;
    }
    if (!added) break;
  }
  return picked;
}

type Judged = { row: StrategyTrialRow; report: JudgeReport };
type JudgePair = { modelId: string; first: JudgeReport; second: JudgeReport };

function summarizeValidity(
  sds: readonly number[],
  pairs: readonly JudgePair[],
  items: readonly DefectResult[],
): JudgeValidity {
  const pooledSd =
    sds.length > 0 ? Math.sqrt(sds.reduce((n, sd) => n + sd ** 2, 0) / sds.length) : null;
  const alphaByAxis = {} as Record<JudgeAxis, number | null>;
  for (const axis of JUDGE_AXES) {
    alphaByAxis[axis] = krippendorffAlphaInterval(
      pairs.map((p) => [p.first.axes[axis], p.second.axes[axis]]),
    );
  }
  const alpha = krippendorffAlphaInterval(pairs.map((p) => [p.first.mean, p.second.mean]));
  const scoredItems = items.filter((i) => i.caught !== null);
  const caught = scoredItems.filter((i) => i.caught).length;
  const byKind = Object.fromEntries(
    DEFECT_KINDS.map((kind) => {
      const of = scoredItems.filter((i) => i.defect === kind);
      return [kind, { planted: of.length, caught: of.filter((i) => i.caught).length }];
    }),
  ) as JudgeValidity['defects']['byKind'];
  const rate = scoredItems.length > 0 ? caught / scoredItems.length : null;
  return {
    retest: {
      trials: sds.length,
      pooledSd,
      pass: pooledSd === null ? null : pooledSd <= VALIDITY_THRESHOLDS.retestSd,
    },
    defects: {
      model: JUDGE_MODEL,
      planted: scoredItems.length,
      caught,
      rate,
      pass: rate === null ? null : rate >= VALIDITY_THRESHOLDS.defectsCaught,
      byKind,
      items: [...items],
    },
    interJudge: {
      model: SECOND_JUDGE_MODEL,
      trials: pairs.length,
      alpha,
      alphaByAxis,
      meanDifference:
        pairs.length > 0
          ? pairs.reduce((n, p) => n + (p.second.mean - p.first.mean), 0) / pairs.length
          : null,
      pass: alpha === null ? null : alpha >= VALIDITY_THRESHOLDS.alpha,
    },
  };
}

/**
 * Run (or read back) every validity check over the judged rows. The second
 * judge's quarter and the defect trials are drawn per model, so judging one
 * model now and another later reuses the first model's reports. Second-judge
 * reports go to `judge-second.json` and defect scores to `judge-defects.json`
 * in each trial's directory, and are reused when present.
 */
export async function runJudgeValidity(
  rows: readonly StrategyTrialRow[],
  sourcesFor: (craftbookId: string) => readonly string[],
  opts: { cliPath?: string; log?: (line: string) => void } = {},
): Promise<JudgeValidity & { byModel: Record<string, JudgeValidity> }> {
  const log = opts.log ?? (() => {});
  const cli = opts.cliPath ? { cliPath: opts.cliPath } : {};
  const byModelJudged = new Map<string, Judged[]>();
  for (const row of rows) {
    const report = await readReport<JudgeReport>(join(row.trialDir, 'judge.json'));
    if (!isCurrentJudgeReport(report)) continue;
    const list = byModelJudged.get(row.modelId) ?? [];
    list.push({ row, report });
    byModelJudged.set(row.modelId, list);
  }

  const sds: Array<{ modelId: string; sd: number }> = [];
  const pairs: JudgePair[] = [];
  const items: Array<DefectResult & { modelId: string }> = [];
  for (const [modelId, judged] of byModelJudged) {
    for (const { report } of judged) {
      if (report.samples.length > 1) sds.push({ modelId, sd: report.sd });
    }
    const sample = secondJudgeSample(judged.map((j) => j.row.trialId));
    for (const { row, report } of judged) {
      if (!sample.has(row.trialId)) continue;
      let second = await readReport<JudgeReport>(join(row.trialDir, 'judge-second.json'));
      if (!isCurrentJudgeReport(second) || second.model !== SECOND_JUDGE_MODEL) {
        log(`[judge-validity] second judge on ${modelId}/${row.arm}/${row.craftbookId}`);
        second = await judgeTrial(row.trialDir, row.craftbookId, sourcesFor(row.craftbookId), {
          model: SECOND_JUDGE_MODEL,
          file: 'judge-second.json',
          ...cli,
        }).catch(() => null);
      }
      if (second?.samples?.length) pairs.push({ modelId, first: report, second });
    }
    for (const { row, report } of defectTrials(judged)) {
      const file = join(row.trialDir, 'judge-defects.json');
      const cached = await readReport<{
        model?: string;
        promptVersion?: number;
        items?: DefectResult[];
      }>(file);
      if (
        cached?.model === JUDGE_MODEL &&
        cached.promptVersion === JUDGE_PROMPT_VERSION &&
        cached.items
      ) {
        items.push(...cached.items.map((i) => ({ ...i, modelId })));
        continue;
      }
      const bundle = await buildJudgeBundle(
        row.trialDir,
        row.craftbookId,
        sourcesFor(row.craftbookId),
      );
      if (!bundle) continue;
      const trialItems: DefectResult[] = [];
      for (const defect of DEFECT_KINDS) {
        const axis = DEFECT_AXIS[defect];
        const clean = report.axes[axis];
        if (clean < DEFECT_MIN_CLEAN_AXIS) continue;
        const damaged = plantDefect(bundle, defect);
        if (!damaged) continue;
        log(`[judge-validity] ${defect} in ${modelId}/${row.arm}/${row.craftbookId}`);
        const scored = judgeBundle(damaged, { samples: 1, ...cli });
        const score = scored.samples[0]?.scores[axis] ?? null;
        trialItems.push({
          trialId: row.trialId,
          craftbookId: row.craftbookId,
          defect,
          axis,
          clean,
          damaged: score,
          caught: score === null ? null : clean - score >= DEFECT_MIN_DROP,
          ...(scored.samples[0] ? { reasons: scored.samples[0].reasons } : {}),
        });
      }
      await writeFile(
        file,
        JSON.stringify(
          { model: JUDGE_MODEL, promptVersion: JUDGE_PROMPT_VERSION, items: trialItems },
          null,
          2,
        ),
      );
      items.push(...trialItems.map((i) => ({ ...i, modelId })));
    }
  }

  const byModel: Record<string, JudgeValidity> = {};
  for (const modelId of byModelJudged.keys()) {
    byModel[modelId] = summarizeValidity(
      sds.filter((s) => s.modelId === modelId).map((s) => s.sd),
      pairs.filter((p) => p.modelId === modelId),
      items.filter((i) => i.modelId === modelId),
    );
  }
  return {
    ...summarizeValidity(
      sds.map((s) => s.sd),
      pairs,
      items,
    ),
    byModel,
  };
}

export function renderJudgeValidityMarkdown(
  v: JudgeValidity & { byModel?: Record<string, JudgeValidity> },
): string {
  const verdict = (pass: boolean | null) =>
    pass === null ? 'not measured' : pass ? 'pass' : 'FAIL';
  const fixed = (n: number | null, digits = 2) => (n === null ? '—' : n.toFixed(digits));
  const kinds = DEFECT_KINDS.map(
    (k) => `${k} ${v.defects.byKind[k].caught}/${v.defects.byKind[k].planted}`,
  ).join(', ');
  return [
    '## Judge validity',
    '',
    `- **Test-retest:** pooled SD ${fixed(v.retest.pooledSd)} over ${v.retest.trials} trials (threshold ≤ ${VALIDITY_THRESHOLDS.retestSd}): ${verdict(v.retest.pass)}`,
    `- **Planted defects:** ${v.defects.caught}/${v.defects.planted} caught (${v.defects.rate === null ? '—' : `${Math.round(v.defects.rate * 100)}%`}; threshold ≥ ${VALIDITY_THRESHOLDS.defectsCaught * 100}%, a drop of ${DEFECT_MIN_DROP}+ on the defect's axis): ${verdict(v.defects.pass)}. By kind: ${kinds}`,
    `- **Inter-judge (${v.interJudge.model}):** alpha ${fixed(v.interJudge.alpha)} over ${v.interJudge.trials} trials (threshold ≥ ${VALIDITY_THRESHOLDS.alpha}): ${verdict(v.interJudge.pass)}. By axis: ${JUDGE_AXES.map((a) => `${a} ${fixed(v.interJudge.alphaByAxis[a])}`).join(', ')}; mean difference (second − first) ${fixed(v.interJudge.meanDifference)}`,
    ...Object.entries(v.byModel ?? {}).map(
      ([modelId, m]) =>
        `- *${modelId}:* retest SD ${fixed(m.retest.pooledSd)} (${m.retest.trials}); defects ${m.defects.caught}/${m.defects.planted}; alpha ${fixed(m.interJudge.alpha)} (${m.interJudge.trials})`,
    ),
    '',
  ].join('\n');
}
