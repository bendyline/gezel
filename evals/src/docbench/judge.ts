/**
 * The docbench judge: one pinned model reads a case the way the task pack
 * describes it and returns structured scores.
 *
 * Two modes, both from the pack's rubric:
 * - **rubric**: each axis scored 0–10 from the context and the artifact. A
 *   picture (`vision`) is rendered to PNG and shown to the judge.
 * - **matcher**: the judge marks each answer-key issue found or missed and
 *   labels each of the model's items valid, trivial or wrong; the F1 is
 *   computed in code ({@link matchScore}), never by the judge.
 *
 * The official judge is a pinned Claude model through the Claude CLI, with
 * no tools (the Read tool alone for a picture) and an empty working
 * directory, so it judges only what it is shown — the same isolation as the
 * strategy judge (`strategy/judge.ts`). A local OpenAI-compatible judge is
 * allowed for diagnostics; its verdicts are stamped unofficial and never
 * published.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  BENCH_COMPLEXITIES,
  type BenchCaseOutcome,
  type BenchComplexity,
  type BenchJudgeInput,
  type BenchJudgeSpec,
  type BenchTaskInfo,
} from '@bendyline/gezel/eval';
import type { CaseJudgement, LevelCounts, MatchCounts } from './score.ts';

/**
 * Bumped when a prompt or schema below changes, so verdicts from two versions
 * are never mixed. 2: matcher items carry a complexity level when the task asks.
 */
export const DOCBENCH_JUDGE_PROMPT_VERSION = 2;
export const DOCBENCH_OFFICIAL_JUDGE = process.env.GEZEL_DOCBENCH_JUDGE_MODEL ?? 'claude-opus-5-5';

const JUDGE_TIMEOUT_MS = 10 * 60_000;
/** Caps that keep one huge artifact from crowding out the context. */
const MAX_CONTEXT_CHARS = 40_000;
const MAX_ARTIFACT_CHARS = 60_000;

export interface JudgeRequest {
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
  /** A rendered picture to show the judge. */
  readonly imagePath?: string;
}

export interface JudgeProvider {
  readonly model: string;
  readonly official: boolean;
  /** The provider can be shown a rendered picture. */
  readonly seesImages: boolean;
  ask(request: JudgeRequest): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------- providers

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase())
      : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...extensions]) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** The Claude CLI bundled with the VS Code extension, newest first. */
function vscodeBundledClaude(): string | null {
  const root = join(homedir(), '.vscode', 'extensions');
  if (!existsSync(root)) return null;
  const extensions = readdirSync(root)
    .filter((name) => name.startsWith('anthropic.claude-code-'))
    .sort()
    .reverse();
  for (const extension of extensions) {
    for (const file of ['claude.exe', 'claude']) {
      const candidate = join(root, extension, 'resources', 'native-binary', file);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** `--claude-bin`, else GEZEL_CLAUDE_BIN, else `claude` on PATH, else the VS Code extension's copy. */
export function resolveClaudeCli(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved =
    explicit?.trim() ||
    env.GEZEL_CLAUDE_BIN?.trim() ||
    onPath('claude', env) ||
    vscodeBundledClaude();
  if (!resolved) {
    throw new Error(
      'The Claude CLI was not found. Install Claude Code, or pass --claude-bin <path> ' +
        '(or set GEZEL_CLAUDE_BIN). Use --judge none to run without a judge.',
    );
  }
  return resolved;
}

/** The structured result of `claude -p --output-format json --json-schema`. */
export function parseClaudeOutput(stdout: string): Record<string, unknown> {
  const outer = JSON.parse(stdout) as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
  };
  if (outer.is_error) throw new Error(`judge call failed: ${String(outer.result).slice(0, 300)}`);
  const raw = outer.structured_output ?? JSON.parse(outer.result ?? '');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('judge returned no object');
  }
  return raw as Record<string, unknown>;
}

function runProcess(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
    const child = spawn(useShell ? `"${command}"` : command, args, {
      cwd,
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), JUDGE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`judge exited ${String(code)}: ${(stderr || stdout).slice(0, 400)}`));
    });
    child.stdin.end(input);
  });
}

