import { constants } from 'node:fs';
import { access, link, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { TrialFacts } from './bin/score-trial.ts';
import {
  type AxisScore,
  type EvidenceRef,
  type FixedRubricScore,
  type TrialResultMetadata,
  scoreTrialFacts,
  validateScoreEvidence,
} from './fixed-rubric.ts';

const SNAPSHOT_DIRS = new Set([
  '.git',
  'artifacts',
  'keurmeester',
  'node_modules',
  'project-history',
  'sessions',
  'workspace',
]);

export type TrialReportStatus =
  | 'written'
  | 'skipped-active'
  | 'skipped-existing'
  | 'skipped-incomplete';

export interface TrialReportResult {
  trialDir: string;
  status: TrialReportStatus;
  score?: FixedRubricScore;
}

interface ResultJson extends TrialResultMetadata {
  trialId?: string;
  scenarioId?: string;
  modelId?: string;
  success?: boolean;
  failureMode?: string;
  reason?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Find likely trial directories without descending into captured workspaces.
 * A status/facts/result marker makes a directory a leaf for discovery.
 */
export async function discoverTrialCandidates(root: string): Promise<string[]> {
  const found: string[] = [];
  const absoluteRoot = resolve(root);

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('status.json') || names.has('facts.json') || names.has('result.json')) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SNAPSHOT_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name));
    }
  };

  await walk(absoluteRoot);
  return found.sort((a, b) => a.localeCompare(b));
}

function compactJson(value: unknown, limit = 180): string {
  const raw = JSON.stringify(value) ?? String(value);
  const oneLine = raw.replace(/\s+/g, ' ').replace(/`/g, "'");
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatEvidence(ref: EvidenceRef): string {
  return `\`${ref.source}.${ref.path}: ${compactJson(ref.value)}\``;
}

function axisWhy(axis: AxisScore): string {
  const adjustments = axis.adjustments?.map((item) => item.summary).join(' ') ?? '';
  const evidence = axis.evidence.map(formatEvidence).join('; ');
  return escapeTable(`${axis.summary}${adjustments ? ` ${adjustments}` : ''} ${evidence}`);
}

function recordAt(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function metric(value: unknown, suffix = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}${suffix}` : 'n/a';
}

function performanceRows(facts: TrialFacts): string[] {
  const peakRss = recordAt(facts, 'perf.process.peakRssMb');
  const peakGpu = recordAt(facts, 'perf.gpu.peakUtilPercent');
  const peakGpuMem = recordAt(facts, 'perf.gpu.peakMemUsedMb');
  const totalGpuMem = recordAt(facts, 'perf.gpu.memTotalMb');
  const memoryModel = recordAt(facts, 'perf.gpu.memoryModel');
  const peakSysMem = recordAt(facts, 'perf.systemMemory.peakUsedMb');
  const totalSysMem = recordAt(facts, 'perf.systemMemory.totalMb');
  const meanTps = recordAt(facts, 'perf.derived.meanTokensPerSec');
  const inputTokens = recordAt(facts, 'perf.usage.totalInputTokens');
  const outputTokens = recordAt(facts, 'perf.usage.totalOutputTokens');
  const cpu = recordAt(facts, 'host.cpuModel');
  const ram = recordAt(facts, 'host.totalRamGb');
  const gpu = recordAt(facts, 'host.gpuModel');
  const framework = recordAt(facts, 'host.framework');
  const binary = recordAt(facts, 'host.frameworkBinary');
  const tokenText =
    typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? `${inputTokens} + ${outputTokens}`
      : 'n/a';
  const hostText = [
    typeof cpu === 'string' ? cpu.trim() : null,
    typeof ram === 'number' ? `${ram} GB RAM` : null,
    typeof gpu === 'string' ? gpu : null,
  ]
    .filter(Boolean)
    .join(', ');
  const frameworkText = [framework, binary]
    .filter((item) => typeof item === 'string')
    .join(' via ');

  return [
    `| Peak RSS | ${metric(peakRss, ' MB')} | \`facts.perf.process.peakRssMb\` |`,
    `| Peak GPU util | ${metric(peakGpu, '%')} | \`facts.perf.gpu.peakUtilPercent\` |`,
    // On a unified-memory host there is no discrete VRAM to report; saying so
    // beats printing "n/a" (or the old 0, which read as "used no memory").
    `| Peak GPU memory | ${
      memoryModel === 'unified'
        ? 'unified with system RAM — see next row'
        : `${metric(peakGpuMem, ' MB')} / ${metric(totalGpuMem, ' MB')}`
    } | \`facts.perf.gpu.peakMemUsedMb\`, \`facts.perf.gpu.memoryModel\` |`,
    `| Peak system memory | ${metric(peakSysMem, ' MB')} / ${metric(totalSysMem, ' MB')} | \`facts.perf.systemMemory.peakUsedMb\`, \`facts.perf.systemMemory.totalMb\` |`,
    `| Mean tokens/sec | ${metric(meanTps)} | \`facts.perf.derived.meanTokensPerSec\` |`,
    `| Total tokens | ${tokenText} | \`facts.perf.usage.totalInputTokens\`, \`facts.perf.usage.totalOutputTokens\` |`,
    `| Host | ${escapeTable(hostText || 'n/a')} | \`facts.host.cpuModel\`, \`facts.host.totalRamGb\`, \`facts.host.gpuModel\` |`,
    `| Framework | ${escapeTable(frameworkText || 'n/a')} | \`facts.host.framework\`, \`facts.host.frameworkBinary\` |`,
  ];
}

