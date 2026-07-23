import type { ChatEventEnvelope } from '@bendyline/gezel';

/**
 * Fold one global chat event into the set of sessions currently doing work.
 * Returns true only when the tray's idle/working state changed, so delta and
 * tool bursts do not cause redundant native-image updates.
 */
export function updateActiveTraySessions(
  activeSessions: Set<string>,
  envelope: ChatEventEnvelope,
): boolean {
  const wasWorking = activeSessions.size > 0;
  if (envelope.event.type === 'user_message') {
    activeSessions.add(envelope.sessionId);
  } else if (envelope.event.type === 'done' || envelope.event.type === 'error') {
    activeSessions.delete(envelope.sessionId);
  }
  return wasWorking !== activeSessions.size > 0;
}
