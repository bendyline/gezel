/**
 * Model-based checks of the sync engine and writer: a seeded sequence of
 * source changes, faults and sync passes is run through the REAL
 * `syncWithAdapter` and writer into a temp corpus, and the corpus is compared
 * with what the source holds. A failing sequence is shrunk by replaying it
 * with steps removed, and reported with its seed and the shortest sequence
 * that still fails, so it can be kept as a regression.
 */

import { syncWithAdapter } from '../../manager.js';
import { scopeDirName } from '../../scoped-cursor.js';
import { assertCorpusInvariants, createConnectorTestEnv, readCorpus } from '../harness.js';
import { type Rng, createRng } from './prng.js';
import { ModelAdapter, type ModelProfile, SourceModel } from './source-model.js';

export type ModelOp =
  | { op: 'add'; scope: number; dir: number; n: number }
  | { op: 'edit'; pick: number }
  | { op: 'delete'; pick: number }
  | { op: 'move'; pick: number; dir: number }
  | { op: 'expire' }
  | { op: 'throttle' }
  | { op: 'transient'; pick: number; times: number }
  | { op: 'sync' };

export interface RunProfile extends ModelProfile {
  /** Cursors expire (Gmail 404, Graph 410) during the sequence. */
  expire: boolean;
}

const DIRS = ['', 'north', 'south'];
const CORPUS = 'data/model';
const LIMIT = 3;

export function generateOps(rng: Rng, profile: RunProfile, count: number): ModelOp[] {
  const ops: ModelOp[] = [{ op: 'add', scope: 0, dir: 0, n: rng.int(1, 5) }];
  for (let i = 1; i < count; i++) {
    const roll = rng.next();
    if (roll < 0.25)
      ops.push({ op: 'add', scope: rng.int(0, 1), dir: rng.int(0, 2), n: rng.int(1, 4) });
    else if (roll < 0.4) ops.push({ op: 'edit', pick: rng.int(0, 99) });
    else if (roll < 0.52) ops.push({ op: 'delete', pick: rng.int(0, 99) });
    else if (roll < 0.6 && profile.moves)
      ops.push({ op: 'move', pick: rng.int(0, 99), dir: rng.int(0, 2) });
    else if (roll < 0.65 && profile.expire) ops.push({ op: 'expire' });
    else if (roll < 0.7) ops.push({ op: 'throttle' });
    else if (roll < 0.75) ops.push({ op: 'transient', pick: rng.int(0, 99), times: rng.int(1, 2) });
    else ops.push({ op: 'sync' });
  }
  return ops;
}

