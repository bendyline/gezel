/**
 * `pnpm --filter @bendyline/gezel-evals run ab-grammar [<scenario>...] [...flags]`
 *
 * A/B harness for the MLX decode-time tool-call grammar (and, when curated,
 * the per-family chat-template fix). Runs the SAME scenario matrix twice on
 * one model — once with the behavior(s) forced ON (treatment), once forced
 * OFF (control) — and diffs them. No catalog edits or reinstalls between
 * arms: the toggle rides `GEZEL_FORCE_BEHAVIORS` / `GEZEL_REMOVE_BEHAVIORS`
 * via `TrialOptions.forceBehaviors` / `removeBehaviors`.
 *
 * Positional args = scenario ids (default: the full registered matrix).
 * Flags:
 *   --model <id>      chat model catalog id (default `qwen3.5-4b-q4`)
 *   --provider <p>    engine (default `mlx`)
 *   --count <N>       trials per scenario per arm (default 5)
 *   --timeout <dur>   per-trial timeout override, e.g. `20m`
 *   --behaviors <a,b> behavior ids to toggle (default `tools.mlx-grammar`)
 *   --with-template   also toggle `tools.mlx-template-fix`
 *   --runs-dir <path> override the output root
 *   --list            list scenarios and exit
 *
 * Output: `evals/runs/ab-grammar-<ts>/{control,treatment}/` (per-arm
 * matrices) + `ab-summary.json` + a printed comparison. Primary metric is
 * pass rate; the "mechanism" counts (grammar activations, malformed /
 * unknown-tool retries, tools-dropped fallthroughs) are scraped from each
 * arm's daemon.log so you can see WHY the pass rate moved.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import type { BatchOptions, EvalScenario, MatrixSummary } from '../types.ts';
import { parseArgs, parseDuration, printScenarios, resolveProviderFlag } from './args.ts';

/** daemon.log substrings that tell the mechanism story, per arm. */
const MARKERS: Record<string, string> = {
  grammarActive: '[tool-grammar] active',
  grammarMatcherError: '[tool-grammar] matcher error',
  toolsDropped: '[tool-prompt] TOOLS DROPPED',
  unknownTool: 'model called unknown tool',
  malformedCall: 'malformed tool call',
};

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(`\n[ab] ${sig} received — aborting gracefully (Ctrl+C again to force-exit)`);
      ac.abort();
    } else {
      console.error('[ab] second signal — forcing exit');
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac;
}

/** Recursively count marker occurrences across every daemon.log under root. */
async function scanMechanism(root: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(
    Object.keys(MARKERS).map((k) => [k, 0]),
  );
  let entries: string[] = [];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return counts;
  }
  for (const rel of entries) {
    if (!rel.endsWith('daemon.log')) continue;
    let text = '';
    try {
      text = await readFile(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const [key, needle] of Object.entries(MARKERS)) {
      // Count occurrences (not just presence) — a single trial can mangle
      // many calls, and that count IS the signal.
      let idx = 0;
      let n = 0;
      idx = text.indexOf(needle, idx);
      while (idx !== -1) {
        n += 1;
        idx += needle.length;
        idx = text.indexOf(needle, idx);
      }
      counts[key] = (counts[key] ?? 0) + n;
    }
  }
  return counts;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.list) {
    printScenarios(listScenarios());
    return;
  }

  const scenarios: EvalScenario[] =
    args.positional.length > 0 ? args.positional.map(getScenario) : listScenarios();
  const modelId = (args.flags.model as string) || 'qwen3.5-4b-q4';
  const engine = resolveProviderFlag(args.flags) ?? 'mlx';
  const count = args.flags.count ? Number(args.flags.count) : 5;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });

  const behaviors = (
    typeof args.flags.behaviors === 'string' ? args.flags.behaviors : 'tools.mlx-grammar'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (args.flags['with-template']) behaviors.push('tools.mlx-template-fix');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-grammar-${ts}`);
  await mkdir(root, { recursive: true });

  const ac = installSignalHandlers();
  console.log(
    `[ab] model=${modelId} engine=${engine} count=${count} scenarios=${scenarios.length} ` +
      `behaviors=[${behaviors.join(', ')}]\n[ab] root=${root}`,
  );

  const baseOpts: BatchOptions = { modelId, engine, count, timeoutMs, signal: ac.signal };

  // Control first (behaviors OFF), then treatment (behaviors ON). Sequential:
  // two arms on one box would cross-saturate VRAM and the success rate would lie.
  console.log('\n[ab] ===== CONTROL arm (behaviors OFF) =====');
  const control = await runMatrix(scenarios, {
    ...baseOpts,
    removeBehaviors: behaviors,
    runsDir: join(root, 'control'),
  });

  console.log('\n[ab] ===== TREATMENT arm (behaviors ON) =====');
  const treatment = await runMatrix(scenarios, {
    ...baseOpts,
    forceBehaviors: behaviors,
    runsDir: join(root, 'treatment'),
  });

  const controlMech = await scanMechanism(join(root, 'control'));
  const treatmentMech = await scanMechanism(join(root, 'treatment'));

  // Per-scenario pass-rate diff.
  const byScenario = scenarios.map((s) => {
    const c = control.scenarios.find((x) => x.scenarioId === s.id);
    const t = treatment.scenarios.find((x) => x.scenarioId === s.id);
    return {
      scenarioId: s.id,
      controlRate: c?.successRate ?? 0,
      treatmentRate: t?.successRate ?? 0,
      delta: (t?.successRate ?? 0) - (c?.successRate ?? 0),
    };
  });

  const summary = {
    modelId,
    engine,
    count,
    behaviors,
    startedAt: control.startedAt,
    finishedAt: treatment.finishedAt,
    control: { overallSuccessRate: control.overallSuccessRate, mechanism: controlMech },
    treatment: { overallSuccessRate: treatment.overallSuccessRate, mechanism: treatmentMech },
    overallDelta: treatment.overallSuccessRate - control.overallSuccessRate,
    byScenario,
  };
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify(summary, null, 2));

  // Report.
  console.log('\n[ab] ===== A/B RESULT =====');
  console.log(
    `  ${'scenario'.padEnd(20)} ${'control'.padStart(8)} ${'treat'.padStart(8)} ${'Δ'.padStart(8)}`,
  );
  for (const r of byScenario) {
    const d = `${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`;
    console.log(
      `  ${r.scenarioId.padEnd(20)} ${pct(r.controlRate).padStart(8)} ${pct(r.treatmentRate).padStart(8)} ${d.padStart(8)}`,
    );
  }
  const od = `${summary.overallDelta >= 0 ? '+' : ''}${(summary.overallDelta * 100).toFixed(1)}%`;
  console.log(
    `  ${'OVERALL'.padEnd(20)} ${pct(control.overallSuccessRate).padStart(8)} ${pct(treatment.overallSuccessRate).padStart(8)} ${od.padStart(8)}`,
  );
  console.log('\n[ab] mechanism (daemon.log markers)   control → treatment');
  for (const key of Object.keys(MARKERS)) {
    console.log(
      `  ${key.padEnd(22)} ${String(controlMech[key]).padStart(6)} → ${String(treatmentMech[key]).padStart(6)}`,
    );
  }
  console.log(`\n[ab] wrote ${join(root, 'ab-summary.json')}`);
  deviceLock?.release();
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('[ab] fatal:', err);
  process.exit(1);
});