/** The official judge: a pinned Claude model through the Claude CLI. */
export function claudeCliJudge(model: string, cliPath: string): JudgeProvider {
  return {
    model,
    official: model === DOCBENCH_OFFICIAL_JUDGE,
    seesImages: true,
    async ask(request) {
      // An empty directory, holding only the picture when there is one: the
      // judge sees exactly what it is shown.
      const dir = await mkdtemp(join(tmpdir(), 'docbench-judge-'));
      try {
        if (request.imagePath) await copyFile(request.imagePath, join(dir, 'picture.png'));
        const tools = request.imagePath ? 'Read' : '';
        const stdout = await runProcess(
          cliPath,
          [
            '-p',
            '--model',
            model,
            '--output-format',
            'json',
            '--json-schema',
            JSON.stringify(request.schema),
            '--tools',
            tools,
            ...(tools ? ['--allowedTools', tools] : []),
          ],
          request.prompt,
          dir,
        );
        return parseClaudeOutput(stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** A diagnostic judge on any OpenAI-compatible endpoint. Never official, never shown pictures. */
export function openAiJudge(baseUrl: string, model: string, token?: string): JudgeProvider {
  return {
    model: `${model}@${baseUrl}`,
    official: false,
    seesImages: false,
    async ask(request) {
      const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: 'user', content: request.prompt }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'judgement', schema: request.schema, strict: true },
          },
        }),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`judge HTTP ${String(response.status)}`);
      const body = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const text = body.choices?.[0]?.message?.content ?? '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end < start) throw new Error('judge returned no JSON object');
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    },
  };
}

// ---------------------------------------------------------------- prompts

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[… ${String(text.length - max)} characters omitted]`;
}

function axisLines(spec: BenchJudgeSpec): string[] {
  return spec.axes.map((axis) => `- \`${axis.id}\` (${axis.label}): ${axis.description}`);
}

const SCALE =
  'Score each axis as an integer from 0 to 10: 0 when it is absent or unusable, 5 when it is ' +
  'acceptable with clear problems, 10 when it is as good as a careful expert would make it. ' +
  'In `reasons`, name the main strengths and the specific problems in at most 80 words.';

function axisProperties(spec: BenchJudgeSpec): Record<string, unknown> {
  return Object.fromEntries(
    spec.axes.map((axis) => [axis.id, { type: 'integer', minimum: 0, maximum: 10 }]),
  );
}

export function rubricPrompt(
  spec: BenchJudgeSpec,
  input: BenchJudgeInput,
  artifact: NonNullable<BenchCaseOutcome['artifact']>,
  showsPicture: boolean,
): string {
  const output =
    artifact.kind === 'svg'
      ? [
          showsPicture
            ? 'The rendered picture is in `picture.png` in your working directory: open it with the Read tool and judge what you see. Its SVG source follows for reference.'
            : 'You cannot see the rendered picture; judge it from its SVG source, imagining how it renders.',
          '',
          '```svg',
          clip(artifact.content, MAX_ARTIFACT_CHARS),
          '```',
        ]
      : [clip(artifact.content, MAX_ARTIFACT_CHARS)];
  return [
    'You are judging the output of an AI model working inside a document editor. Judge only what is shown here.',
    '',
    '## The task',
    spec.instructions,
    '',
    '## What the model was given',
    clip(input.context, MAX_CONTEXT_CHARS),
    '',
    '## What the model produced',
    ...output,
    ...(input.reference ? ['', '## A reference answer, for comparison', input.reference] : []),
    '',
    '## How to score',
    ...axisLines(spec),
    '',
    SCALE,
  ].join('\n');
}

export function rubricSchema(spec: BenchJudgeSpec): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ...axisProperties(spec), reasons: { type: 'string' } },
    required: [...spec.axes.map((axis) => axis.id), 'reasons'],
    additionalProperties: false,
  };
}

