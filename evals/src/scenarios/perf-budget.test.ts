import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BENCH_MJS,
  BENCH_PATH,
  BUDGET_MS,
  CORRECT_MJS,
  CORRECT_PATH,
  DEDUPE_PATH,
  DEDUPE_SEED_MJS,
  EXPECTED_RESULT_COUNT,
  ITEMS_PATH,
  PERF_BUDGET_KICKOFF_MESSAGE,
  PERF_BUDGET_MISSION_OBJECTIVES,
  PERF_BUDGET_SIGNALS,
  generateItemsJson,
  verifyPerfBudgetDir,
  wrapperReturnHint,
} from './perf-budget.ts';

/**
 * Unwinnable-grader guard AND the calibration run for BUDGET_MS: these
 * tests execute the real gates (spawned `node correct.mjs` /
 * `node bench.mjs`) against (a) the seeded quadratic implementation,
 * which must FAIL the budget while staying correct, and (b) a reference
 * O(n) rewrite, which must PASS. Both measured timings are printed so
 * every test run re-validates the budget fit on the current machine.
 * The fixture is tuned (low ITEM_COUNT, large ID_POOL_SIZE) so the
 * quadratic seed and the linear reference stay orders of magnitude apart
 * on any CPU — on a fast Apple-silicon dev box the seed runs ~4.5-5.4 s
 * and the reference ~0.02 s against the 1600 ms budget. See BUDGET_MS in
 * perf-budget.ts for the full reasoning.
 */

/** Reference O(n) solution — Map keyed by id, Set per id for tag union. */
const REFERENCE_DEDUPE_MJS = `export function dedupeItems(items) {
  const result = [];
  const byId = new Map();
  const tagSets = new Map();
  for (const item of items) {
    let entry = byId.get(item.id);
    if (entry === undefined) {
      entry = { id: item.id, tags: [] };
      byId.set(item.id, entry);
      tagSets.set(item.id, new Set());
      result.push(entry);
    }
    const seen = tagSets.get(item.id);
    for (const tag of item.tags) {
      if (!seen.has(tag)) {
        seen.add(tag);
        entry.tags.push(tag);
      }
    }
  }
  return result;
}
`;

/** Fast but WRONG: drops everything. Must be caught by correct.mjs, not the bench. */
const BROKEN_FAST_DEDUPE_MJS = `export function dedupeItems(items) {
  return [];
}
`;

/**
 * The observed failure shape: a correct-enough dedupe whose
 * tag-merge logic is fine, but which returns a WRAPPER object
 * `{ deduplicatedItems, unionTags }` instead of the bare array. correct.mjs
 * fails every case with expected-array / got-object, and the model (lacking
 * a named hint) keeps tweaking the merge and stalls at 3/5.
 */
const WRAPPER_RETURN_DEDUPE_MJS = `export function dedupeItems(items) {
  const byId = new Map();
  for (const item of items) {
    let entry = byId.get(item.id);
    if (entry === undefined) {
      entry = { id: item.id, tags: [] };
      byId.set(item.id, entry);
    }
    for (const tag of item.tags) {
      if (entry.tags.indexOf(tag) === -1) entry.tags.push(tag);
    }
  }
  const deduplicatedItems = [...byId.values()];
  const unionTags = {};
  return { deduplicatedItems, unionTags };
}
`;

