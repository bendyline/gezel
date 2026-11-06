import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  type CraftbookContract,
  type Task,
  compareSemver,
  interpolateContextDeep,
  taskInterpolationContext,
} from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { repoRoot } from '../native-bin.ts';
import { type ContractGrade, gradeContract } from '../strategy/contract-grade.ts';
import { assertKnownFlags, parseArgs } from './args.ts';

/**
 * Grade saved craftbook trials against drafted contracts, over the files each
 * trial left, and report where the drafted gate disagrees with a reference.
 * No engine runs: this checks a contract sweep against real deliverables
 * before any of it ships.
 *
 *   pnpm exec tsx evals/src/bin/contract-replay.ts \
 *     --runs-dir evals/runs/strategy-r2-2026-11-01,evals/runs/strategy-full-2026-10-25 \
 *     --drafts evals/runs/contract-drafts-2026-11-05/blind \
 *     --out evals/runs/contract-drafts-2026-11-05/replay.json
 *
 * A book whose latest version in the gilde data directory `--reference`
 * carries a contract is compared gate against gate (default: the gilde
 * the evals resolve; pass `../gilde/data` for unreleased edits). A book without
 * one is compared with the trial's own eval verdict, and only on trials whose
 * recorded steps name every drafted deliverable, since an older version of the
 * book may have written elsewhere. Contracts are interpolated per trial from
 * the task's own parameters, as the runtime does at launch.
 *
 * Trials were shaped by the contract they ran with, so a drafted criterion the
 * run never saw can fail work nobody asked for. The `harness` arm, which hid
 * every contract, and trials that ran with none are the unbiased slices.
 */

interface ContractFile {
  id: string;
  contract: CraftbookContract;
}

interface Verdict {
  gatePassed: boolean;
  score: number;
  failed: string[];
  /** The first failure message of each failed gate criterion. */
  why: Record<string, string>;
}

interface ReplayRow {
  trial: string;
  model: string;
  arm: string;
  book: string;
  judge: number | null;
  /** The trial's own eval verdict. */
  evalPassed: boolean | null;
  status: string;
  /** The reviewed contract, interpolated now, equals the snapshot the task ran with. */
  referenceMatchesRun: boolean;
  reference: Verdict | null;
  draft: Verdict;
}

const GOOD_WORK = 7;

async function readContracts(dir: string): Promise<Map<string, CraftbookContract>> {
  const out = new Map<string, CraftbookContract>();
  for (const name of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
    const file = JSON.parse(await readFile(join(dir, name), 'utf8')) as ContractFile;
    out.set(file.id, file.contract);
  }
  return out;
}

/** The contract each book's latest released version carries, from a gilde data directory. */
async function readCatalogContracts(dataDir: string): Promise<Map<string, CraftbookContract>> {
  const out = new Map<string, CraftbookContract>();
  const root = join(dataDir, 'craftbook-templates');
  for (const shard of await readdir(root).catch(() => [])) {
    for (const id of await readdir(join(root, shard)).catch(() => [])) {
      const manifest = await readJson<{ yankedVersions?: string[] }>(
        join(root, shard, id, 'manifest.json'),
      );
      if (!manifest) continue;
      const yanked = new Set(manifest.yankedVersions ?? []);
      const versions = (await readdir(join(root, shard, id, 'versions')).catch(() => []))
        .filter((v) => !yanked.has(v) && /^\d+\.\d+\.\d+$/.test(v))
        .sort(compareSemver);
      const latest = versions.at(-1);
      if (!latest) continue;
      const book = await readJson<{ contract?: CraftbookContract }>(
        join(root, shard, id, 'versions', latest, 'craftbook.json'),
      );
      if (book?.contract) out.set(id, book.contract);
    }
  }
  return out;
}

