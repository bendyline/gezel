/**
 * Index of eval trials under `<home>/eval-runs/`.
 *
 * The harness writes one directory per trial; this module reads what it
 * wrote and never recomputes a verdict. Layout it understands:
 *
 *   eval-runs/jobs/<jobId>/<nn>-<target>/<scenarioId>/<trialId>/   in-app jobs
 *   eval-runs/<trialId>/                                           legacy runner
 *
 * A trial directory is one holding `result.json` (finished) or
 * `status.json` (started). Dot-directories (the preflight probe cache) and a
 * trial's own snapshot subtrees are never walked.
 */

import { createReadStream } from 'node:fs';
import { promises as fs, type Dirent } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type EvalRubricBand,
  EvalRubricBandSchema,
  type EvalTrialDetail,
  type EvalTrialSummary,
} from '@bendyline/gezel/eval';

const MAX_WALK_DEPTH = 6;
const LOG_TAIL_LINES = 200;
const MAX_ARTIFACTS = 200;

interface ResultFile {
  trialId?: string;
  scenarioId?: string;
  modelId?: string;
  engine?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  success?: boolean;
  reason?: string;
  failureMode?: string;
  failureClass?: string;
  failureClassRule?: string;
  failureClassEvidence?: string;
  generalistMode?: string;
  modelTier?: string;
}

interface StatusFile {
  trialId?: string;
  scenarioId?: string;
  modelId?: string;
  engine?: string;
  startedAt?: string;
}

interface ScoreFile {
  composite?: number;
  band?: string;
  eligibility?: { includedInModelAggregate?: boolean };
  axes?: Record<string, { score?: number; summary?: string }>;
}

interface MetricsFile {
  derived?: { genTokensPerSec?: number | null; meanTokensPerSec?: number | null };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function mtime(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** A trial that started but has no result, and no live job is running it. */
export const INTERRUPTED_REASON = 'Stopped before it finished';

export interface IndexedTrial {
  summary: EvalTrialSummary;
  dir: string;
}

/**
 * Walk and parse, with a per-directory cache keyed on the mtimes of the
 * files a summary is built from — the Benchmarks view polls while a job runs,
 * and re-reading every result on each poll is the only expensive part.
 */
export class EvalResultsIndex {
  private readonly cache = new Map<string, { signature: string; summary: EvalTrialSummary }>();

  constructor(
    private readonly runsDir: string,
    /** Trial ids an in-app job is running right now. */
    private readonly liveTrialIds: () => ReadonlySet<string> = () => new Set(),
  ) {}

  async list(): Promise<IndexedTrial[]> {
    const dirs = await this.trialDirs();
    const live = this.liveTrialIds();
    const out: IndexedTrial[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      seen.add(dir);
      const summary = await this.summarize(dir, live);
      if (summary) out.push({ summary, dir });
    }
    for (const dir of this.cache.keys()) if (!seen.has(dir)) this.cache.delete(dir);
    out.sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt));
    return out;
  }

  async find(trialId: string): Promise<IndexedTrial | null> {
    return (await this.list()).find((entry) => entry.summary.trialId === trialId) ?? null;
  }

  async detail(trialId: string): Promise<EvalTrialDetail | null> {
    const entry = await this.find(trialId);
    if (!entry) return null;
    const [result, score, postmortem, logTail, artifacts] = await Promise.all([
      readJson<ResultFile>(join(entry.dir, 'result.json')),
      readJson<ScoreFile>(join(entry.dir, 'score.json')),
      fs.readFile(join(entry.dir, 'postmortem.md'), 'utf8').catch(() => undefined),
      tailLines(join(entry.dir, 'log.txt'), LOG_TAIL_LINES),
      listArtifacts(entry.dir),
    ]);
    const axis = (name: string) => {
      const value = score?.axes?.[name];
      return typeof value?.score === 'number'
        ? { score: value.score, summary: value.summary ?? '' }
        : null;
    };
    const completion = axis('completion');
    const quality = axis('quality');
    const efficiency = axis('efficiency');
    const behavior = axis('behavior');
    return {
      trial: entry.summary,
      ...(completion && quality && efficiency && behavior
        ? {
            rubric: {
              completion,
              quality,
              efficiency,
              behavior,
              includedInModelAggregate: score?.eligibility?.includedInModelAggregate ?? true,
            },
          }
        : {}),
      ...(result?.failureClassEvidence
        ? { failureClassEvidence: result.failureClassEvidence }
        : {}),
      ...(postmortem ? { postmortemMarkdown: postmortem } : {}),
      logTail,
      artifacts,
    };
  }

