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
 * An entry whose scope does not already say where it came from carries a
 * source after the kind — `## HH:MM [pref] {project:spanish gezel:wren}` —
 * so retrieval can prefer the current project's entries and growth can
 * credit the gezel that wrote an entry about the person.
 *
 * Deliberately a leaf module with no imports so `fs/store.ts` can depend
 * on it without cycles.
 */

/**
 * `correction` is a mistake and its fix, and `example` is a worked example
 * worth repeating. Both come from scored work, where a script knows which
 * answer was right; the others come from conversation.
 */
export const MEMORY_KINDS = [
  'fact',
  'decision',
  'pref',
  'status',
  'correction',
  'example',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const DEFAULT_MEMORY_KIND: MemoryKind = 'fact';

/**
 * Whose memory an entry is: one gezel's, one project's, or the person's own
 * ("About you"), which every gezel reads.
 */
export const MEMORY_SCOPES = ['gezel', 'project', 'user'] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** The user scope has one owner, so every call names it with this id. */
export const USER_MEMORY_ID = 'user';

export function isMemoryScope(value: string | undefined | null): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/** Where an entry came from, when its scope does not already say. */
export interface MemorySource {
  project?: string;
  gezel?: string;
}

/** The source an entry keeps: only what its scope does not already say. */
export function memoryEntrySource(
  scope: MemoryScope,
  source: MemorySource | undefined,
): MemorySource | undefined {
  const project = scope === 'project' ? undefined : source?.project;
  const gezel = scope === 'gezel' ? undefined : source?.gezel;
  return project || gezel
    ? { ...(project ? { project } : {}), ...(gezel ? { gezel } : {}) }
    : undefined;
}

/**
 * How much more an entry written in the project at hand counts in recall than
 * one written elsewhere. Project scope already is that project; this ranks
 * the gezel's and the person's own entries.
 */
export const SAME_PROJECT_MEMORY_BOOST = 1.2;

export function sameProjectMemoryScore(
  score: number,
  source: MemorySource | undefined,
  projectId: string | undefined,
): number {
  return projectId && source?.project === projectId ? score * SAME_PROJECT_MEMORY_BOOST : score;
}

/**
 * Matches the legacy `## HH:MM`, `## HH:MM [kind]`, and
 * `## HH:MM [kind] {project:<id> gezel:<id>}` headings.
 */
export const MEMORY_HEADING_RE = /^## (\d{2}:\d{2})(?:\s*\[([a-z]+)\])?(?:\s*\{([^{}\n]*)\})?\s*$/;

const SOURCE_KEYS = ['project', 'gezel'] as const;
const SOURCE_VALUE_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isMemoryKind(value: string | undefined | null): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function formatMemoryBlock(
  time: string,
  text: string,
  kind: MemoryKind,
  source?: MemorySource,
): string {
  return `\n## ${time} [${kind}]${renderMemorySource(source)}\n\n${text.trim()}\n`;
}

/** ` {project:<id> gezel:<id>}`, or empty when there is nothing safe to say. */
export function renderMemorySource(source: MemorySource | undefined): string {
  const parts = SOURCE_KEYS.flatMap((key) => {
    const value = source?.[key];
    return value && SOURCE_VALUE_RE.test(value) ? [`${key}:${value}`] : [];
  });
  return parts.length > 0 ? ` {${parts.join(' ')}}` : '';
}

/** The source of a heading's `{…}` suffix; unknown keys and unsafe values drop. */
export function parseMemorySource(raw: string | undefined): MemorySource | undefined {
  if (!raw) return undefined;
  const source: MemorySource = {};
  for (const token of raw.trim().split(/\s+/)) {
    const at = token.indexOf(':');
    const key = token.slice(0, at);
    const value = token.slice(at + 1);
    if (at > 0 && (SOURCE_KEYS as readonly string[]).includes(key) && SOURCE_VALUE_RE.test(value)) {
      source[key as (typeof SOURCE_KEYS)[number]] = value;
    }
  }
  return source.project || source.gezel ? source : undefined;
}

export interface ParsedMemoryBlock {
  /** HH:MM heading time. */
  time: string;
  /** Parsed kind; missing or unknown suffixes fall back to 'fact'. */
  kind: MemoryKind;
  /** Block body with surrounding whitespace trimmed. */
  text: string;
  /** Where the entry came from, when its heading says. */
  source?: MemorySource;
}

/**
 * Parse one daily file's content into its memory blocks. Tolerant of
 * legacy headings (no kind suffix) and of unknown kind tags — both map
 * to 'fact'. Blocks with empty bodies are dropped.
 */
export function parseMemoryDay(content: string): ParsedMemoryBlock[] {
  const blocks: ParsedMemoryBlock[] = [];
  const lines = content.split('\n');
  let current: { time: string; kind: MemoryKind; source?: MemorySource; body: string[] } | null =
    null;

  const flush = () => {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) {
      blocks.push({
        time: current.time,
        kind: current.kind,
        text,
        ...(current.source ? { source: current.source } : {}),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const m = line.match(MEMORY_HEADING_RE);
    if (m) {
      flush();
      const kind = isMemoryKind(m[2]) ? m[2] : DEFAULT_MEMORY_KIND;
      const source = parseMemorySource(m[3]);
      current = { time: m[1]!, kind, ...(source ? { source } : {}), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * One day file holding every entry of both: `existing` as it stands, then each
 * entry of `incoming` it does not already have (same kind and text), in
 * order. A restore uses it so the person's memories are added to, never
 * replaced.
 */
export function mergeMemoryDay(existing: string, incoming: string): string {
  const have = new Set(parseMemoryDay(existing).map((block) => `${block.kind}\0${block.text}`));
  let merged = existing;
  for (const block of parseMemoryDay(incoming)) {
    const key = `${block.kind}\0${block.text}`;
    if (have.has(key)) continue;
    have.add(key);
    merged += formatMemoryBlock(block.time, block.text, block.kind, block.source);
  }
  return merged;
}
