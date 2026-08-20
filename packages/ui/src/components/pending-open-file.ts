/**
 * One-shot "open this file" intent handed from the titlebar search to
 * `ProjectsView`. Selecting a file result in another project dispatches
 * `gezel:open-tab` (which remounts ProjectsView with the new project) and then
 * wants that file focused — but the new view's event listener isn't mounted in
 * time to catch a same-tick `gezel:open-file` event. This module bridges the
 * gap exactly like [nav-intents.ts](./nav-intents.ts): the search records the
 * intent before navigating, the freshly-mounted view consumes it.
 *
 * The companion live `gezel:open-file` event still covers the already-open
 * project case (no remount), and drains the mailbox so a stale intent can't
 * fire on a later manual navigation.
 */

export interface OpenFileIntent {
  projectId: string;
  path: string;
  source: 'workspace' | 'artifacts';
  /** 1-based line to reveal after opening — a search hit's match location. */
  line?: number;
  lineEnd?: number;
}

interface StoredIntent extends OpenFileIntent {
  at: number;
}

/** Intents older than this are ignored — a safety net against stale opens. */
const INTENT_TTL_MS = 10_000;

let pending: StoredIntent | null = null;

/** Record that the user asked to open `path` in `projectId`. */
export function queueOpenFile(intent: OpenFileIntent): void {
  pending = { ...intent, at: Date.now() };
}

/**
 * Consume a pending open-file intent for `projectId`; returns it (clearing the
 * mailbox) or null. Expired intents are dropped without firing.
 */
export function consumeOpenFile(projectId: string): OpenFileIntent | null {
  if (!pending) return null;
  if (pending.projectId !== projectId) return null;
  const { at, ...intent } = pending;
  pending = null;
  if (Date.now() - at > INTENT_TTL_MS) return null;
  return intent;
}
