#!/usr/bin/env -S npx tsx
/**
 * `pnpm eval:judge-sweep --run-id <id>` — advisory judging, after the fact.
 *
 *   pnpm eval:judge-sweep --run-id 2026-08-09-m4max-llamacpp
 *   pnpm eval:judge-sweep --run-id <id> --dry-run
 *
 * Why post-hoc rather than inline (`eval:all --llm-judge`):
 *
 *  1. **One judge for the whole sweep.** A 30-hour sweep judged inline is
 *     judged by whatever the backend resolves to at each cell's completion
 *     time. Scoring every cell in one pass means the qualitative numbers
 *     are at least internally comparable — the same property the
 *     deterministic side gets from a single run identity.
 *  2. **It can be re-run.** The artifacts are on disk, so a better judge,
 *     a fixed rubric, or a second opinion costs no GPU time.
 *  3. **It cannot change pass/fail.** The judge writes `llm-judge.json`
 *     beside each trial and a roll-up beside the sweep; it never touches
 *     the scorecard dataset. Deterministic gates decide the score, and the
 *     handboek articles quote only those — see the scorecard schema's note
 *     on judge drift.
 *
 * Judging is serial on purpose. The CLI backend spawns a process per call
 * and a sweep has hundreds of artifacts; running them concurrently while
 * an eval sweep holds the GPU is how you turn an advisory pass into an
 * interference source.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../scenarios/index.ts';
import { maybeJudgeTrial } from '../trial-llm-judge.ts';
import { parseArgs } from './args.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface JudgedTrial {
  modelId: string;
  suiteId: string;
  scenarioId: string;
  trialId: string;
  /** Which rubric produced the score — the two are not comparable. */
  rubric: 'scenario' | 'default-html';
  meanScore: number;
  scoreAxes: Record<string, number>;
  judgeModel: string;
}

function dirsUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = typeof args.flags['run-id'] === 'string' ? args.flags['run-id'] : null;
  if (!runId) {
    console.error('--run-id <id> is required (see evals/runs/scorecard-*)');
    process.exit(2);
  }
  const dryRun = Boolean(args.flags['dry-run']);
  const sweepRoot = join(repoRoot, 'evals/runs', `scorecard-${runId}`);
  if (!existsSync(sweepRoot)) {
    console.error(`[judge] no sweep at ${sweepRoot}`);
    process.exit(2);
  }

  const judged: JudgedTrial[] = [];
  let skipped = 0;
  let considered = 0;

  for (const modelId of dirsUnder(sweepRoot)) {
    for (const suiteId of dirsUnder(join(sweepRoot, modelId))) {
      for (const scenarioId of dirsUnder(join(sweepRoot, modelId, suiteId))) {
        const scenario = SCENARIOS[scenarioId];
        if (!scenario) continue;
        // Judge whatever has a judgeable artifact, rather than only
        // scenarios declaring a spec: NO core scenario declares one — the
        // anchored games rely on the default first-HTML rubric, and that
        // rubric (visual quality, polish) is precisely what they were
        // built for. `maybeJudgeTrial` returns false when nothing matches,
        // so a markdown-only scenario simply skips.
        const usedRubric = scenario.judge ? 'scenario' : 'default-html';
        for (const trialId of dirsUnder(join(sweepRoot, modelId, suiteId, scenarioId))) {
          const runDir = join(sweepRoot, modelId, suiteId, scenarioId, trialId);
          if (!statSync(runDir).isDirectory()) continue;
          considered += 1;
          if (dryRun) continue;

          const wrote = await maybeJudgeTrial({
            scenario: {
              id: scenario.id,
              prompt: scenario.prompt,
              description: scenario.description,
              judge: scenario.judge,
            },
            runDir,
            log: () => {},
          });
          if (!wrote) {
            skipped += 1;
            continue;
          }
          const report = JSON.parse(readFileSync(join(runDir, 'llm-judge.json'), 'utf8'));
          judged.push({
            modelId,
            suiteId,
            scenarioId,
            trialId,
            rubric: usedRubric,
            meanScore: report.meanScore,
            scoreAxes: report.scoreAxes,
            judgeModel: report.judgeModel,
          });
          console.log(
            `[judge] ${modelId} ${suiteId}/${scenarioId} ${report.meanScore.toFixed(1)} (${report.judgeModel})`,
          );
        }
      }
    }
  }

  if (dryRun) {
    console.log(`[judge] ${considered} judgeable trial(s) under ${sweepRoot}`);
    return;
  }

  // Roll up per model x suite x RUBRIC. Reported separately from the
  // scorecard so a reader cannot mistake an opinion for a measurement —
  // and split by rubric because a scenario's own axes and the default HTML
  // axes measure different things, so averaging them means nothing.
  const byCell = new Map<string, number[]>();
  for (const entry of judged) {
    const key = `${entry.modelId} ${entry.suiteId} ${entry.rubric}`;
    byCell.set(key, [...(byCell.get(key) ?? []), entry.meanScore]);
  }
  const summary = {
    runId,
    judgedAt: new Date().toISOString(),
    judgeModels: [...new Set(judged.map((entry) => entry.judgeModel))],
    trials: judged.length,
    skipped,
    cells: [...byCell.entries()]
      .map(([key, scores]) => {
        const [modelId, suiteId, rubric] = key.split(' ');
        return {
          modelId,
          suiteId,
          rubric,
          trials: scores.length,
          meanScore: Number(mean(scores).toFixed(2)),
        };
      })
      .sort((a, b) => a.modelId!.localeCompare(b.modelId!) || a.suiteId!.localeCompare(b.suiteId!)),
    perTrial: judged,
  };
  const outPath = join(sweepRoot, 'judge-report.json');
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\n[judge] wrote ${outPath}`);
  console.log(`[judge] ${judged.length} judged, ${skipped} skipped (no artifact)`);
  for (const cell of summary.cells) {
    console.log(
      `  ${cell.modelId!.padEnd(20)} ${cell.suiteId!.padEnd(14)} ${cell.rubric!.padEnd(13)} mean ${cell.meanScore} (n=${cell.trials})`,
    );
  }
  console.log(
    '\nAdvisory only — these never enter the scorecard dataset or the handboek articles.',
  );
}

void main();
