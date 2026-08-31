/**
 * In-memory "where was I" for the chat surfaces — the companion to
 * {@link ./composer-drafts.js}. Drafts preserve what the user was writing;
 * this preserves who they were writing to and which thread it was going into.
 *
 * The same unmount that discarded the draft also discarded the surrounding
 * selection: the meester conversation forgot which gezel it had handed off to,
 * a gezel tab forgot which thread was focused, and project chat fell back to
 * its voorman-first ranking. Re-picking the newest thread is a reasonable
 * *first* answer, but it is the wrong answer to "I was just here".
 *
 * Memory-only and best-effort by design. A restored session id that has since
 * been archived or deleted is not an error: `SessionSwitcher` already falls
 * back to auto-picking the newest thread in scope when the id it is handed is
 * not in the list, so a stale entry costs one extra list read and nothing else.
 */

export interface ChatThreadSelection {
  gezelId?: string;
  projectId?: string;
  sessionId?: string;
}

/** Same rationale as the draft cap — see `composer-drafts.ts`. */
const MAX_ENTRIES = 128;

const selections = new Map<string, ChatThreadSelection>();

/** The Home workshop's meester conversation. There is only ever one. */
export const MEESTER_THREAD_KEY = 'meester';

/** A gezel tab scoped to one project. */
export function gezelThreadKey(gezelId: string, projectId: string): string {
  return `gezel|${gezelId}|${projectId}`;
}

/** A gezel tab's cross-project "All projects" mode. */
export function gezelAllProjectsThreadKey(gezelId: string): string {
  return `gezel-all|${gezelId}`;
}

/** Which gezel a project chat was addressing. */
export function projectRecipientKey(projectId: string): string {
  return `project|${projectId}`;
}

/** Which thread a project chat had open with one gezel. */
export function projectThreadKey(projectId: string, gezelId: string): string {
  return `project|${projectId}|${gezelId}`;
}

export function readChatThreadSelection(key: string): ChatThreadSelection | undefined {
  return selections.get(key);
}

/**
 * Merge a patch over whatever is remembered. Fields are written
 * independently — the meester conversation learns its project before the
 * session it will open there — so a patch must never blank a sibling field
 * it says nothing about. Pass an explicit empty string to forget one.
 */
export function writeChatThreadSelection(key: string, patch: ChatThreadSelection): void {
  const merged = { ...selections.get(key), ...patch };
  selections.delete(key);
  selections.set(key, merged);
  while (selections.size > MAX_ENTRIES) {
    const oldest = selections.keys().next();
    if (oldest.done) break;
    selections.delete(oldest.value);
  }
}

export function clearChatThreadSelection(key: string): void {
  selections.delete(key);
}

/** Test seam. */
export function resetChatThreadMemory(): void {
  selections.clear();
}
