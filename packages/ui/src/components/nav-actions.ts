import { type OpenFileIntent, queueOpenFile } from './pending-open-file.js';
import { type OpenHandboekIntent, queueOpenHandboek } from './pending-open-handboek.js';
import { type OpenKnowledgeIntent, queueOpenKnowledge } from './pending-open-knowledge.js';
import { type OpenSessionIntent, queueOpenSession } from './pending-open-session.js';
import type { RecentTabInput } from './recent-tabs.js';

/**
 * One step of a navigation. Produced side-effect-free by the `*ToActions`
 * mappers (titlebar search results, pending questions) and interpreted by
 * {@link runNavActions}. Splitting the two keeps every mapper unit-testable
 * without a DOM, and keeps the queue-then-dispatch ordering rule in exactly
 * one place.
 */
export type NavAction =
  | { kind: 'event'; type: string; detail: unknown }
  | { kind: 'open-file'; intent: OpenFileIntent }
  | { kind: 'open-session'; intent: OpenSessionIntent }
  | { kind: 'open-handboek'; intent: OpenHandboekIntent }
  | { kind: 'open-knowledge'; intent: OpenKnowledgeIntent };

export function openTabAction(detail: RecentTabInput): NavAction {
  return { kind: 'event', type: 'gezel:open-tab', detail };
}

/**
 * Fire a single tab navigation — the common one-liner case. Going through
 * `RecentTabInput` is the point: a hand-built `gezel:open-tab` detail with a
 * wrong shape fails silently (App's listener just returns), so the type is
 * the only thing that catches it.
 */
export function navigateToTab(detail: RecentTabInput): void {
  runNavActions([openTabAction(detail)]);
}

/**
 * Order within the list is load-bearing: an intent is queued *before* the
 * `gezel:open-tab` event so a view that remounts can consume it on mount,
 * and the live `gezel:open-*` event trails so an already-open view (no
 * remount) still reacts. Mappers encode that order; this just runs it.
 */
export function runNavActions(actions: NavAction[]): void {
  for (const action of actions) {
    if (action.kind === 'open-file') {
      queueOpenFile(action.intent);
    } else if (action.kind === 'open-session') {
      queueOpenSession(action.intent);
    } else if (action.kind === 'open-handboek') {
      queueOpenHandboek(action.intent);
    } else if (action.kind === 'open-knowledge') {
      queueOpenKnowledge(action.intent);
    } else {
      window.dispatchEvent(new CustomEvent(action.type, { detail: action.detail }));
    }
  }
}
