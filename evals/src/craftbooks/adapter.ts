import type { CraftbookTestSpec } from '@bendyline/gezel';
import type { CraftbookEvalOverride } from './overrides.ts';
import type { LoadedCraftbookTestSpec } from './test-spec-loader.ts';
import type {
  CraftbookEvalGateCheck,
  CraftbookEvalMode,
  CraftbookEvalSimulator,
  CraftbookEvalSpec,
} from './types.ts';

/**
 * Adapt a catalog-shipped `test.json` (plus the evals-internal override
 * for the book, when any) into the `CraftbookEvalSpec` shape the scenario
 * factory consumes. The test spec is the shipped truth (prompt, fixtures,
 * checks, rubric); the override carries what deliberately stays in-repo:
 * run/coverage records, hand-authored-scenario links, bespoke ids, gaps.
 */
export function evalSpecFromTestSpec(
  loaded: LoadedCraftbookTestSpec,
  override?: CraftbookEvalOverride,
): CraftbookEvalSpec {
  const { craftbookId, spec } = loaded;
  const legacySimulators = readLegacySimulators(spec);
  const mode: CraftbookEvalMode = override?.existingScenarioId
    ? (override.mode ?? 'artifact-task')
    : loaded.hasSpawn
      ? 'workflow'
      : (override?.mode ?? 'artifact-task');
  return {
    craftbookId,
    mode,
    scenarioId: override?.scenarioId ?? `craftbook-${craftbookId}`,
    title: spec.title,
    objective: spec.objective,
    ...(override?.existingScenarioId ? { existingScenarioId: override.existingScenarioId } : {}),
    prompt: spec.prompt,
    setup: {
      projectName: spec.setup.projectName,
      ...(spec.setup.about ? { about: spec.setup.about } : {}),
      ...(spec.setup.missionObjectives ? { missionObjectives: spec.setup.missionObjectives } : {}),
      ...(spec.setup.managedWorkspaceWritePolicy
        ? { managedWorkspaceWritePolicy: spec.setup.managedWorkspaceWritePolicy }
        : {}),
      files: spec.setup.files,
      ...(spec.setup.craftbookParams ? { craftbookParams: spec.setup.craftbookParams } : {}),
      ...(legacySimulators.length > 0 ? { simulators: legacySimulators } : {}),
      ...(spec.setup.worker ? { worker: spec.setup.worker } : {}),
    },
    success: {
      summary: spec.success.summary,
      ...(spec.success.deliverables
        ? {
            deliverables: spec.success.deliverables.map((deliverable) => ({
              path: deliverable.path,
              kind: deliverable.kind,
              ...(deliverable.artifact ? { artifact: true } : {}),
              ...(deliverable.minBytes !== undefined ? { minBytes: deliverable.minBytes } : {}),
              ...(deliverable.checks
                ? { checks: deliverable.checks as CraftbookEvalGateCheck[] }
                : {}),
            })),
          }
        : {}),
      ...(spec.success.checks ? { checks: spec.success.checks as CraftbookEvalGateCheck[] } : {}),
      ...(spec.success.taskNotes
        ? {
            taskNotes: {
              ...spec.success.taskNotes,
              ...(spec.success.taskNotes.checks
                ? { checks: spec.success.taskNotes.checks as CraftbookEvalGateCheck[] }
                : {}),
            },
          }
        : {}),
      ...(spec.success.taskGraph
        ? {
            taskGraph: {
              ...spec.success.taskGraph,
              ...(spec.success.taskGraph.checks
                ? { checks: spec.success.taskGraph.checks as CraftbookEvalGateCheck[] }
                : {}),
            },
          }
        : {}),
      ...(spec.success.mocks ? { mocks: spec.success.mocks } : {}),
      ...(spec.success.history ? { history: spec.success.history } : {}),
      ...(spec.success.unchangedFixtures
        ? { unchangedFixtures: spec.success.unchangedFixtures }
        : {}),
    },
    coverage: override?.coverage ?? {
      status: 'implemented',
      notes: 'Adapted from the catalog test.json sidecar; no local validation recorded yet.',
    },
    qualityFocus: spec.qualityFocus,
    ...(override?.gaps && override.gaps.length > 0 ? { gaps: override.gaps } : {}),
    rubric: spec.rubric,
    tags: spec.tags,
    ...(spec.mocks.length > 0 ? { mocks: spec.mocks } : {}),
    testSpecVersion: loaded.version,
    ...(loaded.stepPathTokens.length > 0 ? { stepPathTokens: loaded.stepPathTokens } : {}),
    ...(override?.timeoutMs !== undefined ? { timeoutMs: override.timeoutMs } : {}),
    ...(override?.progressTimeoutMs !== undefined
      ? { progressTimeoutMs: override.progressTimeoutMs }
      : {}),
  };
}

/**
 * Documentation-only simulator metadata carried through the migration
 * under `extensions.legacySimulators` — coverage tooling still reads it
 * until each book graduates to live `mocks[]` services.
 */
function readLegacySimulators(spec: CraftbookTestSpec): CraftbookEvalSimulator[] {
  const raw = spec.extensions?.legacySimulators;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is CraftbookEvalSimulator =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as CraftbookEvalSimulator).id === 'string' &&
      typeof (entry as CraftbookEvalSimulator).kind === 'string' &&
      typeof (entry as CraftbookEvalSimulator).description === 'string',
  );
}
