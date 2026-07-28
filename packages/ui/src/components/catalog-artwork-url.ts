import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Resolves a `CatalogItemSummary.logoUrl` into something `<img src>` can
 * actually load.
 *
 * The service composes logo URLs as `/api/catalog/{kind}/{id}/file/{logo}`
 * (`logoUrlFor` in packages/catalog/src/source.ts), and all of `/api/*` is
 * bearer-gated — only `/api/health` is exempt. A bare `<img src>` sends no
 * Authorization header, so those URLs 401 and the artwork falls back to its
 * glyph. That failure is invisible: it looks exactly like an item shipping
 * no logo at all, which is how 283 craftbook `logo.webp` files could land in
 * the catalog and change nothing on screen.
 *
 * So we fetch through the authed client and hand `<img>` an object URL.
 * Absolute (`http(s)://`), `data:`, and `blob:` URLs are already loadable
 * and pass straight through.
 */

/** Resolved object URLs, keyed by the original logo path. */
const resolved = new Map<string, string>();
/** In-flight fetches, so N cards sharing a logo path fetch once. */
const pending = new Map<string, Promise<string | null>>();
/** Paths whose fetch failed — never retried; the caller shows its glyph. */
const failed = new Set<string>();

/**
 * Gallery grids render the whole catalog at once (the New Task dialog's
 * "All craftbooks" rail is ~283 unvirtualized cards). Firing that many
 * fetches in one tick would queue ahead of the requests the dialog actually
 * needs to become interactive, so logos drain through a small window.
 */
const MAX_CONCURRENT = 6;
let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((release) => queue.push(release));
}

function release(): void {
  const next = queue.shift();
  if (next) {
    next();
    return;
  }
  active -= 1;
}

function needsAuthedFetch(url: string): boolean {
  // Anything with a scheme or protocol-relative prefix is already loadable;
  // only same-origin paths route through the bearer-gated API.
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

function resolveViaFetch(path: string): Promise<string | null> {
  const inFlight = pending.get(path);
  if (inFlight) return inFlight;
  const p = acquire()
    .then(() => api.fetchCatalogFile(path))
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      resolved.set(path, url);
      return url;
    })
    .catch(() => {
      failed.add(path);
      return null;
    })
    .finally(() => {
      release();
      pending.delete(path);
    });
  pending.set(path, p);
  return p;
}

/**
 * Object URLs are cached for the process lifetime and deliberately never
 * revoked: the catalog is a fixed, bounded set, the same logos reappear
 * every time a gallery mounts, and revoking on unmount would break any
 * other mounted surface still pointing at the same URL. Worst case is the
 * full craftbook set at ~17 KB each.
 */
export function useCatalogArtworkUrl(logoUrl?: string): string | undefined {
  const passthrough = !!logoUrl && !needsAuthedFetch(logoUrl);
  const initial = !logoUrl ? undefined : passthrough ? logoUrl : resolved.get(logoUrl);
  const [url, setUrl] = useState<string | undefined>(initial);

  useEffect(() => {
    if (!logoUrl || passthrough) {
      setUrl(logoUrl);
      return;
    }
    const hit = resolved.get(logoUrl);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(undefined);
    if (failed.has(logoUrl)) return;
    let alive = true;
    void resolveViaFetch(logoUrl).then((next) => {
      if (alive && next) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [logoUrl, passthrough]);

  return url;
}

/** Test seam — drops every cached object URL and failure memo. */
export function resetCatalogArtworkCache(): void {
  for (const url of resolved.values()) URL.revokeObjectURL(url);
  resolved.clear();
  pending.clear();
  failed.clear();
}
