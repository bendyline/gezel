import { type RefObject, useEffect } from 'react';

/**
 * Marks, inside a rendered reply, each sentence the fact check could not
 * find in any source. The check used to report them only in a gray line
 * under the reply ("3 sources · 1 statement not found in any source"), so
 * a wrong weekday table read as settled until the person opened the
 * footer and matched its quote back to the text.
 *
 * Drawn with the CSS Custom Highlight API: no DOM is changed, so the
 * markdown renderer and its own updates are left alone.
 */
export const FLAGGED_HIGHLIGHT = 'gezel-unconfirmed';

/** `[1]`, `[1, 2]`, `[2-4]`: citation markers, as text in the rendered reply. */
const MARKER = /\s*\[\d{1,3}(?:\s*(?:[-–]|,)\s*\d{1,3})*\]/g;

/** A checked sentence as the reader sees it: no markdown punctuation, no markers. */
function plainSentence(text: string): string {
  return text
    .replace(MARKER, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TextIndex {
  /** The container's text with markers dropped and whitespace collapsed. */
  text: string;
  /** For each character of `text`, the node and offset it came from. */
  at: Array<{ node: Text; offset: number }>;
}

function indexText(container: HTMLElement): TextIndex {
  const nodes: Text[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const raw = nodes.map((node) => node.data).join('');
  const dropped = new Set<number>();
  for (const match of raw.matchAll(MARKER)) {
    for (let i = match.index ?? 0; i < (match.index ?? 0) + match[0].length; i++) dropped.add(i);
  }
  const index: TextIndex = { text: '', at: [] };
  let rawAt = 0;
  let lastWasSpace = true;
  for (const node of nodes) {
    for (let offset = 0; offset < node.data.length; offset++, rawAt++) {
      if (dropped.has(rawAt)) continue;
      const ch = node.data[offset]!;
      const space = /\s/.test(ch);
      if (space && lastWasSpace) continue;
      index.text += space ? ' ' : ch;
      index.at.push({ node, offset });
      lastWasSpace = space;
    }
  }
  return index;
}

/**
 * Where each sentence sits in the rendered reply. A sentence the renderer
 * changed past recognizing is matched by its opening words up to the end
 * of that sentence; one that cannot be found is left unmarked rather than
 * marking the wrong words.
 */
export function findSentenceRanges(container: HTMLElement, sentences: readonly string[]): Range[] {
  const index = indexText(container);
  const ranges: Range[] = [];
  for (const sentence of sentences) {
    const plain = plainSentence(sentence);
    if (plain.length < 8) continue;
    let start = index.text.indexOf(plain);
    let end = start + plain.length;
    if (start < 0) {
      const opening = plain.split(' ').slice(0, 6).join(' ');
      if (opening.length < 12) continue;
      start = index.text.indexOf(opening);
      if (start < 0) continue;
      const stop = /[.!?](?:\s|$)/.exec(index.text.slice(start + opening.length));
      end = stop ? start + opening.length + stop.index + 1 : index.text.length;
    }
    const first = index.at[start];
    const last = index.at[end - 1];
    if (!first || !last) continue;
    const range = container.ownerDocument.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    ranges.push(range);
  }
  return ranges;
}

type HighlightRegistry = Map<string, { add(range: Range): void; delete(range: Range): boolean }>;

function registry(): HighlightRegistry | null {
  const highlights = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  return highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'
    ? highlights
    : null;
}

/** Mark `sentences` inside the element `ref` points at, for as long as it renders them. */
export function useFlaggedSentences(
  ref: RefObject<HTMLElement | null>,
  sentences: readonly string[],
): void {
  const key = sentences.join('\n');
  useEffect(() => {
    const container = ref.current;
    const highlights = registry();
    if (!container || !highlights || !key) return;
    const wanted = key.split('\n');
    let shared = highlights.get(FLAGGED_HIGHLIGHT);
    if (!shared) {
      const HighlightCtor = (globalThis as unknown as { Highlight: new () => typeof shared })
        .Highlight;
      shared = new HighlightCtor();
      highlights.set(FLAGGED_HIGHLIGHT, shared!);
    }
    const target = shared!;
    let placed: Range[] = [];
    const place = () => {
      for (const range of placed) target.delete(range);
      placed = findSentenceRanges(container, wanted);
      for (const range of placed) target.add(range);
    };
    place();
    // The markdown renderer fills in after mount and again as media loads.
    const observer = new MutationObserver(() => place());
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      for (const range of placed) target.delete(range);
    };
  }, [ref, key]);
}
