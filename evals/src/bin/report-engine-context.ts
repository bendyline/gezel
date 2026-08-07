/**
 * Granted-context report over eval history (Theme E / E4).
 *
 * Walks `evals/runs/` for per-trial daemon.logs, extracts each trial's
 * ACTUAL engine context grant via extractEngineContext, and reports the
 * distribution plus every policy-relevant anomaly: grants below the 64K
 * minimum (`MIN_VIABLE_LOCAL_CONTEXT_TOKENS`), admission-bypass launches
 * (clamp verdict ignored — the 2026-08-05 gemma4-31b OOM shape), outright
 * capacity denials, and Gemma swa-full declines.
 *
 * Works on runs recorded BEFORE result.json carried `engineContext` —
 * the daemon.log launch lines are the source either way.
 *
 *   pnpm --filter @bendyline/gezel-evals run report:engine-context
 *   tsx src/bin/report-engine-context.ts [--runs <dir>] [--min 65536] [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EngineContextRecord, extractEngineContext } from '../engine-context.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNS_DIR = resolve(HERE, '..', '..', 'runs');
const DEFAULT_MIN_TOKENS = 65_536;

interface TrialRow {
  daemonLogPath: string;
  modelId: string;
  record: EngineContextRecord;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function* walkDaemonLogs(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkDaemonLogs(full);
    else if (entry === 'daemon.log') yield full;
  }
}

function trialModelId(daemonLogPath: string, record: EngineContextRecord): string {
  try {
    const result = JSON.parse(
      readFileSync(join(dirname(daemonLogPath), 'result.json'), 'utf8'),
    ) as { modelId?: string };
    if (typeof result.modelId === 'string') return result.modelId;
  } catch {
    // Older layouts / preflight probes have no result.json beside the log.
  }
  return record.launchModel ?? 'unknown';
}

function collect(runsDir: string): TrialRow[] {
  const rows: TrialRow[] = [];
  for (const daemonLogPath of walkDaemonLogs(runsDir)) {
    let log: string;
    try {
      log = readFileSync(daemonLogPath, 'utf8');
    } catch {
      continue;
    }
    const record = extractEngineContext(log);
    if (!record) continue;
    rows.push({ daemonLogPath, modelId: trialModelId(daemonLogPath, record), record });
  }
  return rows;
}

function main(): void {
  const runsDir = resolve(argValue('--runs') ?? DEFAULT_RUNS_DIR);
  const minTokens = Number.parseInt(argValue('--min') ?? String(DEFAULT_MIN_TOKENS), 10);
  const rows = collect(runsDir);

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          daemonLog: relative(runsDir, r.daemonLogPath),
          modelId: r.modelId,
          ...r.record,
        })),
        null,
        2,
      ),
    );
    return;
  }

  const distribution = new Map<string, number>();
  const belowMin: TrialRow[] = [];
  const bypassed: TrialRow[] = [];
  const denied: TrialRow[] = [];
  const swaDeclined: TrialRow[] = [];
  for (const row of rows) {
    const granted = row.record.grantedPerSlotTokens;
    if (granted !== undefined) {
      const key = `${row.modelId} ctx=${granted} slots=${row.record.slots ?? '?'}`;
      distribution.set(key, (distribution.get(key) ?? 0) + 1);
      if (granted < minTokens) belowMin.push(row);
    }
    if (row.record.clampBypassed) bypassed.push(row);
    if (row.record.capacityDenied) denied.push(row);
    if (row.record.swaFullDeclined) swaDeclined.push(row);
  }

  console.log(`engine-context report — ${rows.length} trials with engine evidence in ${runsDir}\n`);
  console.log('granted context distribution (last launch per trial):');
  for (const [key, count] of [...distribution.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${key}`);
  }

  const section = (title: string, list: TrialRow[], detail: (r: TrialRow) => string): void => {
    console.log(`\n${title}: ${list.length}`);
    for (const row of list) {
      console.log(`  ${detail(row)}  ${relative(runsDir, dirname(row.daemonLogPath))}`);
    }
  };
  section(
    `grants below ${minTokens.toLocaleString('en-US')} tokens`,
    belowMin,
    (r) => `${r.modelId} granted=${r.record.grantedPerSlotTokens}`,
  );
  section(
    'admission bypassed (launched above the clamp verdict — OOM-risk shape)',
    bypassed,
    (r) =>
      `${r.modelId} launched=${r.record.grantedPerSlotTokens} clampSaid=${r.record.clamp?.grantedTokens}`,
  );
  section('capacity denials', denied, (r) => r.modelId);
  section('gemma swa-full declines (window preserved)', swaDeclined, (r) => r.modelId);
}

main();
