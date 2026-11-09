import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { falsifiedFigure } from './judge-validity.ts';
import {
  type JudgeAxis,
  drawerPath,
  filesUnder,
  readContractTask,
  seedFiles,
  trialRoots,
} from './judge.ts';

/**
 * Planted defects for folder deliverables, which judge v3 is the first to
 * read: the code books' `./` and invoice-run's `invoices`. The text defects
 * in judge-validity.ts damage prose in memory; these damage a copy of the
 * trial on disk, because a folder bundle is built from files and a code
 * defect is only real when the project's own tests say so.
 */

export const FOLDER_DEFECT_KINDS = [
  'behavior-broken',
  'change-undone',
  'tests-removed',
  'invoice-dropped',
  'invoice-amount',
] as const;
export type FolderDefectKind = (typeof FOLDER_DEFECT_KINDS)[number];

export const FOLDER_DEFECT_AXIS: Record<FolderDefectKind, JudgeAxis> = {
  // The judge prompt's craft axis: "code or data must be correct".
  'behavior-broken': 'craft',
  'change-undone': 'completeness',
  'tests-removed': 'completeness',
  'invoice-dropped': 'completeness',
  'invoice-amount': 'grounding',
};

const isTestPath = (path: string) => /(^|\/)(tests?|__tests__)\/|\.test\.[cm]?[jt]s$/.test(path);
const isSourcePath = (path: string) => /\.[cm]?[jt]s$/.test(path) && !isTestPath(path);

/** One-token mutations, each a plausible slip that changes behavior. */
const MUTATIONS: ReadonlyArray<[RegExp, string]> = [
  [/===/g, '!=='],
  [/!==/g, '==='],
  [/<=/g, '<'],
  [/>=/g, '>'],
  [/(?<![<=!>-])<(?![=<])/g, '<='],
  [/(?<![=>-])>(?![=>])/g, '>='],
  [/&&/g, '||'],
  [/\|\|/g, '&&'],
  [/toUpperCase/g, 'toLowerCase'],
  [/toLowerCase/g, 'toUpperCase'],
  [/\btrue\b/g, 'false'],
  [/\bfalse\b/g, 'true'],
  [/ \+ /g, ' - '],
  [/ - /g, ' + '],
  [/ \* /g, ' / '],
  [/(?<![\w.])(\d+)(?![\w.])/g, '$1+1'],
];

/**
 * Every single-token mutant of `text` on the lines `changed` marks, in a
 * stable order. Comments and imports are skipped: a broken import fails to
 * load, which is a crash, not a defect the judge must reason about.
 */
export function* mutants(text: string, changed: ReadonlySet<number>): Generator<string> {
  const lines = text.split('\n');
  for (const index of [...changed].sort((a, b) => a - b)) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed || /^(\/\/|\*|\/\*|import\b|export\s+\{)/.test(trimmed)) continue;
    for (const [pattern, replacement] of MUTATIONS) {
      for (const match of line.matchAll(pattern)) {
        const at = match.index!;
        const mutated =
          line.slice(0, at) +
          match[0].replace(new RegExp(pattern.source), replacement) +
          line.slice(at + match[0].length);
        if (mutated === line) continue;
        const next = [...lines];
        next[index] = mutated;
        yield next.join('\n');
      }
    }
  }
}

/** Line indexes of `text` that do not appear in the seed: every line of an added file. */
export function changedLines(text: string, seed: string | undefined): Set<number> {
  const original = new Set((seed ?? '').split('\n').map((l) => l.trim()));
  const out = new Set<number>();
  text.split('\n').forEach((line, i) => {
    if (seed === undefined || !original.has(line.trim())) out.add(i);
  });
  return out;
}

/** Whether the project's tests pass, run the way the code books declare them. */
export function testsPass(projectDir: string, timeoutMs = 120_000): boolean {
  const result = spawnSync(process.execPath, ['--test'], {
    cwd: projectDir,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: projectDir, NODE_ENV: 'test' },
  });
  return result.status === 0;
}

export interface TrialCopy {
  dir: string;
  task: Task;
  /** The folder deliverable's directory inside the copy, and whether it is in the drawer. */
  folder: { dir: string; artifact: boolean; path: string };
  projectDir: string;
  seed: ReadonlyMap<string, string>;
}

/** Copy what a judge bundle reads (state and the task's project trees) into `dest`. */
export async function copyTrial(
  trialDir: string,
  craftbookId: string,
  dest: string,
): Promise<TrialCopy | null> {
  const task = await readContractTask(trialDir, craftbookId);
  const contract = task?.craftbook.contract;
  if (!task || !contract) return null;
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(join(trialDir, 'state.json'), join(dest, 'state.json'));
  for (const tree of ['workspace', 'artifacts']) {
    await cp(join(trialDir, tree, task.projectId), join(dest, tree, task.projectId), {
      recursive: true,
    }).catch(() => undefined);
  }
  const roots = trialRoots(dest, task);
  for (const d of contract.deliverables) {
    if (d.textSource) continue;
    const found = await roots.folder(d.path, d.artifact);
    if (!found) continue;
    const seed = new Map(
      seedFiles(task)
        .filter((f) => f.artifact === found.artifact)
        .map((f) => [f.path, f.content]),
    );
    return {
      dir: dest,
      task,
      folder: { ...found, path: d.path },
      projectDir: roots.workspace,
      seed,
    };
  }
  return null;
}