export function matcherPrompt(spec: BenchJudgeSpec, input: BenchJudgeInput): string {
  const key = input.answerKey ?? [];
  const items = input.items ?? [];
  return [
    'You are judging the output of an AI model working inside a document editor. Judge only what is shown here.',
    '',
    '## The task',
    spec.instructions,
    '',
    '## What the model was given',
    clip(input.context, MAX_CONTEXT_CHARS),
    '',
    '## The answer key: problems known to be in it',
    ...(key.length === 0
      ? ['None: this document was written to have nothing worth flagging.']
      : key.map(
          (issue) =>
            `- \`${issue.id}\`${issue.quote ? ` at "${clip(issue.quote, 200)}"` : ''}: ${issue.issue}`,
        )),
    '',
    "## The model's output, item by item",
    ...items.flatMap((item) => [`### \`${item.id}\``, clip(item.text, 2_000), '']),
    '## What to return',
    '- `key`: one entry for every answer-key id, saying whether some item found that problem and which items did.',
    '- `items`: one entry for every output item id, labelled `valid`, `trivial` or `wrong` as the task describes.',
    ...(spec.levels
      ? [
          '- Give every item a `level`: how much the change it proposes takes, judged by the change itself, not by whether it is right. ' +
            '`low`: mechanical (a typo, punctuation, capitalization, a number or date format, one wrong word). ' +
            '`medium`: rewording a sentence or two (wordiness, passive voice, jargon, an unclear or overstated sentence, an inconsistent term). ' +
            '`high`: paragraph or document level (a buried main point, a contradiction between sections, missing information or a missing definition the reader needs, the order or structure of sections, an unsupported central claim).',
        ]
      : []),
    ...(spec.axes.length > 0 ? ['', '## How to score', ...axisLines(spec), '', SCALE] : []),
  ].join('\n');
}

export function matcherSchema(
  spec: BenchJudgeSpec,
  input: BenchJudgeInput,
): Record<string, unknown> {
  const keyIds = (input.answerKey ?? []).map((issue) => issue.id);
  const itemIds = (input.items ?? []).map((item) => item.id);
  const idOf = (ids: string[]) =>
    ids.length > 0 ? { type: 'string', enum: ids } : { type: 'string' };
  return {
    type: 'object',
    properties: {
      key: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: idOf(keyIds),
            found: { type: 'boolean' },
            by: { type: 'array', items: idOf(itemIds) },
          },
          required: ['id', 'found', 'by'],
          additionalProperties: false,
        },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: idOf(itemIds),
            label: { type: 'string', enum: ['valid', 'trivial', 'wrong'] },
            ...(spec.levels ? { level: { type: 'string', enum: [...BENCH_COMPLEXITIES] } } : {}),
          },
          required: spec.levels ? ['id', 'label', 'level'] : ['id', 'label'],
          additionalProperties: false,
        },
      },
      ...axisProperties(spec),
      reasons: { type: 'string' },
    },
    required: ['key', 'items', ...spec.axes.map((axis) => axis.id), 'reasons'],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------- parsing

function readAxes(raw: Record<string, unknown>, spec: BenchJudgeSpec): Record<string, number> {
  const axes: Record<string, number> = {};
  for (const axis of spec.axes) {
    const value = Number(raw[axis.id]);
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      throw new Error(`judge returned an invalid ${axis.id} score: ${String(raw[axis.id])}`);
    }
    axes[axis.id] = value;
  }
  return axes;
}

/** Counts from a matcher verdict. Throws when it leaves a key issue or an item unanswered. */
function isComplexity(value: unknown): value is BenchComplexity {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Counts from a matcher verdict. Throws when it leaves a key issue or an item
 * unanswered, or (with `levels`) an item without a level.
 */
export function readMatch(
  raw: Record<string, unknown>,
  input: BenchJudgeInput,
  levels = false,
): MatchCounts {
  const keyIds = new Set((input.answerKey ?? []).map((issue) => issue.id));
  const itemIds = new Set((input.items ?? []).map((item) => item.id));
  const found = new Set<string>();
  const answered = new Set<string>();
  for (const entry of Array.isArray(raw.key) ? raw.key : []) {
    const record = entry as { id?: unknown; found?: unknown };
    if (typeof record.id !== 'string' || !keyIds.has(record.id)) continue;
    answered.add(record.id);
    if (record.found === true) found.add(record.id);
  }
  const labels = new Map<string, { label: string; level: BenchComplexity | null }>();
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const record = entry as { id?: unknown; label?: unknown; level?: unknown };
    if (typeof record.id !== 'string' || !itemIds.has(record.id)) continue;
    if (record.label !== 'valid' && record.label !== 'trivial' && record.label !== 'wrong')
      continue;
    const level = isComplexity(record.level) ? record.level : null;
    if (levels && level === null) continue;
    labels.set(record.id, { label: record.label, level });
  }
  const missingKey = [...keyIds].filter((id) => !answered.has(id));
  const missingItems = [...itemIds].filter((id) => !labels.has(id));
  if (missingKey.length > 0 || missingItems.length > 0) {
    throw new Error(
      `judge left unanswered: ${[...missingKey, ...missingItems].slice(0, 8).join(', ')}`,
    );
  }
  const values = [...labels.values()];
  const count = (label: string) => values.filter((value) => value.label === label).length;
  const counts = {
    found: found.size,
    keyTotal: keyIds.size,
    valid: count('valid'),
    trivial: count('trivial'),
    wrong: count('wrong'),
  };
  if (!levels) return counts;
  const key = input.answerKey ?? [];
  const byLevel = (level: BenchComplexity): LevelCounts => ({
    // An answer-key issue without a level counts as medium.
    keyTotal: key.filter((issue) => (issue.level ?? 'medium') === level).length,
    found: key.filter((issue) => (issue.level ?? 'medium') === level && found.has(issue.id)).length,
    valid: values.filter((value) => value.label === 'valid' && value.level === level).length,
  });
  return {
    ...counts,
    levels: { low: byLevel('low'), medium: byLevel('medium'), high: byLevel('high') },
  };
}

