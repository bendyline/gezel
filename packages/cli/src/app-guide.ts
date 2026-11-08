import type { HandboekCatalog } from '@bendyline/gezel-service/handboek';
import { createHandboekEngine, siteDeviceInfo } from '@bendyline/gezel-service/handboek';
import { CliError } from './connection.js';
import { PUBLISHED_HANDBOEK, rewriteSiteLinks, siteLinkIndex } from './handboek-links.js';

/** The Handboek article `gezel app guide` prints, and gezel.com publishes. */
export const APP_GUIDE_ARTICLE_ID = 'build-a-gezel-app';

// The guide and the four articles it includes name no catalog item, so the
// engine runs without loading the catalog.
const NO_CATALOG: HandboekCatalog = {
  list: async () => [],
  get: async () => null,
};

/**
 * The integrated app-building guide from the Handboek this CLI ships: the
 * loop, the rules, and the four guides in full, with links pointing at
 * gezel.com. Matches the installed version, and needs no network or daemon.
 */
export async function renderAppGuide(opts: { contentDir?: string } = {}): Promise<string> {
  const engine = createHandboekEngine({
    catalog: NO_CATALOG,
    device: siteDeviceInfo,
    ...(opts.contentDir ? { contentDir: opts.contentDir } : {}),
  });
  const article = await engine.article(APP_GUIDE_ARTICLE_ID, {
    mode: 'agent',
    inlineIncludes: true,
  });
  if (!article) {
    throw new CliError(
      `this install has no "${APP_GUIDE_ARTICLE_ID}" Handboek article; read ${PUBLISHED_HANDBOEK}${APP_GUIDE_ARTICLE_ID}.md`,
    );
  }
  const { areas } = await engine.toc();
  const { ids, byStem } = siteLinkIndex(areas.flatMap((a) => a.entries.map((e) => e.id)));
  const markdown = rewriteSiteLinks(
    article.markdown,
    article.id,
    ids,
    byStem,
    () => true,
    PUBLISHED_HANDBOEK,
  );
  return `${markdown.trimEnd()}\n`;
}

export async function runAppGuide(): Promise<void> {
  process.stdout.write(await renderAppGuide());
}
