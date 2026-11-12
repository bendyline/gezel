/**
 * `pnpm eval:docbench` — score local models on DocBlocks' AI workloads.
 *
 * Three phases, each resumable on the same `--run-id`:
 *
 * 1. **Generate** — per model, a trial gezeld with the model, and the
 *    DocBlocks task pack (`docbench-pack run`) against the daemon's own
 *    `/v1/chat/completions`, every trial its tasks ask for. Endpoint failures
 *    are retried once and never scored.
 * 2. **Judge** — every usable outcome the task's rubric needs judged, by the
 *    pinned Claude judge (pictures rendered and shown to it), cached beside
 *    the outcome as `<case>-t<n>.judge.json`.
 * 3. **Score** — the docbench score per model with family and task scores,
 *    95% intervals and rank bands: `summary.json` and `report.md`.
 *
 * Flags:
 *   --models <a,b>          catalog ids (default: the 21-model default set; `slice` for the Phase 1 four),
 *                           `apple-foundation-models` for the model macOS runs, or a frontier reference:
 *                           `claude-<model>` on the Claude CLI, `codex-<model>` on the Codex CLI
 *                           (never publishable; see `docbench/cli-endpoint.ts`)
 *   --run-id <id>           output folder under evals/runs/docbench-<id> (default: a timestamp)
 *   --pack <dir>            the built task pack (default: GEZEL_DOCBENCH_PACK or ../docblocks/packages/bench)
 *   --tasks <a,b>           run these tasks only
 *   --cases <a,b>           run these case ids only
 *   --judge <model|none|openai:<baseUrl>#<model>>
 *                           the judge (default: the official claude-opus-5-5, or GEZEL_DOCBENCH_JUDGE_MODEL)
 *   --claude-bin <path>     the Claude CLI (default: GEZEL_CLAUDE_BIN, PATH, or the VS Code extension's)
 *   --codex-bin <path>      the Codex CLI, for `codex-<model>` references (default: GEZEL_CODEX_BIN or PATH)
 *   --judge-concurrency <n> judge calls at once (default 3)
 *   --now <iso>             the date prompts state (default: kept from the run, else today at noon UTC)
 *   --seed-base <n>         trial n uses seed base+n (default 1000)
 *   --source-home <dir>     borrow installed weights read-only from this gezel home (e.g. ~/.gezel-dev)
 *   --allow-download        fetch weights the eval cache lacks
 *   --llama-bin <path>      the llama-server binary (default: resolved like every eval)
 *   --skip-generate         judge and score what the run already has
 *   --skip-judge            score without judging (checks only; not publishable)
 *   --keep-homes            keep each trial's GEZEL_HOME for debugging
 *   --fixtures <dir>        run on another fixture set laid out like the pack's (a private holdout);
 *                           the round records the set's hash and refuses to resume on another
 *   --regenerate            generate again for models the round already has (default: skip them)
 *
 * Two generation processes may share a round (say, local models in one and
 * frontier references in another): the run record is merged on every write.
 * Only models that run on this machine take the eval device lock.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchPackManifest } from '@bendyline/gezel/eval';
import {
  DOCBENCH_JUDGE_PROMPT_VERSION,
  DOCBENCH_OFFICIAL_JUDGE,
  type JudgeProvider,
  claudeCliJudge,
  isCurrentJudgement,
  judgeOutcome,
  openAiJudge,
  resolveClaudeCli,
} from '../docbench/judge.ts';
import { describePack, readOutcomes, resolvePack } from '../docbench/pack.ts';
import { openSvgRenderer } from '../docbench/render.ts';
import {
  DOCBENCH_SUMMARY_SCHEMA_VERSION,
  type DocbenchSummary,
  type ModelSummary,
  isPublishable,
  renderReport,
  withBands,
} from '../docbench/report.ts';
import {
  DOCBENCH_LAUNCH_CONTEXT,
  type GenerateResult,
  contestantFor,
  generateModel,
  runsOnDevice,
} from '../docbench/runner.ts';
import { type CaseJudgement, outcomeKey, scoreModel } from '../docbench/score.ts';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { resolveLlamaBinary } from '../native-bin.ts';
import { captureDevice } from '../scorecard.ts';
import { parseArgs } from './args.ts';

/** Phase 1's slice (`--models slice`): a tiny, two small, and the local ceiling. */
export const DOCBENCH_SLICE_MODELS = [
  'qwen3.5-0.8b-q4',
  'minicpm5-2b-q4',
  'gemma4-12b-q4',
  'qwen3.8-27b-q4',
] as const;