async function writeFileAt(dir: string, rel: string, content: string): Promise<void> {
  const target = join(dir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function writeSeedWorkspace(dir: string): Promise<void> {
  await writeFileAt(dir, BENCH_PATH, BENCH_MJS);
  await writeFileAt(dir, CORRECT_PATH, CORRECT_MJS);
  await writeFileAt(dir, DEDUPE_PATH, DEDUPE_SEED_MJS);
  await writeFileAt(dir, ITEMS_PATH, generateItemsJson());
}

describe('perf-budget grader — gates run against the real workspace tree', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(`${tmpdir()}/perf-budget-test-`);
    await writeSeedWorkspace(tmp);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('CALIBRATION (a): the seeded quadratic implementation is correct but fails the budget', async () => {
    const result = await verifyPerfBudgetDir(tmp);
    console.log(
      `[perf-budget calibration] seeded quadratic: ELAPSED_MS=${result.elapsedMs} (budget ${BUDGET_MS} ms)`,
    );
    expect(result.ok).toBe(false);
    // All guards + correctness fire; only the budget gate fails.
    expect(result.signals).toEqual([
      'bench-untouched',
      'correct-untouched',
      'data-untouched',
      'correctness-green',
    ]);
    expect(result.missingRequiredSignals).toEqual(['bench-under-budget']);
    expect(result.failReason).toContain(`over the ${BUDGET_MS} ms budget`);
    expect(result.elapsedMs).toBeGreaterThan(BUDGET_MS);
    // Calibration sanity: the seed must not be anywhere near a lucky pass
    // — it clears at least 2× the budget on the fastest machine we run on.
    expect(result.elapsedMs).toBeGreaterThan(BUDGET_MS * 2);
  }, 120_000);

  it('CALIBRATION (b): the reference O(n) rewrite passes every gate', async () => {
    await writeFileAt(tmp, DEDUPE_PATH, REFERENCE_DEDUPE_MJS);
    const result = await verifyPerfBudgetDir(tmp);
    console.log(
      `[perf-budget calibration] reference O(n): ELAPSED_MS=${result.elapsedMs} (budget ${BUDGET_MS} ms)`,
    );
    expect(result.failReason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual([...PERF_BUDGET_SIGNALS]);
    // Calibration sanity: a real rewrite clears the budget with room to
    // spare. The reference runs ~0.02 s (ITEM_COUNT is low), so BUDGET_MS /
    // 2 (800 ms) leaves huge margin even with cold-start jitter under load.
    expect(result.elapsedMs).toBeLessThan(BUDGET_MS / 2);
    // Restore the seed for the remaining tests.
    await writeFileAt(tmp, DEDUPE_PATH, DEDUPE_SEED_MJS);
  }, 120_000);

  it('a fast-but-wrong rewrite is caught by correct.mjs with verbatim CASE lines', async () => {
    await writeFileAt(tmp, DEDUPE_PATH, BROKEN_FAST_DEDUPE_MJS);
    const result = await verifyPerfBudgetDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['correctness-green']);
    expect(result.failReason).toMatch(/CASE \d+:/);
    expect(result.caseFailures?.length).toBeGreaterThan(0);
    expect(result.caseFailures?.[0]).toMatch(/^CASE \d+:/);
    await writeFileAt(tmp, DEDUPE_PATH, DEDUPE_SEED_MJS);
  }, 60_000);

  it('names the wrapper-return mistake when dedupeItems returns an object instead of the array', async () => {
    await writeFileAt(tmp, DEDUPE_PATH, WRAPPER_RETURN_DEDUPE_MJS);
    const result = await verifyPerfBudgetDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['correctness-green']);
    // The actionable diagnosis leads, naming the actual wrapper key the
    // model emitted, and the verbatim CASE lines still follow.
    expect(result.failReason).toContain('returning an OBJECT, not the array');
    expect(result.failReason).toContain('"deduplicatedItems"');
    expect(result.failReason).toMatch(/failing cases: .*CASE \d+:/);
    await writeFileAt(tmp, DEDUPE_PATH, DEDUPE_SEED_MJS);
  }, 60_000);

  it('tampering with bench.mjs fails the byte-identical guard without running anything', async () => {
    await writeFileAt(tmp, BENCH_PATH, BENCH_MJS.replace('Math.round(t1 - t0)', '0'));
    const result = await verifyPerfBudgetDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['bench-untouched']);
    expect(result.failReason).toContain(BENCH_PATH);
    await writeFileAt(tmp, BENCH_PATH, BENCH_MJS);
  });

  it('shrinking data/items.json fails the data guard (the obvious bench cheat)', async () => {
    await writeFileAt(tmp, ITEMS_PATH, '[]');
    const result = await verifyPerfBudgetDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['data-untouched']);
    expect(result.failReason).toContain(ITEMS_PATH);
    await writeFileAt(tmp, ITEMS_PATH, generateItemsJson());
  });

  it('deleting correct.mjs fails its guard', async () => {
    await rm(join(tmp, CORRECT_PATH));
    const result = await verifyPerfBudgetDir(tmp);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['correct-untouched']);
    await writeFileAt(tmp, CORRECT_PATH, CORRECT_MJS);
  });
});

