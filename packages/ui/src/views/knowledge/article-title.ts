/**
 * An article's markdown without the `#` heading that repeats its title. The
 * reader's header already shows the title (and the topic under it), so an
 * article that opens on its own H1 showed "What is gezel?" twice, the second
 * time larger than the first (2026-11-09). Only a first heading that says the
 * same thing is dropped; an article whose H1 differs keeps it.
 */
export function withoutRepeatedTitle(markdown: string, title: string): string {
  const match =
    /^(\s*(?:---\r?\n[\s\S]*?\r?\n---\r?\n)?\s*)#[ \t]+([^\r\n]*?)[ \t#]*(\r?\n|$)/.exec(markdown);
  if (!match) return markdown;
  if (comparable(match[2] ?? '') !== comparable(title)) return markdown;
  const rest = markdown.slice(match[0].length).replace(/^\s*\r?\n/, '');
  return `${match[1] ?? ''}${rest}`;
}

function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/[\s.!?:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