/** Trial directories under a run root: …/craftbook-<book>/<trial>/{state,result}.json. */
async function findTrials(root: string, depth = 0): Promise<string[]> {
  if (depth > 7) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (
    entries.some((e) => e.name === 'state.json') &&
    entries.some((e) => e.name === 'result.json')
  ) {
    return [root];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      ['workspace', 'artifacts', 'sessions', 'recording'].includes(entry.name)
    ) {
      continue;
    }
    out.push(...(await findTrials(join(root, entry.name), depth + 1)));
  }
  return out;
}

/** Key order differs between a parsed snapshot and the file; compare content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function judgeMean(trialDir: string): Promise<number | null> {
  const judge = await readJson<{ mean?: number; promptVersion?: number }>(
    join(trialDir, 'judge.json'),
  );
  return judge?.promptVersion === 2 && typeof judge.mean === 'number' ? judge.mean : null;
}

/** Every drafted deliverable is a file this run's steps name, so the run wrote where the draft looks. */
function sameLayout(contract: CraftbookContract, task: Task): boolean {
  const steps = JSON.stringify(task.craftbook.steps);
  return contract.deliverables.every((d) => {
    const name = d.path.split('/').filter(Boolean).at(-1);
    return !name || d.path === './' || steps.includes(name);
  });
}

const verdict = (grade: ContractGrade): Verdict => {
  const failed = grade.criteria.filter((c) => c.enforce === 'gate' && c.pass === false);
  return {
    gatePassed: grade.gatePassed,
    score: grade.score,
    failed: failed.map((c) => c.id),
    why: Object.fromEntries(failed.map((c) => [c.id, (c.failures[0] ?? '').slice(0, 240)])),
  };
};

function mean(values: number[]): string {
  return values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : '-';
}

const judged = (rows: ReplayRow[]) =>
  mean(rows.flatMap((r) => (r.judge === null ? [] : [r.judge])));

function compareTable(
  rows: ReplayRow[],
  label: string,
  other: string,
  passes: (r: ReplayRow) => boolean,
): string[] {
  const lines = [
    `## ${label} (${rows.length} trials)`,
    '',
    `| Book | Trials | ${other} passes | Drafted gate passes | Both | ${other} only (judge) | Drafted only (judge) |`,
    '|---|---|---|---|---|---|---|',
  ];
  const books = [...new Set(rows.map((r) => r.book))].sort();
  for (const book of [...books, '**all**']) {
    const rs = book === '**all**' ? rows : rows.filter((r) => r.book === book);
    const otherOnly = rs.filter((r) => passes(r) && !r.draft.gatePassed);
    const draftOnly = rs.filter((r) => !passes(r) && r.draft.gatePassed);
    lines.push(
      `| ${book} | ${rs.length} | ${rs.filter(passes).length} | ${rs.filter((r) => r.draft.gatePassed).length} | ${rs.filter((r) => passes(r) && r.draft.gatePassed).length} | ${otherOnly.length} (${judged(otherOnly)}) | ${draftOnly.length} (${judged(draftOnly)}) |`,
    );
  }
  return lines;
}

