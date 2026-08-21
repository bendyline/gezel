import { NEW_THREAD_TITLE } from '@bendyline/gezel';

/**
 * Shared presentation helpers for chat-thread labels.
 *
 * Lifted out of `SessionSwitcher` once a second surface — the chat pill
 * row — needed the same treatment. Keeping one copy matters most for
 * `MENTION_RE`: a thread auto-titled from a message that @-mentions
 * someone stores the raw `@[Ada](gezel:g1)` wire form, and any surface
 * that renders `session.title` without stripping it shows the markdown.
 */

/**
 * `@[Label](gezel:id)` mention markdown — the same wire form
 * `extractMentionTokens` reads. Used to swap raw mention syntax in a
 * thread title for a compact `@Label` pill (or plain `@Label` text).
 */
export const MENTION_RE = /@\[([^\]]+)\]\(gezel\\?:[^)\s]+\)/g;

/** Flatten mentions to `@Label` text for typeahead, titles, and triggers. */
export function plainTitle(title: string): string {
  return title.replace(MENTION_RE, (_full, label: string) => `@${label}`);
}

/**
 * The service stamps a fresh thread with the sentinel title "New session"
 * (and keys its auto-title logic off that exact string — see
 * `chat/manager.ts`). Show it as "New thread" in the UI without renaming
 * the stored sentinel.
 */
export function displayThreadTitle(title: string): string {
  return title === NEW_THREAD_TITLE ? 'New thread' : title;
}
