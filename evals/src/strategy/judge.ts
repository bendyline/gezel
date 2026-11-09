import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';
import { type CraftbookContract, type Task, criterionEnforce } from '@bendyline/gezel';
import { loadCraftbookTestSpecAtVersionSync } from '../craftbooks/test-spec-loader.ts';
import { contractTask } from './contract-grade.ts';

/**
 * The strategy benchmark's quality judge (P3, docs/evals/strategy-prereg-2026-10-22.md).
 *
 * One pinned model scores a trial's deliverables 0–10 on four axes, three
 * times, from a blinded bundle: the request, the contract's stated bar, the
 * deliverables' text and the sources they were meant to come from. Paths that
 * would reveal the strategy (task folders, step files, verdicts, notes) never
 * reach it. It runs through the Claude CLI, with no tools and from an empty
 * directory, so it judges only what it is shown.
 */

export const JUDGE_MODEL = process.env.GEZEL_STRATEGY_JUDGE_MODEL ?? 'claude-opus-5-5';
/**
 * Bumped whenever the prompt or the bundle changes, so scores from two
 * versions are never mixed. 2: the judge reads formatting as delivered (v1
 * scored a report stripped to one paragraph no lower on craft, 0 of 7
 * planted defects) and is told whether a binary deliverable exists. 3: a
 * folder deliverable (refactor-module's `./`, invoice-run's `invoices`) is
 * shown as the files the work changed or added, beside the seed it started
 * from; v2 read the folder as a file, showed `[missing]`, and scored every
 * code book 0 in every round.
 */
export const JUDGE_PROMPT_VERSION = 3;
/** v3 changed only folder deliverables, so a v2 report stands for a trial without one. */
const FILE_ONLY_COMPATIBLE_VERSION = 2;
export const JUDGE_SAMPLES = 3;
const JUDGE_TIMEOUT_MS = 600_000;
/** Per-file and whole-bundle caps, so a huge deliverable cannot crowd out the sources. */
const MAX_FILE_CHARS = 60_000;
const MAX_BUNDLE_CHARS = 240_000;

export const JUDGE_AXES = ['fitness', 'completeness', 'grounding', 'craft'] as const;
export type JudgeAxis = (typeof JUDGE_AXES)[number];

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    fitness: { type: 'integer', minimum: 0, maximum: 10 },
    completeness: { type: 'integer', minimum: 0, maximum: 10 },
    grounding: { type: 'integer', minimum: 0, maximum: 10 },
    craft: { type: 'integer', minimum: 0, maximum: 10 },
    reasons: { type: 'string' },
  },
  required: ['fitness', 'completeness', 'grounding', 'craft', 'reasons'],
  additionalProperties: false,
} as const;

export interface JudgeSample {
  scores: Record<JudgeAxis, number>;
  reasons: string;
}

export interface JudgeReport {
  model: string;
  samples: JudgeSample[];
  /** Per-axis mean over samples. */
  axes: Record<JudgeAxis, number>;
  /** Mean of the axis means: the P3 score. */
  mean: number;
  /** Standard deviation of the per-sample overall means (test-retest). */
  sd: number;
  errors: string[];
  promptVersion?: number;
}

/**
 * A saved report this version of the judge can use. Pass `folderDeliverable`
 * (from `trialHasFolderDeliverable`) to accept a v2 report whose bundle v3
 * left unchanged; without it only this version counts.
 */
export function isCurrentJudgeReport(
  report: Partial<JudgeReport> | null,
  opts: { folderDeliverable?: boolean } = {},
): report is JudgeReport {
  const version = report?.promptVersion;
  return (
    (version === JUDGE_PROMPT_VERSION ||
      (version === FILE_ONLY_COMPATIBLE_VERSION && opts.folderDeliverable === false)) &&
    Array.isArray(report?.samples) &&
    report.samples.length > 0
  );
}

export interface JudgeBundle {
  request: string;
  goal: string;
  bar: string[];
  deliverables: Array<{ label: string; text: string; kind?: string }>;
  sources: Array<{ label: string; text: string }>;
}

/**
 * Replace the task folder (`tasks/12/`, an eval's `tasks/eval/`), which names
 * the run's mechanics. Nothing else is rewritten: process files never enter
 * the bundle, and renaming file names inside a deliverable corrupted its real
 * citations (`source/pilot-scope.md` read as a missing `pilot-notes.md`).
 */
