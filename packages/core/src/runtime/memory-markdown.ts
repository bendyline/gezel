/**
 * Shared format + parser for the daily memory markdown files
 * (`memories/daily/YYYY-MM-DD.md`). These files are the memory system's
 * source of truth — the sqlite-vec index is a derived cache rebuilt from
 * them — so every reader (manager.allEntries, the health monitor's count,
 * the compactor) must parse them identically. This module is the single
 * definition of that format.
 *
 * Block format (new writes always carry the kind suffix):
 *
 *   ## HH:MM [kind]
 *
 *   One concise memory sentence.
 *
 * Legacy blocks (`## HH:MM` with no suffix) parse as kind 'fact'.
 *
 * Deliberately a leaf module with no imports so `fs/store.ts` can depend
 * on it without cycles.
 */

export type MemoryKind = 'fact' | 'decision' | 'pref' | 'status';

export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'decision', 'pref', 'status'];

export const DEFAULT_MEMORY_KIND: MemoryKind = 'fact';

/** Matches both legacy `## HH:MM` and new `## HH:MM [kind]` headings. */
export const MEMORY_HEADING_RE = /^## (\d{2}:\d{2})(?:\s*\[([a-z]+)\])?\s*$/;

export function isMemoryKind(value: string | undefined | null): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function formatMemoryBlock(time: string, text: string, kind: MemoryKind): string {
  return `\n## ${time} [${kind}]\n\n${text.trim()}\n`;
}

export interface ParsedMemoryBlock {
  /** HH:MM heading time. */
  time: string;
  /** Parsed kind; missing or unknown suffixes fall back to 'fact'. */
  kind: MemoryKind;
  /** Block body with surrounding whitespace trimmed. */
  text: string;
}

/**
 * Parse one daily file's content into its memory blocks. Tolerant of
 * legacy headings (no kind suffix) and of unknown kind tags — both map
 * to 'fact'. Blocks with empty bodies are dropped.
 */
export function parseMemoryDay(content: string): ParsedMemoryBlock[] {
  const blocks: ParsedMemoryBlock[] = [];
  const lines = content.split('\n');
  let current: { time: string; kind: MemoryKind; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) blocks.push({ time: current.time, kind: current.kind, text });
    current = null;
  };

  for (const line of lines) {
    const m = line.match(MEMORY_HEADING_RE);
    if (m) {
      flush();
      const kind = isMemoryKind(m[2]) ? m[2] : DEFAULT_MEMORY_KIND;
      current = { time: m[1]!, kind, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return blocks;
}
