import type { TaskNote } from '../schemas/task.js';

/**
 * Render the most recent task notes as a compact digest for prompt
 * injection. Newest first, capped to keep the system prompt manageable.
 * Each entry shows time, author, and the first lines of the note text.
 * Callers pass notes already sorted newest first.
 */
export function formatTaskNotesDigest(notes: readonly TaskNote[], limit = 10): string {
  if (notes.length === 0) return '';
  const lines: string[] = [];
  for (const n of notes.slice(0, limit)) {
    const author = n.author.kind === 'user' ? 'User' : n.author.name;
    const body = n.text.trim();
    lines.push(`- _${n.at}_ — **${author}**:\n${body}`);
  }
  if (notes.length > limit) {
    lines.push(
      `_(…${notes.length - limit} older note(s) — call \`read_task_notes\` for the full feed.)_`,
    );
  }
  return lines.join('\n\n');
}

/** Task notes newest first, the order {@link formatTaskNotesDigest} expects. */
export function newestTaskNotesFirst(notes: readonly TaskNote[]): TaskNote[] {
  return [...notes].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
