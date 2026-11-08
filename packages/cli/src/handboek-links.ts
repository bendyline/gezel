/** Where the Handboek is published, for links that must work off the site. */
export const PUBLISHED_HANDBOEK = 'https://gezel.com/docs/';

const up = (depth: number): string => '../'.repeat(depth);

/**
 * Rewrite intra-handboek links for the static layout. Articles link two
 * ways — relative `.md` paths in curated prose, bare article ids in
 * generated tables — and both must land on `<root>/<target-id>/` from a
 * page nested at `<root>/<page-id>/`. An asset this content tree does not
 * carry (an npm install leaves out the scorecard evidence) links to its
 * gezel.com copy, as the in-app Handboek does. With `base` the links are
 * absolute instead, for the markdown twins and `gezel app guide`, which are
 * read away from the page.
 */
export function rewriteSiteLinks(
  markdown: string,
  pageId: string,
  ids: Set<string>,
  byStem: Map<string, string>,
  hasAsset: (path: string) => boolean = () => true,
  base?: string,
): string {
  const prefix = base ?? up(pageId.split('/').length);
  return markdown.replace(/\]\(([^()\s]+)\)/g, (whole, rawTarget: string) => {
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget) ||
      rawTarget.startsWith('//') ||
      rawTarget.startsWith('#')
    ) {
      return whole;
    }
    const [path, suffix = ''] = splitLinkSuffix(rawTarget);
    const candidate = path.replace(/^(\.\.?\/)+/, '');
    if (candidate.startsWith('assets/')) {
      return hasAsset(candidate)
        ? `](${prefix}${candidate}${suffix})`
        : `](${PUBLISHED_HANDBOEK}${candidate}${suffix})`;
    }
    const article = candidate.replace(/\.md$/, '');
    const target = ids.has(article) ? article : byStem.get(article.split('/').pop() ?? '');
    if (!target) return whole;
    return `](${prefix}${target}/${suffix})`;
  });
}

/** Article ids, and the last path segment of each for stem-only links. */
export function siteLinkIndex(entryIds: readonly string[]): {
  ids: Set<string>;
  byStem: Map<string, string>;
} {
  const byStem = new Map<string, string>();
  for (const id of entryIds) {
    const stem = id.split('/').pop();
    if (stem && !byStem.has(stem)) byStem.set(stem, id);
  }
  return { ids: new Set(entryIds), byStem };
}

function splitLinkSuffix(raw: string): [string, string] {
  const idx = raw.search(/[?#]/);
  return idx === -1 ? [raw, ''] : [raw.slice(0, idx), raw.slice(idx)];
}
