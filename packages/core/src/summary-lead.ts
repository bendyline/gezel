/**
 * The opening of a file's index summary, as one plain line: the first
 * paragraph that is not a heading (a heading names the file; the prose under
 * it says what it is), markdown emphasis removed, cut at `max` characters.
 */
export function summaryLead(summary: string, max = 280): string {
  const paragraphs = summary
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const first =
    paragraphs.find((p) => !/^#+\s/.test(p)) ?? paragraphs[0]?.replace(/^#+\s+/, '') ?? '';
  const plain = first.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  return plain.length > max ? `${plain.slice(0, max - 3).trimEnd()}…` : plain;
}
