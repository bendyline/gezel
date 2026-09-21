/** Literal token matching over source text; no model or derived index is involved. */
export function lexicalTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_]+/gu) ?? [],
    ),
  ].slice(0, 32);
}

export function lexicalScore(terms: readonly string[], value: string): number {
  if (!terms.length) return 0;
  const text = value.normalize('NFKC').toLocaleLowerCase();
  return terms.filter((term) => text.includes(term)).length / terms.length;
}

export function lexicalExcerpt(
  terms: readonly string[],
  text: string,
): { snippet: string; line: number; lineEnd: number } | null {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => lexicalScore(terms, line) > 0);
  if (first < 0) return null;
  const end = Math.min(lines.length, first + 3);
  return {
    snippet: lines.slice(first, end).join('\n').slice(0, 600),
    line: first + 1,
    lineEnd: end,
  };
}
