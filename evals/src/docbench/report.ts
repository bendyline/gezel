/**
 * The docbench report: `summary.json` for machines (the scorecard ingest and
 * the Gilde publish step read it) and `report.md` for people.
 *
 * The report says plainly what a number is not: a score with missing
 * families covers only part of the benchmark, a score with unjudged cases is
 * the deterministic checks alone, and an unofficial judge's score is a
 * diagnostic. Only a complete, fully judged, officially judged round is a
 * docbench score to publish.
 */

import type { ScorecardDevice } from '@bendyline/gezel';
import type { BenchPackManifest } from '@bendyline/gezel/eval';
import { type Interval, type ModelScore, assignBands } from './score.ts';

export const DOCBENCH_SUMMARY_SCHEMA_VERSION = 1;

export interface ModelSummary extends ModelScore {
  readonly modelId: string;
  readonly band: number;
  readonly generation: {
    readonly seconds: number | null;
    readonly outcomes: number;
    readonly infraRetried: number;
    /** Catalog version of the measured build, when generation recorded it. */
    readonly catalogVersion?: string;
  } | null;
}

export interface DocbenchSummary {
  readonly schemaVersion: typeof DOCBENCH_SUMMARY_SCHEMA_VERSION;
  readonly runId: string;
  readonly createdAt: string;
  readonly pack: {
    readonly id: string;
    readonly version: string;
    /** Which fixtures, by content hash: scores compare only on the same set. */
    readonly fixtures?: { readonly id: string; readonly sha256: string };
  };
  readonly judge: {
    readonly model: string;
    readonly promptVersion: number;
    readonly official: boolean;
  } | null;
  /** The judge validity study (`eval:docbench-validity`) for this judge and prompt, when run. */
  readonly validity: {
    readonly pass: boolean;
    readonly model: string;
    readonly retestSd: number | null;
    readonly alpha: number | null;
    readonly defectsCaught: number | null;
  } | null;
  /** The "today" every prompt stated. */
  readonly now: string;
  readonly launchContext: number;
  readonly device: ScorecardDevice;
  readonly harnessCommit: string | null;
  /** A complete, fully and officially judged round: the only kind to publish. */
  readonly publishable: boolean;
  readonly models: readonly ModelSummary[];
}

export function withBands(
  scores: readonly (Omit<ModelSummary, 'band'> & { readonly band?: number })[],
): ModelSummary[] {
  const bands = assignBands(
    scores
      .filter((score) => Number.isFinite(score.docbench))
      .map((score) => ({ id: score.modelId, score: score.docbench, ci: score.ci })),
  );
  return [...scores]
    .map((score) => ({ ...score, band: bands.get(score.modelId) ?? 0 }))
    .sort((a, b) => (b.docbench || -1) - (a.docbench || -1));
}

export function isPublishable(
  summary: Pick<DocbenchSummary, 'judge' | 'models' | 'validity'>,
): boolean {
  return (
    summary.judge?.official === true &&
    summary.validity?.pass === true &&
    summary.models.length > 0 &&
    summary.models.every(
      (model) =>
        model.coverage >= 0.999 && model.judgedShare >= 0.999 && Number.isFinite(model.docbench),
    )
  );
}

function fixed(value: number, digits = 0): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '–';
}

