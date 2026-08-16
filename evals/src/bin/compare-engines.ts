#!/usr/bin/env -S npx tsx
/**
 * `pnpm eval:compare-engines --a <runsDir> --b <runsDir>` — diff two eval
 * arms that differ ONLY by engine.
 *
 * Why this exists rather than another pass-rate table: by the time a model
 * saturates the suites (qwen3.8-27b scored 33/33 core, 35/39 productivity),
 * pass/fail carries almost no information — 11 of 13 productivity scenarios
 * were 3/3, and measured per-cell noise is +/-1-2 trials. Detecting an
 * engine-level difference through that lens needs ~10 trials per cell.
 *
 * The mechanism counters in `TrialFacts` do not have that problem. A latent
 * engine bug is a SHIFTED DISTRIBUTION on a specific counter — MLX emitting
 * 3x the write_file calls, a red flag that only ever fires on one arm, a
 * tool that one engine never successfully calls at all. Those are visible at
 * n=5 and, unlike a score gap, they name the thing to go fix.
 *
 * Arms must be paired: same scenarios, same replicate count, same model,
 * same everything but `--provider`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertKnownFlags, parseArgs } from './args.ts';

interface ArmTrial {
  scenarioId: string;
  trialId: string;
  success: boolean;
  failureClass: string;
  engineSeen: string | null;
  durationMs: number;
  budgetUsedFraction: number;
  totalToolCalls: number;
  byTool: Record<string, number>;
  redFlags: string[];
  firstTurnTtftMs: number | null;
  timeToFirstArtifactMs: number | null;
  nativeEngineIncidents: number;
}

function dirsUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Recover which engine actually served the trial from the daemon log.
 *
 * Trusting the `--provider` flag is not enough. A silent fallback to the
 * other engine produces exactly the null result the "engines are equivalent"
 * hypothesis predicts, for entirely the wrong reason — so every trial has to
 * prove its arm from the run's own evidence before it is counted.
 */
function engineFromRun(runDir: string): string | null {
  for (const name of ['daemon.log', 'log.txt']) {
    const p = join(runDir, name);
    if (!existsSync(p)) continue;
    const head = readFileSync(p, 'utf8').slice(0, 200_000);
    if (/gezel_mlx_server|\[mlx\]|provider=mlx/i.test(head)) return 'mlx';
    if (/llama-server|\[llama-cpp\]|provider=llama-cpp/i.test(head)) return 'llama-cpp';
  }
  return null;
}