export interface PlantedFolderDefect {
  kind: FolderDefectKind;
  /** What was changed, for the report. */
  note: string;
  /** For code: whether the project's tests passed before and after the damage. */
  testsBefore?: boolean;
  testsAfter?: boolean;
}

function keyFor(copy: TrialCopy, rel: string): string {
  const prefix = drawerPath(copy.folder.path);
  return prefix === '.' ? rel : `${prefix}/${rel}`;
}

/**
 * Damage the copy in place, or return null when the defect does not apply.
 * `behavior-broken` keeps only a mutant the project's tests reject, so the
 * defect is a verified behavior change, never a guess.
 */
export async function plantFolderDefect(
  copy: TrialCopy,
  kind: FolderDefectKind,
  opts: { maxMutants?: number } = {},
): Promise<PlantedFolderDefect | null> {
  const files = await filesUnder(copy.folder.dir);
  const read = (rel: string) => readFile(join(copy.folder.dir, rel), 'utf8');
  const write = (rel: string, text: string) => writeFile(join(copy.folder.dir, rel), text);
  const delivered = await Promise.all(
    files.map(async (rel) => ({ rel, key: keyFor(copy, rel), text: await read(rel) })),
  );
  const touched = delivered.filter((f) => copy.seed.get(f.key) !== f.text);

  if (kind === 'behavior-broken' || kind === 'change-undone' || kind === 'tests-removed') {
    if (copy.folder.artifact || copy.seed.size === 0) return null;
    const testsBefore = testsPass(copy.projectDir);
    if (kind === 'behavior-broken') {
      if (!testsBefore) return null;
      let tried = 0;
      for (const file of touched.filter((f) => isSourcePath(f.key))) {
        for (const mutant of mutants(file.text, changedLines(file.text, copy.seed.get(file.key)))) {
          if (++tried > (opts.maxMutants ?? 40)) break;
          await write(file.rel, mutant);
          if (!testsPass(copy.projectDir)) {
            const line = mutant.split('\n').find((l, i) => l !== file.text.split('\n')[i]);
            return {
              kind,
              note: `${file.key}: ${line?.trim()}`,
              testsBefore,
              testsAfter: false,
            };
          }
          await write(file.rel, file.text);
        }
      }
      return null;
    }
    if (kind === 'change-undone') {
      // The edited source file with the most new lines goes back to its seed.
      const edited = touched
        .filter((f) => isSourcePath(f.key) && copy.seed.has(f.key))
        .sort(
          (a, b) =>
            changedLines(b.text, copy.seed.get(b.key)).size -
            changedLines(a.text, copy.seed.get(a.key)).size,
        )[0];
      if (!edited) return null;
      await write(edited.rel, copy.seed.get(edited.key)!);
      return {
        kind,
        note: `${edited.key} restored to its starting version`,
        testsBefore,
        testsAfter: testsPass(copy.projectDir),
      };
    }
    // tests-removed: only where the deliverable promises tests.
    const kindOf = copy.task.craftbook.contract?.deliverables.find(
      (d) => d.path === copy.folder.path,
    )?.kind;
    if (kindOf !== 'code-with-tests') return null;
    const tests = touched.filter((f) => isTestPath(f.key));
    if (tests.length === 0) return null;
    for (const t of tests) {
      const original = copy.seed.get(t.key);
      if (original === undefined) await rm(join(copy.folder.dir, t.rel));
      else await write(t.rel, original);
    }
    return {
      kind,
      note: `new or changed tests removed: ${tests.map((t) => t.key).join(', ')}`,
      testsBefore,
      testsAfter: testsPass(copy.projectDir),
    };
  }

  const invoices = touched.filter((f) => /\.html?$/i.test(f.key));
  if (invoices.length < 2) return null;
  const target = invoices[invoices.length - 1]!;
  if (kind === 'invoice-dropped') {
    await rm(join(copy.folder.dir, target.rel));
    return { kind, note: `${target.key} deleted` };
  }
  // invoice-amount: every copy of one amount in one invoice, line item and total alike.
  const amount = /\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/.exec(target.text)?.[1];
  if (!amount) return null;
  const wrong = falsifiedFigure(amount);
  await write(target.rel, target.text.split(amount).join(wrong));
  return { kind, note: `${target.key}: ${amount} changed to ${wrong}` };
}
