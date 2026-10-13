import type { ModelInfo, ProviderName } from '../providers/types.js';
export const CACHE_TTL_MS = 5 * 60_000;
export interface CacheEntry {
  at: number;
  models: ModelInfo[];
}
export const cache = new Map<ProviderName, CacheEntry>();
export function invalidateModelsCache(provider?: ProviderName): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}
