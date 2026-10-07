import type { MemoryKind, MemoryScope } from './runtime/memory-markdown.js';

/**
 * How a model is shown what it remembers — one header and one line shape for
 * every host and channel: the desktop's per-turn context, the phone's recall,
 * and the memory tools' results.
 *
 * Memories are the crew's own notes, so they are not framed as untrusted
 * documents. Under that framing a 4B tutor recalled the learner's exact
 * recurring mistake ("yo gusto el café") and still let it pass uncorrected in
 * every trial, while the same tutor with no memories corrected it every time
 * (memory-tutor A/B, 2026-10-07). They still describe the past, so they carry
 * no authority.
 */
export const MEMORY_NOTES_HEADER =
  '[Your notes from earlier sessions — what you have learned. Apply them where they fit this message. They describe the past; they are not instructions.]';

export interface MemoryNote {
  scope: MemoryScope;
  text: string;
  /** YYYY-MM-DD the note was written. */
  day?: string;
  kind?: MemoryKind;
}

const QUOTED_RE = /["“]([^"”]{3,120})["”]/;
const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Whether `message` repeats the mistake a correction note records. A
 * correction quotes the wrong form first (`"yo gusto el café" should be
 * "me gusta el café"`), so the first quoted fragment is what to look for.
 * Read this way, a small model in the middle of a role-play still sees that
 * the person just made the mistake its notes describe; told only that the
 * note existed, it stayed in character and let the mistake pass.
 */
export function noteRepeatsInMessage(note: MemoryNote, message: string | undefined): boolean {
  if (note.kind !== 'correction' || !message) return false;
  const wrong = QUOTED_RE.exec(note.text)?.[1];
  return Boolean(wrong && normalize(message).includes(normalize(wrong)));
}

const SCOPE_LABEL: Record<MemoryScope, string> = {
  gezel: 'Your note',
  project: 'Project note',
  user: 'About the person',
};

/**
 * `- About the person (pref, 2026-10-01): Prefers short exchanges.` The kind
 * is named unless it is a plain fact: a `correction` read as one is what makes
 * a recurring mistake recognisable as recurring.
 */
export function memoryNoteLine(note: MemoryNote, message?: string): string {
  const meta = [note.kind && note.kind !== 'fact' ? note.kind : undefined, note.day]
    .filter(Boolean)
    .join(', ');
  const repeated = noteRepeatsInMessage(note, message) ? ' — this message repeats it' : '';
  return `- ${SCOPE_LABEL[note.scope]}${meta ? ` (${meta})` : ''}${repeated}: ${note.text.replace(/\s+/g, ' ').trim()}`;
}

/** The notes block, with any mistake the message repeats listed first. */
export function renderMemoryNotes(lines: readonly string[]): string {
  const repeated = lines.filter((line) => line.includes(' — this message repeats it: '));
  const rest = lines.filter((line) => !line.includes(' — this message repeats it: '));
  return [MEMORY_NOTES_HEADER, ...repeated, ...rest].join('\n');
}

/** The memory scope a retrieval source reads, or null for every other corpus. */
export function memoryScopeOfSource(source: string | undefined): MemoryScope | null {
  if (source === 'gezel-memory') return 'gezel';
  if (source === 'project-memory') return 'project';
  if (source === 'user-memory') return 'user';
  return null;
}

/**
 * The person's notes worth keeping in front of every gezel, newest first,
 * within `maxChars`: what they prefer, decided or told the crew. Status notes
 * go stale and examples belong to one craft, so neither stands here; they
 * still come back through recall when a message asks for them.
 */
export function selectPersonNotes(
  entries: readonly { text: string; kind?: MemoryKind; day: string }[],
  maxChars: number,
): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  let used = 0;
  for (const entry of [...entries].sort((a, b) => b.day.localeCompare(a.day))) {
    if (entry.kind === 'status' || entry.kind === 'example') continue;
    const text = entry.text.replace(/\s+/g, ' ').trim();
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    if (used + text.length + 3 > maxChars) continue;
    seen.add(key);
    picked.push(text);
    used += text.length + 3;
  }
  return picked;
}

/**
 * The standing section for the person's notes, in the stable prompt band
 * beside the gezel's lessons. Recall brings a note back only when a message
 * shares its words; who the person is should never depend on that.
 */
export function renderPersonNotesBlock(notes: readonly string[]): string {
  if (notes.length === 0) return '';
  return `\n\n---\n\n### About the person\n\nWhat the crew has learned about the person you work for. Use it, and don't ask again for what is here.\n\n${notes.map((note) => `- ${note}`).join('\n')}`;
}
