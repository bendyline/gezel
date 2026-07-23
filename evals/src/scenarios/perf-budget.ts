import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { materializeProjectWorkspace, spawnAndAwait } from './helpers.ts';

/**
 * Perf-budget — optimize without breaking correctness.
 *
 * Axis: performance reasoning / algorithmic substitution (scenario #8 in
 * docs/orthogonal-scenarios-2026-06.md — zero coverage in the suite
 * today). The seeded `src/dedupe.mjs` is CORRECT but quadratic: it
 * merges tag lists per id with a linear scan over the result array for
 * every input item. Against the seeded 70k-row fixture that takes
 * several seconds; an O(n) Map/Set rewrite takes ~0.02 s. The model
 * must make `node bench.mjs` finish under BUDGET_MS without changing the
 * bench or correctness protocols.
 *
 * All gates are runtime gates (execution, not style regexes):
 *   - bench.mjs / correct.mjs / data/items.json byte-identical guards
 *     (the haversine-untouched pattern — items.json is guarded because
 *     shrinking the fixture is the obvious cheat),
 *   - `node correct.mjs` exits 0 (8 behavioral cases),
 *   - `node bench.mjs` prints ELAPSED_MS ≤ BUDGET_MS with the expected
 *     RESULT_COUNT.
 *
 * Feedback relays the actual ELAPSED_MS vs the budget and any failing
 * CASE lines verbatim.
 */

const PROJECT_NAME = 'Pipeline Performance';
const DEVELOPER_NAME = 'Otto';

export const DEDUPE_PATH = 'src/dedupe.mjs';
export const BENCH_PATH = 'bench.mjs';
export const CORRECT_PATH = 'correct.mjs';
export const ITEMS_PATH = 'data/items.json';

/**
 * The budget must hold across machines, from the DGX Spark eval host to a
 * fast Apple-silicon dev box (~3× quicker). The trick is the WORKLOAD, not
 * a host-specific number: the seed's cost is quadratic (O(n × unique_ids))
 * while the reference is linear (O(n)), so the fixture is tuned to keep the
 * two timings orders of magnitude apart on *any* CPU. With ITEM_COUNT
 * pinned low (reference time scales with it, and must stay tiny even under
 * the full parallel suite) and ID_POOL_SIZE large (so ~55k distinct ids
 * make the seed's inner result-scan long), the gap is enormous:
 *   - seeded quadratic dedupe.mjs:  ~4.5-5.4 s isolated on the fast dev box
 *     (≥2.8× budget at its quickest), multiples of that on slower hosts
 *   - reference O(n) Map/Set rewrite: ~0.02 s per fresh process — n is low
 *     enough that even heavy parallel load keeps it far under budget/2
 * Nothing lands between ~0.05 s and ~4.5 s, so there is no lucky pass
 * without a genuine O(n) fix and a real rewrite never false-fails.
 * BUDGET_MS = 1600 sits in the middle of that gap. perf-budget.test.ts
 * re-runs both sides as its calibration guard (seed must clear 2×budget,
 * reference must stay under budget/2) so every run re-validates the fit on
 * the current machine.
 */
export const BUDGET_MS = 1600;

// ─────────────────────────────────────────────────────────────────────
// Deterministic fixture generator. A tiny LCG (no Math.random) so the
// scenario setup and the offline tests produce byte-identical
// data/items.json — the grader guards the fixture against tampering by
// regenerating it.

export const ITEM_COUNT = 70_000;
const ID_POOL_SIZE = 140_000;
const TAG_POOL_SIZE = 30;
const LCG_SEED = 0xc0ffee;

/** Unique ids the LCG actually emits across ITEM_COUNT draws (measured, deterministic). */
export const EXPECTED_RESULT_COUNT = 55_177;

export interface PerfItem {
  id: string;
  tags: string[];
}

export function generateItems(): PerfItem[] {
  let s = LCG_SEED >>> 0;
  const next = (range: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor(((s >>> 8) / 0x1000000) * range);
  };
  const items: PerfItem[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const id = `item-${String(next(ID_POOL_SIZE)).padStart(6, '0')}`;
    const tagCount = 1 + next(4);
    const tags: string[] = [];
    for (let t = 0; t < tagCount; t++) {
      tags.push(`tag-${String(next(TAG_POOL_SIZE)).padStart(2, '0')}`);
    }
    items.push({ id, tags });
  }
  return items;
}

