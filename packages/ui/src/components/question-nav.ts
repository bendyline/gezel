import type { Question } from '@bendyline/gezel';
import { type NavAction, openTabAction, runNavActions } from './nav-actions.js';
import type { OpenSessionIntent } from './pending-open-session.js';

/**
 * The chat thread a question came from, or null when it has none.
 *
 * Service-synthesized cards are filed with `sessionId: ''` — task-paused
 * and night-shift-review carry no conversation at all, and
 * schedule-approval comes from project-type adoption rather than a turn.
 * Those get their own affordance (the context strip's "Open task", the
 * report rows), so "Open in chat" is hidden rather than left dead. The
 * `gezelId` check guards the same shape: task-paused falls back to
 * `config.meesterGezelId ?? ''`, which is empty on an install with no
 * designated Meester.
 */
export function questionChatTarget(question: Question): OpenSessionIntent | null {
  if (!question.gezelId || !question.sessionId) return null;
  return {
    gezelId: question.gezelId,
    sessionId: question.sessionId,
    ...(question.projectId ? { projectId: question.projectId } : {}),
  };
}

/** Pure mapping from a question to the navigation that focuses its thread. */
export function questionToActions(question: Question): NavAction[] {
  const intent = questionChatTarget(question);
  if (!intent) return [];
  return [
    { kind: 'open-session', intent },
    openTabAction({ kind: 'gezel', id: intent.gezelId }),
    { kind: 'event', type: 'gezel:open-session', detail: intent },
  ];
}

/**
 * Focus the thread a question was asked in. Hosts call this from their
 * `onOpenInChat` handler and then close themselves.
 */
export function openQuestionInChat(question: Question): void {
  runNavActions(questionToActions(question));
}
