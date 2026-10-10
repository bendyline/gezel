import { createHash } from 'node:crypto';
import type { QualificationOptions } from '../qualification/config.ts';
import { validateQualification } from '../qualification/config.ts';

export const MODELS = [
  { provider: 'openai', model: 'gpt-6-luna' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
] as const;
export const SCENARIOS = ['tictactoe', 'symptom-debug', 'craftbook-codemod-sweep'] as const;
export const CONSENT_SCRIPT = 'evals/user-scripts/codemod-sweep-command-consent.json';
export const TIMEOUT_MS = 600_000;
export const COMPLETION_TIMEOUT_MS = 120_000;

export interface CampaignCell {
  id: string;
  repetition: number;
  provider: 'openai' | 'anthropic';
  model: string;
  scenario: string;
  repairPolicy: 'runtime' | 'harness';
}

export const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Round one is a stable prefix, so extending to three never repeats it. */
export function campaignCells(count: number): CampaignCell[] {
  if (count !== 1 && count !== 3)
    throw new Error('--count must be 1 (screen) or 3 (repeatability)');
  const cells: CampaignCell[] = [];
  for (let repetition = 1; repetition <= count; repetition++) {
    for (const [s, scenario] of SCENARIOS.entries()) {
      const models = (repetition + s) % 2 ? [...MODELS] : [...MODELS].reverse();
      for (const model of models) {
        const m = MODELS.findIndex((candidate) => candidate.provider === model.provider);
        const policies =
          (repetition + s + m) % 2
            ? (['runtime', 'harness'] as const)
            : (['harness', 'runtime'] as const);
        for (const repairPolicy of policies) {
          cells.push({
            ...model,
            scenario,
            repairPolicy,
            repetition,
            id: `r${repetition}-${model.provider}-${scenario}-${repairPolicy}`,
          });
        }
      }
    }
  }
  return cells;
}

export function campaignDefinition(script: unknown) {
  const qualification = validateQualification({
    userSimulation: 'scripted',
    userScript: script as QualificationOptions['userScript'],
    completionTimeoutMs: COMPLETION_TIMEOUT_MS,
  });
  return {
    version: 1,
    models: MODELS,
    scenarios: SCENARIOS,
    generalist: 'on',
    guidance: 'current',
    productRecovery: 'current',
    repairPolicies: ['runtime', 'harness'],
    timeoutMs: TIMEOUT_MS,
    completionTimeoutMs: COMPLETION_TIMEOUT_MS,
    userSimulation: {
      tictactoe: 'disabled',
      'symptom-debug': 'disabled',
      'craftbook-codemod-sweep': 'scripted',
    },
    userScript: qualification.userScript,
    userScriptHash: hash(qualification.userScript),
  };
}

/** Only allowlisted, explicit settings reach the single-trial CLI. */
export function trialArguments(cell: CampaignCell, runsDir: string, scriptPath: string): string[] {
  return [
    cell.scenario,
    '--provider',
    cell.provider,
    '--model',
    cell.model,
    '--runs-dir',
    runsDir,
    '--qualification',
    '--generalist',
    'on',
    '--repair-policy',
    cell.repairPolicy,
    '--timeout',
    '10m',
    '--completion-timeout',
    '2m',
    '--user-simulation',
    cell.scenario === 'craftbook-codemod-sweep' ? 'scripted' : 'disabled',
    ...(cell.scenario === 'craftbook-codemod-sweep' ? ['--user-script', scriptPath] : []),
    '--write-reports',
  ];
}

export function assertCampaignEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of ['GEZEL_FORCE_BEHAVIORS', 'GEZEL_REMOVE_BEHAVIORS']) {
    if (env[name]?.trim()) throw new Error(`Unset ${name}: this campaign fixes current guidance`);
  }
}

export function campaignPlan(cells: CampaignCell[]): string {
  return [
    '# Phase 1 API harness comparison plan',
    '',
    `${cells.length} sequential trials: two providers, three scenarios, two evaluator-repair policies, ${cells.length / 12} repetition(s) per cell.`,
    '',
    'Generalist on; current product guidance and recovery. Runtime disables evaluator repairs; harness enables them as an assisted diagnostic. This does not vary Gezel runtime recovery.',
    '',
    'Each trial requests 10 minutes of execution plus up to 2 minutes to observe completion. Startup, cleanup and in-flight grace add time. This is an attempt/time bound, not a dollar budget; API usage is billed by the providers. No API requests are made when preparing this plan.',
    '',
    'Policy pairs stay adjacent and their first policy is balanced. Provider order also alternates. Extending from one to three repetitions appends 24 trials to the original 12.',
    '',
    '| Order | Repetition | Provider | Model | Scenario | Repair policy | User simulation |',
    '|---:|---:|---|---|---|---|---|',
    ...cells.map(
      (c, index) =>
        `| ${index + 1} | ${c.repetition} | ${c.provider} | ${c.model} | ${c.scenario} | ${c.repairPolicy} | ${c.scenario === 'craftbook-codemod-sweep' ? 'frozen command consent' : 'disabled'} |`,
    ),
    '',
    'Results: campaign.json journals attempts; summary.json preserves every result; report.md compares per-model/scenario outcomes and paired counts. No aggregate mixes providers or assisted/independent results.',
    '',
    'Unexpected consent requests, provider/account errors, incomplete API responses, measurement failures, or source/build/catalog drift stop the campaign for review. Ordinary task failures stay in the sample. Attempts with missing final evidence are never automatically repeated.',
    '',
  ].join('\n');
}