let cachedItemsJson: string | null = null;

/** The exact data/items.json seed content (~3.7 MB; generated once, cached). */
export function generateItemsJson(): string {
  if (cachedItemsJson === null) cachedItemsJson = JSON.stringify(generateItems());
  return cachedItemsJson;
}

// ─────────────────────────────────────────────────────────────────────
// Seed fixtures. The .mjs sources deliberately avoid template literals
// so they can live inside these TS template strings unescaped.

/**
 * The starting implementation: correct (all 8 cases in correct.mjs pass)
 * but quadratic — a linear scan over `result` per input item plus
 * indexOf scans for tag union.
 */
export const DEDUPE_SEED_MJS = `// Merge duplicate items by id, unioning their tags.
//
// Contract (enforced by correct.mjs — run 'node correct.mjs'):
//   - input:  array of { id: string, tags: string[] }
//   - output: array of { id, tags } with one entry per distinct id,
//     ids in first-seen order, tags the deduplicated union in
//     first-seen order, input not mutated.
export function dedupeItems(items) {
  const result = [];
  for (const item of items) {
    let entry = null;
    for (let i = 0; i < result.length; i++) {
      if (result[i].id === item.id) {
        entry = result[i];
        break;
      }
    }
    if (entry === null) {
      entry = { id: item.id, tags: [] };
      result.push(entry);
    }
    for (const tag of item.tags) {
      if (entry.tags.indexOf(tag) === -1) {
        entry.tags.push(tag);
      }
    }
  }
  return result;
}
`;

export const BENCH_MJS = `// Read-only benchmark protocol — DO NOT MODIFY. The scenario checker
// compares this file byte-for-byte against the seed, then runs
// 'node bench.mjs' and parses the RESULT_COUNT / ELAPSED_MS lines.
import { readFileSync } from 'node:fs';
import { dedupeItems } from './src/dedupe.mjs';

const items = JSON.parse(readFileSync(new URL('./data/items.json', import.meta.url), 'utf8'));
const t0 = performance.now();
const result = dedupeItems(items);
const t1 = performance.now();
console.log('RESULT_COUNT=' + result.length);
console.log('ELAPSED_MS=' + Math.round(t1 - t0));
`;

export const CORRECT_MJS = `// Read-only correctness suite — DO NOT MODIFY. The scenario checker
// compares this file byte-for-byte against the seed, then runs
// 'node correct.mjs'; it must exit 0. Failures print as 'CASE n: ...'.
import { dedupeItems } from './src/dedupe.mjs';

let failures = 0;
function check(n, label, fn) {
  try {
    fn();
  } catch (err) {
    failures += 1;
    console.log('CASE ' + n + ': ' + label + ' — ' + String((err && err.message) || err));
  }
}
function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(what + ': expected ' + e + ', got ' + a);
}

check(1, 'empty input returns an empty array', () => {
  assertEqual(dedupeItems([]), [], 'dedupeItems([])');
});
check(2, 'a single item passes through unchanged', () => {
  assertEqual(
    dedupeItems([{ id: 'a', tags: ['x', 'y'] }]),
    [{ id: 'a', tags: ['x', 'y'] }],
    'result',
  );
});
check(3, 'distinct ids stay separate, in first-seen order', () => {
  assertEqual(
    dedupeItems([
      { id: 'b', tags: ['x'] },
      { id: 'a', tags: ['y'] },
    ]),
    [
      { id: 'b', tags: ['x'] },
      { id: 'a', tags: ['y'] },
    ],
    'result',
  );
});
check(4, 'same id merges tags as a union in first-seen order', () => {
  assertEqual(
    dedupeItems([
      { id: 'a', tags: ['x', 'y'] },
      { id: 'a', tags: ['y', 'z'] },
    ]),
    [{ id: 'a', tags: ['x', 'y', 'z'] }],
    'result',
  );
});
check(5, 'duplicate tags within one item are deduplicated', () => {
  assertEqual(dedupeItems([{ id: 'a', tags: ['x', 'x', 'x'] }]), [{ id: 'a', tags: ['x'] }], 'result');
});
check(6, 'merged ids keep their first-seen position across interleaving', () => {
  assertEqual(
    dedupeItems([
      { id: 'a', tags: ['1'] },
      { id: 'b', tags: ['2'] },
      { id: 'a', tags: ['3'] },
      { id: 'c', tags: ['4'] },
      { id: 'b', tags: ['5'] },
    ]),
    [
      { id: 'a', tags: ['1', '3'] },
      { id: 'b', tags: ['2', '5'] },
      { id: 'c', tags: ['4'] },
    ],
    'result',
  );
});
check(7, 'the input array and its items are not mutated', () => {
  const input = [
    { id: 'a', tags: ['x'] },
    { id: 'a', tags: ['y'] },
  ];
  const snapshot = JSON.stringify(input);
  dedupeItems(input);
  if (JSON.stringify(input) !== snapshot) {
    throw new Error('input was mutated: ' + JSON.stringify(input));
  }
});
check(8, 'result entries are plain { id, tags } objects', () => {
  const out = dedupeItems([{ id: 'a', tags: ['x'] }]);
  const keys = Object.keys(out[0]).sort().join(',');
  if (keys !== 'id,tags') throw new Error('expected keys id,tags — got ' + keys);
  if (!Array.isArray(out[0].tags)) throw new Error('tags must be an array');
});

if (failures > 0) {
  console.log(failures + ' case(s) failed');
  process.exitCode = 1;
} else {
  console.log('ALL CASES PASSED');
}
`;

