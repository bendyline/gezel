import type { KnowledgeDocumentInitial, KnowledgeDocumentSummary } from '@bendyline/gezel-client';

/** Digits and symbols sort first in a slug listing, so `#` leads the index. */
export const LETTER_INDEX_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] as const;

export interface LetterIndexEntry {
  key: string;
  /** Listing position of the first document filed under this key; null when none is. */
  offset: number | null;
}

/** The key a slug initial files under: its base Latin letter (é → E), else `#`. */
export function letterKeyFor(initial: string): string {
  const base = initial
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .charAt(0);
  return base >= 'A' && base <= 'Z' ? base : '#';
}

/** The key the listing files a document under; null for a curated (ordinal) document. */
export function letterKeyForDocument(document: KnowledgeDocumentSummary): string | null {
  if (document.ordinal !== null) return null;
  return letterKeyFor(Array.from(document.slug)[0] ?? '');
}

/** Every key, in order, with where its first document sits. */
export function buildLetterIndex(initials: KnowledgeDocumentInitial[]): LetterIndexEntry[] {
  const first = new Map<string, number>();
  for (const { initial, offset } of initials) {
    const key = letterKeyFor(initial);
    const known = first.get(key);
    if (known === undefined || offset < known) first.set(key, offset);
  }
  return LETTER_INDEX_KEYS.map((key) => ({ key, offset: first.get(key) ?? null }));
}

/**
 * A listing earns an index when it runs past one page and spreads over at
 * least two letters. A curated listing (every document has an ordinal) has
 * no initials, so it never shows one: its order is not alphabetical.
 */
export function showsLetterIndex(
  entries: LetterIndexEntry[],
  total: number,
  pageSize: number,
): boolean {
  if (total <= pageSize) return false;
  return entries.filter((entry) => entry.offset !== null).length >= 2;
}
