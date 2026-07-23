/**
 * Calibration analysis for the F3.1 fail-fast per-task budget: mine the scored
 * trial corpus for how much a task actually SPENDS (output tokens + provider
 * round-trips), split by model tier and pass/fail, and print the distributions
 * that set the `taskBudget` thresholds.
 *
 * The budget's job is to sit ABOVE what a legitimate (passing) autonomous run
 * uses and BELOW where a doomed run has clearly gone runaway. So the levers we
 * want are the high percentiles of PASSING trials (the soft floor must clear
 * them) and the tail of ALL trials (where the hard cap catches the spin).
 *
 * Signals per trial:
 *   - outputTokens = facts.perf.usage.totalOutputTokens (the primary cost
 *     signal; the fail tax is ~3.6× OUTPUT tokens). Clean and direct.
 *   - turns = count of llama-server decode blocks in daemon.log (≈ provider
 *     round-trips). NOTE: this over-counts vs. the budget's own turn tally —
 *     the budget only accrues TASK-SCOPED sessions, while the log includes
 *     background klerk/memory-extraction sessions too. Treat turns as an upper
 *     bound; output tokens is the anchor.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx src/bin/analyze-task-spend.ts [runsDir]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvalModelTier } from '../model-tier.ts';

const DECODE_BLOCK_RE = /(?<!prompt )\beval time\s*=\s*[\d.]+\s*ms\s*\/\s*\d+\s*tokens/g;

interface TrialSpend {
  tier: string;
  success: boolean;
  outputTokens: number | null;
  turns: number | null;
}

function walkFactsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (name === 'facts.json') out.push(p);
    }
  }
  return out;
}

function readTrial(factsPath: string): TrialSpend | null {
  let facts: {
    modelId?: string;
    modelTier?: string;
    outcome?: { success?: boolean };
    perf?: { usage?: { totalOutputTokens?: number } };
  };
  try {
    facts = JSON.parse(readFileSync(factsPath, 'utf8'));
  } catch {
    return null;
  }
  if (!facts.modelId) return null;
  const tier =
    facts.modelTier ??
    // Corpus is local-model evals; classify as llama-cpp when the tier wasn't stamped.
    classifyEvalModelTier({ engine: 'llama-cpp', modelId: facts.modelId });
  const outputTokens = facts.perf?.usage?.totalOutputTokens ?? null;
  let turns: number | null = null;
  try {
    const log = readFileSync(join(dirname(factsPath), 'daemon.log'), 'utf8');
    turns = (log.match(DECODE_BLOCK_RE) ?? []).length || null;
  } catch {
    /* no daemon.log */
  }
  return { tier, success: facts.outcome?.success === true, outputTokens, turns };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function summarize(label: string, values: number[]): string {
  if (values.length === 0) return `${label.padEnd(22)} n=0`;
  const s = [...values].sort((a, b) => a - b);
  const p = (q: number) => String(pct(s, q)).padStart(7);
  return `${label.padEnd(22)} n=${String(values.length).padStart(4)}  p50=${p(50)} p90=${p(90)} p95=${p(95)} p99=${p(99)} max=${String(s[s.length - 1]).padStart(7)}`;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const runsDir = resolve(process.argv[2] ?? join(here, '..', '..', 'runs'));
  const trials = walkFactsFiles(runsDir)
    .map(readTrial)
    .filter((t): t is TrialSpend => t !== null);
  console.log(
    `\n=== F3.1 task-spend calibration — ${runsDir} (${trials.length} scored trials) ===\n`,
  );

  const tiers = ['tiny', 'small', 'medium', 'large', 'cloud'];
  for (const tier of tiers) {
    const inTier = trials.filter((t) => t.tier === tier);
    if (inTier.length === 0) continue;
    const pass = inTier.filter((t) => t.success);
    const fail = inTier.filter((t) => !t.success);
    const outTok = (rows: TrialSpend[]) =>
      rows.map((r) => r.outputTokens).filter((n): n is number => typeof n === 'number');
    const turns = (rows: TrialSpend[]) =>
      rows.map((r) => r.turns).filter((n): n is number => typeof n === 'number');
    console.log(
      `── ${tier.toUpperCase()} (${inTier.length} trials: ${pass.length} pass / ${fail.length} fail) ──`,
    );
    console.log(`  outTok  ${summarize('PASS', outTok(pass))}`);
    console.log(`  outTok  ${summarize('FAIL', outTok(fail))}`);
    console.log(`  turns   ${summarize('PASS', turns(pass))}`);
    console.log(`  turns   ${summarize('FAIL', turns(fail))}`);
    // Suggested thresholds: soft clears p95 of PASS; hard clears p99 of ALL
    // (catches the runaway tail) with a floor of ~2× soft.
    const passOut = [...outTok(pass)].sort((a, b) => a - b);
    const allOut = [...outTok(inTier)].sort((a, b) => a - b);
    const softOut = pct(passOut, 95);
    const hardOut = Math.max(pct(allOut, 99), softOut * 2);
    const passTurns = [...turns(pass)].sort((a, b) => a - b);
    const allTurns = [...turns(inTier)].sort((a, b) => a - b);
    const softTurns = pct(passTurns, 95);
    const hardTurns = Math.max(pct(allTurns, 99), softTurns * 2);
    console.log(
      `  → suggest  softOutputTokens≈${softOut}  hardOutputTokens≈${hardOut}  softTurns≈${softTurns}  hardTurns≈${hardTurns}\n`,
    );
  }
}

main();
