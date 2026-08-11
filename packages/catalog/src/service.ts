import { join } from 'node:path';
import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
  CraftbookTestSpec,
} from '@bendyline/gezel';
import { BuiltinToolsetsSource } from './builtin-toolsets.js';
import { CommunitySource } from './community-source.js';
import { LocalCatalogSource } from './local-source.js';
import { BundledSource, type CatalogSource } from './source.js';

/**
 * Composes one or more `CatalogSource`s behind a single API. Order is
 * priority order — earlier sources shadow later ones on id collision:
 *
 *   1. BuiltinToolsetsSource — synthetic groups for our in-process MCP
 *      server. Tools we ship and own.
 *   2. BundledSource — pre-reviewed third-party catalog shipped with
 *      the app (`data/`). Hand-curated.
 *   3. CommunitySource — auto-imported entries from the upstream MCP
 *      registry (`data/community/`). Permissively-licensed only;
 *      treated as a second tier that the UI can label distinctly.
 *
 * UI + HTTP both go through this service.
 */
export class CatalogService {
  private readonly sources: CatalogSource[];
  private readonly contentRootProvider: (() => string) | null;

  /**
   * @param sources explicit source list (replaces the defaults entirely).
   * @param opts.localRoot a GEZEL_HOME to read user-installed / `.gzl`-imported
   *   catalog items from (project types + gezel roles). Appended just ahead of
   *   the bundled tier so a user's imported item shadows a same-id bundled one.
   * @param opts.contentRoot dynamic gilde content root for the default
   *   bundled + community tiers, re-read on every disk access. The live
   *   gilde update mechanism flips it without reconstructing this service
   *   (which is built once at boot and held by many subsystems).
   * @param opts.gezelVersion the calendar line this build sits on, compared
   *   against content `minGezelVersion` floors. Defaults to
   *   `GEZEL_CONTENT_COMPAT` inside each source — *not* `GEZEL_VERSION`, which
   *   is semver on the npm channel and not on the axis floors are authored
   *   against. Injectable so tests can exercise gating (dev checkouts report
   *   `0.0.0`, which bypasses all filtering).
   */
  constructor(
    sources?: CatalogSource[],
    opts?: { localRoot?: string; contentRoot?: () => string; gezelVersion?: string },
  ) {
    this.contentRootProvider = opts?.contentRoot ?? null;
    if (sources && sources.length > 0) {
      this.sources = sources;
      return;
    }
    const contentRoot = opts?.contentRoot;
    const gezelVersion = opts?.gezelVersion;
    const local = opts?.localRoot ? [new LocalCatalogSource(opts.localRoot, gezelVersion)] : [];
    this.sources = [
      new BuiltinToolsetsSource(),
      ...local,
      new BundledSource({
        ...(contentRoot ? { dataDir: contentRoot } : {}),
        ...(gezelVersion !== undefined ? { gezelVersion } : {}),
      }),
      new CommunitySource(
        contentRoot ? () => join(contentRoot(), 'community') : undefined,
        gezelVersion,
      ),
    ];
  }

  /**
   * The effective gilde content root, or null when constructed without a
   * provider (tests, CLI one-shots). Cheap and synchronous — ChatManager
   * snapshots it per session to detect a live content flip and rebuild
   * cached model profiles/tuning on the next turn.
   */
  contentRoot(): string | null {
    return this.contentRootProvider ? this.contentRootProvider() : null;
  }

  /** All active sources in priority order (higher trust first). */
  listSources(): Array<{ id: string; label: string }> {
    return this.sources.map((s) => ({ id: s.id, label: s.label }));
  }

  /**
   * Merged listing across sources. Items from earlier sources (bundled)
   * shadow later sources (remote) on id collision.
   */
  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    const seen = new Set<string>();
    const merged: CatalogItemSummary[] = [];
    for (const source of this.sources) {
      const items = await source.list(kind);
      for (const item of items) {
        if (seen.has(item.manifest.id)) continue;
        seen.add(item.manifest.id);
        merged.push(item);
      }
    }
    return merged;
  }

  async get(
    kind: CatalogKind,
    id: string,
    sourceId?: string,
    version?: string,
  ): Promise<CatalogItemDetail | null> {
    for (const source of this.sources) {
      if (sourceId && source.id !== sourceId) continue;
      const detail = await source.get(kind, id, version);
      if (detail) return detail;
    }
    return null;
  }

  async listVersions(
    kind: CatalogKind,
    id: string,
    sourceId?: string,
  ): Promise<CatalogItemVersionInfo[]> {
    for (const source of this.sources) {
      if (sourceId && source.id !== sourceId) continue;
      const versions = await source.listVersions(kind, id);
      if (versions.length > 0) return versions;
    }
    return [];
  }

  async readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    sourceId?: string,
    version?: string,
  ): Promise<Buffer | null> {
    for (const source of this.sources) {
      if (sourceId && source.id !== sourceId) continue;
      const buf = await source.readItemFile(kind, id, relPath, version);
      if (buf) return buf;
    }
    return null;
  }

  /** Every file under an item's folder (item-relative paths). For the exporter. */
  async listItemFiles(kind: CatalogKind, id: string, sourceId?: string): Promise<string[]> {
    for (const source of this.sources) {
      if (sourceId && source.id !== sourceId) continue;
      if (!source.listItemFiles) continue;
      const files = await source.listItemFiles(kind, id);
      if (files.length > 0) return files;
    }
    return [];
  }

  /**
   * A craftbook's eval descriptor (`test.json` sidecar), from the first
   * source that carries one. Null when no source ships it.
   */
  async getCraftbookTestSpec(
    id: string,
    version?: string,
  ): Promise<{ version: string; spec: CraftbookTestSpec } | null> {
    for (const source of this.sources) {
      if (!source.getCraftbookTestSpec) continue;
      const found = await source.getCraftbookTestSpec(id, version);
      if (found) return found;
    }
    return null;
  }
}