/** Drafted gate criteria that fail work the reference passed, with the judge's view of that work. */
function blockers(rows: ReplayRow[], passes: (r: ReplayRow) => boolean): string[] {
  const tally = new Map<string, ReplayRow[]>();
  for (const r of rows.filter(passes)) {
    for (const id of r.draft.failed) {
      const key = `${r.book} / ${id}`;
      tally.set(key, [...(tally.get(key) ?? []), r]);
    }
  }
  return [...tally]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, rs]) => {
      const good = rs.filter((r) => r.judge !== null && r.judge >= GOOD_WORK).length;
      const id = key.split(' / ')[1]!;
      const example = rs[0]!.draft.why[id];
      return `- ${key}: fails ${rs.length} passing trials (judge ${judged(rs)}; ${good} judged ${GOOD_WORK}+)${example ? `\n  - e.g. ${example}` : ''}`;
    });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, ['runs-dir', 'drafts', 'reference', 'books', 'out']);
  const abs = (p: string) => (isAbsolute(p) ? p : join(repoRoot(), p));
  const roots = String(args.flags['runs-dir'] ?? '')
    .split(',')
    .filter(Boolean)
    .map(abs);
  if (!roots.length || !args.flags.drafts) throw new Error('--runs-dir and --drafts are required');
  const drafts = await readContracts(abs(String(args.flags.drafts)));
  const reference = await readCatalogContracts(
    args.flags.reference ? abs(String(args.flags.reference)) : gildeDataDir(),
  );
  const onlyBooks = args.flags.books ? new Set(String(args.flags.books).split(',')) : null;

  const rows: ReplayRow[] = [];
  let otherLayout = 0;
  for (const root of roots) {
    for (const trialDir of await findTrials(root)) {
      const scenario = basename(dirname(trialDir));
      if (!scenario.startsWith('craftbook-')) continue;
      const book = scenario.slice('craftbook-'.length);
      const draft = drafts.get(book);
      if (!draft || (onlyBooks && !onlyBooks.has(book))) continue;
      const ref = reference.get(book);
      let ranWith: CraftbookContract | undefined;
      let refNow: CraftbookContract | undefined;
      let layoutMatches = true;
      const draftGrade = await gradeContract(trialDir, book, {
        contract: (task) => {
          ranWith = task.craftbook.contract;
          const interpolated = interpolateContextDeep(draft, taskInterpolationContext(task));
          layoutMatches = ref !== undefined || sameLayout(interpolated, task);
          return interpolated;
        },
      });
      if (!draftGrade) continue;
      if (!layoutMatches) {
        otherLayout += 1;
        continue;
      }
      const refGrade = ref
        ? await gradeContract(trialDir, book, {
            contract: (task) => {
              refNow = interpolateContextDeep(ref, taskInterpolationContext(task));
              return refNow;
            },
          })
        : null;
      const result = await readJson<{ success?: boolean }>(join(trialDir, 'result.json'));
      rows.push({
        trial: trialDir,
        model: basename(dirname(dirname(dirname(trialDir)))),
        arm: basename(dirname(dirname(trialDir))),
        book,
        judge: await judgeMean(trialDir),
        evalPassed: typeof result?.success === 'boolean' ? result.success : null,
        status: draftGrade.status,
        referenceMatchesRun: refNow !== undefined && canonical(refNow) === canonical(ranWith),
        reference: refGrade ? verdict(refGrade) : null,
        draft: verdict(draftGrade),
      });
    }
  }

  const reviewed = rows.filter((r) => r.reference !== null);
  const heldOut = rows.filter((r) => r.reference === null && r.evalPassed !== null);
  const refPasses = (r: ReplayRow) => r.reference?.gatePassed === true;
  const evalPasses = (r: ReplayRow) => r.evalPassed === true;
  const sections: string[] = ['# Drafted contracts on saved trials', ''];
  if (reviewed.length) {
    sections.push(
      `Reviewed contract equals the one the trial ran with: ${reviewed.filter((r) => r.referenceMatchesRun).length} of ${reviewed.length}.`,
      '',
      ...compareTable(reviewed, 'Against the reviewed contract, all trials', 'Reviewed', refPasses),
      '',
      ...compareTable(
        reviewed.filter((r) => r.arm === 'harness'),
        'Against the reviewed contract, harness arm (no contract shown or checked)',
        'Reviewed',
        refPasses,
      ),
      '',
      '### Drafted gate criteria that fail work the reviewed gate passes',
      ...blockers(reviewed, refPasses),
      '',
    );
  }
  if (heldOut.length) {
    sections.push(
      `Books without a reviewed contract: ${heldOut.length} trials; ${otherLayout} more skipped because their book version wrote elsewhere.`,
      '',
      ...compareTable(heldOut, "Against the trial's own eval verdict", 'Eval', evalPasses),
      '',
      '### Drafted gate criteria that fail trials the eval passed',
      ...blockers(heldOut, evalPasses),
      '',
    );
  }
  const report = sections.join('\n');
  console.log(report);
  if (args.flags.out) {
    const out = abs(String(args.flags.out));
    await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`);
    await writeFile(out.replace(/\.json$/, '.md'), `${report}\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
