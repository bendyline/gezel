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
 * Open one Handboek article. The Handboek lives in the Knowledge area as its
 * built-in `handboek` catalog, so the article is a knowledge document there.
 */
export function openHandboekArticleActions(articleId: string): NavAction[] {
  const intent: OpenKnowledgeIntent = { catalogId: 'handboek', documentId: articleId };
  return [
    { kind: 'open-knowledge', intent },
    openTabAction({ kind: 'area', area: 'knowledge' }),
    { kind: 'event', type: 'gezel:open-knowledge-document', detail: intent },
  ];
}

/**
 * Open one file in its project's file editor. Queue first so a remounting
 * `ProjectsView` can consume the intent, then switch to the project tab, then
 * fire the live event for a view that is already open.
 *
 * A project file must never be opened as a `document` tab: that tab is the
 * shared-library editor, and its autosave writes into the library folder.
 */
export function openProjectFileActions(intent: OpenFileIntent): NavAction[] {
  return [
    { kind: 'open-file', intent },
    openTabAction({ kind: 'project', id: intent.projectId }),
    { kind: 'event', type: 'gezel:open-file', detail: intent },
  ];
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

/** Opens the titlebar's Updates drawer (the owner's pending questions). */
export const OPEN_UPDATES_EVENT = 'gezel:open-updates';

export function openUpdates(): void {
  window.dispatchEvent(new CustomEvent(OPEN_UPDATES_EVENT));
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