export function blind(text: string): string {
  return text.replace(/\btasks\/(?:\d+|eval)\//g, 'work/');
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]`
    : text;
}

async function sizeUnder(root: string, file: string): Promise<number | null> {
  const full = resolve(root, file.replace(/^\.?\/+/, ''));
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  try {
    return (await stat(full)).size;
  } catch {
    return null;
  }
}

async function readUnder(root: string, file: string): Promise<string | null> {
  const full = resolve(root, file.replace(/^\.?\/+/, ''));
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  try {
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

async function folderUnder(root: string, file: string): Promise<string | null> {
  const full = resolve(root, file.replace(/^\.?\/+/, ''));
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  try {
    return (await stat(full)).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

/** Installed and generated trees the work did not write. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
const MAX_FOLDER_CHARS = MAX_BUNDLE_CHARS / 2;

/** `./src/`, `src` and `src/` name one folder; the drawer root is `.`. */
export function drawerPath(path: string): string {
  return posix.normalize(path.replace(/^\.?\/+/, '') || '.').replace(/(.)\/+$/, '$1');
}

export async function filesUnder(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) out.push(...(await filesUnder(full, base)));
    } else if (entry.isFile() && !LOCKFILES.has(entry.name)) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.replace(/\n$/, '')}\n${fence}`;
}

/**
 * A folder deliverable as the person finds it: every file the work changed
 * or added, in full, and the untouched ones by name. Code books deliver
 * `./`, edited in place, so the seed shows what changed.
 */
async function folderText(
  folder: { dir: string; artifact: boolean },
  path: string,
  seed: ReadonlyMap<string, string>,
): Promise<string> {
  const prefix = drawerPath(path);
  const shown: string[] = [];
  const unchanged: string[] = [];
  for (const rel of await filesUnder(folder.dir)) {
    // The drawer's task folders are the run's mechanics, which never reach the judge.
    if (folder.artifact && prefix === '.' && rel.startsWith('tasks/')) continue;
    const key = prefix === '.' ? rel : `${prefix}/${rel}`;
    const bytes = await readFile(join(folder.dir, rel));
    if (bytes.includes(0)) {
      shown.push(`#### ${key} (binary, ${bytes.length} bytes)`);
      continue;
    }
    const text = bytes.toString('utf8');
    const original = seed.get(key);
    if (original === text) {
      unchanged.push(key);
      continue;
    }
    const state = seed.size === 0 ? '' : original === undefined ? ' (added)' : ' (changed)';
    shown.push(`#### ${key}${state}\n\n${fenced(clip(text, MAX_FILE_CHARS))}`);
  }
  const lead =
    seed.size === 0
      ? `The folder \`${path}\` as delivered.`
      : `The folder \`${path}\` as delivered: each file the work changed or added, in full. The starting version of a changed file is among the sources.`;
  return clip(
    [
      lead,
      ...(shown.length > 0 ? shown : ['[no files were changed or added]']),
      ...(unchanged.length > 0 ? [`Unchanged: ${unchanged.join(', ')}`] : []),
    ].join('\n\n'),
    MAX_FOLDER_CHARS,
  );
}

/** The files a trial's project was seeded with, from the sidecar of the version it ran. */
export function seedFiles(task: Task): Array<{ path: string; content: string; artifact: boolean }> {
  const spec = task.craftbook.version
    ? loadCraftbookTestSpecAtVersionSync(task.craftbook.id, task.craftbook.version)
    : null;
  return (spec?.setup.files ?? [])
    .filter((f) => f.surface !== 'harness')
    .map((f) => ({
      path: drawerPath(f.path),
      content: f.content,
      artifact: f.surface === 'artifact',
    }));
}

