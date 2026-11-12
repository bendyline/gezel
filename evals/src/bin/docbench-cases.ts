/**
 * `pnpm eval:docbench-cases --run-id <id>` — write a round's side-by-side
 * case pages to `runs/docbench-<id>/compare/` (`index.html` plus one page
 * per task). Reads what generation and judging left on disk; changes
 * nothing else, so it can run while a round is still being judged.
 *
 * `--models a,b` limits the pages to some models; by default every model
 * with outcomes, in the round's ranking order when it has been scored.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchPackManifestSchema } from '@bendyline/gezel/eval';
import {
  type CaseRow,
  type ModelHeadline,
  type TaskMean,
  renderCasesIndex,
  renderTaskCasesPage,
  taskPageName,
} from '../docbench/cases-page.ts';
import { readOutcomes } from '../docbench/pack.ts';
import type { DocbenchSummary } from '../docbench/report.ts';
import { type CaseJudgement, caseScore } from '../docbench/score.ts';
import { parseArgs } from './args.ts';

function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const runId = text(flags['run-id']);
  if (!runId) throw new Error('--run-id is required');
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const runDir = join(evalsRoot, 'runs', `docbench-${runId}`);
  if (!existsSync(join(runDir, 'manifest.json'))) throw new Error(`No docbench round at ${runDir}`);
  const manifest = BenchPackManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')),
  );
  const summaryFile = join(runDir, 'summary.json');
  const summary = existsSync(summaryFile)
    ? (JSON.parse(await readFile(summaryFile, 'utf8')) as DocbenchSummary)
    : null;

  const onDisk = (await readdir(runDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(join(runDir, entry.name, 'cases')))
    .map((entry) => entry.name);
  const wanted = text(flags.models)
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const selected = wanted ?? onDisk;
  const scored = new Map(summary?.models.map((model) => [model.modelId, model.docbench]) ?? []);
  const models: ModelHeadline[] = selected
    .map((modelId) => {
      const docbench = scored.get(modelId);
      return docbench === undefined || !Number.isFinite(docbench)
        ? { modelId }
        : { modelId, docbench };
    })
    .sort((a, b) => (b.docbench ?? -1) - (a.docbench ?? -1) || a.modelId.localeCompare(b.modelId));

  const rowsByTask = new Map<string, CaseRow[]>();
  for (const { modelId } of models) {
    for (const { file, outcome } of await readOutcomes(join(runDir, modelId, 'cases'))) {
      const verdictFile = file.replace(/\.json$/u, '.judge.json');
      const judgement = existsSync(verdictFile)
        ? (JSON.parse(await readFile(verdictFile, 'utf8')) as CaseJudgement)
        : null;
      const rows = rowsByTask.get(outcome.taskId) ?? [];
      rows.push({ modelId, outcome, judgement });
      rowsByTask.set(outcome.taskId, rows);
    }
  }

  const outDir = join(runDir, 'compare');
  await mkdir(outDir, { recursive: true });
  const taskScores = new Map<string, Map<string, TaskMean>>();
  for (const task of manifest.tasks) {
    const rows = rowsByTask.get(task.id) ?? [];
    const sums = new Map<string, { total: number; count: number; judged: boolean }>();
    for (const row of rows) {
      if (row.outcome.error?.class === 'infra') continue;
      const scored = caseScore(row.outcome, task, row.judgement);
      const entry = sums.get(row.modelId) ?? { total: 0, count: 0, judged: true };
      entry.total += scored.score;
      entry.count += 1;
      entry.judged &&= scored.judged;
      sums.set(row.modelId, entry);
    }
    taskScores.set(
      task.id,
      new Map(
        [...sums].map(([modelId, { total, count, judged }]) => [
          modelId,
          { score: total / count, judged },
        ]),
      ),
    );
    await writeFile(
      join(outDir, taskPageName(task.id)),
      renderTaskCasesPage({ runId, task, rows, models }),
    );
  }
  await writeFile(
    join(outDir, 'index.html'),
    renderCasesIndex({ runId, manifest, models, taskScores }),
  );
  console.log(
    `[docbench-cases] wrote ${join(outDir, 'index.html')} (${String(manifest.tasks.length)} tasks, ${String(models.length)} models)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