// ─────────────────────────────────────────────────────────────────────
// User-shaped task text (single-sourced into missionObjectives + kickoff).

const PERF_RULES = [
  `1. Rewrite ${DEDUPE_PATH} so that \`node bench.mjs\` prints ELAPSED_MS of at most ${BUDGET_MS}`,
  ' on this machine (the seeded implementation takes several seconds — you need an',
  ' algorithmic fix, e.g. a Map keyed by id instead of nested array scans, not micro-tweaks).',
  ' 2. `node correct.mjs` must stay green (exit 0, all 8 cases) — the observable behavior of',
  ' dedupeItems must not change: one entry per distinct id, ids in first-seen order, tags the',
  ' deduplicated union in first-seen order, input not mutated.',
  ` 3. Keep the exact export signature \`export function dedupeItems(items)\` in ${DEDUPE_PATH}.`,
  ` 4. Do NOT modify ${BENCH_PATH}, ${CORRECT_PATH}, or ${ITEMS_PATH} — the checker verifies`,
  ' all three byte-for-byte against the originals.',
].join('');

export const PERF_BUDGET_MISSION_OBJECTIVES = [
  `Make the item-dedupe pipeline fast enough for production. ${DEDUPE_PATH} is functionally`,
  'correct today but far too slow on the real 70k-row fixture in data/items.json.',
  PERF_RULES,
  'Use plain Node — no npm installs, no external dependencies.',
].join(' ');