export function collectArm(runsDir: string): ArmTrial[] {
  const out: ArmTrial[] = [];
  const walk = (dir: string): void => {
    for (const child of dirsUnder(dir)) {
      const p = join(dir, child);
      const result = join(p, 'result.json');
      if (existsSync(result)) {
        const r = readJson<Record<string, unknown>>(result);
        if (!r || r.scenarioId === 'preflight') continue;
        const facts = readJson<Record<string, never>>(join(p, 'facts.json')) ?? ({} as never);
        const tool = (facts.toolUse ?? {}) as {
          totalToolCalls?: number;
          byTool?: Record<string, number>;
          redFlags?: Array<{ pattern?: string }>;
        };
        const timing = (facts.timing ?? {}) as Record<string, number | null>;
        const outcome = (facts.outcome ?? {}) as Record<string, number>;
        const incidents = (facts.nativeEngineIncidents ?? {}) as { total?: number };
        out.push({
          scenarioId: String(r.scenarioId),
          trialId: String(r.trialId),
          success: Boolean(r.success),
          failureClass: String(r.failureClass ?? (r.success ? 'pass' : 'model')),
          engineSeen: engineFromRun(p),
          durationMs: Number(r.durationMs ?? 0),
          budgetUsedFraction: Number(outcome.budgetUsedFraction ?? Number.NaN),
          totalToolCalls: Number(tool.totalToolCalls ?? Number.NaN),
          byTool: tool.byTool ?? {},
          redFlags: (tool.redFlags ?? []).map((f) => String(f.pattern ?? 'unknown')),
          firstTurnTtftMs: timing.firstTurnTtftMs ?? null,
          timeToFirstArtifactMs: timing.timeToFirstArtifactMs ?? null,
          nativeEngineIncidents: Number(incidents.total ?? 0),
        });
        continue;
      }
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(runsDir);
  return out;
}

function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * Mann-Whitney U (normal approximation), two-sided.
 *
 * Rank-based on purpose: trial durations and tool-call counts are heavily
 * skewed by watchdog kills and repair loops, so a t-test on the mean would
 * mostly be reporting the tail. Small-n and ties are the normal case here,
 * so this is a screening signal for "which counter to go look at", never a
 * publication claim.
 */
export function mannWhitneyP(a: number[], b: number[]): number {
  const xs = a.filter(Number.isFinite);
  const ys = b.filter(Number.isFinite);
  if (xs.length < 2 || ys.length < 2) return Number.NaN;
  const all = [...xs.map((v) => ({ v, g: 0 })), ...ys.map((v) => ({ v, g: 1 }))].sort(
    (p, q) => p.v - q.v,
  );
  const ranks = new Array<number>(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    i = j + 1;
  }
  let rankSumA = 0;
  all.forEach((e, i) => {
    if (e.g === 0) rankSumA += ranks[i]!;
  });
  const n1 = xs.length;
  const n2 = ys.length;
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  if (sigma === 0) return Number.NaN;
  const z = (u - mu) / sigma;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (1.330274 * t ** 4 - 1.821256 * t ** 3 + 1.781478 * t * t - 0.356538 * t + 0.3193815);
  return 1 - p;
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, ['a', 'b', 'label-a', 'label-b', 'json']);
  const aDir = String(args.flags.a ?? '');
  const bDir = String(args.flags.b ?? '');
  if (!aDir || !bDir) {
    console.error('usage: eval:compare-engines --a <runsDir> --b <runsDir>');
    process.exit(2);
  }
  const labelA = String(args.flags['label-a'] ?? 'A');
  const labelB = String(args.flags['label-b'] ?? 'B');
  const A = collectArm(aDir);
  const B = collectArm(bDir);
  if (A.length === 0 || B.length === 0) {
    console.error(`no trials found (${labelA}=${A.length}, ${labelB}=${B.length})`);
    process.exit(2);
  }

  // Arm integrity first: a trial that did not run on its intended engine
  // invalidates the comparison rather than merely adding noise.
  const engines = (arm: ArmTrial[]) => [...new Set(arm.map((t) => t.engineSeen ?? 'unknown'))];
  console.log('ARM INTEGRITY');
  console.log(`  ${labelA}: ${A.length} trials, engine(s) observed: ${engines(A).join(', ')}`);
  console.log(`  ${labelB}: ${B.length} trials, engine(s) observed: ${engines(B).join(', ')}`);
  if (engines(A).length > 1 || engines(B).length > 1) {
    console.log('  WARNING: an arm contains more than one engine — results are not attributable.');
  }

  const scenarios = [...new Set([...A, ...B].map((t) => t.scenarioId))].sort();
  console.log('\nOUTCOME (secondary — saturated suites make this weak)');
  console.log(`  ${'scenario'.padEnd(32)}${labelA.padStart(10)}${labelB.padStart(12)}`);
  for (const s of scenarios) {
    const a = A.filter((t) => t.scenarioId === s);
    const b = B.filter((t) => t.scenarioId === s);
    const ok = (xs: ArmTrial[]) => `${xs.filter((t) => t.success).length}/${xs.length}`;
    console.log(`  ${s.padEnd(32)}${ok(a).padStart(10)}${ok(b).padStart(12)}`);
  }

  const metrics: Array<[string, (t: ArmTrial) => number, number]> = [
    ['tool calls / trial', (t) => t.totalToolCalls, 0],
    ['duration (min)', (t) => t.durationMs / 60000, 1],
    ['budget used (frac)', (t) => t.budgetUsedFraction, 2],
    ['first-turn TTFT (ms)', (t) => t.firstTurnTtftMs ?? Number.NaN, 0],
    ['time to 1st artifact (s)', (t) => (t.timeToFirstArtifactMs ?? Number.NaN) / 1000, 0],
  ];
  console.log('\nMECHANISM (primary — median per arm, Mann-Whitney p)');
  console.log(
    `  ${'metric'.padEnd(28)}${labelA.padStart(10)}${labelB.padStart(12)}${'ratio'.padStart(9)}${'p'.padStart(9)}`,
  );
  for (const [name, pick, digits] of metrics) {
    const xa = A.map(pick);
    const xb = B.map(pick);
    const ma = median(xa);
    const mb = median(xb);
    const ratio = Number.isFinite(ma) && Number.isFinite(mb) && ma !== 0 ? mb / ma : Number.NaN;
    const p = mannWhitneyP(xa, xb);
    const flag = Number.isFinite(p) && p < 0.05 ? '  <-- differs' : '';
    console.log(
      `  ${name.padEnd(28)}${fmt(ma, digits).padStart(10)}${fmt(mb, digits).padStart(12)}${fmt(ratio, 2).padStart(9)}${fmt(p, 3).padStart(9)}${flag}`,
    );
  }

  // Per-tool divergence: this is where a latent bug is actually legible.
  const toolTotals = (arm: ArmTrial[]) => {
    const acc: Record<string, number> = {};
    for (const t of arm) for (const [k, v] of Object.entries(t.byTool)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  };
  const ta = toolTotals(A);
  const tb = toolTotals(B);
  const names = [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort();
  console.log('\nPER-TOOL CALL TOTALS (a tool present on one arm only is the loudest signal)');
  console.log(`  ${'tool'.padEnd(32)}${labelA.padStart(10)}${labelB.padStart(12)}`);
  for (const n of names) {
    const a = ta[n] ?? 0;
    const b = tb[n] ?? 0;
    const onlyOne = (a === 0) !== (b === 0);
    console.log(
      `  ${n.padEnd(32)}${String(a).padStart(10)}${String(b).padStart(12)}${onlyOne ? '  <-- one arm only' : ''}`,
    );
  }

  const flags = (arm: ArmTrial[]) => {
    const acc: Record<string, number> = {};
    for (const t of arm) for (const f of t.redFlags) acc[f] = (acc[f] ?? 0) + 1;
    return acc;
  };
  const fa = flags(A);
  const fb = flags(B);
  const fnames = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  if (fnames.length) {
    console.log('\nRED FLAGS');
    for (const n of fnames) {
      console.log(
        `  ${n.padEnd(32)}${String(fa[n] ?? 0).padStart(10)}${String(fb[n] ?? 0).padStart(12)}`,
      );
    }
  }

  const incidents = (arm: ArmTrial[]) => arm.reduce((s, t) => s + t.nativeEngineIncidents, 0);
  console.log(
    `\nNATIVE ENGINE INCIDENTS   ${labelA}: ${incidents(A)}   ${labelB}: ${incidents(B)}`,
  );

  if (args.flags.json) {
    console.log(`\n${JSON.stringify({ a: A, b: B }, null, 2)}`);
  }
}

main();
