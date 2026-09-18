import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  createFanoutWorker,
  fanoutDiagnostics,
  findFanoutState,
  readWorkspaceText,
  reviewHostSessions,
} from './fanout-shared.ts';

/**
 * Hermetic declarative fanout, execution-only flavour with an arithmetic
 * oracle: four seeded CSV shards, one child per shard writing
 * `results/<n>.json`, a host that merges them into `tally.json`. Nothing is
 * authored and nothing is judged — the numbers either match the seed or they
 * do not — so this is the member to run at `--count 3` on local models when
 * the question is "did the fanout work", not "was the prose good".
 */

const PROJECT_NAME = 'Fanout Tally Eval';
const HOST_TITLE = 'Tally four CSV shards through a fanout';
const WORKER_NAME = 'Fanout Tally Clerk';

interface ShardRow {
  item: string;
  qty: number;
  unitPrice: number;
}

export const FANOUT_TALLY_SHARDS: ReadonlyArray<{ shard: number; rows: ShardRow[] }> = [
  {
    shard: 1,
    rows: [
      { item: 'bolts', qty: 12, unitPrice: 3 },
      { item: 'washers', qty: 40, unitPrice: 1 },
      { item: 'brackets', qty: 5, unitPrice: 9 },
    ],
  },
  {
    shard: 2,
    rows: [
      { item: 'hinges', qty: 8, unitPrice: 7 },
      { item: 'screws', qty: 100, unitPrice: 1 },
      { item: 'latches', qty: 3, unitPrice: 15 },
    ],
  },
  {
    shard: 3,
    rows: [
      { item: 'planks', qty: 6, unitPrice: 22 },
      { item: 'dowels', qty: 30, unitPrice: 2 },
      { item: 'glue', qty: 2, unitPrice: 11 },
    ],
  },
  {
    shard: 4,
    rows: [
      { item: 'sandpaper', qty: 10, unitPrice: 4 },
      { item: 'varnish', qty: 1, unitPrice: 35 },
      { item: 'brushes', qty: 4, unitPrice: 6 },
    ],
  },
];

export function shardCsv(rows: ShardRow[]): string {
  return ['item,qty,unit_price', ...rows.map((r) => `${r.item},${r.qty},${r.unitPrice}`)].join(
    '\n',
  );
}