describe('perf-budget — fixture determinism & prompt evidence', () => {
  it('the LCG fixture is deterministic and matches the hardcoded result count', () => {
    const items = JSON.parse(generateItemsJson()) as Array<{ id: string; tags: string[] }>;
    expect(new Set(items.map((i) => i.id)).size).toBe(EXPECTED_RESULT_COUNT);
    // Regenerating yields byte-identical JSON (no Math.random anywhere).
    expect(generateItemsJson()).toBe(generateItemsJson());
  });

  // The de-facto prompt for seeded scenarios is the kickoff + mission
  // text. Every gated requirement is stated there.
  const evidence =
    `${PERF_BUDGET_KICKOFF_MESSAGE}\n${PERF_BUDGET_MISSION_OBJECTIVES}`.toLowerCase();

  it.each([
    ['bench-under-budget', new RegExp(`elapsed_ms of at most ${BUDGET_MS}`)],
    ['correctness-green', /correct\.mjs.*must stay green \(exit 0/],
    [
      'bench-untouched / correct-untouched / data-untouched',
      /do not modify bench\.mjs, correct\.mjs, or data\/items\.json/,
    ],
    ['export signature', /export function dedupeitems\(items\)/],
  ])('required gate "%s" is stated in the kickoff/mission text', (_name, pattern) => {
    expect(pattern.test(evidence)).toBe(true);
  });
});

describe('perf-budget — wrapperReturnHint detector', () => {
  it('detects a wrapper return and names the offending key', () => {
    const cases = [
      'CASE 1: empty input returns an empty array — dedupeItems([]): expected [], got {"deduplicatedItems":[],"unionTags":{}}',
      'CASE 2: a single item passes through unchanged — result: expected [{"id":"a","tags":["x","y"]}], got {"deduplicatedItems":[{"id":"a","tags":["x","y"]}],"unionTags":{}}',
      'CASE 8: result entries are plain { id, tags } objects — Cannot convert undefined or null to object',
    ];
    const hint = wrapperReturnHint(cases);
    expect(hint).not.toBeNull();
    expect(hint).toContain('returning an OBJECT, not the array');
    expect(hint).toContain('"deduplicatedItems"');
  });

  it('handles an alternate wrapper key (tagUnion)', () => {
    const hint = wrapperReturnHint([
      'CASE 3: distinct ids stay separate — result: expected [{"id":"b","tags":["x"]}], got {"deduplicatedItems":[{"id":"b","tags":["x"]}],"tagUnion":{}}',
    ]);
    expect(hint).toContain('"deduplicatedItems"');
  });

  it('returns null for a bare-array-but-wrong-contents failure (no false wrapper hint)', () => {
    const cases = [
      'CASE 4: same id merges tags as a union — result: expected [{"id":"a","tags":["x","y","z"]}], got [{"id":"a","tags":["x","y"]}]',
      'CASE 6: merged ids keep first-seen position — result: expected [{"id":"a","tags":["1","3"]}], got [{"id":"a","tags":["1"]}]',
    ];
    expect(wrapperReturnHint(cases)).toBeNull();
  });

  it('returns null when there are no parseable expected/got case lines', () => {
    expect(wrapperReturnHint([])).toBeNull();
    expect(
      wrapperReturnHint([
        'CASE 8: result entries are plain { id, tags } — Cannot convert undefined',
      ]),
    ).toBeNull();
  });
});
