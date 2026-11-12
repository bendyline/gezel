/**
 * `pnpm eval:docbench-validity --run-id <id> --model <id>` — test the
 * docbench judge on a finished, judged round (see `docbench/validity.ts`).
 *
 * Pick a model whose outputs span the range — a mid-sized model has good and
 * bad outputs to judge — and run it once per judge or prompt version. The
 * round's `report.md` says whether its judge passed; only a passing judge's
 * scores are publishable.
 *
 * Flags:
 *   --run-id <id>           the round (evals/runs/docbench-<id>)
 *   --model <id>            whose outputs to judge again
 *   --judge <model>         the judge under test (default: the official one)
 *   --second-judge <model>  default claude-sonnet-5-5
 *   --claude-bin <path>     the Claude CLI
 *   --sample <n>            outputs in the retest and agreement sample (default 12)
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BenchPackManifest, BenchPackManifestSchema } from '@bendyline/gezel/eval';
import {
  DOCBENCH_OFFICIAL_JUDGE,
  claudeCliJudge,
  isCurrentJudgement,
  resolveClaudeCli,
} from '../docbench/judge.ts';
import { readOutcomes } from '../docbench/pack.ts';
import { openSvgRenderer } from '../docbench/render.ts';
import { type CaseJudgement, outcomeKey } from '../docbench/score.ts';
import {
  type JudgedOutcome,
  renderValidityMarkdown,
  runDocbenchValidity,
} from '../docbench/validity.ts';
import { SECOND_JUDGE_MODEL } from '../strategy/judge-validity.ts';
import { parseArgs } from './args.ts';

function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const runId = text(flags['run-id']);
  const modelId = text(flags.model);
  if (!runId || !modelId) throw new Error('--run-id and --model are required');
  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const runDir = join(evalsRoot, 'runs', `docbench-${runId}`);
  if (!existsSync(join(runDir, 'manifest.json'))) throw new Error(`No docbench round at ${runDir}`);
  const manifest: BenchPackManifest = BenchPackManifestSchema.parse(
    JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')),
  );
  const cli = resolveClaudeCli(text(flags['claude-bin']));
  const judge = claudeCliJudge(text(flags.judge) ?? DOCBENCH_OFFICIAL_JUDGE, cli);
  const secondJudge = claudeCliJudge(text(flags['second-judge']) ?? SECOND_JUDGE_MODEL, cli);

  const judged: JudgedOutcome[] = [];
  for (const { file, outcome } of await readOutcomes(join(runDir, modelId, 'cases'))) {
    const task = manifest.tasks.find((item) => item.id === outcome.taskId);
    const verdictFile = file.replace(/\.json$/u, '.judge.json');
    if (!task?.judge || !existsSync(verdictFile)) continue;
    const verdict = JSON.parse(await readFile(verdictFile, 'utf8')) as CaseJudgement;
    if (!isCurrentJudgement(verdict, judge, task.judge)) continue;
    judged.push({ key: outcomeKey(outcome), outcome, task, verdict });
  }
  if (judged.length === 0) {
    throw new Error(
      `No current ${judge.model} verdicts for ${modelId} in ${runId}: judge the round first.`,
    );
  }
  console.log(`[validity] ${String(judged.length)} judged outputs of ${modelId}`);

  const renderer = await openSvgRenderer(join(runDir, 'renders'));
  try {
    const validity = await runDocbenchValidity(judged, {
      judge,
      secondJudge,
      renderSvg: renderer.render,
      sample: Number(text(flags.sample) ?? 12),
      log: (line) => console.log(line),
    });
    const report = { ...validity, runId, model: modelId, createdAt: new Date().toISOString() };
    await writeFile(join(runDir, 'validity.json'), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = renderValidityMarkdown(validity, runId);
    await writeFile(join(runDir, 'validity.md'), markdown);
    console.log(`\n${markdown}`);
  } finally {
    await renderer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