function nativeReliabilitySection(facts: TrialFacts): string[] {
  const incidents = facts.nativeEngineIncidents;
  if (!incidents) return [];
  const kinds = Object.entries(incidents.kinds)
    .map(([kind, count]) => `${kind} x${count}`)
    .join(', ');
  return [
    '## Native-engine reliability',
    '',
    `- Unexpected exits: ${incidents.count} (${kinds || 'unclassified'}).`,
    `- Incident IDs: ${incidents.incidentIds.map((id) => `\`${id}\``).join(', ')}.`,
    ...incidents.evidence.map((item) => `- Evidence: ${item.replace(/`/g, "'")}`),
    '',
  ];
}

function evidenceSection(name: string, axis: AxisScore): string[] {
  const lines = [`### ${name} - ${axis.ruleId}`, '', axis.summary];
  if (axis.adjustments) {
    for (const adjustment of axis.adjustments) {
      lines.push('', `- Adjustment ${adjustment.ruleId}: ${adjustment.summary}`);
    }
  }
  lines.push('');
  for (const ref of axis.evidence) lines.push(`- ${formatEvidence(ref)}`);
  return lines;
}

/** Render only evidence-backed sections; analysis/recommendations are a separate phase. */
export function renderDeterministicPostmortem(facts: TrialFacts, score: FixedRubricScore): string {
  const outcome = facts.outcome.success ? 'success' : (facts.outcome.failureMode ?? 'failed');
  const durationSeconds = Math.round(facts.outcome.durationMs / 1000);
  const duration = `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`;
  const eligibility = score.eligibility.includedInModelAggregate
    ? `included (${score.eligibility.failureClass})`
    : `excluded from model aggregate (${score.eligibility.failureClass}${score.eligibility.failureClassRule ? ` / ${score.eligibility.failureClassRule}` : ''})`;
  const lines = [
    '<!-- BEGIN GENERATED FIXED-RUBRIC SCORE; DO NOT EDIT -->',
    `# Trial postmortem - ${facts.scenarioId} / ${facts.modelId}`,
    '',
    `**Composite: ${score.composite.toFixed(1)} / 10** (band: ${score.band})`,
    `**Outcome: ${outcome}** (duration: ${duration}; budget used: ${(facts.outcome.budgetUsedFraction * 100).toFixed(1)}%)`,
    `**Model aggregate eligibility: ${eligibility}.**`,
    '',
    '## Score breakdown',
    '',
    '| Axis | Score | Why |',
    '|---|---:|---|',
    `| Task completion (40%) | ${score.axes.completion.score} / 10 | ${axisWhy(score.axes.completion)} |`,
    `| Output quality (25%) | ${score.axes.quality.score} / 10 | ${axisWhy(score.axes.quality)} |`,
    `| Process efficiency (20%) | ${score.axes.efficiency.score} / 10 | ${axisWhy(score.axes.efficiency)} |`,
    `| Behavior soundness (15%) | ${score.axes.behavior.score} / 10 | ${axisWhy(score.axes.behavior)} |`,
    '',
    `Composite = 0.4 * ${score.axes.completion.score} + 0.25 * ${score.axes.quality.score} + 0.2 * ${score.axes.efficiency.score} + 0.15 * ${score.axes.behavior.score} = **${score.composite.toFixed(1)}**.`,
    '',
    '## Performance',
    '',
    'Performance is reported separately and does not affect the capability composite.',
    '',
    '| Metric | Value | Source |',
    '|---|---:|---|',
    ...performanceRows(facts),
    '',
    ...nativeReliabilitySection(facts),
    '## Evidence map',
    '',
    ...evidenceSection('Task completion', score.axes.completion),
    '',
    ...evidenceSection('Output quality', score.axes.quality),
    '',
    ...evidenceSection('Process efficiency', score.axes.efficiency),
    '',
    ...evidenceSection('Behavior soundness', score.axes.behavior),
    '',
    '## Evidence-led observations',
    '',
    `- Completion: ${score.axes.completion.summary} ${score.axes.completion.evidence.map(formatEvidence).join('; ')}`,
    `- Quality: ${score.axes.quality.summary} ${score.axes.quality.evidence.map(formatEvidence).join('; ')}`,
    `- Efficiency: ${score.axes.efficiency.summary} ${score.axes.efficiency.evidence.map(formatEvidence).join('; ')}`,
    `- Behavior: ${score.axes.behavior.summary} ${score.axes.behavior.evidence.map(formatEvidence).join('; ')}`,
    '',
    '## Raw evidence',
    '',
    '- Machine-readable fixed score: `score.json`.',
    '- Extracted observable facts: `facts.json`.',
    '- Terminal trial metadata and failure classification: `result.json`.',
    '<!-- END GENERATED FIXED-RUBRIC SCORE -->',
    '',
    '## Enrichment needed',
    '',
    'This deterministic report intentionally does not invent tactical or strategic recommendations. A follow-up evidence review should inspect `daemon.log`, model tuning, and relevant framework modules before adding:',
    '',
    '- Tactical fixes with a concrete file, field, and proposed value.',
    '- Strategic framework fixes tied to a reusable failure mode.',
    '- A cross-scenario generalization check and next experiment.',
    '',
  ];
  return lines.join('\n');
}

