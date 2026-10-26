import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { type CraftbookContract, type Task, criterionEnforce } from '@bendyline/gezel';
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
 * planted defects) and is told whether a binary deliverable exists.
 */
export const JUDGE_PROMPT_VERSION = 2;
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

/** A saved report this version of the judge can use. */
export function isCurrentJudgeReport(report: Partial<JudgeReport> | null): report is JudgeReport {
  return (
    report?.promptVersion === JUDGE_PROMPT_VERSION &&
    Array.isArray(report.samples) &&
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
  let state: { tasks?: { tasks?: Task[] } | Task[] };
  try {
    state = JSON.parse(await readFile(join(trialDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : (state.tasks?.tasks ?? []);
  const task = contractTask(tasks, craftbookId);
  if (!task?.craftbook.contract) return null;
  const contract: CraftbookContract = task.craftbook.contract;
  const workspace = resolve(trialDir, 'workspace', task.projectId);
  const artifacts = resolve(trialDir, 'artifacts', task.projectId);
  const read = async (path: string, artifact: boolean | undefined) =>
    (await readUnder(artifact ? artifacts : workspace, path)) ??
    (await readUnder(artifact ? workspace : artifacts, path));

  const size = async (path: string, artifact: boolean | undefined) =>
    (await sizeUnder(artifact ? artifacts : workspace, path)) ??
    (await sizeUnder(artifact ? workspace : artifacts, path));

  const deliverables: JudgeBundle['deliverables'] = [];
  for (const [i, d] of contract.deliverables.entries()) {
    const text = d.textSource
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
      text: text === null ? '[missing]' : blind(clip(text, MAX_FILE_CHARS)),
      kind: d.kind,
    });
  }
  const sources: JudgeBundle['sources'] = [];
  let budget = MAX_BUNDLE_CHARS - deliverables.reduce((n, d) => n + d.text.length, 0);
  for (const path of sourcePaths) {
    if (budget <= 0) break;
    const text = await readUnder(workspace, path);
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
