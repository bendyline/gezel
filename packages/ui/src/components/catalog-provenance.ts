/**
 * Which catalog tier an item came from, as the person choosing it should
 * understand it.
 *
 * The community tier is thousands of MCP servers imported automatically from
 * the public MCP registry. Nobody at Gezel reads them before they are listed,
 * and the tier has carried a self-described honeypot, adult-site search, and
 * wallets that ask for a private key. Those entries stay searchable, but they
 * must never sit beside the reviewed ones looking like more of the same.
 */

/** `sourceId` the catalog service stamps on every community-tier item. */
export const COMMUNITY_CATALOG_SOURCE_ID = 'community';

export const COMMUNITY_BADGE_LABEL = 'Community';

export const COMMUNITY_BADGE_HINT =
  "Shared by someone through the public MCP registry. Gezel hasn't reviewed it, so install it only if you know and trust who made it.";

export const COMMUNITY_CATALOG_NOTICE =
  "Toolsets marked Community come from the public MCP registry and haven't been reviewed by Gezel. Install only ones you trust.";

export const COMMUNITY_SECRETS_WARNING =
  "This toolset comes from the community and hasn't been reviewed by Gezel. Only enter keys or passwords if you trust who made it — and never a wallet's private key or recovery phrase.";

export function isCommunityCatalogItem(item: { sourceId?: string | null }): boolean {
  return item.sourceId === COMMUNITY_CATALOG_SOURCE_ID;
}

/**
 * Reviewed items first, community after, each group keeping its incoming
 * order. The service already merges sources in trust order, but a filter or
 * a future re-sort must not be able to float an unreviewed entry to the top.
 */
export function reviewedBeforeCommunity<T extends { sourceId?: string | null }>(
  items: readonly T[],
): T[] {
  const reviewed: T[] = [];
  const community: T[] = [];
  for (const item of items) (isCommunityCatalogItem(item) ? community : reviewed).push(item);
  return [...reviewed, ...community];
}
