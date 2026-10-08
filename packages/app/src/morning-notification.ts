import type { ChatEventEnvelope } from '@bendyline/gezel';

/**
 * The one morning notification: the night's review card, when the daemon
 * files it. Returns the notification once per card (`seen` remembers ids, so
 * a reconnect that replays the event stays quiet), else null.
 */
export function morningNotificationFor(
  envelope: ChatEventEnvelope,
  seen: Set<string>,
): { title: string; body: string } | null {
  const event = envelope.event;
  if (event.type !== 'question_asked') return null;
  const question = event.question;
  if (question.intent?.kind !== 'night-shift-review' || question.answer) return null;
  if (seen.has(question.id)) return null;
  seen.add(question.id);
  return { title: 'Your crew worked overnight', body: question.prompt };
}
