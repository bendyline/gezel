/**
 * Connector prep for a task launch: pull down what a craftbook declared it
 * reads, BEFORE its first step's prompt is built.
 *
 * The connector standard forbids a model-callable fetch — a gezel reads a
 * mirrored corpus, it never calls the source (docs/connector-standards.md).
 * That leaves the runtime responsible for making the corpus exist, and a
 * task launch is the one moment where it can: `TaskManager.create`
 * interpolates `{{param}}` into step prompts and gate paths exactly once,
 * so prep runs just before that and returns the concrete paths to bake in.
 *
 * Per-type behavior registers here rather than living in TaskManager, which
 * knows nothing about connectors.
 */

import type {
  CraftbookConnectorNeed,
  ProjectConnectorBinding,
  ProjectDetail,
} from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { BindingSyncResult } from './manager.js';

const log = createLogger('connectors');

export interface ConnectorTaskPrepContext {
  project: ProjectDetail;
  /** The project's binding for this connector type. */
  binding: { id: string; type: string; corpusDir?: string };
  /** Params supplied at launch, merged over the craftbook's defaults. */
  params: Record<string, string>;
  /** Targeted sync — narrows the pass to the scopes the task needs now. */
  sync(
    bindingId: string,
    opts?: { scopes?: readonly string[]; backfillLimit?: number },
  ): Promise<BindingSyncResult>;
}

export interface ConnectorTaskPrepResult {
  /** Merged into `craftbookParams` before interpolation. */
  params?: Record<string, string>;
  /** One line for the task's launch note. */
  summary?: string;
}

export type ConnectorTaskPrep = (ctx: ConnectorTaskPrepContext) => Promise<ConnectorTaskPrepResult>;

/**
 * A task must never start against a corpus that only partially arrived.
 * Connector syncs reserve `error` for whole-pass failures; individual
 * fetch/write failures are reported only through `errors`, and rate limiting
 * can also end an otherwise clean pass early. Ambient sync may retry either
 * case later, but launch-time prep has no such luxury because craftbook paths
 * are interpolated exactly once.
 */
export function assertConnectorTaskSync(
  result: BindingSyncResult,
  subject: string,
): asserts result is BindingSyncResult & { errors: 0; error?: undefined; rateLimited?: false } {
  const hardError = result.error?.trim();
  if (hardError) throw new Error(`Could not pull down ${subject}: ${hardError}`);
  if (result.errors > 0) {
    throw new Error(
      `Could not pull down ${subject}: ${result.errors} record${result.errors === 1 ? '' : 's'} failed to sync`,
    );
  }
  if (result.rateLimited) {
    throw new Error(
      `Could not pull down ${subject}: the source rate-limited the sync before it completed`,
    );
  }
}

const PREPS = new Map<string, ConnectorTaskPrep>();

/** Register the launch-time prep for one connector type. */
export function registerConnectorTaskPrep(typeId: string, prep: ConnectorTaskPrep): void {
  PREPS.set(typeId, prep);
}

/** Test seam — drops a registration so suites don't leak into each other. */
export function clearConnectorTaskPreps(): void {
  PREPS.clear();
}

/** Test seam — the registered prep for a type, so its contract is testable. */
export function connectorTaskPrepFor(typeId: string): ConnectorTaskPrep | undefined {
  return PREPS.get(typeId);
}

export interface RunConnectorTaskPrepDeps {
  getProject(projectId: string): Promise<ProjectDetail | null>;
  sync(
    project: ProjectDetail,
    bindingId: string,
    opts?: { scopes?: readonly string[]; backfillLimit?: number },
  ): Promise<BindingSyncResult>;
  /** Security posture — a task-initiated sync respects it like any other. */
  allowExternalServices(project: ProjectDetail): Promise<boolean>;
  /**
   * Optional native zero-config binding provisioner. It must refuse any type
   * that needs new credentials or user choices; required unhandled types stay
   * setup-blocked.
   */
  ensureBinding?: (
    project: ProjectDetail,
    need: CraftbookConnectorNeed,
  ) => Promise<ProjectConnectorBinding | null>;
}

/**
 * Run every declared connector's prep. Throws on a failure the user must
 * act on (posture off, auth missing, source unreachable): a task whose
 * corpus never arrived would otherwise open with its first step reporting
 * the source as empty, which reads as "nothing to review" rather than
 * "the fetch failed".
 */
export async function runConnectorTaskPrep(
  deps: RunConnectorTaskPrepDeps,
  input: {
    projectId: string;
    craftbookId: string;
    connectors: CraftbookConnectorNeed[];
    params: Record<string, string>;
  },
): Promise<{ params: Record<string, string>; note?: string }> {
  const project = await deps.getProject(input.projectId);
  if (!project) throw new Error(`project ${input.projectId} not found`);

  const params: Record<string, string> = {};
  const summaries: string[] = [];

  for (const need of input.connectors) {
    if (!(await deps.allowExternalServices(project))) {
      throw new Error(
        `Craftbook "${input.craftbookId}" reads the ${need.typeId} connector, but this install's security policy blocks external services. Enable them in Settings → Security, then run it again.`,
      );
    }
    let binding = (project.connectors ?? []).find((b) => b.type === need.typeId && !b.disabled);
    if (!binding && !need.optional && deps.ensureBinding) {
      binding = (await deps.ensureBinding(project, need)) ?? undefined;
    }
    if (!binding) {
      // Optional needs simply have nothing to do. Required connectors that
      // cannot be safely auto-provisioned should normally have failed in
      // TaskManager with ConnectorSetupRequiredError; keep this fail-closed
      // backstop for direct callers.
      if (!need.optional) {
        throw new Error(`no enabled ${need.typeId} connector is bound to this project`);
      }
      continue;
    }

    const prep = PREPS.get(need.typeId);
    if (!prep) {
      // No type-specific prep: an ordinary full sync still makes the
      // corpus current, which is all a non-parameterized connector needs.
      const result = await deps.sync(project, binding.id);
      assertConnectorTaskSync(result, `${need.typeId} connector data`);
      log.info(`[connectors] task prep synced ${need.typeId} for ${input.craftbookId}`);
      continue;
    }

    const result = await prep({
      project,
      binding,
      params: { ...input.params, ...params },
      sync: (bindingId, opts) => deps.sync(project, bindingId, opts),
    });
    Object.assign(params, result.params ?? {});
    if (result.summary) summaries.push(result.summary);
  }

  return {
    params,
    ...(summaries.length > 0
      ? {
          note: `# Connector data pulled for this run\n\n${summaries.map((s) => `- ${s}`).join('\n')}`,
        }
      : {}),
  };
}
