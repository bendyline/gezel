import {
  EVAL_CATALOG_SCHEMA_VERSION,
  type EvalCatalog,
  type EvalCatalogScenario,
  type EvalRequirement,
} from '@bendyline/gezel/eval';
import { CRAFTBOOK_AUTHORING_SCENARIOS } from './craftbooks/authoring/index.ts';
import { runnableGenericCraftbookSpecs } from './craftbooks/specs.ts';
import {
  CHAT_PROVIDERS,
  categorizeProvider,
  defaultModelFor,
  defaultProvider,
} from './providers.ts';
import { DEFAULT_MAX_DURATION_MS } from './runner.ts';
import { ANCHORED_SCENARIOS, listScenarios } from './scenarios/index.ts';
import { MIN_TRIALS_FOR_RATE } from './stats-discipline.ts';
import { DEFAULT_SUITE_ID, listSuites } from './suites.ts';
import type { EvalScenario } from './types.ts';

/** Declared requirements plus the ones implied by other scenario fields. */
export function requirementsOf(scenario: EvalScenario): EvalRequirement[] {
  const out = new Set<EvalRequirement>(scenario.requires ?? []);
  if (scenario.defaultImageModelId) out.add('image-model');
  if (scenario.requiresEmbeddings) out.add('embeddings');
  if (scenario.requiresDocblocks) out.add('docblocks');
  return [...out].sort();
}

/**
 * The harness's registry as one JSON-ready document (`EvalCatalogSchema`):
 * every scenario with what a runner needs to plan it, every suite, and the
 * provider defaults. See `bin/catalog.ts`.
 */
export function buildEvalCatalog(): EvalCatalog {
  const suites = listSuites();
  const suitesByScenario = new Map<string, string[]>();
  for (const suite of suites) {
    for (const id of suite.scenarios) {
      suitesByScenario.set(id, [...(suitesByScenario.get(id) ?? []), suite.id]);
    }
  }
  const craftbookIds = new Set(runnableGenericCraftbookSpecs().map((spec) => spec.scenarioId));
  const authoringIds = new Set(Object.keys(CRAFTBOOK_AUTHORING_SCENARIOS));
  const anchored = new Set<string>(ANCHORED_SCENARIOS);
  const scenarios = listScenarios();
  const timeoutOf = (scenario: EvalScenario) => scenario.timeoutMs ?? DEFAULT_MAX_DURATION_MS;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));

  return {
    schemaVersion: EVAL_CATALOG_SCHEMA_VERSION,
    scenarios: scenarios.map(
      (scenario): EvalCatalogScenario => ({
        id: scenario.id,
        description: scenario.description,
        kind: authoringIds.has(scenario.id)
          ? 'craftbook-authoring'
          : craftbookIds.has(scenario.id)
            ? 'craftbook'
            : 'scenario',
        anchored: anchored.has(scenario.id),
        timeoutMs: timeoutOf(scenario),
        ...(scenario.suggestedTrials ? { suggestedTrials: scenario.suggestedTrials } : {}),
        ...(scenario.defaultImageModelId
          ? { defaultImageModelId: scenario.defaultImageModelId }
          : {}),
        requires: requirementsOf(scenario),
        judgeAxes: (scenario.judge?.axes ?? []).map((axis) => axis.name),
        suites: suitesByScenario.get(scenario.id) ?? [],
      }),
    ),
    suites: suites.map((suite) => ({
      id: suite.id,
      description: suite.description,
      scenarioIds: [...suite.scenarios],
      authoredCeilingMs: suite.scenarios.reduce((sum, id) => {
        const scenario = byId.get(id);
        return sum + (scenario ? timeoutOf(scenario) : 0);
      }, 0),
    })),
    defaultSuiteId: DEFAULT_SUITE_ID,
    providers: CHAT_PROVIDERS.map((id) => ({
      id,
      category: categorizeProvider(id),
      defaultModelId: defaultModelFor(id),
    })),
    defaultProvider: defaultProvider(),
    minTrialsForRate: MIN_TRIALS_FOR_RATE,
  };
}