export const PERF_BUDGET_KICKOFF_MESSAGE = [
  `Our dedupe pipeline is too slow. Please read ${DEDUPE_PATH}, ${BENCH_PATH} and`,
  `${CORRECT_PATH} (paths relative to the workspace root, no leading "workspace/"), then`,
  `optimize ${DEDUPE_PATH}. The rules: ${PERF_RULES}`,
  'Plain Node only — do not run npm install; there is no node_modules and no dependency is',
  'needed. The checker runs `node correct.mjs` and `node bench.mjs` automatically every time',
  `${DEDUPE_PATH} changes and reports the measured ELAPSED_MS and any failing CASE lines back`,
  'to you via chat.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Grader.

export const PERF_BUDGET_SIGNALS = [
  'bench-untouched',
  'correct-untouched',
  'data-untouched',
  'correctness-green',
  'bench-under-budget',
] as const;

export interface PerfBudgetCheckResult {
  ok: boolean;
  signals: string[];
  score: number;
  failReason?: string;
  missingRequiredSignals?: string[];
  /** Parsed from bench.mjs output when the bench gate ran. */
  elapsedMs?: number;
  /** Failing `CASE n:` lines from correct.mjs, verbatim. */
  caseFailures?: string[];
}

async function readDirText(dir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(dir, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The single most common perf-budget miss for small models: returning a
 * WRAPPER object (`{ deduplicatedItems: [...], unionTags: {} }`) instead
 * of the bare array. correct.mjs then fails almost every case with
 * `expected [...]` / `got {...}`, and CASE 8 throws because `out[0]` is
 * undefined. The raw CASE lines never NAME the mistake, so a small model
 * keeps fixing tag-merge logic, never drops the wrapper, and stalls at
 * 3/5 until the hard ceiling (observed: perf-budget 1/3, all
 * failures this exact shape). Detect the expected-array / got-object
 * mismatch and prepend a plain-language nudge so the relayed feedback
 * points straight at `return result;` instead of `return { ...: result }`.
 *
 * Returns null when the failures are NOT a wrapper return (e.g. a bare
 * array with wrong contents → `expected [...]` / `got [...]`), so a
 * genuinely-wrong algorithm still gets the unembellished CASE lines.
 */
export function wrapperReturnHint(caseFailures: string[]): string | null {
  let wrapperKey: string | null = null;
  let hits = 0;
  for (const line of caseFailures) {
    // assertEqual prints `<what>: expected <e>, got <a>` with e/a as
    // JSON.stringify output (no spaces around commas), so `, got ` is an
    // unambiguous delimiter. Wrapper symptom: expected an array, got an
    // object.
    const m = line.match(/expected (\[.*?), got (\{.*)$/);
    if (!m) continue;
    hits += 1;
    const got = m[2];
    if (wrapperKey === null && got) {
      const k = got.match(/^\{\s*"([^"]+)"/);
      if (k?.[1]) wrapperKey = k[1];
    }
  }
  if (hits === 0) return null;
  const example = wrapperKey ? `{ "${wrapperKey}": [...] }` : '{ ... }';
  return `dedupeItems is returning an OBJECT, not the array — correct.mjs expects the array of { id, tags } returned DIRECTLY (\`return result;\`), but it received a wrapper like \`${example}\`. Drop the wrapper: return the deduplicated array itself, not an object with the items nested inside.`;
}

/**
 * Offline verification of a perf-budget workspace DIRECTORY (no daemon):
 * byte-identical guards on the read-only protocol files, then the two
 * runtime gates. Exported so the grader tests (and any failure-class
 * backfill) can run the exact production gate against a local tree.
 */
export async function verifyPerfBudgetDir(dir: string): Promise<PerfBudgetCheckResult> {
  const signals: string[] = [];
  const fail = (
    missing: string[],
    failReason: string,
    extra: Partial<PerfBudgetCheckResult> = {},
  ): PerfBudgetCheckResult => ({
    ok: false,
    signals,
    score: signals.length,
    failReason,
    missingRequiredSignals: missing,
    ...extra,
  });

  // Byte-identical guards on the protocol files. trim() tolerates only
  // trailing-newline normalization (the haversine-untouched pattern).
  const [bench, correct, items] = await Promise.all([
    readDirText(dir, BENCH_PATH),
    readDirText(dir, CORRECT_PATH),
    readDirText(dir, ITEMS_PATH),
  ]);
  const guardFailures: string[] = [];
  if (bench !== null && bench.trim() === BENCH_MJS.trim()) signals.push('bench-untouched');
  else guardFailures.push('bench-untouched');
  if (correct !== null && correct.trim() === CORRECT_MJS.trim()) signals.push('correct-untouched');
  else guardFailures.push('correct-untouched');
  if (items !== null && items.trim() === generateItemsJson().trim()) signals.push('data-untouched');
  else guardFailures.push('data-untouched');
  if (guardFailures.length > 0) {
    const named = guardFailures
      .map((g) =>
        g === 'bench-untouched'
          ? BENCH_PATH
          : g === 'correct-untouched'
            ? CORRECT_PATH
            : ITEMS_PATH,
      )
      .join(', ');
    return fail(
      guardFailures,
      `${named} ${guardFailures.length === 1 ? 'was' : 'were'} modified or deleted — these files are read-only; restore them exactly as seeded and put the optimization in ${DEDUPE_PATH} only`,
    );
  }

  // Runtime gate 1: correctness must stay green.
  const correctRun = await spawnAndAwait(process.execPath, [join(dir, CORRECT_PATH)], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  if (correctRun.exitCode !== 0) {
    const caseFailures = correctRun.stdout.split('\n').filter((l) => /^CASE \d+:/.test(l));
    const detail =
      caseFailures.length > 0
        ? caseFailures.join(' | ')
        : `correct.mjs ${correctRun.timedOut ? 'timed out' : `exited ${correctRun.exitCode}`}: ${(correctRun.stderr || correctRun.stdout).trim().slice(0, 400)}`;
    // Lead with a named diagnosis when the failures are the wrapper-return
    // shape — the raw CASE lines alone never get a small model to drop the
    // wrapper. Plain wrong-algorithm failures get the unembellished lines.
    const hint = wrapperReturnHint(caseFailures);
    const reason = hint
      ? `node correct.mjs failed — ${hint} (failing cases: ${detail})`
      : `node correct.mjs failed — ${detail}`;
    return fail(['correctness-green'], reason, { caseFailures });
  }
  signals.push('correctness-green');

  // Runtime gate 2: the bench must come in under budget.
  const benchRun = await spawnAndAwait(process.execPath, [join(dir, BENCH_PATH)], {
    cwd: dir,
    timeoutMs: 60_000,
  });
  if (benchRun.exitCode !== 0) {
    return fail(
      ['bench-under-budget'],
      `node bench.mjs ${benchRun.timedOut ? `did not finish within 60 s (budget is ${BUDGET_MS} ms)` : `exited ${benchRun.exitCode}: ${(benchRun.stderr || benchRun.stdout).trim().slice(0, 400)}`}`,
    );
  }
  const elapsedMatch = benchRun.stdout.match(/^ELAPSED_MS=(\d+)$/m);
  const countMatch = benchRun.stdout.match(/^RESULT_COUNT=(\d+)$/m);
  if (!elapsedMatch || !countMatch) {
    return fail(
      ['bench-under-budget'],
      `bench.mjs output did not include the ELAPSED_MS/RESULT_COUNT protocol lines (got: ${benchRun.stdout.trim().slice(0, 200)})`,
    );
  }
  const elapsedMs = Number(elapsedMatch[1]);
  const resultCount = Number(countMatch[1]);
  if (resultCount !== EXPECTED_RESULT_COUNT) {
    return fail(
      ['bench-under-budget'],
      `bench.mjs reported RESULT_COUNT=${resultCount}, expected ${EXPECTED_RESULT_COUNT} — dedupeItems is dropping or inventing entries on the full fixture`,
      { elapsedMs },
    );
  }
  if (elapsedMs > BUDGET_MS) {
    return fail(
      ['bench-under-budget'],
      `bench.mjs measured ELAPSED_MS=${elapsedMs}, which is over the ${BUDGET_MS} ms budget — the current algorithm is still too slow`,
      { elapsedMs },
    );
  }
  signals.push('bench-under-budget');

  return { ok: true, signals, score: signals.length, elapsedMs };
}

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

/** Tiny FNV-1a content hash for the run-once-per-revision cache key. */
function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Optimize a correct-but-quadratic item-dedupe module until the seeded benchmark meets ' +
        'its performance budget, without breaking the read-only correctness suite or touching ' +
        'the benchmark protocol files.',
      missionObjectives: PERF_BUDGET_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('perf-budget setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: DEDUPE_PATH, content: DEDUPE_SEED_MJS },
    { path: BENCH_PATH, content: BENCH_MJS },
    { path: CORRECT_PATH, content: CORRECT_MJS },
    { path: ITEMS_PATH, content: generateItemsJson() },
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} fixture files under project ${projectId}`);

  let dev: { id: string };
  try {
    const created = await client.createGezel({ name: DEVELOPER_NAME, role: 'Developer' });
    dev = { id: created.id };
    log(`[scenario:setup] created developer "${DEVELOPER_NAME}" id=${dev.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === DEVELOPER_NAME);
    if (!existing) throw err;
    dev = { id: existing.id };
    log(`[scenario:setup] reusing developer "${DEVELOPER_NAME}" id=${dev.id}`);
  }
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${DEVELOPER_NAME} to project ${projectId}`);

  await client.sendChatMessage(dev.id, {
    message: PERF_BUDGET_KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${DEVELOPER_NAME} in project ${projectId}`);
}

/**
 * Run-once-per-revision cache: the runtime gates cost two spawns plus a
 * ~3.7 MB workspace materialization, so they only re-run when
 * src/dedupe.mjs actually changes. A cheat that edits the guarded files
 * WITHOUT touching dedupe.mjs leaves a failing cached verdict in place,
 * and any later dedupe.mjs edit re-materializes everything and re-checks
 * the guards — so the cache never lets a tampered tree pass.
 */
const gateCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: PerfBudgetCheckResult }
>();

export const perfBudgetScenario: EvalScenario = {
  id: 'perf-budget',
  description: [
    'Optimize a correct-but-quadratic dedupe module: `node bench.mjs` over a seeded 70k-row',
    `fixture must finish under ${BUDGET_MS} ms (an O(n) rewrite — the seed takes several seconds) while`,
    'the read-only correct.mjs suite stays green and bench/correct/data stay byte-identical.',
  ].join(' '),
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is optimizing the dedupe pipeline in the "${PROJECT_NAME}"`,
    "project to meet its benchmark budget. You don't need to do anything — just confirm you've",
    'seen this note.',
  ].join(' '),
  evidenceTexts: [PERF_BUDGET_KICKOFF_MESSAGE, PERF_BUDGET_MISSION_OBJECTIVES],
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] perf-budget project not present yet');
      return { done: false };
    }

    const dedupeText = await readWorkspaceText(client, projectId, DEDUPE_PATH);
    if (dedupeText === null) {
      const result: PerfBudgetCheckResult = {
        ok: false,
        signals: [],
        score: 0,
        failReason: `${DEDUPE_PATH} is missing — it must keep existing and export dedupeItems(items)`,
        missingRequiredSignals: ['correctness-green'],
      };
      logChanged(
        'sniff',
        `[scenario] perf-budget bytes=0 score=0 signals=none failReason="${result.failReason}"`,
      );
      recordSniff?.({ key: 'perf-budget', score: 0, bytes: 0 });
      await postSniffFeedback(ctx, DEDUPE_PATH, result, { projectId });
      return { done: false };
    }

    const hash = simpleHash(dedupeText);
    let result: PerfBudgetCheckResult;
    const cached = gateCache.get(ctx);
    if (cached && cached.lastHash === hash) {
      result = cached.lastResult;
    } else {
      const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-perf-budget-`);
      try {
        await materializeProjectWorkspace(client, projectId, tmp, {
          include: /\.(m?js|c?js|json)$/,
        });
        result = await verifyPerfBudgetDir(tmp);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
      gateCache.set(ctx, { lastHash: hash, lastResult: result });
      log(
        `[scenario] perf-budget gates ran: ok=${result.ok}${result.elapsedMs != null ? ` elapsedMs=${result.elapsedMs} (budget ${BUDGET_MS})` : ''}`,
      );
    }

    logChanged(
      'sniff',
      `[scenario] perf-budget bytes=${dedupeText.length} score=${result.score}/${PERF_BUDGET_SIGNALS.length} signals=${result.signals.join(',') || 'none'}${result.failReason ? ` failReason="${result.failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'perf-budget', score: result.score, bytes: dedupeText.length });

    if (result.ok) {
      return {
        done: true,
        success: true,
        reason: `all ${PERF_BUDGET_SIGNALS.length} gates passed — bench ELAPSED_MS=${result.elapsedMs} ≤ ${BUDGET_MS} ms budget with correct.mjs green (${result.signals.join(', ')})`,
      };
    }

    await postSniffFeedback(ctx, DEDUPE_PATH, result, {
      projectId,
      sourceText: dedupeText,
    });
    return { done: false };
  },
};