function range(ci: Interval, scale = 1): string {
  return `${fixed(ci[0] * scale)}–${fixed(ci[1] * scale)}`;
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${String(Math.round(value * 100))}%` : '–';
}

export function renderReport(summary: DocbenchSummary, manifest: BenchPackManifest): string {
  const lines: string[] = [];
  const families = manifest.families.filter((family) =>
    summary.models.some((model) => model.families[family.id]),
  );
  const missing = manifest.families.filter((family) => !families.includes(family));
  lines.push(
    `# docbench ${summary.pack.version}: ${summary.runId}`,
    '',
    `Run ${summary.createdAt} on ${summary.device.label}. Prompts dated ${summary.now.slice(0, 10)}; ` +
      `models launched with a ${String(summary.launchContext)}-token context.`,
    '',
    summary.judge
      ? `Judge: ${summary.judge.model} (prompt v${String(summary.judge.promptVersion)})${
          summary.judge.official
            ? ', the official judge.'
            : ', **unofficial**: a diagnostic, not a docbench score.'
        }`
      : '**No judge**: scores are the deterministic checks alone, not a docbench score.',
  );
  if (missing.length > 0) {
    lines.push(
      '',
      `**Partial**: no tasks yet for ${missing.map((family) => family.label).join(', ')}. Scores weight the families present.`,
    );
  }
  lines.push(
    '',
    summary.validity
      ? `Judge validity (on ${summary.validity.model}'s outputs): ${summary.validity.pass ? 'passed' : '**failed**'} — ` +
          `retest spread ${summary.validity.retestSd?.toFixed(2) ?? '–'}, agreement alpha ${summary.validity.alpha?.toFixed(2) ?? '–'}, ` +
          `planted defects caught ${summary.validity.defectsCaught === null ? '–' : `${String(Math.round(summary.validity.defectsCaught * 100))}%`}. See validity.md.`
      : 'Judge validity: not yet tested for this judge (`pnpm eval:docbench-validity`).',
    '',
    summary.publishable
      ? 'This round is complete, officially judged by a judge that passed its validity tests: publishable.'
      : 'This round is not publishable (it needs every family, every case judged, the official judge, and a judge that passed its validity tests).',
    '',
    '## Scores',
    '',
    'Docbench is 0–100. Models in the same band have overlapping 95% intervals: the order within a band is noise.',
    '',
    `| Band | Model | Docbench | 95% interval | Usable | ${families.map((family) => family.label).join(' | ')} |`,
    `| --- | --- | --- | --- | --- | ${families.map(() => '---').join(' | ')} |`,
  );
  for (const model of summary.models) {
    const unjudged = model.judgedShare < 0.999 ? ' (partly unjudged)' : '';
    lines.push(
      `| ${String(model.band || '–')} | ${model.modelId}${unjudged} | **${fixed(model.docbench)}** | ${range(model.ci)} | ` +
        `${pct(model.usableRate)} | ${families
          .map((family) => {
            const result = model.families[family.id];
            return result ? fixed(result.score * 100) : '–';
          })
          .join(' | ')} |`,
    );
  }
  lines.push('', '## Tasks', '');
  for (const task of manifest.tasks) {
    if (!summary.models.some((model) => model.tasks[task.id])) continue;
    lines.push(
      `### ${task.label} (\`${task.id}\`, ${task.family})`,
      '',
      task.description,
      '',
      '| Model | Score | 95% interval | Usable | Trials | Judged | Median output tokens | Endpoint failures |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const model of summary.models) {
      const result = model.tasks[task.id];
      if (!result) continue;
      lines.push(
        `| ${model.modelId} | ${fixed(result.score * 100)} | ${range(result.ci, 100)} | ${pct(result.usableRate)} | ` +
          `${String(result.trials)} | ${pct(result.judgedShare)} | ${result.medianOutputTokens === null ? '–' : fixed(result.medianOutputTokens)} | ` +
          `${String(result.infraFailures)} |`,
      );
    }
    lines.push('');
  }
  const profiled = manifest.tasks.filter((task) =>
    summary.models.some((model) => model.tasks[task.id]?.findings),
  );
  if (profiled.length > 0) {
    lines.push(
      '## Review depth',
      '',
      'What each review was made of, per document: valid suggestions by how much the fix takes ' +
        '(low: mechanical, such as a typo or a number format; medium: rewording a sentence; high: ' +
        'paragraph or document level, such as a buried point or a contradiction), the trivial and wrong ' +
        'ones, and the share of seeded issues found at each level.',
      '',
    );
    for (const task of profiled) {
      lines.push(
        `### ${task.label} (\`${task.id}\`)`,
        '',
        '| Model | Valid low | Valid medium | Valid high | Trivial | Wrong | Precision | Found low | Found medium | Found high |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const model of summary.models) {
        const findings = model.tasks[task.id]?.findings;
        if (!findings) continue;
        const per = (value: number) => fixed(value, 1);
        const found = (value: number | null) => (value === null ? '–' : pct(value));
        lines.push(
          `| ${model.modelId} | ${per(findings.perOutput.low)} | ${per(findings.perOutput.medium)} | ` +
            `${per(findings.perOutput.high)} | ${per(findings.perOutput.trivial)} | ${per(findings.perOutput.wrong)} | ` +
            `${pct(findings.precision)} | ${found(findings.recallByLevel.low)} | ${found(findings.recallByLevel.medium)} | ` +
            `${found(findings.recallByLevel.high)} |`,
        );
      }
      lines.push('');
    }
  }
  lines.push(
    '## How to read this',
    '',
    '- A case scores 0 when DocBlocks would have shown the person nothing from the model (after its own repairs and retries).',
    '- Otherwise it blends the pack\'s deterministic checks with the judge, by each task\'s weights; review findings are matched against seeded defects (F1, so padding and "This is a correct sentence" earn nothing).',
    '- Endpoint failures are retried and excluded, never scored. Intervals come from a nested bootstrap over cases and their trials.',
    "- Speed is not in the score: median output tokens, with a machine's decode rate, say how long each feature takes there.",
    '',
  );
  return lines.join('\n');
}