async function atomicWrite(path: string, content: string, force: boolean): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    if (!force) {
      // A hard-link publish is atomic and fails if another writer won the race.
      await link(temp, path);
      await rm(temp, { force: true });
      return;
    }
    try {
      await rename(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      // Windows may reject rename-over-existing. Keep the non-atomic gap as
      // narrow as possible; the completed temp already lives beside target.
      await rm(path, { force: true });
      await rename(temp, path);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function writeTrialReport(
  trialDir: string,
  opts: { force?: boolean } = {},
): Promise<TrialReportResult> {
  const dir = resolve(trialDir);
  const statusPath = join(dir, 'status.json');
  const factsPath = join(dir, 'facts.json');
  const resultPath = join(dir, 'result.json');
  const scorePath = join(dir, 'score.json');
  const postmortemPath = join(dir, 'postmortem.md');

  if (await pathExists(statusPath)) return { trialDir: dir, status: 'skipped-active' };
  if (!(await pathExists(factsPath)) || !(await pathExists(resultPath))) {
    return { trialDir: dir, status: 'skipped-incomplete' };
  }
  const force = opts.force ?? false;
  const scoreExists = await pathExists(scorePath);
  const postmortemExists = await pathExists(postmortemPath);
  if (!force && scoreExists !== postmortemExists) {
    throw new Error(
      `partial report pair at ${dir}; score.json and postmortem.md must either both exist or both be absent (use --force to repair)`,
    );
  }
  if (!force && scoreExists && postmortemExists) {
    return { trialDir: dir, status: 'skipped-existing' };
  }

  const [facts, result] = await Promise.all([
    readJson<TrialFacts>(factsPath),
    readJson<ResultJson>(resultPath),
  ]);
  const score = scoreTrialFacts(facts, result);
  validateScoreEvidence(score, facts, result);
  const scoreJson = `${JSON.stringify(score, null, 2)}\n`;
  const postmortem = renderDeterministicPostmortem(facts, score);

  await atomicWrite(scorePath, scoreJson, force);
  await atomicWrite(postmortemPath, postmortem, force);
  return { trialDir: dir, status: 'written', score };
}
