import {
  type ChatSession,
  type ProviderName,
  type Task,
  isLocalProvider,
  parseTaskRef,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { resolveCatalogIdFromModelId } from '../providers/catalog-model-config.js';
import { resolveCatalogParameterSize } from './catalog-model-lookup.js';
import { type LocalModelTier, classifyLocalModelTier } from './local-model-tier.js';
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

export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { code?: string }).code === 'context-overflow') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ran out of working memory|exceeds the available context size/i.test(msg);
}

/**
 * True when a session's most recent turn ended because its accumulated
 * context was the problem — a compaction-loop halt (the per-send compaction
 * budget ran out without progress) or a context overflow. Resuming such a
 * transcript replays the failure; a generalist retry starts fresh instead.
 */
export function sessionContextPoisoned(record: ChatSession): boolean {
  if (record.lastTurnError && isContextOverflowError(record.lastTurnError)) return true;
  for (let i = record.messages.length - 1; i >= 0; i -= 1) {
    const message = record.messages[i]!;
    if (message.role === 'assistant') return message.synthetic === 'context-loop-halt';
  }
  return false;
}

/**
 * Entry preface: a fresh-launch gezel has never seen this task before, so
 * before the "you've been assigned" line it is oriented with the craftbook
 * the task came from and the full step arc. The per-step procedure lives in
 * the system prompt; this is the bird's-eye "what is this task and where
 * does my step sit in it" the seed otherwise lacks. Only for the `entry`
 * kind — handoff recipients inherit the same system-prompt context and the
 * prior gezels' notes (and a generalist task carries a Task outline on every
 * turn), so they don't need it re-stated.
 */
export function renderEntryPreface(task: Task, dispatchStepId: string): string {
  const cb = task.craftbook;
  const stepArc = cb.steps
    .map((s, i) => {
      const here = s.id === dispatchStepId ? ' ← your step' : '';
      const desc = s.description?.trim() ? ` — ${s.description.trim()}` : '';
      return `${i + 1}. ${s.name}${desc}${here}`;
    })
    .join('\n');
  const cbDesc = cb.description?.trim() ? ` ${cb.description.trim()}` : '';
  return `Task ${task.ref} ("${task.title}") was just created from the **${cb.name}** craftbook.${cbDesc}\n\nIts steps:\n${stepArc}\n\n`;
}

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
  if (!isLocalProvider(args.providerName)) return 'cloud';
  const [config, gezel] = await Promise.all([
    args.store.readConfig(),
    args.gezelId ? args.store.getGezel(args.gezelId).catch(() => null) : Promise.resolve(null),
  ]);
  const effectiveModel =
    gezel?.parsed.frontmatter.model ?? config.defaultModel?.[args.providerName] ?? undefined;
  const catalogId =
    (await resolveCatalogIdFromModelId(args.catalog, effectiveModel)) ?? effectiveModel;
  return classifyLocalModelTier({
    providerName: args.providerName,
    modelId: effectiveModel,
    parameterSize: await resolveCatalogParameterSize(args.catalog, catalogId),
  });
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