/** Run one sequence; returns the invariant violations (empty when it holds). */
export async function runSequence(profile: RunProfile, ops: readonly ModelOp[]): Promise<string[]> {
  const env = await createConnectorTestEnv();
  const model = new SourceModel();
  const problems: string[] = [];
  let cursor: unknown;
  const pass = async () => {
    let returned = 0;
    const inner = new ModelAdapter(model, profile);
    const adapter = Object.create(inner) as ModelAdapter;
    adapter.listChangesSince = async (scope, c, o) => {
      const batch = await inner.listChangesSince(scope, c, o);
      returned = Math.max(returned, batch.records.length);
      return batch;
    };
    const r = await syncWithAdapter(adapter, {
      storageDir: env.artifactsDir,
      quarantineDir: env.quarantineDir,
      corpusDir: CORPUS,
      backfillLimit: LIMIT,
      allowPrune: profile.tombstones,
      cursor,
      retrySchedule: [1, 1, 1],
    });
    if (returned > LIMIT && !r.truncated?.length) {
      problems.push(`a batch of ${returned} past the ${LIMIT}-record limit was not reported`);
    }
    if (r.error) problems.push(`pass failed: ${r.error}`);
    cursor = r.cursor;
    return r;
  };
  const target = (pick: number) => {
    const live = model.live().sort((a, b) => a.id.localeCompare(b.id));
    return live.length ? live[pick % live.length]!.id : undefined;
  };
  try {
    for (const op of ops) {
      switch (op.op) {
        case 'add':
          for (let i = 0; i < op.n; i++) model.add(model.scopes[op.scope]!, DIRS[op.dir]!);
          break;
        case 'edit': {
          const id = target(op.pick);
          if (id) model.edit(id);
          break;
        }
        case 'delete': {
          const id = target(op.pick);
          if (id) model.delete(id);
          break;
        }
        case 'move': {
          const id = target(op.pick);
          if (id) model.move(id, DIRS[op.dir]!);
          break;
        }
        case 'expire':
          model.epoch++;
          break;
        case 'throttle':
          model.faults.throttleNextList++;
          break;
        case 'transient': {
          const id = target(op.pick);
          if (id) model.faults.transient.set(id, op.times);
          break;
        }
        case 'sync':
          await pass();
          break;
      }
    }

    // Settle: pass until two quiet passes in a row.
    let quiet = 0;
    for (let i = 0; i < 40 && quiet < 2; i++) {
      const r = await pass();
      quiet = r.written + r.pruned === 0 && !r.rateLimited && r.errors === 0 ? quiet + 1 : 0;
    }
    if (quiet < 2) problems.push('the corpus never settled');

    try {
      await assertCorpusInvariants(env.artifactsDir, CORPUS);
    } catch (err) {
      problems.push(String(err instanceof Error ? err.message : err));
    }

    // Over-return loses records by design (reported, above); only the shape holds.
    if (!profile.honoursLimit) return problems;

    const corpus = await readCorpus(env.artifactsDir, CORPUS);
    const byScope = new Map<string, Map<string, { path: string; body: string }[]>>();
    for (const rec of corpus) {
      const scopeDir = rec.path.split('/')[0]!;
      const id = rec.frontmatter.title ?? '';
      const ids = byScope.get(scopeDir) ?? new Map();
      byScope.set(scopeDir, ids);
      ids.set(id, [...(ids.get(id) ?? []), { path: rec.path, body: rec.body.trim() }]);
    }
    for (const [scopeDir, ids] of byScope) {
      for (const [id, copies] of ids) {
        if (copies.length > 1)
          problems.push(`${scopeDir}: ${id} is in the corpus ${copies.length} times`);
      }
    }
    for (const r of model.live()) {
      const copies = byScope.get(scopeDirName(r.scope))?.get(r.id) ?? [];
      const want = `${r.id} revision ${r.rev}`;
      const dirPrefix = r.dir ? `${scopeDirName(r.scope)}/${r.dir}/` : `${scopeDirName(r.scope)}/`;
      if (copies.length === 0) problems.push(`${r.id} is missing from the corpus`);
      else if (copies[0]!.body !== want)
        problems.push(`${r.id} is stale: "${copies[0]!.body}", want "${want}"`);
      else if (
        !copies[0]!.path.startsWith(dirPrefix) ||
        (!r.dir && copies[0]!.path.slice(dirPrefix.length).includes('/'))
      ) {
        problems.push(`${r.id} is at ${copies[0]!.path}, not in ${dirPrefix}`);
      }
    }
    if (profile.tombstones) {
      const liveIds = new Set(model.live().map((r) => r.id));
      for (const ids of byScope.values()) {
        for (const id of ids.keys()) {
          if (!liveIds.has(id))
            problems.push(`${id} was deleted upstream but is still in the corpus`);
        }
      }
    }

    const after = await pass();
    if (after.written + after.pruned > 0) problems.push('a pass over a settled source wrote again');
    return problems;
  } finally {
    await env.dispose();
  }
}

/** Remove steps while the sequence still fails, within a replay budget. */
async function shrink(profile: RunProfile, ops: ModelOp[], budget = 80): Promise<ModelOp[]> {
  let current = ops;
  let replays = 0;
  for (let i = 0; i < current.length && replays < budget; ) {
    const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
    replays++;
    if ((await runSequence(profile, candidate)).length > 0) current = candidate;
    else i++;
  }
  return current;
}

/**
 * Run `runs` seeded sequences of a profile. Throws, with the seed and the
 * shrunk sequence, on the first one that breaks an invariant.
 */
export async function checkEngineModel(
  profile: RunProfile,
  opts: { seed: number; runs: number; ops: number },
): Promise<void> {
  for (let run = 0; run < opts.runs; run++) {
    const seed = (opts.seed + run * 0x9e3779b1) >>> 0;
    const ops = generateOps(createRng(seed), profile, opts.ops);
    const problems = await runSequence(profile, ops);
    if (problems.length === 0) continue;
    const shrunk = await shrink(profile, ops);
    const shrunkProblems = await runSequence(profile, shrunk);
    throw new Error(
      [
        `engine model '${profile.name}' failed: ${(shrunkProblems.length ? shrunkProblems : problems).join('; ')}`,
        `  seed 0x${seed.toString(16)} (run ${run + 1} of ${opts.runs}), shrunk ${ops.length} -> ${shrunk.length} steps`,
        `  ${JSON.stringify(shrunk)}`,
        '  keep: save the steps under src/connectors/__fixtures__/model-regressions/',
      ].join('\n'),
    );
  }
}