// ---------------------------------------------------------------- judging a case

/** Turns an SVG into a PNG file the judge can look at. */
export type SvgRenderer = (svg: string) => Promise<string>;

export interface JudgeCaseOptions {
  readonly provider: JudgeProvider;
  readonly renderSvg?: SvgRenderer;
  /** Attempts per case when a verdict fails to parse or leaves something unanswered. */
  readonly attempts?: number;
}

function base(provider: JudgeProvider, spec: BenchJudgeSpec) {
  return {
    rubricId: spec.rubricId,
    promptVersion: DOCBENCH_JUDGE_PROMPT_VERSION,
    judgeModel: provider.model,
    official: provider.official,
  };
}

/**
 * Judge one outcome. Null when there is nothing to judge: the task has no
 * judge, or the outcome is unusable (it scores zero either way).
 */
export async function judgeOutcome(
  outcome: BenchCaseOutcome,
  task: BenchTaskInfo,
  options: JudgeCaseOptions,
): Promise<CaseJudgement | null> {
  const spec = task.judge;
  const input = outcome.judgeInput;
  if (!spec || !input || !outcome.usable) return null;
  const { provider } = options;

  if (spec.mode === 'matcher' && (input.items ?? []).length === 0) {
    // Nothing to label: no call needed, and an empty output helps no one.
    const keyTotal = (input.answerKey ?? []).length;
    return {
      ...base(provider, spec),
      axes: Object.fromEntries(spec.axes.map((axis) => [axis.id, keyTotal === 0 ? 10 : 0])),
      match: spec.levels
        ? readMatch(
            {
              key: (input.answerKey ?? []).map((issue) => ({ id: issue.id, found: false })),
              items: [],
            },
            input,
            true,
          )
        : { found: 0, keyTotal, valid: 0, trivial: 0, wrong: 0 },
      reasons: 'The output had no items to judge.',
    };
  }

  let imagePath: string | undefined;
  let prompt: string;
  let schema: Record<string, unknown>;
  if (spec.mode === 'matcher') {
    prompt = matcherPrompt(spec, input);
    schema = matcherSchema(spec, input);
  } else {
    const artifact = outcome.artifact ?? { kind: 'text' as const, content: '(no output)' };
    if (spec.vision && artifact.kind === 'svg' && provider.seesImages && options.renderSvg) {
      imagePath = await options.renderSvg(artifact.content);
    }
    prompt = rubricPrompt(spec, input, artifact, imagePath !== undefined);
    schema = rubricSchema(spec);
  }

  const errors: string[] = [];
  for (let attempt = 0; attempt < (options.attempts ?? 2); attempt += 1) {
    try {
      const raw = await provider.ask({ prompt, schema, ...(imagePath ? { imagePath } : {}) });
      return {
        ...base(provider, spec),
        axes: readAxes(raw, spec),
        ...(spec.mode === 'matcher' ? { match: readMatch(raw, input, spec.levels === true) } : {}),
        reasons: String(raw.reasons ?? ''),
      };
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ...base(provider, spec), axes: {}, reasons: '', error: errors.join(' | ') };
}

/** Whether a saved verdict was made by this judge, prompt and rubric, so it can be reused. */
export function isCurrentJudgement(
  saved: Partial<CaseJudgement> | null,
  provider: JudgeProvider,
  spec: BenchJudgeSpec,
): boolean {
  return (
    !!saved &&
    !saved.error &&
    saved.promptVersion === DOCBENCH_JUDGE_PROMPT_VERSION &&
    saved.judgeModel === provider.model &&
    saved.rubricId === spec.rubricId
  );
}