export function shardTotal(rows: ShardRow[]): number {
  return rows.reduce((sum, r) => sum + r.qty * r.unitPrice, 0);
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function setup(ctx: EvalContext): Promise<void> {
  const project = await ctx.client.createProject({
    name: PROJECT_NAME,
    about:
      'A hermetic fanout exercise with an arithmetic oracle: one child task per CSV shard computes a subtotal, the host merges the subtotals.',
    missionObjectives:
      'Each child writes results/<shard>.json from its own CSV; the host writes tally.json from the four results files only.',
  });
  for (const { shard, rows } of FANOUT_TALLY_SHARDS) {
    await ctx.client.writeProjectWorkspaceFile(project.id, {
      path: `shards/${shard}.csv`,
      content: `${shardCsv(rows)}\n`,
    });
  }
  const workerId = await createFanoutWorker(ctx, project.id, {
    name: WORKER_NAME,
    role: 'Researcher',
    description: 'Reads small data files, computes exact totals, and writes JSON results.',
    about:
      'You are careful with numbers. Read the file you are given, compute exactly what the step asks, write exactly the file it names, then advance the step.',
  });
  const task = await ctx.client.createTask(project.id, {
    title: HOST_TITLE,
    description:
      'Fan out one child task per CSV shard; each child writes results/<shard>.json. When every child has finished, merge the four results into tally.json.',
    assignee: { kind: 'gezel', gezelId: workerId },
    steps: [
      {
        id: 'merge',
        name: 'Merge the tally',
        description: 'Runs after every shard child has finished.',
        prompt:
          'Four child tasks each wrote `results/<n>.json` of the shape {"shard": <n>, "rows": <rows>, "total": <total>}. Call `list_dir` on `results/`, read every file with `read_file`, then call `write_file` to write `tally.json` containing exactly {"shards": 4, "rows": <sum of the four rows values>, "total": <sum of the four total values>} as integers. Do not recompute anything from the CSV files. Then call `advance_task_step`.',
        terminal: true,
      },
    ],
    entryStepId: 'merge',
    spawnsSteps: [
      {
        id: 'sum',
        name: 'Sum shard {{shard}}',
        description: 'One CSV shard, one JSON result.',
        prompt:
          'Call `read_file` on `shards/{{shard}}.csv`. It has a header row (item,qty,unit_price) followed by data rows. Compute rows (the number of data rows) and total (the sum over data rows of qty multiplied by unit_price; all values are integers). Call `write_file` to write `results/{{shard}}.json` containing exactly {"shard": {{shard}}, "rows": <rows>, "total": <total>}. Then call `advance_task_step` to finish this task.',
        terminal: true,
      },
    ],
    fanout: {
      count: FANOUT_TALLY_SHARDS.length,
      variations: FANOUT_TALLY_SHARDS.map((s) => ({
        title: `Sum shard ${s.shard}`,
        context: { shard: String(s.shard) },
      })),
    },
  });
  ctx.log(
    `[fanout-tally] created fanout host ${task.ref} with ${FANOUT_TALLY_SHARDS.length} children for worker ${workerId}`,
  );
}

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const state = await findFanoutState(ctx.client, PROJECT_NAME, HOST_TITLE);
  if (!state) return { done: false };
  const { project, host, children } = state;

  const expectedRows = FANOUT_TALLY_SHARDS.reduce((n, s) => n + s.rows.length, 0);
  const expectedTotal = FANOUT_TALLY_SHARDS.reduce((n, s) => n + shardTotal(s.rows), 0);
  const results = new Map<number, { rows: number | null; total: number | null } | null>();
  for (const { shard } of FANOUT_TALLY_SHARDS) {
    const text = await readWorkspaceText(ctx.client, project.id, `results/${shard}.json`);
    if (!text) {
      results.set(shard, null);
      continue;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      results.set(shard, { rows: readNumber(parsed.rows), total: readNumber(parsed.total) });
    } catch {
      results.set(shard, { rows: null, total: null });
    }
  }
  const correctResults = FANOUT_TALLY_SHARDS.filter((s) => {
    const r = results.get(s.shard);
    return r?.rows === s.rows.length && r?.total === shardTotal(s.rows);
  }).length;
  const tallyText = await readWorkspaceText(ctx.client, project.id, 'tally.json');
  const completedChildren = children.filter((c) => c.status === 'complete').length;
  const hostDone = host.status === 'complete';

  ctx.recordSniff?.({
    key: 'fanout-tally',
    score: correctResults + (tallyText ? 1 : 0),
    bytes: tallyText?.length ?? 0,
    milestones: completedChildren + correctResults + (hostDone ? 1 : 0),
    deliverableMissing: !tallyText,
    ...(correctResults < FANOUT_TALLY_SHARDS.length
      ? { failReason: `${correctResults}/${FANOUT_TALLY_SHARDS.length} shard results correct` }
      : {}),
  });
  ctx.logChanged(
    'fanout-tally',
    `[fanout-tally] host=${host.status}:${host.activeStepId ?? '-'} children=${completedChildren}/${children.length} results=${correctResults}/${FANOUT_TALLY_SHARDS.length} tally=${tallyText?.length ?? 0}B checks=${correctResults + (tallyText ? 1 : 0)}/${FANOUT_TALLY_SHARDS.length + 1}`,
  );

  if (host.status === 'paused' || host.status === 'canceled') {
    return {
      done: true,
      success: false,
      reason: `fanout host ${host.ref} is ${host.status} with ${completedChildren}/${children.length} children complete`,
    };
  }
  if (!hostDone) return { done: false };

  const failures: string[] = [];
  if (children.length !== FANOUT_TALLY_SHARDS.length) {
    failures.push(`fanout created ${children.length}/${FANOUT_TALLY_SHARDS.length} children`);
  }
  const unfinished = children.filter((c) => c.status !== 'complete');
  if (unfinished.length > 0) failures.push(`${unfinished.length} child task(s) did not complete`);
  for (const s of FANOUT_TALLY_SHARDS) {
    const r = results.get(s.shard);
    if (!r) failures.push(`results/${s.shard}.json is missing or not JSON`);
    else if (r.rows !== s.rows.length || r.total !== shardTotal(s.rows)) {
      failures.push(
        `results/${s.shard}.json says rows=${r.rows} total=${r.total}, expected rows=${s.rows.length} total=${shardTotal(s.rows)}`,
      );
    }
  }
  if (!tallyText) failures.push('tally.json is missing');
  else {
    try {
      const tally = JSON.parse(tallyText) as Record<string, unknown>;
      if (readNumber(tally.shards) !== FANOUT_TALLY_SHARDS.length)
        failures.push(
          `tally.json shards=${String(tally.shards)}, expected ${FANOUT_TALLY_SHARDS.length}`,
        );
      if (readNumber(tally.rows) !== expectedRows)
        failures.push(`tally.json rows=${String(tally.rows)}, expected ${expectedRows}`);
      if (readNumber(tally.total) !== expectedTotal)
        failures.push(`tally.json total=${String(tally.total)}, expected ${expectedTotal}`);
    } catch {
      failures.push('tally.json is not valid JSON');
    }
  }

  const { entries } = await ctx.client.listHistory({
    projectId: project.id,
    kind: 'tool.called',
    limit: 2_000,
  });
  for (const child of children) {
    const wrote = entries.some(
      (entry) =>
        entry.entryType === 'event' &&
        entry.details?.taskRef === child.ref &&
        entry.details?.success === true &&
        entry.details?.name === 'write_file',
    );
    if (!wrote) failures.push(`${child.ref} has no successful write_file receipt`);
  }
  const review = await reviewHostSessions(ctx.client, project.id, host.ref, 'results/');
  if (review.hostWrotePaths.length > 0) {
    failures.push(
      `the host wrote ${review.hostWrotePaths.length} shard result(s) itself: ${[...new Set(review.hostWrotePaths)].join(', ')}`,
    );
  }
  const diagnostics = fanoutDiagnostics(host, children, review);
  const fanout = diagnostics.fanout as { barrierHeld: boolean | null };
  if (fanout.barrierHeld === false) {
    failures.push('the host was active before its last child settled (fanout barrier not held)');
  }

  if (failures.length > 0) {
    return { done: true, success: false, reason: failures.join('; '), diagnostics };
  }
  return {
    done: true,
    success: true,
    reason: `${children.length} shard children wrote correct results; host merged tally.json (${expectedRows} rows, total ${expectedTotal}) after the barrier released`,
    diagnostics,
  };
}

export const fanoutTallyScenario: EvalScenario = {
  id: 'fanout-tally',
  description:
    'Hermetic declarative fanout, execution-only: four seeded CSV shards, one child per shard writing a JSON subtotal, a host merging them into tally.json. Arithmetic oracle; grades fanout mechanics and exact numbers.',
  prompt:
    'Tally four CSV shards by fanning out one child task per shard to compute its subtotal, then merge the four subtotals into tally.json once every child is finished.',
  skipInitialPrompt: true,
  setup,
  successCheck,
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  suggestedTrials: 1,
  repairPolicy: 'runtime',
};