export async function readContractTask(
  trialDir: string,
  craftbookId: string,
): Promise<Task | null> {
  let state: { tasks?: { tasks?: Task[] } | Task[] };
  try {
    state = JSON.parse(await readFile(join(trialDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : (state.tasks?.tasks ?? []);
  const task = contractTask(tasks, craftbookId);
  return task?.craftbook.contract ? task : null;
}

export function trialRoots(trialDir: string, task: Task) {
  const workspace = resolve(trialDir, 'workspace', task.projectId);
  const artifacts = resolve(trialDir, 'artifacts', task.projectId);
  return {
    workspace,
    artifacts,
    /** The folder a deliverable names, on its own drawer first, as `read` looks. */
    folder: async (path: string, artifact: boolean | undefined) => {
      const first = await folderUnder(artifact ? artifacts : workspace, path);
      if (first) return { dir: first, artifact: Boolean(artifact) };
      const second = await folderUnder(artifact ? workspace : artifacts, path);
      return second ? { dir: second, artifact: !artifact } : null;
    },
  };
}

/** Whether a deliverable of this trial's contract is a folder on disk (judge v3 changed only those). */
export async function trialHasFolderDeliverable(
  trialDir: string,
  craftbookId: string,
): Promise<boolean> {
  const task = await readContractTask(trialDir, craftbookId);
  if (!task?.craftbook.contract) return false;
  const roots = trialRoots(trialDir, task);
  for (const d of task.craftbook.contract.deliverables) {
    if (!d.textSource && (await roots.folder(d.path, d.artifact))) return true;
  }
  return false;
}

/**
 * The blinded bundle for one trial: the task's request, the contract's stated
 * bar (eval-only criteria stay hidden, as from the model under test), each
 * deliverable's text (its text source for a binary file), and the sources.
 */
export async function buildJudgeBundle(
  trialDir: string,
  craftbookId: string,
  sourcePaths: readonly string[],
): Promise<JudgeBundle | null> {
  const task = await readContractTask(trialDir, craftbookId);
  if (!task?.craftbook.contract) return null;
  const contract: CraftbookContract = task.craftbook.contract;
  const roots = trialRoots(trialDir, task);
  const { workspace, artifacts } = roots;
  const seed = seedFiles(task);
  let folders = 0;
  const read = async (path: string, artifact: boolean | undefined) =>
    (await readUnder(artifact ? artifacts : workspace, path)) ??
    (await readUnder(artifact ? workspace : artifacts, path));

  const size = async (path: string, artifact: boolean | undefined) =>
    (await sizeUnder(artifact ? artifacts : workspace, path)) ??
    (await sizeUnder(artifact ? workspace : artifacts, path));

  const deliverables: JudgeBundle['deliverables'] = [];
  for (const [i, d] of contract.deliverables.entries()) {
    const folder = d.textSource ? null : await roots.folder(d.path, d.artifact);
    if (folder) folders++;
    const text = folder
      ? await folderText(
          folder,
          d.path,
          new Map(
            seed.filter((f) => f.artifact === folder.artifact).map((f) => [f.path, f.content]),
          ),
        )
      : d.textSource
        ? await read(d.textSource.path, d.textSource.artifact)
        : await read(d.path, d.artifact);
    // Without this the judge marked a deck down for "nothing confirms the
    // file exists", which it could not have seen.
    let note = '';
    if (d.textSource) {
      const bytes = await size(d.path, d.artifact);
      note =
        bytes === null
          ? ' [the delivered file itself is missing; its text source is shown]'
          : ` [the delivered file exists (${bytes} bytes); its text source is shown]`;
    }
    deliverables.push({
      label: `Deliverable ${i + 1} (${d.kind}): ${d.description}${note}`,
      text: text === null ? '[missing]' : blind(folder ? text : clip(text, MAX_FILE_CHARS)),
      kind: d.kind,
    });
  }
  const sources: JudgeBundle['sources'] = [];
  let budget = MAX_BUNDLE_CHARS - deliverables.reduce((n, d) => n + d.text.length, 0);
  // A folder is edited in place, so its sources come from the seed: the
  // workspace copy of a source file IS the delivered change.
  const fromSeed = folders > 0 && seed.length > 0;
  for (const path of fromSeed ? seed.map((f) => f.path) : sourcePaths) {
    if (budget <= 0) break;
    const text = fromSeed
      ? (seed.find((f) => f.path === path)?.content ?? null)
      : await readUnder(workspace, path);
    if (text === null) continue;
    const clipped = clip(text, Math.min(MAX_FILE_CHARS, budget));
    budget -= clipped.length;
    sources.push({ label: path, text: clipped });
  }
  return {
    request: blind([task.title, task.description ?? ''].filter(Boolean).join('\n\n')),
    goal: contract.goal,
    bar: contract.criteria.filter((c) => criterionEnforce(c) !== 'eval-only').map((c) => c.text),
    deliverables,
    sources,
  };
}

export function judgePrompt(bundle: JudgeBundle): string {
  const section = (title: string, items: Array<{ label: string; text: string }>) =>
    items.map((item) => `### ${title}: ${item.label}\n\n${item.text}`).join('\n\n');
  return [
    'You are grading the work a team delivered for a person. Grade only what is shown here.',
    '',
    '## The request',
    bundle.request,
    '',
    '## The goal and quality bar the work was held to',
    bundle.goal,
    ...bundle.bar.map((line) => `- ${line}`),
    '',
    '## What was delivered',
    'Each deliverable is shown exactly as the person receives it, formatting included.',
    '',
    section('Deliverable', bundle.deliverables),
    '',
    bundle.sources.length > 0
      ? `## The sources the work had\n\n${section('Source', bundle.sources)}`
      : '## The sources the work had\n\nNone were supplied; judge grounding by whether claims are cited and plausible.',
    '',
    '## Scores, each an integer from 0 to 10',
    '- fitness: does it do what the person asked, for the audience they named?',
    '- completeness: does it meet every item of the bar above?',
    '- grounding: is every specific fact (names, numbers, dates, quotes) supported by the sources, with nothing invented?',
    '- craft: is it well made for its kind, as delivered? A reader must find their way: a report or deck needs the headings, lists and tables its content calls for, and code or data must be correct.',
    'A missing deliverable scores 0 on every axis it affects. In `reasons`, name the main strengths and the specific problems, in at most 120 words.',
  ].join('\n');
}

/** The structured result from `claude -p --output-format json --json-schema`. */
export function parseJudgeOutput(stdout: string): JudgeSample {
  const outer = JSON.parse(stdout) as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
  };
  if (outer.is_error) throw new Error(`judge call failed: ${String(outer.result).slice(0, 200)}`);
  const raw =
    (outer.structured_output as Record<string, unknown> | undefined) ??
    (JSON.parse(outer.result ?? '') as Record<string, unknown>);
  const scores = {} as Record<JudgeAxis, number>;
  for (const axis of JUDGE_AXES) {
    const value = Number(raw[axis]);
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      throw new Error(`judge returned an invalid ${axis} score: ${String(raw[axis])}`);
    }
    scores[axis] = value;
  }
  return { scores, reasons: String(raw.reasons ?? '') };
}

function callJudge(prompt: string, cliPath: string, model: string): JudgeSample {
  const result = spawnSync(
    cliPath,
    [
      '-p',
      prompt,
      '--model',
      model,
      '--effort',
      'high',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(JUDGE_SCHEMA),
      '--tools',
      '',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: JUDGE_TIMEOUT_MS, cwd: tmpdir() },
  );
  if (result.error) throw new Error(`claude CLI failed to start: ${result.error.message}`);
  return parseJudgeOutput(result.stdout ?? '');
}

export function summarizeSamples(
  samples: readonly JudgeSample[],
): Omit<JudgeReport, 'model' | 'errors' | 'samples'> {
  const axes = {} as Record<JudgeAxis, number>;
  for (const axis of JUDGE_AXES) {
    axes[axis] = samples.reduce((n, s) => n + s.scores[axis], 0) / Math.max(1, samples.length);
  }
  const overall = samples.map(
    (s) => JUDGE_AXES.reduce((n, axis) => n + s.scores[axis], 0) / JUDGE_AXES.length,
  );
  const mean = overall.reduce((n, v) => n + v, 0) / Math.max(1, overall.length);
  const sd =
    overall.length > 1
      ? Math.sqrt(overall.reduce((n, v) => n + (v - mean) ** 2, 0) / (overall.length - 1))
      : 0;
  return { axes, mean, sd };
}

export interface JudgeOptions {
  cliPath?: string;
  samples?: number;
  model?: string;
}

/** Score one bundle: `samples` independent calls to one model. */
export function judgeBundle(bundle: JudgeBundle, opts: JudgeOptions = {}): JudgeReport {
  const model = opts.model ?? JUDGE_MODEL;
  const prompt = judgePrompt(bundle);
  const samples: JudgeSample[] = [];
  const errors: string[] = [];
  for (let i = 0; i < (opts.samples ?? JUDGE_SAMPLES); i++) {
    try {
      samples.push(callJudge(prompt, opts.cliPath ?? 'claude', model));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    model,
    samples,
    ...summarizeSamples(samples),
    errors,
    promptVersion: JUDGE_PROMPT_VERSION,
  };
}

/**
 * Judge one trial and write the report beside it (`judge.json` unless `file`
 * names another). Null when there is nothing to judge.
 */
export async function judgeTrial(
  trialDir: string,
  craftbookId: string,
  sourcePaths: readonly string[],
  opts: JudgeOptions & { file?: string } = {},
): Promise<JudgeReport | null> {
  const bundle = await buildJudgeBundle(trialDir, craftbookId, sourcePaths);
  if (!bundle) return null;
  const report = judgeBundle(bundle, opts);
  await writeFile(join(trialDir, opts.file ?? 'judge.json'), JSON.stringify(report, null, 2));
  return report;
}
