#!/usr/bin/env -S npx tsx
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FixedRubricScore } from '../fixed-rubric.ts';
import { discoverTrialCandidates } from '../postmortem-report.ts';
import type { TrialFacts } from './score-trial.ts';

interface TrialResult {
  failureClass?: string;
  failureClassRule?: string;
  failureClassEvidence?: string;
}

interface TrialEntry {
  root: string;
  dir: string;
  facts: TrialFacts;
  score: FixedRubricScore;
  result: TrialResult;
  postmortem: string;
}

interface ModelTuningTarget {
  manifest: string;
  compactToolSchemas: boolean;
  buildPrelude: boolean;
  codingTemperature: { current: number; proposed: number };
  generalTemperature: { current: number; proposed: number };
  efficiency: { field: string; current: number; proposed: number };
  cleanRun: { field: string; current: number; proposed: number };
}

const MODEL_TUNING: Readonly<Record<string, ModelTuningTarget>> = {
  'qwen3.5-2b': {
    manifest: '../gilde/data/chat-models/qw/qwen3.5-2b-q4/manifest.json',
    compactToolSchemas: false,
    buildPrelude: false,
    codingTemperature: { current: 0.5, proposed: 0.3 },
    generalTemperature: { current: 0.6, proposed: 0.4 },
    efficiency: { field: 'tuning.reasoning.thinkingBudget', current: 2048, proposed: 1024 },
    cleanRun: { field: 'tuning.reasoning.thinkingBudget', current: 2048, proposed: 1536 },
  },
  'qwen3.5-4b': {
    manifest: '../gilde/data/chat-models/qw/qwen3.5-4b-q4/manifest.json',
    compactToolSchemas: false,
    buildPrelude: false,
    codingTemperature: { current: 0.5, proposed: 0.3 },
    generalTemperature: { current: 0.6, proposed: 0.4 },
    efficiency: { field: 'tuning.reasoning.thinkingBudget', current: 2048, proposed: 1024 },
    cleanRun: { field: 'tuning.reasoning.thinkingBudget', current: 2048, proposed: 1536 },
  },
  'qwen3.5-9b': {
    manifest: '../gilde/data/chat-models/qw/qwen3.5-9b-q4/manifest.json',
    compactToolSchemas: true,
    buildPrelude: true,
    codingTemperature: { current: 0.5, proposed: 0.3 },
    generalTemperature: { current: 0.6, proposed: 0.4 },
    efficiency: { field: 'tuning.reasoning.thinkingBudget', current: 2048, proposed: 1024 },
    cleanRun: { field: 'tuning.sampling.maxTokens', current: 16384, proposed: 12288 },
  },
  'gemma4-e4b-q8': {
    manifest: '../gilde/data/chat-models/ge/gemma4-e4b-q8/manifest.json',
    compactToolSchemas: true,
    buildPrelude: true,
    codingTemperature: { current: 0.3, proposed: 0.2 },
    generalTemperature: { current: 0.9, proposed: 0.7 },
    efficiency: { field: 'tuning.reasoning.thinkingBudget', current: 96, proposed: 64 },
    cleanRun: {
      field: 'tuning.profiles.thinking-general.sampling.maxTokens',
      current: 8192,
      proposed: 6144,
    },
  },
  'gemma4-12b-q4': {
    manifest: '../gilde/data/chat-models/ge/gemma4-12b-q4/manifest.json',
    compactToolSchemas: true,
    buildPrelude: true,
    codingTemperature: { current: 0.6, proposed: 0.4 },
    generalTemperature: { current: 0.8, proposed: 0.6 },
    efficiency: { field: 'tuning.reasoning.thinkingBudget', current: 256, proposed: 128 },
    cleanRun: {
      field: 'tuning.profiles.thinking-general.sampling.maxTokens',
      current: 2048,
      proposed: 1536,
    },
  },
};

const GENERATED_MARKER = '<!-- BEGIN EVIDENCE ENRICHMENT; GENERATED FROM FACTS/SCORES -->';
const SNAPSHOT_NOTE =
  "All citations below resolve to this trial's `facts.json`/`score.json` or to sibling scored trials named in the comparison.";

