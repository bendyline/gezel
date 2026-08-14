/** Display one prompt-cache pool without confusing shared prefixes for chats. */
export interface CacheEntryIdentity {
  sessionId: string;
}

export interface CacheEntrySummary {
  chatCount: number;
  prefixCount: number;
  totalCount: number;
  label: string;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Gezel stores chat-specific KV state and reusable model/gezel/project
 * prefixes in the same provider cache. Prefix ids are deliberately namespaced
 * `prefix-*`; use that contract rather than presenting every entry as a chat.
 */
export function summarizeCacheEntries(
  entries: readonly CacheEntryIdentity[] | undefined,
  fallbackTotal = 0,
): CacheEntrySummary {
  if (entries === undefined) {
    const totalCount = Math.max(0, fallbackTotal);
    return {
      chatCount: 0,
      prefixCount: 0,
      totalCount,
      label: counted(totalCount, 'cache entry', 'cache entries'),
    };
  }

  const prefixCount = entries.filter((entry) => entry.sessionId.startsWith('prefix-')).length;
  const chatCount = entries.length - prefixCount;
  const parts: string[] = [];
  if (chatCount > 0) parts.push(counted(chatCount, 'chat cache', 'chat caches'));
  if (prefixCount > 0) parts.push(counted(prefixCount, 'shared prefix', 'shared prefixes'));

  return {
    chatCount,
    prefixCount,
    totalCount: entries.length,
    label: parts.length > 0 ? parts.join(' + ') : '0 cache entries',
  };
}