  private async summarize(
    dir: string,
    live: ReadonlySet<string>,
  ): Promise<EvalTrialSummary | null> {
    const files = ['result.json', 'status.json', 'score.json', 'metrics.json'];
    const signature = (await Promise.all(files.map((f) => mtime(join(dir, f))))).join(':');
    const cached = this.cache.get(dir);
    if (cached && cached.signature === signature) return this.withLiveness(cached.summary, live);

    const [result, status, score, metrics] = await Promise.all([
      readJson<ResultFile>(join(dir, 'result.json')),
      readJson<StatusFile>(join(dir, 'status.json')),
      readJson<ScoreFile>(join(dir, 'score.json')),
      readJson<MetricsFile>(join(dir, 'metrics.json')),
    ]);
    const base = result ?? status;
    if (!base) return null;
    const trialId = base.trialId ?? basename(dir);
    const scenarioId = base.scenarioId;
    const modelId = base.modelId;
    const startedAt = base.startedAt;
    if (!scenarioId || !modelId || !startedAt) return null;

    const jobId = jobIdFor(this.runsDir, dir);
    const band = EvalRubricBandSchema.safeParse(score?.band);
    const decode = metrics?.derived?.genTokensPerSec ?? metrics?.derived?.meanTokensPerSec;
    const summary: EvalTrialSummary = {
      trialId,
      scenarioId,
      modelId,
      ...(base.engine ? { provider: base.engine } : {}),
      ...(jobId ? { jobId } : {}),
      startedAt,
      running: false,
      runDir: dir,
      ...(result
        ? {
            ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
            ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
            ...(typeof result.success === 'boolean' ? { success: result.success } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.failureMode ? { failureMode: result.failureMode } : {}),
            ...(result.failureClass ? { failureClass: result.failureClass } : {}),
            ...(result.failureClassRule ? { failureClassRule: result.failureClassRule } : {}),
            ...(result.generalistMode ? { generalistMode: result.generalistMode } : {}),
            ...(result.modelTier ? { modelTier: result.modelTier } : {}),
          }
        : {}),
      ...(typeof score?.composite === 'number' ? { composite: score.composite } : {}),
      ...(band.success ? { band: band.data as EvalRubricBand } : {}),
      ...(typeof decode === 'number' && decode > 0 ? { decodeTokensPerSec: decode } : {}),
    };
    this.cache.set(dir, { signature, summary });
    return this.withLiveness(summary, live);
  }

  /**
   * A started trial is running only while a live job owns it. Anything else
   * without a result was cut short (daemon restart, a killed CLI run) and must
   * not sit in the UI as "running" forever.
   */
  private withLiveness(summary: EvalTrialSummary, live: ReadonlySet<string>): EvalTrialSummary {
    if (summary.success !== undefined) return summary;
    if (live.has(summary.trialId)) return { ...summary, running: true };
    return { ...summary, running: false, reason: summary.reason ?? INTERRUPTED_REASON };
  }

  private async trialDirs(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const names = new Set(entries.map((e) => e.name));
      if (depth > 0 && (names.has('result.json') || names.has('status.json'))) {
        found.push(dir);
        return;
      }
      if (depth >= MAX_WALK_DEPTH) return;
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => walk(join(dir, e.name), depth + 1)),
      );
    };
    await walk(this.runsDir, 0);
    return found;
  }
}

/** `eval-runs/jobs/<jobId>/…` → jobId. */
function jobIdFor(runsDir: string, dir: string): string | undefined {
  const parts = relative(runsDir, dir).split(sep);
  return parts[0] === 'jobs' && parts[1] ? parts[1] : undefined;
}

async function tailLines(path: string, count: number): Promise<string[]> {
  const lines: string[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(path, 'utf8'),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      lines.push(line);
      if (lines.length > count) lines.shift();
    }
  } catch {
    return [];
  }
  return lines;
}

/** What the trial left in its captured artifacts and workspace snapshots. */
async function listArtifacts(trialDir: string): Promise<Array<{ path: string; bytes: number }>> {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_ARTIFACTS) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_ARTIFACTS) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(path);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path).catch(() => null);
        if (stat) out.push({ path: relative(trialDir, path), bytes: stat.size });
      }
    }
  };
  for (const root of ['artifacts', 'workspace']) await walk(join(trialDir, root));
  return out;
}