function compact(value: unknown, limit = 220): string {
  const text = (JSON.stringify(value) ?? String(value)).replace(/\s+/g, ' ').replace(/`/g, "'");
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function cite(path: string, value: unknown): string {
  return `\`${path}: ${compact(value)}\``;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function fmt1(value: number): string {
  return value.toFixed(1);
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function numberAt(value: unknown, path: string): number | null {
  const found = valueAt(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function atomicReplace(path: string, content: string): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(temp, content, 'utf8');
  try {
    try {
      await rename(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await rm(path, { force: true });
      await rename(temp, path);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function loadEntries(roots: string[]): Promise<TrialEntry[]> {
  const entries: TrialEntry[] = [];
  for (const rawRoot of roots) {
    const root = resolve(rawRoot);
    for (const dir of await discoverTrialCandidates(root)) {
      try {
        const [facts, score, result, postmortem] = await Promise.all([
          readJson<TrialFacts>(join(dir, 'facts.json')),
          readJson<FixedRubricScore>(join(dir, 'score.json')),
          readJson<TrialResult>(join(dir, 'result.json')),
          readFile(join(dir, 'postmortem.md'), 'utf8'),
        ]);
        entries.push({ root, dir, facts, score, result, postmortem });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`cannot load scored trial ${dir}: ${String(error)}`);
      }
    }
  }
  const byPair = new Map<string, TrialEntry>();
  for (const entry of entries) {
    const key = `${entry.facts.modelId}\u0000${entry.facts.scenarioId}`;
    const existing = byPair.get(key);
    if (existing) {
      throw new Error(
        `duplicate model/scenario pair: ${entry.facts.modelId}/${entry.facts.scenarioId}\n${existing.dir}\n${entry.dir}`,
      );
    }
    byPair.set(key, entry);
  }
  return entries.sort(
    (a, b) =>
      a.facts.modelId.localeCompare(b.facts.modelId) ||
      a.facts.scenarioId.localeCompare(b.facts.scenarioId),
  );
}

function isCriticalOutput(entry: TrialEntry): boolean {
  return (
    entry.score.axes.completion.ruleId === 'C_CRITICAL_OUTPUT' ||
    entry.score.axes.quality.ruleId === 'Q_CRITICAL_OUTPUT'
  );
}

function noProducedOutput(entry: TrialEntry): boolean {
  return (
    entry.score.axes.quality.ruleId === 'Q_NO_PRODUCED_OUTPUT' ||
    entry.facts.timing.timeToFirstArtifactMs === null
  );
}

function topTool(entry: TrialEntry): [string, number] | null {
  return (
    Object.entries(entry.facts.toolUse.byTool).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0] ?? null
  );
}

function tuningTarget(entry: TrialEntry): ModelTuningTarget {
  const target = MODEL_TUNING[entry.facts.modelId];
  if (!target) throw new Error(`missing model tuning target for ${entry.facts.modelId}`);
  return target;
}

function tacticalFix(entry: TrialEntry): string[] {
  const facts = entry.facts;
  const target = tuningTarget(entry);
  const redFlag = facts.toolUse.redFlags[0];
  if (redFlag) {
    if (!target.compactToolSchemas) {
      return [
        `- **Tool-call surface experiment:** add \`"mcp.compact-tool-schemas"\` to \`${target.manifest}\` -> \`behaviors\`, then rerun a tool-heavy and a file-writing scenario. The observed \`${redFlag.pattern}\` call (${cite('facts.toolUse.redFlags[0]', redFlag)}) is a generic tool-selection/schema-attention failure, not a scenario recipe.`,
      ];
    }
    return [
      `- **Tool-call prompt experiment:** in \`packages/service/src/model-profile/behaviors/prompt-tool-cookbook-${target.manifest.includes('gemma4-12b') ? 'full' : 'condensed'}.ts\`, add the explicit invariant “invoke listed MCP tools directly; never substitute an npm/shell command for a listed tool.” Keep the current manifest behavior enabled. This targets ${cite('facts.toolUse.redFlags[0].pattern', redFlag.pattern)} while remaining task-agnostic.`,
    ];
  }
  if (isCriticalOutput(entry)) {
    return [
      `- **Parse-stability experiment:** lower \`${target.manifest}\` -> \`tuning.profiles.thinking-coding.sampling.temperature\` from \`${target.codingTemperature.current}\` to \`${target.codingTemperature.proposed}\`, and A/B on this scenario plus an unrelated code-writing scenario. The change is justified by ${cite('facts.sniff.latest', facts.sniff.latest)} and should be accepted only if parse failures fall without reducing unrelated composites.`,
    ];
  }
  if (noProducedOutput(entry)) {
    if (!target.buildPrelude) {
      return [
        `- **Immediate-action experiment:** add \`"prompt.meester-build-prelude"\` to \`${target.manifest}\` -> \`behaviors\`. The trial never reached an authored artifact (${cite('facts.timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs)}; ${cite('facts.sniff.latest', facts.sniff.latest)}), so measure whether a generic act-before-narrating prelude improves first-tool and first-artifact latency across two unrelated tasks.`,
      ];
    }
    return [
      `- **Deliberation experiment:** lower \`${target.manifest}\` -> \`tuning.profiles.thinking-general.sampling.temperature\` from \`${target.generalTemperature.current}\` to \`${target.generalTemperature.proposed}\`. The no-output signal (${cite('facts.timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs)}) warrants a bounded A/B for faster commitment to a tool call, not a model-size conclusion.`,
    ];
  }
  if (facts.autoAnswer.total >= 2) {
    return [
      `- **Question-avoidance prompt experiment:** in \`packages/service/src/model-profile/behaviors/prompt-private-reasoning-guidance.ts\`, add “infer reversible defaults; ask only when the answer changes scope or creates an irreversible side effect.” This trial needed ${facts.autoAnswer.total} interventions (${cite('facts.autoAnswer.total', facts.autoAnswer.total)}); validate against one unrelated scenario before promoting the wording.`,
    ];
  }
  if (facts.outcome.budgetUsedFraction > 0.5 || facts.toolUse.totalToolCalls > 10) {
    return [
      `- **Budget experiment:** change \`${target.manifest}\` -> \`${target.efficiency.field}\` from \`${target.efficiency.current}\` to \`${target.efficiency.proposed}\` for one A/B arm. The trial used ${(facts.outcome.budgetUsedFraction * 100).toFixed(1)}% of its budget and ${facts.toolUse.totalToolCalls} tool calls (${cite('facts.outcome.budgetUsedFraction', facts.outcome.budgetUsedFraction)}; ${cite('facts.toolUse.totalToolCalls', facts.toolUse.totalToolCalls)}). Keep the change only if completion and quality remain stable across an unrelated task.`,
    ];
  }
  return [
    `- **Headroom experiment:** retain the successful behavior as the baseline, and A/B \`${target.manifest}\` -> \`${target.cleanRun.field}\` from \`${target.cleanRun.current}\` to \`${target.cleanRun.proposed}\`. The run was already efficient (${cite('facts.outcome.budgetUsedFraction', facts.outcome.budgetUsedFraction)}; ${cite('facts.toolUse.totalToolCalls', facts.toolUse.totalToolCalls)}), so the only justified tweak is a conservative resource reduction with a no-regression requirement.`,
  ];
}

function strategicFix(entry: TrialEntry): string[] {
  const facts = entry.facts;
  const redFlag = facts.toolUse.redFlags[0];
  if (facts.team.missingExpectedRoles.length > 0 || redFlag) {
    return [
      `- **Role/tool routing:** update \`packages/service/src/chat/role-tool-filter.ts\` and its tests so required role capabilities remain visible and shell/npm surrogates for MCP tools are rejected with a corrective hint. Evidence: ${cite('facts.team.missingExpectedRoles', facts.team.missingExpectedRoles)}; ${cite('facts.toolUse.redFlags', facts.toolUse.redFlags)}. Measure the same failure pattern across all five models, not only this scenario.`,
    ];
  }
  if (isCriticalOutput(entry)) {
    return [
      `- **Pre-terminal validation:** route authored HTML/JavaScript through \`packages/service/src/model-profile/behaviors/validate-inline-js-parses.ts\` from \`packages/service/src/chat/deliverable-gate.ts\`, with one bounded repair turn before completion. The recorded gate evidence is ${cite('facts.sniff.latest', facts.sniff.latest)} and the terminal reason is ${cite('facts.outcome.reason', facts.outcome.reason)}.`,
    ];
  }
  if (noProducedOutput(entry)) {
    return [
      `- **First-artifact deadline:** extend \`packages/service/src/chat/task-budget.ts\` and \`packages/service/src/chat/deliverable-contract.ts\` with a telemetry-backed first-tool/first-artifact checkpoint that nudges or replans before the watchdog. Evidence: ${cite('facts.timing.timeToFirstToolCallMs', facts.timing.timeToFirstToolCallMs)}; ${cite('facts.timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs)}; ${cite('facts.outcome.reason', facts.outcome.reason)}.`,
    ];
  }
  if (facts.autoAnswer.total >= 2) {
    return [
      `- **Question ergonomics:** have \`packages/service/src/chat/questions.ts\` classify reversible/defaultable questions and let \`packages/service/src/chat/phase-gate.ts\` answer those from project context before surfacing them. This trial required ${facts.autoAnswer.total} interventions (${cite('facts.autoAnswer.byKind', facts.autoAnswer.byKind)}).`,
    ];
  }
  const writeCalls =
    // Legacy `writeFile` key kept for scoring pre-rename run dirs.
    (facts.toolUse.byTool.writeFile ?? 0) +
    (facts.toolUse.byTool.write_artifact ?? 0) +
    (facts.toolUse.byTool.write_file ?? 0);
  if (writeCalls >= 3) {
    return [
      `- **Write/validate ergonomics:** add a validated patch/replace-section mode beside the existing write tools in \`packages/mcp/src/server.ts\`, and expose its result through \`packages/service/src/chat/deliverable-gate.ts\`. The trial made ${writeCalls} write calls (${cite('facts.toolUse.byTool', facts.toolUse.byTool)}), so measure whether the new path reduces rewrites without lowering gate completion.`,
    ];
  }
  const top = topTool(entry);
  return [
    `- **Adaptive early finish:** teach \`packages/service/src/chat/deliverable-gate.ts\` to stop or collapse the team once the deterministic contract is satisfied, while recording the decision in \`packages/service/src/chat/session-telemetry.ts\`. This clean run passed with ${facts.toolUse.totalToolCalls} calls${top ? ` (top tool \`${top[0]}\`: ${top[1]})` : ''} and ${(facts.outcome.budgetUsedFraction * 100).toFixed(1)}% budget (${cite('facts.outcome.success', facts.outcome.success)}; ${cite('facts.toolUse.byTool', facts.toolUse.byTool)}).`,
  ];
}

function signature(entry: TrialEntry): string {
  return [
    entry.score.axes.completion.ruleId,
    entry.score.axes.quality.ruleId,
    entry.score.axes.behavior.ruleId,
  ].join(' / ');
}

function chooseUnrelated(entry: TrialEntry, sameModel: TrialEntry[]): TrialEntry | null {
  const craftbook = entry.facts.scenarioId.startsWith('craftbook-');
  const others = sameModel.filter((candidate) => candidate !== entry);
  return (
    others.find(
      (candidate) =>
        candidate.facts.scenarioId.startsWith('craftbook-') !== craftbook &&
        candidate.score.axes.completion.ruleId === entry.score.axes.completion.ruleId,
    ) ??
    others.find((candidate) => candidate.facts.scenarioId.startsWith('craftbook-') !== craftbook) ??
    others[0] ??
    null
  );
}

function axisObservation(prefix: string, axis: FixedRubricScore['axes']['completion']): string {
  return `- ${prefix}${axis.summary} ${axis.evidence
    .map((ref) => cite(`${ref.source}.${ref.path}`, ref.value))
    .join('; ')}.`;
}

function positiveObservations(entry: TrialEntry): string[] {
  const facts = entry.facts;
  const lines: string[] = [];
  if (facts.outcome.success) {
    lines.push(axisObservation('', entry.score.axes.completion));
  } else if ((facts.sniff.latest?.bytes ?? 0) > 0) {
    lines.push(
      `- The run produced an inspectable artifact and measurable gate progress before termination (${cite('facts.timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs)}; ${cite('facts.sniff.latest', facts.sniff.latest)}).`,
    );
  } else if (facts.timing.timeToFirstToolCallMs !== null) {
    lines.push(
      `- The run took an observable tool action before termination (${cite('facts.timing.timeToFirstToolCallMs', facts.timing.timeToFirstToolCallMs)}; ${cite('facts.toolUse.totalToolCalls', facts.toolUse.totalToolCalls)}).`,
    );
  } else {
    lines.push(
      `- The terminal miss is fully captured for diagnosis rather than silently dropped (${cite('facts.outcome.reason', facts.outcome.reason)}; ${cite('score.eligibility.failureClass', entry.score.eligibility.failureClass)}).`,
    );
  }

  if (
    facts.toolUse.redFlags.length === 0 &&
    facts.team.missingExpectedRoles.length === 0 &&
    facts.autoAnswer.total <= 1
  ) {
    lines.push(
      `- The behavior trace is clean: no red flags, no missing expected roles, and at most one intervention (${cite('facts.toolUse.redFlags', facts.toolUse.redFlags)}; ${cite('facts.team.missingExpectedRoles', facts.team.missingExpectedRoles)}; ${cite('facts.autoAnswer.total', facts.autoAnswer.total)}).`,
    );
  } else if (
    facts.artifacts.htmlFiles.length +
      facts.artifacts.imageFiles.length +
      facts.artifacts.otherFileCount >
    0
  ) {
    lines.push(
      `- The run left inspectable deliverables despite the behavior issue (${cite('facts.artifacts.htmlFiles', facts.artifacts.htmlFiles)}; ${cite('facts.artifacts.imageFiles', facts.artifacts.imageFiles)}; ${cite('facts.artifacts.otherFileCount', facts.artifacts.otherFileCount)}).`,
    );
  } else {
    lines.push(
      `- The trace records an actionable behavior signal for a reusable framework fix (${cite('facts.toolUse.redFlags', facts.toolUse.redFlags)}; ${cite('facts.team.missingExpectedRoles', facts.team.missingExpectedRoles)}; ${cite('facts.autoAnswer.total', facts.autoAnswer.total)}).`,
    );
  }
  return lines;
}

function negativeObservations(entry: TrialEntry): string[] {
  const lines: string[] = [];
  if (!entry.facts.outcome.success) {
    lines.push(axisObservation('', entry.score.axes.completion));
  } else if (entry.score.axes.efficiency.score < 10) {
    lines.push(axisObservation('Remaining efficiency headroom: ', entry.score.axes.efficiency));
  } else {
    lines.push(
      `- No task-completion defect was observed; remaining headroom is resource reduction under a no-regression constraint (${cite('score.composite', entry.score.composite)}; ${cite('facts.outcome.budgetUsedFraction', entry.facts.outcome.budgetUsedFraction)}; ${cite('facts.toolUse.totalToolCalls', entry.facts.toolUse.totalToolCalls)}).`,
    );
  }

  if (entry.score.axes.quality.score < 10) {
    lines.push(axisObservation('', entry.score.axes.quality));
  } else if (entry.score.axes.behavior.score < 10) {
    lines.push(axisObservation('', entry.score.axes.behavior));
  } else if (entry.score.axes.efficiency.score < 10 && !entry.facts.outcome.success) {
    lines.push(axisObservation('', entry.score.axes.efficiency));
  } else {
    lines.push(
      `- No output-quality or behavior defect was observed; tactical headroom is limited to efficiency experiments (${cite('score.axes.quality.score', entry.score.axes.quality.score)}; ${cite('score.axes.behavior.score', entry.score.axes.behavior.score)}).`,
    );
  }
  return lines;
}

function renderEnrichment(
  entry: TrialEntry,
  all: TrialEntry[],
  byScenario: Map<string, TrialEntry[]>,
  byModel: Map<string, TrialEntry[]>,
  summaryPath: string,
): string {
  const scenarioPeers = byScenario.get(entry.facts.scenarioId) ?? [];
  const modelPeers = byModel.get(entry.facts.modelId) ?? [];
  const peerScores = scenarioPeers.map((peer) => peer.score.composite);
  const sortedPeers = [...scenarioPeers].sort(
    (a, b) =>
      b.score.composite - a.score.composite || a.facts.modelId.localeCompare(b.facts.modelId),
  );
  const rank = sortedPeers.findIndex((peer) => peer === entry) + 1;
  const modelIncluded = modelPeers.filter(
    (peer) => peer.score.eligibility.includedInModelAggregate,
  );
  const sameSignature = modelPeers.filter((peer) => signature(peer) === signature(entry));
  const globalSignature = all.filter((peer) => signature(peer) === signature(entry));
  const signatureModels = new Set(globalSignature.map((peer) => peer.facts.modelId)).size;
  const unrelated = chooseUnrelated(entry, modelPeers);
  const peerList = sortedPeers
    .map(
      (peer) =>
        `${peer.facts.modelId} ${fmt1(peer.score.composite)}${peer.facts.outcome.success ? ' pass' : ' fail'}${peer.score.eligibility.includedInModelAggregate ? '' : ' excluded'}`,
    )
    .join('; ');
  const modelScores = modelIncluded.map((peer) => peer.score.composite);
  const deltaFromModelMedian = entry.score.composite - median(modelScores);
  const sameScenarioSpread = Math.max(...peerScores) - Math.min(...peerScores);
  const lines = [
    GENERATED_MARKER,
    '## Evidence-based enrichment',
    '',
    SNAPSHOT_NOTE,
    '',
    '### Positives',
    '',
    ...positiveObservations(entry),
    '',
    '### Negatives / remaining headroom',
    '',
    ...negativeObservations(entry),
    '',
    '### Tactical fixes (parameter and prompt tuning)',
    '',
    ...tacticalFix(entry),
    '',
    '### Strategic fixes (framework)',
    '',
    ...strategicFix(entry),
    '',
    '### Same-scenario comparison',
    '',
    `- Across ${scenarioPeers.length} local models, this scenario has median composite **${fmt1(median(peerScores))}**, range **${fmt1(Math.min(...peerScores))}-${fmt1(Math.max(...peerScores))}**, and ${scenarioPeers.filter((peer) => peer.facts.outcome.success).length}/${scenarioPeers.length} successful terminal verdicts. This trial ranks **${rank}/${scenarioPeers.length}**. Evidence from sibling \`score.json\`/\`facts.json\`: ${peerList}.`,
    '',
    '### Cross-scenario generalization check',
    '',
    `- Within ${entry.facts.modelId}, the eligible ${modelIncluded.length}-scenario aggregate has median **${fmt1(median(modelScores))}** and mean **${fmt1(mean(modelScores))}**; this trial is ${deltaFromModelMedian >= 0 ? '+' : ''}${fmt1(deltaFromModelMedian)} from that median. The exact rubric signature \`${signature(entry)}\` occurs in ${sameSignature.length}/${modelPeers.length} trials for this model and ${globalSignature.length}/${all.length} trials across ${signatureModels} model(s).`,
    unrelated
      ? `- Unrelated comparison: \`${unrelated.facts.scenarioId}\` scored **${fmt1(unrelated.score.composite)}** with signature \`${signature(unrelated)}\` (${cite('sibling score.json.composite', unrelated.score.composite)}; ${cite('sibling facts.outcome.success', unrelated.facts.outcome.success)}). This is the required guard against tuning only the current scenario.`
      : '- No unrelated scenario was available in this matrix.',
    '- **Why this is not test overfit:** the proposed change is tied to a rubric rule, tool/role signal, parse failure, intervention count, or budget invariant that is counted across the full matrix; no scenario name, selector, expected string, or implementation recipe is proposed for a model prompt.',
    '- **Overfit risk:** every tactical change remains an experiment until this scenario and the unrelated comparison both hold or improve under the fixed rubric.',
    '',
    '### Strategic note',
    '',
    sameScenarioSpread >= 2
      ? `- The same-scenario cross-model spread is ${fmt1(sameScenarioSpread)} points. Treat the gap as a prompt/tool/runtime sensitivity to investigate in the cited modules, not as evidence of a model capability ceiling.`
      : `- The same-scenario cross-model spread is ${fmt1(sameScenarioSpread)} points, so this result is comparatively stable; prioritize efficiency and broad regression coverage over scenario-specific tuning.`,
    '',
    '### Recommended next experiment',
    '',
    unrelated
      ? `Re-run \`${entry.facts.scenarioId}\` and \`${unrelated.facts.scenarioId}\` with the single tactical change above; require no composite regression on either and a reduction in the cited failure/efficiency signal before adopting it.`
      : 'Re-run this scenario plus one unrelated task with the single tactical change above; require no composite regression and a reduction in the cited signal before adopting it.',
    '',
    '### Enrichment evidence paths',
    '',
    '- Trial facts: `facts.json`.',
    '- Fixed-rubric score: `score.json`.',
    '- Terminal classification: `result.json`.',
    `- Matrix-wide synthesis: \`${summaryPath}\`.`,
    '<!-- END EVIDENCE ENRICHMENT -->',
    '',
  ];
  return lines.join('\n');
}

function replaceEnrichment(postmortem: string, enrichment: string): string {
  const generatedIndex = postmortem.indexOf(GENERATED_MARKER);
  const placeholderIndex = postmortem.indexOf('## Enrichment needed');
  const cut = generatedIndex >= 0 ? generatedIndex : placeholderIndex;
  if (cut < 0) {
    throw new Error('postmortem has neither generated enrichment nor enrichment placeholder');
  }
  return `${postmortem.slice(0, cut).trimEnd()}\n\n${enrichment}`;
}

function countBy<T>(items: T[], key: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderMatrixSummary(entries: TrialEntry[], roots: string[]): string {
  const models = [...new Set(entries.map((entry) => entry.facts.modelId))].sort();
  const scenarios = [...new Set(entries.map((entry) => entry.facts.scenarioId))].sort();
  const byModel = new Map(
    models.map((model) => [model, entries.filter((entry) => entry.facts.modelId === model)]),
  );
  const byScenario = new Map(
    scenarios.map((scenario) => [
      scenario,
      entries.filter((entry) => entry.facts.scenarioId === scenario),
    ]),
  );
  const lines = [
    '# Full local-model eval matrix summary',
    '',
    `Generated from **${entries.length} terminal fixed-rubric trials**: ${models.length} models x ${scenarios.length} scenarios. Capability scores exclude trials classified as infra/operator/grader from model means; performance remains separate.`,
    '',
    'Roots:',
    '',
    ...roots.map((root) => `- \`${resolve(root)}\``),
    '',
    '## Capability by model',
    '',
    '| Model | Terminal | Eligible | Success | Ship-ready | Needs tuning | Framework gap | Mean | Median |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const model of models) {
    const all = byModel.get(model) ?? [];
    const eligible = all.filter((entry) => entry.score.eligibility.includedInModelAggregate);
    const scores = eligible.map((entry) => entry.score.composite);
    lines.push(
      `| ${model} | ${all.length} | ${eligible.length} | ${eligible.filter((entry) => entry.facts.outcome.success).length} (${pct(eligible.filter((entry) => entry.facts.outcome.success).length, eligible.length)}) | ${eligible.filter((entry) => entry.score.band === 'ship-ready').length} | ${eligible.filter((entry) => entry.score.band === 'needs-tuning').length} | ${eligible.filter((entry) => entry.score.band === 'framework-gap').length} | ${fmt1(mean(scores))} | ${fmt1(median(scores))} |`,
    );
  }

  lines.push(
    '',
    '## Performance by model (separate from capability)',
    '',
    '| Model | Mean duration | Median duration | Mean decode tok/s | Mean peak RSS | Mean peak GPU memory |',
    '|---|---:|---:|---:|---:|---:|',
  );
  for (const model of models) {
    const all = byModel.get(model) ?? [];
    const durations = all.map((entry) => entry.facts.outcome.durationMs / 1000);
    const tps = all
      .map((entry) => numberAt(entry.facts.perf, 'derived.meanTokensPerSec'))
      .filter((value): value is number => value !== null);
    const rss = all
      .map((entry) => numberAt(entry.facts.perf, 'process.peakRssMb'))
      .filter((value): value is number => value !== null);
    const gpuMem = all
      .map((entry) => numberAt(entry.facts.perf, 'gpu.peakMemUsedMb'))
      .filter((value): value is number => value !== null);
    lines.push(
      `| ${model} | ${fmt1(mean(durations))}s | ${fmt1(median(durations))}s | ${tps.length ? fmt1(mean(tps)) : 'n/a'} | ${rss.length ? `${fmt1(mean(rss))} MB` : 'n/a'} | ${gpuMem.length ? `${fmt1(mean(gpuMem))} MB` : 'n/a'} |`,
    );
  }

  const universalSuccess = scenarios.filter((scenario) =>
    (byScenario.get(scenario) ?? []).every((entry) => entry.facts.outcome.success),
  );
  const universalFailure = scenarios.filter((scenario) =>
    (byScenario.get(scenario) ?? []).every((entry) => !entry.facts.outcome.success),
  );
  const universalShipReady = scenarios.filter((scenario) =>
    (byScenario.get(scenario) ?? []).every((entry) => entry.score.composite >= 8),
  );
  const spreads = scenarios
    .map((scenario) => {
      const group = byScenario.get(scenario) ?? [];
      const scores = group.map((entry) => entry.score.composite);
      return {
        scenario,
        spread: Math.max(...scores) - Math.min(...scores),
        group,
      };
    })
    .sort((a, b) => b.spread - a.spread || a.scenario.localeCompare(b.scenario));
  lines.push(
    '',
    '## Same-scenario comparison',
    '',
    `- Successful on all ${models.length} models: **${universalSuccess.length}/${scenarios.length}** scenarios.`,
    `- Failed terminally on all ${models.length} models: **${universalFailure.length}/${scenarios.length}** scenarios.`,
    `- Ship-ready composite on all ${models.length} models: **${universalShipReady.length}/${scenarios.length}** scenarios.`,
    '',
    'Largest cross-model score spreads:',
    '',
    `| Scenario | Spread | ${models.join(' | ')} |`,
    `|---|---:|${models.map(() => '---:').join('|')}|`,
  );
  for (const item of spreads.slice(0, 25)) {
    const byId = new Map(item.group.map((entry) => [entry.facts.modelId, entry.score.composite]));
    lines.push(
      `| ${item.scenario} | ${fmt1(item.spread)} | ${models.map((model) => fmt1(byId.get(model) ?? 0)).join(' | ')} |`,
    );
  }

  lines.push(
    '',
    '## Cross-scenario comparison',
    '',
    '| Model | Craftbook mean | Other mean | Craftbook success | Other success |',
    '|---|---:|---:|---:|---:|',
  );
  for (const model of models) {
    const all = (byModel.get(model) ?? []).filter(
      (entry) => entry.score.eligibility.includedInModelAggregate,
    );
    const craftbook = all.filter((entry) => entry.facts.scenarioId.startsWith('craftbook-'));
    const other = all.filter((entry) => !entry.facts.scenarioId.startsWith('craftbook-'));
    lines.push(
      `| ${model} | ${craftbook.length > 0 ? fmt1(mean(craftbook.map((entry) => entry.score.composite))) : 'n/a'} | ${other.length > 0 ? fmt1(mean(other.map((entry) => entry.score.composite))) : 'n/a'} | ${craftbook.filter((entry) => entry.facts.outcome.success).length}/${craftbook.length} | ${other.filter((entry) => entry.facts.outcome.success).length}/${other.length} |`,
    );
  }

  const completionRules = countBy(entries, (entry) => entry.score.axes.completion.ruleId);
  const qualityRules = countBy(entries, (entry) => entry.score.axes.quality.ruleId);
  const redFlagPatterns = countBy(
    entries.flatMap((entry) => entry.facts.toolUse.redFlags),
    (flag) => flag.pattern,
  );
  const missingRoles = countBy(
    entries.flatMap((entry) => entry.facts.team.missingExpectedRoles),
    (role) => role,
  );
  const highIntervention = entries.filter((entry) => entry.facts.autoAnswer.total >= 2).length;
  const noOutput = entries.filter(noProducedOutput).length;
  const criticalOutput = entries.filter(isCriticalOutput).length;
  const highBudget = entries.filter(
    (entry) =>
      entry.facts.outcome.budgetUsedFraction > 0.5 || entry.facts.toolUse.totalToolCalls > 10,
  ).length;
  lines.push(
    '',
    '## Reusable failure signals',
    '',
    `- Critical/unparseable output: **${criticalOutput}** trials.`,
    `- No produced artifact / no observed first artifact: **${noOutput}** trials.`,
    `- At least two auto-answer interventions: **${highIntervention}** trials.`,
    `- More than half-budget or more than ten tool calls: **${highBudget}** trials.`,
    '',
    'Completion rules:',
    '',
    ...completionRules.map(([rule, count]) => `- \`${rule}\`: ${count}`),
    '',
    'Quality rules:',
    '',
    ...qualityRules.map(([rule, count]) => `- \`${rule}\`: ${count}`),
    '',
    'Red-flag patterns:',
    '',
    ...(redFlagPatterns.length
      ? redFlagPatterns.map(([pattern, count]) => `- \`${pattern}\`: ${count}`)
      : ['- None recorded.']),
    '',
    'Missing expected roles:',
    '',
    ...(missingRoles.length
      ? missingRoles.map(([role, count]) => `- \`${role}\`: ${count}`)
      : ['- None recorded.']),
    '',
    '## Tactical experiments by model',
    '',
  );
  for (const model of models) {
    const target = MODEL_TUNING[model];
    const all = byModel.get(model) ?? [];
    if (!target) continue;
    const parse = all.filter(isCriticalOutput).length;
    const stalled = all.filter(noProducedOutput).length;
    const interventions = all.filter((entry) => entry.facts.autoAnswer.total >= 2).length;
    const expensive = all.filter(
      (entry) =>
        entry.facts.outcome.budgetUsedFraction > 0.5 || entry.facts.toolUse.totalToolCalls > 10,
    ).length;
    const experiments: string[] = [];
    if (parse > 0) {
      experiments.push(
        `A/B \`${target.manifest}\` coding temperature ${target.codingTemperature.current} -> ${target.codingTemperature.proposed} for parse stability (${parse} critical-output trials)`,
      );
    }
    if (expensive > 0) {
      experiments.push(
        `A/B \`${target.manifest}\` \`${target.efficiency.field}\` ${target.efficiency.current} -> ${target.efficiency.proposed} for budget control (${expensive} expensive trials)`,
      );
    }
    if (stalled > 0) {
      experiments.push(`measure first-artifact latency (${stalled} no-artifact trials)`);
    }
    if (interventions > 0) {
      experiments.push(`reduce avoidable questions (${interventions} high-intervention trials)`);
    }
    if (experiments.length === 0) {
      experiments.push(
        'retain the current manifest as baseline; no parse, no-artifact, intervention, or efficiency failure signal justified a tuning change',
      );
    }
    lines.push(
      `- **${model}:** ${experiments.join('; ')}. Accept only cross-scenario improvements.`,
    );
  }
  const routingSignals = entries.filter(
    (entry) =>
      entry.facts.toolUse.redFlags.length > 0 || entry.facts.team.missingExpectedRoles.length > 0,
  ).length;
  const strategicPriorities: string[] = [];
  if (criticalOutput > 0) {
    strategicPriorities.push(
      `**Pre-terminal validation:** connect \`validate-inline-js-parses.ts\` to \`deliverable-gate.ts\` with a bounded repair turn; ${criticalOutput} trials provide evidence.`,
    );
  }
  if (noOutput > 0) {
    strategicPriorities.push(
      `**First-artifact control:** add a first-tool/first-artifact checkpoint in \`task-budget.ts\` + \`deliverable-contract.ts\`; ${noOutput} trials lacked an observed artifact.`,
    );
  }
  if (routingSignals > 0) {
    strategicPriorities.push(
      `**Role/tool routing:** strengthen \`role-tool-filter.ts\` and corrective tool-surface hints; ${routingSignals} trials recorded red flags or missing roles.`,
    );
  }
  if (highIntervention > 0) {
    strategicPriorities.push(
      `**Question ergonomics:** classify reversible/defaultable questions in \`questions.ts\` + \`phase-gate.ts\`; ${highIntervention} trials needed at least two interventions.`,
    );
  }
  if (highBudget > 0) {
    strategicPriorities.push(
      `**Adaptive early finish and write ergonomics:** use \`deliverable-gate.ts\`, \`session-telemetry.ts\`, and validated patch/replace-section support in \`packages/mcp/src/server.ts\`; ${highBudget} trials exceeded the conservative efficiency anchor.`,
    );
  }
  if (strategicPriorities.length === 0) {
    strategicPriorities.push(
      '**Regression coverage:** keep this matrix as a smoke baseline; no reusable failure signal justified a framework change.',
    );
  }
  lines.push(
    '',
    '## Strategic priorities',
    '',
    ...strategicPriorities.map((priority, index) => `${index + 1}. ${priority}`),
    '',
    'These are framework/tuning hypotheses, not model-ceiling claims. No recommendation encodes a scenario name, selector, expected output string, or implementation recipe into model behavior.',
    '',
    '## Limitations and recovery record',
    '',
    '- One trial per model/scenario pair: rankings are a complete matrix, but not statistical confidence intervals.',
    `- The sweep spans ${roots.length} root${roots.length === 1 ? '' : 's'}; the final set contains no duplicate model/scenario pairs.`,
    '- Infra/operator/grader-classified terminal trials remain documented but are excluded from model capability means.',
    '- Performance reflects this host and llama.cpp/CUDA configuration; it is not part of the capability composite.',
    '',
  );
  return lines.join('\n');
}

interface CliArgs {
  roots: string[];
  out: string;
}

function parseArgs(args: string[]): CliArgs | null {
  const roots: string[] = [];
  let out = '';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--out') out = args[++index] ?? '';
    else if (arg === '--help' || arg === '-h') return null;
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else roots.push(arg);
  }
  if (roots.length === 0 || !out) return null;
  return { roots, out };
}

function usage(): void {
  process.stdout.write(
    'usage: enrich-postmortems.ts --out <MATRIX-SUMMARY.md> <root> [root ...]\n' +
      'Adds evidence-grounded tactical/strategic/comparative sections to every\n' +
      'existing fixed-rubric postmortem and writes an aggregate matrix summary.\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    return;
  }
  const entries = await loadEntries(args.roots);
  const byScenario = new Map<string, TrialEntry[]>();
  const byModel = new Map<string, TrialEntry[]>();
  for (const entry of entries) {
    byScenario.set(entry.facts.scenarioId, [
      ...(byScenario.get(entry.facts.scenarioId) ?? []),
      entry,
    ]);
    byModel.set(entry.facts.modelId, [...(byModel.get(entry.facts.modelId) ?? []), entry]);
  }
  let written = 0;
  const summaryPath = resolve(args.out);
  for (const entry of entries) {
    const enrichment = renderEnrichment(entry, entries, byScenario, byModel, summaryPath);
    const next = replaceEnrichment(entry.postmortem, enrichment);
    await atomicReplace(join(entry.dir, 'postmortem.md'), next.endsWith('\n') ? next : `${next}\n`);
    written++;
    if (written % 100 === 0) process.stdout.write(`[enrich] ${written}/${entries.length}\n`);
  }
  const summary = renderMatrixSummary(entries, args.roots);
  await atomicReplace(summaryPath, summary.endsWith('\n') ? summary : `${summary}\n`);
  process.stdout.write(
    `[enrich] done trials=${entries.length} models=${byModel.size} scenarios=${byScenario.size} summary=${summaryPath}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[enrich] fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
