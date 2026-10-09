import { QUERY_STOP_WORDS } from '@bendyline/gezk';
import { memoryNoteLine, renderMemoryNotes } from '../memory-notes.js';
import { contextBudgetCeiling, estimateTokens } from '../retrieval-budget.js';
import { lexicalTerms } from './lexical.js';
import { type PortableMemoryHit, searchMemoryScope } from './memories.js';
import { USER_MEMORY_ID, sameProjectMemoryScore } from './memory-markdown.js';
import type { PortableRepository } from './repository.js';

/** At most this many entries reach one turn, however large the window. */
export const MEMORY_RECALL_MAX_ENTRIES = 4;

/**
 * The words of a message worth searching memory for: no filler, nothing one
 * letter long. A message made only of filler recalls nothing, rather than
 * whatever happens to contain "you".
 */
export function memoryRecallTerms(text: string): string[] {
  return lexicalTerms(text).filter((term) => term.length > 1 && !QUERY_STOP_WORDS.has(term));
}

/**
 * The phone's per-turn memory recall: entries from the gezel's, the
 * project's and the person's own memories that share a word with the message,
 * within the window's retrieval ceiling (160 tokens at 4K, 320 at 8K). Lexical
 * because the phone has no embedder, so every recalled entry contains a word
 * the person typed. Entries written in this project rank first. Prepended to
 * the user message for the model only, like the desktop's indexed context, so
 * the system prompt's cached prefix never changes.
 */
export async function recallPortableMemories(
  repo: PortableRepository,
  args: { gezelId: string; projectId: string; text: string; contextWindow?: number },
): Promise<{ block: string; hits: PortableMemoryHit[] } | null> {
  const terms = memoryRecallTerms(args.text);
  if (terms.length === 0) return null;
  const query = terms.join(' ');
  const scopes = await Promise.all([
    searchMemoryScope(repo, 'gezel', args.gezelId, query),
    searchMemoryScope(repo, 'project', args.projectId, query),
    searchMemoryScope(repo, 'user', USER_MEMORY_ID, query),
  ]);
  const seen = new Set<string>();
  const ranked = scopes
    .flatMap((scope) => scope.results)
    .map((hit) => ({
      ...hit,
      score: sameProjectMemoryScore(hit.score, hit.source, args.projectId),
    }))
    .sort((a, b) => b.score - a.score || b.day.localeCompare(a.day))
    .filter((hit) => {
      const key = hit.text.trim().toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const budget = contextBudgetCeiling(args.contextWindow);
  const rows: string[] = [];
  const hits: PortableMemoryHit[] = [];
  for (const hit of ranked) {
    if (hits.length >= MEMORY_RECALL_MAX_ENTRIES) break;
    const row = memoryNoteLine(hit, args.text);
    if (estimateTokens(renderMemoryNotes([...rows, row])) > budget) continue;
    rows.push(row);
    hits.push(hit);
  }
  return hits.length > 0 ? { block: renderMemoryNotes(rows), hits } : null;
}
