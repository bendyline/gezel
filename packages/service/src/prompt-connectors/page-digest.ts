/**
 * What a turn is given of a saved web page the person named: a short summary
 * and as much of the page's text as the turn's budget holds. A page that fits
 * goes whole. A longer one keeps its opening and the passages that share words
 * with the question, in page order, so "what does the pricing page say about
 * teams" gets the teams passage and "summarize this" gets the start. Pure and
 * model-free: it reads the saved record, never the index, so the first turn
 * after a save has it.
 */

import { proactiveRetrievalTerms, termMatchFraction } from '../index-store/query-terms.js';

export interface PageDigest {
  /** One or two sentences, at most `SUMMARY_MAX` characters. */
  summary: string;
  /** `synopsis`: written by the index's model. `description`: the page's own. `opening`: its first lines. */
  summarySource: 'synopsis' | 'description' | 'opening';
  /** The page text the turn gets. */
  text: string;
  /** Whether `text` is the whole page. */
  whole: boolean;
  /** Words in the whole page and in `text`. */
  words: number;
  shownWords: number;
}

export const SUMMARY_MAX = 320;
/** A passage is at most about this long, so a pick is a paragraph or two, not a chapter. */
const BLOCK_CHARS = 900;
const GAP = '[…]';

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** The record's reading text: no screenshot section, no image lines. */
export function pageReadingText(markdown: string): string {
  return markdown
    .replace(/\n## How the page looked[\s\S]*$/, '')
    .replace(/^!\[[^\]]*\]\([^)]*\)[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Paragraph groups of about `BLOCK_CHARS`, each starting at a heading where one exists. */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  let current = '';
  // A heading stays with the paragraph under it, however long that is.
  let headingOnly = false;
  for (const para of text.split(/\n{2,}/)) {
    const heading = /^#{1,6}\s/.test(para);
    const full = !headingOnly && current.length + para.length > BLOCK_CHARS;
    if (current && (heading || full)) {
      blocks.push(current);
      current = '';
    }
    headingOnly = heading && (current === '' || headingOnly);
    current = current ? `${current}\n\n${para}` : para;
  }
  if (current) blocks.push(current);
  return blocks;
}

function firstProse(text: string): string {
  for (const para of text.split(/\n{2,}/)) {
    const plain = para.replace(/^#{1,6}\s.*$/gm, '').trim();
    if (plain.length >= 40) return plain;
  }
  return text;
}

export function digestPage(args: {
  /** The record's markdown body (frontmatter already removed). */
  markdown: string;
  /** The page's own description, from its metadata. */
  description?: string;
  /** A synopsis the index's model wrote, when one exists. */
  synopsis?: string;
  /** The person's message; addresses in it are not search words. */
  query: string;
  budgetChars: number;
}): PageDigest {
  const text = pageReadingText(args.markdown);
  const words = countWords(text);
  const synopsis = args.synopsis?.trim();
  const description = args.description?.trim();
  const summary = synopsis
    ? { summary: oneLine(synopsis, SUMMARY_MAX), summarySource: 'synopsis' as const }
    : description && description.length >= 20
      ? { summary: oneLine(description, SUMMARY_MAX), summarySource: 'description' as const }
      : { summary: oneLine(firstProse(text), SUMMARY_MAX), summarySource: 'opening' as const };

  const budget = Math.max(400, args.budgetChars);
  if (text.length <= budget) {
    return { ...summary, text, whole: true, words, shownWords: words };
  }

  const blocks = blocksOf(text);
  const terms = proactiveRetrievalTerms(args.query.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' '));
  const scored = blocks.map((block, index) => ({
    index,
    score: index === 0 ? 2 : termMatchFraction(block, terms),
  }));
  // The opening always; then the passages that share the most words with the
  // question; then, with room left, the page in order.
  const order = [
    ...scored.filter((b) => b.score > 0).sort((a, b) => b.score - a.score || a.index - b.index),
    ...scored.filter((b) => b.score === 0),
  ];
  const picked = new Set<number>();
  let used = 0;
  for (const { index } of order) {
    const block = blocks[index] ?? '';
    const room = budget - used;
    if (room < 200) break;
    const cost = block.length + GAP.length + 4;
    if (cost <= room) {
      picked.add(index);
      used += cost;
      continue;
    }
    // Too long for what is left. While most of the budget is still unspent,
    // its start is worth more than nothing; later, a shorter passage may fit.
    if (used < budget / 2) {
      blocks[index] = `${block.slice(0, room - GAP.length - 5).trimEnd()}…`;
      picked.add(index);
      break;
    }
  }
  const kept = [...picked].sort((a, b) => a - b);
  const parts: string[] = [];
  kept.forEach((index, i) => {
    if (i > 0 && index !== (kept[i - 1] ?? 0) + 1) parts.push(GAP);
    parts.push(blocks[index] ?? '');
  });
  if ((kept.at(-1) ?? 0) < blocks.length - 1) parts.push(GAP);
  const shown = parts.join('\n\n');
  return { ...summary, text: shown, whole: false, words, shownWords: countWords(shown) };
}
