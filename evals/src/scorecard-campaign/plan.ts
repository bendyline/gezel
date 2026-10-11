import { z } from 'zod';
import { CHAT_PROVIDERS, categorizeProvider } from '../providers.ts';
import { suiteScenarios } from '../suites.ts';

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
export const ComparisonConfig = z
  .object({
    version: z.literal(1),
    count: z.number().int().min(1).max(100),
    suites: z.array(identifier).min(1),
    generalist: z.enum(['on', 'off', 'auto']),
    cliAuth: z.enum(['login', 'inherit']),
    targets: z
      .array(
        z
          .object({
            id: identifier,
            provider: z.enum(CHAT_PROVIDERS),
            model: identifier,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ComparisonConfig = z.infer<typeof ComparisonConfig>;
export type Target = ComparisonConfig['targets'][number];
export interface Cell extends Target {
  id: string;
  targetId: string;
  suite: string;
  scenario: string;
  repetition: number;
}

export function comparisonDefinition(value: unknown, sourceHome: string) {
  const config = ComparisonConfig.parse(value);
  if (
    new Set(config.suites).size !== config.suites.length ||
    new Set(config.targets.map((t) => t.id)).size !== config.targets.length ||
    new Set(config.targets.map((t) => `${t.provider}/${t.model}`)).size !== config.targets.length
  )
    throw new Error('Duplicate suites, target ids, or provider/model pairs');
  const scenarios = config.suites.flatMap((suite) =>
    suiteScenarios(suite).map((s) => ({
      suite,
      id: s.id,
      timeoutMs: s.timeoutMs ?? null,
      repairPolicy: s.repairPolicy ?? 'harness',
      requires: s.requires ?? [],
      imageModel: s.defaultImageModelId ?? null,
      judge: s.judge ?? null,
    })),
  );
  return {
    ...config,
    sourceHome,
    scenarios,
    evaluator: 'standard-scorecard' as const,
    runtimeLayer: 'required' as const,
  };
}
export type Definition = ReturnType<typeof comparisonDefinition>;

/** Rotate target order across scenarios and repetitions; run one trial at a time. */
export function comparisonCells(d: Definition): Cell[] {
  const cells: Cell[] = [];
  for (let repetition = 1; repetition <= d.count; repetition++) {
    for (const [index, scenario] of d.scenarios.entries()) {
      const offset = (index + repetition - 1) % d.targets.length;
      const targets = [...d.targets.slice(offset), ...d.targets.slice(0, offset)];
      for (const target of targets)
        cells.push({
          ...target,
          targetId: target.id,
          suite: scenario.suite,
          scenario: scenario.id,
          repetition,
          id: `r${repetition}-${target.id}-${scenario.suite}-${scenario.id}`,
        });
    }
  }
  if (new Set(cells.map((c) => c.id)).size !== cells.length)
    throw new Error('Ambiguous cell ids; rename the conflicting targets');
  return cells;
}

/** CLI login arms must not accidentally switch to API billing from the parent shell. */
export function trialEnvironment(d: Definition, target: Target, env: NodeJS.ProcessEnv) {
  const child = { ...env };
  child.GEZEL_EVAL_REQUIRE_RUNTIME_LAYER = '1';
  if (categorizeProvider(target.provider) === 'cli-wrapper' && d.cliAuth === 'login') {
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ])
      delete child[key];
  }
  return child;
}

export function comparisonArguments(cell: Cell, d: Definition, dir: string, preflightDir: string) {
  return [
    '--suite',
    cell.suite,
    '--scenarios',
    cell.scenario,
    '--count',
    '1',
    '--count-strict',
    '--parallel',
    '1',
    '--no-triage',
    '--provider',
    cell.provider,
    '--model',
    cell.model,
    '--generalist',
    d.generalist,
    '--source-home',
    d.sourceHome,
    '--runs-dir',
    dir,
    '--preflight-dir',
    preflightDir,
    '--write-reports',
  ];
}

export function comparisonPlan(d: Definition, cells: Cell[]) {
  const hours =
    (d.scenarios.reduce((n, s) => n + (s.timeoutMs ?? 0), 0) * d.count * d.targets.length) /
    3_600_000;
  return [
    '# Provider scorecard comparison',
    '',
    `${d.scenarios.length} suite entries (${new Set(d.scenarios.map((s) => s.id)).size} distinct scenarios) × ${d.targets.length} targets × ${d.count} repetitions = ${cells.length} trials. Shared suite members run separately in each suite, matching the standard scorecard.`,
    '',
    `Generalist: ${d.generalist}. CLI authentication: ${d.cliAuth}. Local model source: ${d.sourceHome}.`,
    '',
    'Sequential trials with rotating target order. Standard scenario prompts, assertions, user simulation, repair policies and authored timeouts; no qualification override or extra repair hints. Local admission probes and throughput-based timeout scaling remain enabled. No automatic retries or triage skips.',
    'Browser assertions are required: a missing/broken Chromium runtime is a grader failure, never a static-only pass. Large model files are checked by install manifest, size and modification time; small install files are content-hashed, not every weight byte.',
    '',
    `Authored timeout sum: ${hours.toFixed(1)} hours before local throughput scaling, startup and cleanup. This is a budget sum, not a runtime estimate. No dollar cap is enforced.`,
    '',
    'This measures each full integration. CLI wrappers include their own tools and prompts; APIs use Gezel as the agent harness. A standard scorecard PASS measures the scenario gate, not independent API qualification or natural lifecycle completion. Provider/model aliases are pinned as requested, but remote services can update the underlying model.',
    '',
    'Raw trial evidence stays in each cell. summary.json, trials.csv and report.md are derived comparison outputs, never the published scorecard dataset. Source/build/catalog changes stop execution. Interrupted attempts are reconciled from saved results, never silently repeated. Infra/operator/grader failures stop for review and are excluded from capability scores; task failures remain in the sample.',
    '',
    'Performance includes trial duration, time to first action/artifact, token usage, provider-reported cost, tool calls, and local decode/prefill/RAM/GPU when available. Missing measurements stay unknown. Whole-trial token throughput is not decode speed; cache accounting and CLI subscriptions are not directly comparable API costs.',
    '',
    'After completion: use the eval-run skill to judge every declared artifact with its exact axes and fixed 0–10 rubric (20 KiB limit). Save codex-inline-judge.json separately; no advisory scores are invented or merged into fixed scores.',
    '',
    '| Target | Provider | Model |',
    '|---|---|---|',
    ...d.targets.map((t) => `| ${t.id} | ${t.provider} | ${t.model} |`),
    '',
    '| Suite | Scenario | Repair policy | Requirements |',
    '|---|---|---|---|',
    ...d.scenarios.map(
      (s) =>
        `| ${s.suite} | ${s.id} | ${s.repairPolicy} | ${[...s.requires, ...(s.imageModel ? [s.imageModel] : [])].join(', ') || 'standard fixtures'} |`,
    ),
    '',
  ].join('\n');
}
