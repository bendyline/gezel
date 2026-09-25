import { createHash } from 'node:crypto';
import {
  CRAFTBOOK_INVOCATION_KEY_PREFIX,
  type TaskLaunchSpec,
  invocationSignature,
} from '@bendyline/gezel';

/**
 * The invocation key for a launch made from the chat composer. A retried
 * POST — a flaky socket, a double click before the button disabled — must
 * find the task it already made rather than start a second crew, so the
 * key is what identifies "this message, this configuration": the session,
 * the draft it was written in (or the message text when there is none),
 * and the launch spec in its canonical form. The title is cosmetic and is
 * dropped by `invocationSignature`, as it is for a model's repeated call.
 */
export function chatLaunchInvocationKey(args: {
  sessionId: string;
  draftId?: string;
  message: string;
  launch: TaskLaunchSpec;
}): string {
  const messageIdentity = args.draftId ?? createHash('sha256').update(args.message).digest('hex');
  const digest = createHash('sha256')
    .update('chat-launch')
    .update('\n')
    .update(args.sessionId)
    .update('\n')
    .update(messageIdentity)
    .update('\n')
    .update(invocationSignature(args.launch as unknown as Record<string, unknown>))
    .digest('hex');
  return `${CRAFTBOOK_INVOCATION_KEY_PREFIX}${digest}`;
}