/**
 * The default round: the catalog's chat models of 27B and smaller that run on
 * llama.cpp, weighted to the 1–12B class that ordinary laptops run, with the
 * 27B as the ceiling and a 2-bit build of it to show what quantization costs.
 */
export const DOCBENCH_DEFAULT_MODELS = [
  'qwen3.5-0.8b-q4',
  'minicpm5-1b-q4',
  'lfm3-1.7b-q4',
  'qwen3.5-2b-q4',
  'minicpm5-2b-q4',
  'gemma4-e2b-q4',
  'lfm2.5-2.6b-q4',
  'granite4.2-3b-q4',
  'llama3.2-3b-q4',
  'nanbeige4.2-3b-q4',
  'qwen3.5-4b-q4',
  'gemma4-e4b-q4',
  'nemotron3.5-bolt-e4b-q4',
  'granite4.2-8b-q4',
  'qwen3.5-9b-q4',
  'ornith1.5-9b-q4',
  'gemma4-12b-q4',
  'gpt-oss-20b-q4',
  'qwen3.8-27b-q2',
  'qwen3.8-27b-q4',
  'qwen3.6-35b-a3b-q4',
] as const;

const KNOWN_FLAGS = new Set([
  'models',
  'run-id',
  'pack',
  'tasks',
  'cases',
  'judge',
  'claude-bin',
  'codex-bin',
  'judge-concurrency',
  'now',
  'seed-base',
  'source-home',
  'allow-download',
  'llama-bin',
  'skip-generate',
  'skip-judge',
  'keep-homes',
  'fixtures',
  'regenerate',
]);

interface RunRecord {
  readonly runId: string;
  readonly createdAt: string;
  readonly now: string;
  readonly pack: {
    readonly id: string;
    readonly version: string;
    readonly fixtures?: { readonly id: string; readonly sha256: string };
  };
  generation: Record<string, GenerateResult & { readonly error?: string }>;
}

function list(value: string | boolean | undefined): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function harnessCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function judgeProvider(
  spec: string | undefined,
  claudeBin: string | undefined,
): JudgeProvider | null {
  const choice = spec ?? DOCBENCH_OFFICIAL_JUDGE;
  if (choice === 'none') return null;
  if (choice.startsWith('openai:')) {
    const [baseUrl, model] = choice.slice('openai:'.length).split('#');
    if (!baseUrl || !model) throw new Error('--judge openai:<baseUrl>#<model>');
    return openAiJudge(baseUrl, model, process.env.GEZEL_DOCBENCH_JUDGE_TOKEN);
  }
  return claudeCliJudge(choice, resolveClaudeCli(claudeBin));
}

/**
 * Write the run record, keeping any model another process sharing the round
 * wrote since this one started: its entries win only for models this process
 * did not generate.
 */
