/**
 * A fanout shard whose handoff turn ends with its step still open.
 *
 * An ordinary step's handoff is sent once: a turn that ends short is left to
 * the stuck-step sweep, eight minutes of silence per re-drive. A shard cannot
 * wait that long. Its host sits at the post-fanout barrier until the shard
 * settles, a one-slot local engine admits no sibling while it holds the
 * fanout's admission, and nobody reads a shard's thread. An invoice-run shard
 * on GPT-6.1 Sol reported a blocker in prose and ended its turn without
 * pausing or finishing; the run waited silently for nine minutes until it was
 * stopped (2026-11-10). So a shard's open step gets the bounded recovery a
 * fixed-action step gets, and then pauses for help like one.
 */
import {
  type ChatMessage,
  type ChatSession,
  parseTaskRef,
  taskEffectiveStatus,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { readTaskWithEffectiveStatus } from '../tasks/effective-status.js';
import { isFanoutShard } from '../tasks/fanout-barrier.js';
import { servesEarlierActivation } from './session-step-activation.js';
import {
  isSuccessfulAsyncHandoffToolCall,
  isSuccessfulTaskLaunchToolCall,
} from './turn-terminal-actions.js';

const REPLY_EXCERPT_CHARS = 280;

type ShardSession = Pick<ChatSession, 'taskRef' | 'stepId' | 'stepActivationId'> & {
  messages: readonly Pick<ChatMessage, 'role' | 'content' | 'at' | 'toolCalls'>[];
};

/**
 * Why a fanout shard's handoff turn left its step open, or null when the
 * task is not a shard, the step moved on, a newer session owns the step's
 * pass, or the turn handed the work to someone it now waits on. `since` is
 * when the send started; only that turn's replies are read.
 */
export async function openFanoutShardStep(
  store: Pick<Store, 'readTask'>,
  args: { taskRef: string; stepId: string; session: ShardSession | null; since: string },
): Promise<string | null> {
  const parsed = parseTaskRef(args.taskRef);
  if (!parsed) return null;
  const task = await readTaskWithEffectiveStatus(store, parsed.projectId, parsed.num).catch(
    () => null,
  );
  if (!task || taskEffectiveStatus(task) !== 'active' || task.activeStepId !== args.stepId) {
    return null;
  }
  const parentRef = task.parentTaskRef ? parseTaskRef(task.parentTaskRef) : null;
  const parent = parentRef
    ? await store.readTask(parentRef.projectId, parentRef.num).catch(() => null)
    : null;
  if (!isFanoutShard(task, parent)) return null;
  const step = task.craftbook.steps.find((candidate) => candidate.id === args.stepId);
  if (args.session && step && servesEarlierActivation(args.session, args.taskRef, step)) {
    return null;
  }
  const turn = (args.session?.messages ?? []).filter(
    (message) => message.role === 'assistant' && message.at >= args.since,
  );
  const handedOn = turn.some((message) =>
    (message.toolCalls ?? []).some(
      (call) =>
        isSuccessfulAsyncHandoffToolCall(call) ||
        isSuccessfulTaskLaunchToolCall(call) ||
        (call.name === 'create_task' && call.success === true),
    ),
  );
  if (handedOn) return null;
  const lastReply = [...turn]
    .reverse()
    .find((message) => message.content.trim())
    ?.content.trim()
    .replace(/\s+/g, ' ');
  const excerpt =
    lastReply && lastReply.length > REPLY_EXCERPT_CHARS
      ? `${lastReply.slice(0, REPLY_EXCERPT_CHARS)}…`
      : lastReply;
  return `fanout shard ${args.taskRef} ended its turn with step "${args.stepId}" still open${excerpt ? `; its last reply: "${excerpt}"` : ''}`;
}

/** The recovery a shard gets after a turn that left its step open. */
export function fanoutShardRecoveryText(opts: {
  stepId: string;
  file?: string;
  attempt: number;
  of: number;
}): string {
  return [
    `Your turn ended with step \`${opts.stepId}\` still open (bounded recovery ${opts.attempt}/${opts.of}).`,
    'The run that started this task waits for this step before it can go on.',
    ...(opts.file
      ? [`The step finishes once \`${opts.file}\` is written and passes its check.`]
      : []),
    'Finish it now: follow the procedure already in your prompt and persist its declared output.',
    'If the step truly cannot be done with the tools you have, say exactly what is missing in one sentence and end your turn; after these attempts the task pauses so a person can look.',
  ].join(' ');
}
