import type { MediaEntry, MediaProvider } from '@bendyline/squisq';
import { api } from '../../api.js';

/**
 * Media provider for knowledge-catalog documents. A 0.6 catalog ships its
 * images under `assets/` and a body references them by that archive path;
 * the daemon serves the bytes from the mounted catalog behind bearer auth,
 * which an `<img src>` cannot carry, so `resolveUrl` fetches through the
 * client and hands back a `blob:` URL. Fetches are coalesced per path and
 * the URLs are revoked on `dispose()`, which the view calls whenever the
 * catalog or its mounted version changes. Anything that is not a catalog
 * asset passes through untouched. Read-only: uploads are inert.
 */
export function createKnowledgeMediaProvider(opts: {
  catalogId: string;
  version?: string;
}): MediaProvider {
  const blobUrls = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();

  const fetchAsset = (path: string): Promise<string> => {
    const cached = blobUrls.get(path);
    if (cached) return Promise.resolve(cached);
    const pending = inFlight.get(path);
    if (pending) return pending;
    const request = api
      .fetchKnowledgeAsset(opts.catalogId, path, opts.version ? { version: opts.version } : {})
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        blobUrls.set(path, url);
        return url;
      })
      .finally(() => inFlight.delete(path));
    inFlight.set(path, request);
    return request;
  };

  return {
    async addMedia(): Promise<string> {
      throw new Error('knowledge catalogs are read-only');
    },

    async resolveUrl(relPath: string): Promise<string> {
      const path = relPath.replace(/^\.\//, '');
      if (!path.startsWith('assets/')) return relPath;
      try {
        return await fetchAsset(path);
      } catch {
        return relPath;
      }
    },

    async listMedia(): Promise<MediaEntry[]> {
      return [];
    },

    async removeMedia(): Promise<void> {},

    dispose(): void {
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
      blobUrls.clear();
      inFlight.clear();
    },
  };
}