async function writeRecord(file: string, record: RunRecord, mine: ReadonlySet<string>) {
  const onDisk = existsSync(file)
    ? (JSON.parse(await readFile(file, 'utf8')) as Partial<RunRecord>)
    : null;
  const generation = { ...(onDisk?.generation ?? {}) };
  for (const [modelId, result] of Object.entries(record.generation)) {
    if (mine.has(modelId) || !(modelId in generation)) generation[modelId] = result;
  }
  record.generation = generation;
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

async function judgeRun(
  runDir: string,
  manifest: BenchPackManifest,
  models: readonly string[],
  provider: JudgeProvider,
  concurrency: number,
): Promise<void> {
  const needsPictures = manifest.tasks.some((task) => task.judge?.vision);
  const renderer =
    needsPictures && provider.seesImages ? await openSvgRenderer(join(runDir, 'renders')) : null;
  try {
    for (const modelId of models) {
      const outcomes = await readOutcomes(join(runDir, modelId, 'cases'));
      const pending: { file: string; outcome: (typeof outcomes)[number]['outcome'] }[] = [];
      for (const item of outcomes) {
        const task = manifest.tasks.find((candidate) => candidate.id === item.outcome.taskId);
        if (!task?.judge || !item.outcome.usable || !item.outcome.judgeInput) continue;
        const verdictFile = item.file.replace(/\.json$/u, '.judge.json');
        const saved = existsSync(verdictFile)
          ? (JSON.parse(await readFile(verdictFile, 'utf8')) as Partial<CaseJudgement>)
          : null;
        if (!isCurrentJudgement(saved, provider, task.judge)) pending.push(item);
      }
      console.log(
        `[docbench] ${modelId}: judging ${String(pending.length)} outcomes with ${provider.model}`,
      );
      let done = 0;
      await pool(pending, concurrency, async ({ file, outcome }) => {
        const task = manifest.tasks.find((candidate) => candidate.id === outcome.taskId);
        if (!task) return;
        const verdict = await judgeOutcome(outcome, task, {
          provider,
          ...(renderer ? { renderSvg: renderer.render } : {}),
        });
        if (verdict) {
          await writeFile(
            file.replace(/\.json$/u, '.judge.json'),
            `${JSON.stringify(verdict, null, 2)}\n`,
          );
        }
        done += 1;
        const label = verdict?.error ? `failed: ${verdict.error.slice(0, 160)}` : 'judged';
        console.log(
          `[docbench] ${modelId} ${outcome.taskId}/${outcome.caseId} t${String(outcome.trial)}: ${label} (${String(done)}/${String(pending.length)})`,
        );
      });
    }
  } finally {
    await renderer?.close();
  }
}

async function loadJudgements(
  runDir: string,
  modelId: string,
  provider: JudgeProvider | null,
  manifest: BenchPackManifest,
): Promise<Map<string, CaseJudgement>> {
  const judgements = new Map<string, CaseJudgement>();
  if (!provider) return judgements;
  for (const { file, outcome } of await readOutcomes(join(runDir, modelId, 'cases'))) {
    const verdictFile = file.replace(/\.json$/u, '.judge.json');
    if (!existsSync(verdictFile)) continue;
    const verdict = JSON.parse(await readFile(verdictFile, 'utf8')) as CaseJudgement;
    const spec = manifest.tasks.find((task) => task.id === outcome.taskId)?.judge;
    // Only this judge's verdicts count: never mix judges in one score.
    if (spec && verdict.judgeModel === provider.model && verdict.rubricId === spec.rubricId) {
      judgements.set(outcomeKey(outcome), verdict);
    }
  }
  return judgements;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const unknown = Object.keys(flags).filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) throw new Error(`Unknown flag: --${unknown.join(', --')}`);

  const models = list(flags.models);
  const selectedModels =
    models.length === 0
      ? [...DOCBENCH_DEFAULT_MODELS]
      : models.length === 1 && models[0] === 'slice'
        ? [...DOCBENCH_SLICE_MODELS]
        : models;
  const pack = resolvePack(text(flags.pack), text(flags.fixtures));
  const manifest = await describePack(pack);
  const tasks = list(flags.tasks);
  const unknownTasks = tasks.filter((id) => !manifest.tasks.some((task) => task.id === id));
  if (unknownTasks.length > 0) throw new Error(`The pack has no task ${unknownTasks.join(', ')}`);

  const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const runId = text(flags['run-id']) ?? new Date().toISOString().replace(/[:.]/gu, '-');
  const runDir = join(evalsRoot, 'runs', `docbench-${runId}`);
  await mkdir(runDir, { recursive: true });
  const recordFile = join(runDir, 'run.json');
  const previous = existsSync(recordFile)
    ? (JSON.parse(await readFile(recordFile, 'utf8')) as RunRecord)
    : null;
  if (previous && previous.pack.version !== manifest.version) {
    throw new Error(
      `Run ${runId} was generated with docbench ${previous.pack.version}; the pack is now ${manifest.version}. Start a new --run-id.`,
    );
  }
  if (previous?.pack.fixtures && previous.pack.fixtures.sha256 !== manifest.fixtures?.sha256) {
    throw new Error(
      `Run ${runId} was generated on fixture set ${previous.pack.fixtures.id} (${previous.pack.fixtures.sha256.slice(0, 12)}); the fixtures have changed since. Start a new --run-id.`,
    );
  }
  const now =
    text(flags.now) ?? previous?.now ?? `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
  const record: RunRecord = {
    runId,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    now,
    pack: {
      id: manifest.id,
      version: manifest.version,
      ...(manifest.fixtures ? { fixtures: manifest.fixtures } : {}),
    },
    generation: { ...(previous?.generation ?? {}) },
  };
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[docbench] ${manifest.id} ${manifest.version} → ${runDir}`);

  const provider = flags['skip-judge']
    ? null
    : judgeProvider(text(flags.judge), text(flags['claude-bin']));

  const generatedHere = new Set<string>();
  if (!flags['skip-generate']) {
    const lease = selectedModels.some(runsOnDevice) ? acquireEvalDeviceLock() : null;
    try {
      const contestants = selectedModels.map(contestantFor);
      const llamaBin = contestants.some((contestant) => contestant.kind === 'llama-cpp')
        ? resolveLlamaBinary(text(flags['llama-bin'])).path
        : undefined;
      const claudeBin = contestants.some(
        (contestant) => contestant.kind === 'reference' && contestant.reference.cli === 'claude',
      )
        ? resolveClaudeCli(text(flags['claude-bin']))
        : undefined;
      const codexBin = text(flags['codex-bin']) ?? process.env.GEZEL_CODEX_BIN?.trim() ?? 'codex';
      for (const modelId of selectedModels) {
        const done = record.generation[modelId];
        if (done && !done.error && done.outcomes > 0 && flags.regenerate !== true) {
          console.log(
            `[docbench] ${modelId}: already generated (${String(done.outcomes)} outcomes); --regenerate to redo`,
          );
          continue;
        }
        try {
          const result = await generateModel({
            pack,
            manifest,
            modelId,
            modelDir: join(runDir, modelId),
            ...(llamaBin ? { llamaBin } : {}),
            ...(claudeBin ? { claudeBin } : {}),
            codexBin,
            tasks,
            cases: list(flags.cases),
            now,
            seedBase: Number(text(flags['seed-base']) ?? 1000),
            ...(text(flags['source-home']) ? { sourceHome: text(flags['source-home']) } : {}),
            allowDownload: flags['allow-download'] === true,
            keepHome: flags['keep-homes'] === true,
            log: (line) => console.log(line),
          });
          record.generation[modelId] = result;
          generatedHere.add(modelId);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[docbench] ${modelId}: generation failed: ${message}`);
          record.generation[modelId] = {
            outcomes: 0,
            infraRetried: 0,
            launchContext: DOCBENCH_LAUNCH_CONTEXT,
            seconds: 0,
            error: message,
          };
          generatedHere.add(modelId);
        }
        await writeRecord(recordFile, record, generatedHere);
      }
    } finally {
      lease?.release();
    }
  }
  await writeRecord(recordFile, record, generatedHere);

  if (provider) {
    await judgeRun(
      runDir,
      manifest,
      selectedModels,
      provider,
      Number(text(flags['judge-concurrency']) ?? 3),
    );
  }

  const scored: Omit<ModelSummary, 'band'>[] = [];
  for (const modelId of selectedModels) {
    const outcomes = (await readOutcomes(join(runDir, modelId, 'cases'))).map(
      (item) => item.outcome,
    );
    if (outcomes.length === 0) {
      console.warn(`[docbench] ${modelId}: no outcomes to score`);
      continue;
    }
    const judgements = await loadJudgements(runDir, modelId, provider, manifest);
    const generation = record.generation[modelId];
    scored.push({
      modelId,
      ...scoreModel(manifest, outcomes, judgements),
      generation: generation
        ? {
            seconds: generation.seconds,
            outcomes: generation.outcomes,
            infraRetried: generation.infraRetried,
            ...(generation.catalogVersion ? { catalogVersion: generation.catalogVersion } : {}),
          }
        : null,
    });
  }
  // A validity study counts only for the judge and prompt version that scored this round.
  const validityFile = join(runDir, 'validity.json');
  const study = existsSync(validityFile)
    ? (JSON.parse(await readFile(validityFile, 'utf8')) as {
        pass: boolean;
        model: string;
        judge: string;
        promptVersion: number;
        retest: { meanSd: number | null };
        agreement: { alpha: number | null };
        defects: { rate: number | null };
      })
    : null;
  const validity =
    study &&
    provider &&
    study.judge === provider.model &&
    study.promptVersion === DOCBENCH_JUDGE_PROMPT_VERSION
      ? {
          pass: study.pass,
          model: study.model,
          retestSd: study.retest.meanSd,
          alpha: study.agreement.alpha,
          defectsCaught: study.defects.rate,
        }
      : null;
  const summaryBase = {
    judge: provider
      ? {
          model: provider.model,
          promptVersion: DOCBENCH_JUDGE_PROMPT_VERSION,
          official: provider.official,
        }
      : null,
    validity,
    models: withBands(scored),
  };
  const summary: DocbenchSummary = {
    schemaVersion: DOCBENCH_SUMMARY_SCHEMA_VERSION,
    runId,
    createdAt: record.createdAt,
    pack: {
      ...record.pack,
      ...(manifest.fixtures ? { fixtures: manifest.fixtures } : {}),
    },
    now,
    launchContext: DOCBENCH_LAUNCH_CONTEXT,
    device: captureDevice(),
    harnessCommit: harnessCommit(),
    ...summaryBase,
    publishable: isPublishable(summaryBase),
  };
  await writeFile(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const report = renderReport(summary, manifest);
  await writeFile(join(runDir, 'report.md'), report);
  console.log(`\n${report}\n[docbench] wrote ${join(runDir, 'report.md')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
