import {
  type ChatModelTuning,
  type ModelTaskStrategy,
  type ProviderName,
  type Task,
  isLocalProvider,
  parseTaskRef,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  type LocalModelTier,
  classifyLocalModelTier,
} from '@bendyline/gezel-inference/internal/chat/local-model-tier';
import { resolveCatalogIdFromModelId } from '@bendyline/gezel-inference/internal/providers/catalog-model-config';
import type { Store } from '../fs/store.js';
import { type StepSniffName, runStepSniff } from './step-sniff.js';

/**
 * The pieces of generalist-mode session continuity (docs/generalist-mode.md)
 * that do not need `ChatManager`'s state: deciding whether a transcript is
 * worth resuming, orienting a fresh owner in the task, and classifying the
 * model tier a task will execute with. Kept out of the manager so the
 * decisions are testable on their own and the manager stays an orchestrator.
 */

/**
 * A local provider closes an immediate-write turn the moment the requested
 * file lands, before the model can call `advance_task_step`. On a task step
 * that leaves the step active with nothing queued, and the only thing that
 * would move it is the eight-minute stall sweep: five serial fanout children
 * on one engine slot could not finish inside a thirty-minute ceiling that way
 * (fanout-stories, 2026-09-18). One bounded continuation in the same session
 * closes the gap; the sweep stays the backstop.
 */
export function renderWriteBailContinuation(stepId: string): string {
  return `Your file write landed and the runtime closed that turn early. Step \`${stepId}\` is still active: it is not complete until its gate passes. Finish anything the step procedure in your prompt still requires, then call \`advance_task_step\` once.`;
}

export { isContextOverflowError, sessionContextPoisoned } from '@bendyline/gezel';

// Shared with every host that runs craftbook steps.
export { renderEntryPreface } from '@bendyline/gezel';

/**
 * The model tier `providerName` would execute a gezel's turns with: the
 * gezel's pinned model, else the install default for that provider,
 * classified the same way the handoff dispatcher does (catalog
 * `parameterSize` first, model-id tag second). Cloud providers are `cloud`.
 * The task execution-mode resolver decides from this, so the mode decision
 * and the dispatch read the same model.
 */
export async function classifyExecutionTierFor(args: {
  store: Store;
  catalog: CatalogService;
  providerName: ProviderName;
  gezelId?: string;
}): Promise<LocalModelTier> {
  return (await resolveExecutionModelFor(args)).tier;
}

/** The model a gezel's task turns would run on, as `auto` judges it. */
export interface ExecutionModelProfile {
  tier: LocalModelTier;
  /** The model id the dispatch will use, when one is pinned or defaulted. */
  modelId?: string;
  /** The model's measured task strategy: the gezel's override, else the catalog's. */
  affinity?: ModelTaskStrategy;
}

/**
 * {@link classifyExecutionTierFor} plus the model's measured strategy
 * (`tuning.taskStrategy`), read for the same model the dispatch will use. A
 * gezel's own `tuning.taskStrategy` wins over the catalog's.
 */
export async function resolveExecutionModelFor(args: {
  store: Store;
  catalog: CatalogService;
  providerName: ProviderName;
  gezelId?: string;
}): Promise<ExecutionModelProfile> {
  const [config, gezel] = await Promise.all([
    args.store.readConfig(),
    args.gezelId ? args.store.getGezel(args.gezelId).catch(() => null) : Promise.resolve(null),
  ]);
  const effectiveModel =
    gezel?.parsed.frontmatter.model ?? config.defaultModel?.[args.providerName] ?? undefined;
  const local = isLocalProvider(args.providerName);
  const catalogId = local
    ? ((await resolveCatalogIdFromModelId(args.catalog, effectiveModel)) ?? effectiveModel)
    : effectiveModel;
  const manifest = catalogId ? await chatModelManifest(args.catalog, catalogId) : undefined;
  const affinity = gezel?.parsed.frontmatter.tuning?.taskStrategy ?? manifest?.tuning?.taskStrategy;
  const tier: LocalModelTier = local
    ? classifyLocalModelTier({
        providerName: args.providerName,
        modelId: effectiveModel,
        parameterSize: manifest?.parameterSize,
      })
    : 'cloud';
  return {
    tier,
    ...(effectiveModel ? { modelId: effectiveModel } : {}),
    ...(affinity ? { affinity } : {}),
  };
}

async function chatModelManifest(
  catalog: CatalogService,
  catalogId: string,
): Promise<{ parameterSize?: string; tuning?: ChatModelTuning } | undefined> {
  try {
    const detail = await catalog.get('chat-model', catalogId);
    return detail?.manifest.kind === 'chat-model' ? detail.manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One sentence on why an artifact checkpoint has not satisfied its
 * `advanceWhen` yet, for the bounded-recovery message. The message used to
 * say only that the step advances once the file "passes its check", and a
 * small model that had written 122 bytes against a 500-byte floor wrote the
 * same 122 bytes twice more and was paused after fifty seconds
 * (gemma4-e4b-q4 codemod-sweep, 2026-09-20). Null when the file passes.
 */
export function describeCheckpointGap(
  file: string,
  content: string | null,
  spec: { minBytes?: number; sniff?: string },
): string | null {
  if (content === null) return `\`${file}\` does not exist yet`;
  const minBytes = spec.minBytes ?? 1;
  if (content.length < minBytes) {
    return `\`${file}\` is ${content.length} bytes and the check needs at least ${minBytes}`;
  }
  if (spec.sniff && !runStepSniff(spec.sniff as StepSniffName, content)) {
    return `\`${file}\` exists but fails its \`${spec.sniff}\` check`;
  }
  return null;
}

/**
 * The gap sentence for a bounded-recovery attempt on an artifact checkpoint
 * step, or null on the first send and for steps that are not one.
 */
export async function checkpointGapForStep(
  store: Pick<Store, 'readProjectArtifact'>,
  taskRef: string,
  step: { advanceWhen?: { file: string; minBytes?: number; sniff?: string } } | undefined,
  attempt: number,
  artifactCheckpoint: boolean,
): Promise<string | null> {
  if (attempt < 2 || !artifactCheckpoint || !step?.advanceWhen?.file) return null;
  const parsed = parseTaskRef(taskRef);
  if (!parsed) return null;
  const file = step.advanceWhen.file;
  const content = await store.readProjectArtifact(parsed.projectId, file).catch(() => null);
  return describeCheckpointGap(file, content, step.advanceWhen);
}
