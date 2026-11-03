import type { ChatSession } from './schemas/session.js';

/**
 * Whether a thread is pinned to a task or to a craftbook being edited. Those
 * threads have their own surface (the task's Chat tab, the craftbook editor's
 * AI assist), so a gezel's ordinary conversation never resumes one and a
 * message to the gezel is never delivered into one: an ordinary message
 * landing there would be read against a task's procedure or turned into an
 * edit of the book.
 */
export function isTaskOrCraftbookSession(
  session: Pick<ChatSession, 'taskRef' | 'craftbookRef'>,
): boolean {
  return Boolean(session.taskRef || session.craftbookRef);
}
