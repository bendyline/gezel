/**
 * `pnpm --filter @bendyline/gezel-evals run ab-tool-naming [<scenario>...] [...flags]`
 *
 * A/B harness for the MCP tool-naming standardization (snake_case vs the
 * pre-rename Node-fs-mirror spellings). Runs the SAME scenario matrix
 * twice on one model — once with `GEZEL_MCP_TOOL_NAMING=legacy` (the
 * gezel-mcp server re-advertises `readFile`/`writeFile`/`readdir`/… as it
 * did before the rename) and once with the snake_case default
 * (`read_file`/`write_file`/`list_dir`/…) — and diffs them. The toggle
 * rides `TrialOptions.toolNaming` → the daemon env → the gezel-mcp
 * subprocess env (ChatManager forwards `GEZEL_MCP_TOOL_NAMING`
 * explicitly, because the subprocess env is built from scratch).
 *
 * What the experiment can and cannot show:
 *
 *   - The advertised tool names, the `## Tools available this turn`
 *     block, and the function schema all follow the arm, so the model's
 *     FIRST-CALL naming behavior is cleanly arm-controlled.
 *   - Dispatch-level aliases are active in BOTH arms (either spelling
 *     executes) — so rescue is equalized and the pass-rate delta
 *     understates rather than fabricates any naming effect. The honest
 *     primary metrics are the mechanism counters below, not pass rate.
 *   - Known asymmetry, conservative direction: hardcoded failure-path
 *     nudges (llama.cpp stall/salvage prompts) speak snake_case in both
 *     arms. In the legacy arm a nudged model that follows them calls the
 *     canonical spelling, which the alias layer accepts — this can only
 *     shrink the measured difference, never inflate it.
 *
 * Hypotheses to check in the output:
 *   - `unknownTool` + `malformedCall` drop in the snake arm on small
 *     local models (training-prior alignment).
 *   - `aliasRescue` shows which arm's models guess the OTHER spelling:
 *     rescues in the snake arm are legacy guesses (pinned gilde prose,
 *     old priors); rescues in the legacy arm are snake guesses (the
 *     ecosystem prior the rename bets on).
 *   - Pass-rate delta is noisy at small counts; treat it as secondary
 *     unless run with a high `--count`.
 *
 * Positional args = scenario ids (default: the full registered matrix).
 * Flags:
 *   --model <id>      chat model catalog id (default `qwen3.5-4b-q4`)
 *   --provider <p>    engine (default `mlx`)
 *   --count <N>       trials per scenario per arm (default 5)
 *   --timeout <dur>   per-trial timeout override, e.g. `20m`
 *   --runs-dir <path> override the output root
 *   --list            list scenarios and exit
 *
 * Output: `evals/runs/ab-tool-naming-<ts>/{legacy,snake}/` (per-arm
 * matrices) + `ab-summary.json` + a printed comparison.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import type { BatchOptions, EvalScenario } from '../types.ts';
import { parseArgs, parseDuration, printScenarios, resolveProviderFlag } from './args.ts';

/** daemon.log substrings that tell the mechanism story, per arm. */
const MARKERS: Record<string, string> = {
  unknownTool: 'model called unknown tool',
  malformedCall: 'malformed tool call',
  // Bridge-level spelling resolutions (`call_tool alias <requested> -> <resolved>`):
  // the model asked for a name the arm does not advertise and the alias
  // layer saved the call. Directional evidence of which spelling the
  // model actually prefers under each arm.
  aliasRescue: 'call_tool alias',
  // Context for grammar-constrained local runs: when the tool grammar is
  // active the model CANNOT emit a wrong name, so unknownTool stays flat
  // regardless of naming — read naming effects from non-grammar paths.
  grammarActive: '[tool-grammar] active',
  toolsDropped: '[tool-prompt] TOOLS DROPPED',
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
      let idx = text.indexOf(needle, 0);
      let n = 0;
      while (idx !== -1) {
        n += 1;
        idx = text.indexOf(needle, idx + needle.length);
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

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-tool-naming-${ts}`);
  await mkdir(root, { recursive: true });

  const ac = installSignalHandlers();
  console.log(
    `[ab] model=${modelId} engine=${engine} count=${count} scenarios=${scenarios.length}\n[ab] root=${root}`,
  );

  const baseOpts: BatchOptions = { modelId, engine, count, timeoutMs, signal: ac.signal };

  // Legacy arm first (the pre-rename naming), then snake. Sequential: two
  // arms on one box would cross-saturate VRAM and the pass rate would lie.
  console.log('\n[ab] ===== LEGACY arm (pre-rename tool names) =====');
  const legacy = await runMatrix(scenarios, {
    ...baseOpts,
    toolNaming: 'legacy',
    runsDir: join(root, 'legacy'),
  });

  console.log('\n[ab] ===== SNAKE arm (canonical snake_case names) =====');
  const snake = await runMatrix(scenarios, {
    ...baseOpts,
    toolNaming: 'snake',
    runsDir: join(root, 'snake'),
  });

  const legacyMech = await scanMechanism(join(root, 'legacy'));
  const snakeMech = await scanMechanism(join(root, 'snake'));

  const byScenario = scenarios.map((s) => {
    const l = legacy.scenarios.find((x) => x.scenarioId === s.id);
    const k = snake.scenarios.find((x) => x.scenarioId === s.id);
    return {
      scenarioId: s.id,
      legacyRate: l?.successRate ?? 0,
      snakeRate: k?.successRate ?? 0,
      delta: (k?.successRate ?? 0) - (l?.successRate ?? 0),
    };
  });

  const summary = {
    modelId,
    engine,
    count,
    startedAt: legacy.startedAt,
    finishedAt: snake.finishedAt,
    legacy: { overallSuccessRate: legacy.overallSuccessRate, mechanism: legacyMech },
    snake: { overallSuccessRate: snake.overallSuccessRate, mechanism: snakeMech },
    overallDelta: snake.overallSuccessRate - legacy.overallSuccessRate,
    byScenario,
  };
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n[ab] ===== A/B TOOL-NAMING RESULT =====');
  console.log(
    `  ${'scenario'.padEnd(20)} ${'legacy'.padStart(8)} ${'snake'.padStart(8)} ${'Δ'.padStart(8)}`,
  );
  for (const r of byScenario) {
    const d = `${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`;
    console.log(
      `  ${r.scenarioId.padEnd(20)} ${pct(r.legacyRate).padStart(8)} ${pct(r.snakeRate).padStart(8)} ${d.padStart(8)}`,
    );
  }
  const od = `${summary.overallDelta >= 0 ? '+' : ''}${(summary.overallDelta * 100).toFixed(1)}%`;
  console.log(
    `  ${'OVERALL'.padEnd(20)} ${pct(legacy.overallSuccessRate).padStart(8)} ${pct(snake.overallSuccessRate).padStart(8)} ${od.padStart(8)}`,
  );
  console.log('\n[ab] mechanism (daemon.log markers)   legacy → snake');
  for (const key of Object.keys(MARKERS)) {
    console.log(
      `  ${key.padEnd(22)} ${String(legacyMech[key]).padStart(6)} → ${String(snakeMech[key]).padStart(6)}`,
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
