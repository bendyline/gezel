import { readFile, stat } from 'node:fs/promises';
import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
  GezappRegistry,
} from '@bendyline/gezel';
import { GezappRegistrySchema, isSemver } from '@bendyline/gezel';
import { aiAppItemsDir, aiAppsRegistryFile } from '@bendyline/gezel/paths';
import { BundledSource, type CatalogSource } from './source.js';

const AI_APP_KINDS: ReadonlySet<CatalogKind> = new Set([
  'project-type',
  'gezel-template',
  'craftbook-template',
]);

/** The `sourceId` every item from an installed `.gezapp` carries. */
export const INSTALLED_AI_APPS_SOURCE_ID = 'installed-ai-apps';

/**
 * Dynamic catalog source over the active `.gezapp` registry. Package versions
 * stay mounted as units under `~/.gezel/ai-apps/`; the importer never flattens
 * their files into the generic local catalog, so provenance and uninstall
 * remain tractable.
 */
export class InstalledAiAppsSource implements CatalogSource {
  readonly id = INSTALLED_AI_APPS_SOURCE_ID;
  readonly label = 'AI Apps';

  constructor(
    private readonly home: string,
    private readonly gezelVersion?: string,
  ) {}

  async listKinds(): Promise<CatalogKind[]> {
    return [...AI_APP_KINDS];
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (!AI_APP_KINDS.has(kind)) return [];
    const seen = new Set<string>();
    const out: CatalogItemSummary[] = [];
    for (const source of await this.sources()) {
      for (const item of await source.list(kind)) {
        if (seen.has(item.manifest.id)) continue;
        seen.add(item.manifest.id);
        out.push(this.rescope(item));
      }
    }
    out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    return out;
  }

  async get(kind: CatalogKind, id: string, version?: string): Promise<CatalogItemDetail | null> {
    if (!AI_APP_KINDS.has(kind)) return null;
    for (const source of await this.sources()) {
      const item = await source.get(kind, id, version);
      if (item) return this.rescope(item);
    }
    const retained = version ? await this.retainedSource(id, version) : null;
    const item = retained ? await retained.get(kind, id, version) : null;
    return item ? this.rescope(item) : null;
  }

  async listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]> {
    if (!AI_APP_KINDS.has(kind)) return [];
    const byVersion = new Map<string, CatalogItemVersionInfo>();
    for (const source of await this.sources()) {
      for (const version of await source.listVersions(kind, id)) {
        if (!byVersion.has(version.version)) byVersion.set(version.version, version);
      }
    }
    return [...byVersion.values()];
  }

  async readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    version?: string,
  ): Promise<Buffer | null> {
    if (!AI_APP_KINDS.has(kind)) return null;
    for (const source of await this.sources()) {
      const content = await source.readItemFile(kind, id, relPath, version);
      if (content) return content;
    }
    const retained = version ? await this.retainedSource(id, version) : null;
    return retained ? retained.readItemFile(kind, id, relPath, version) : null;
  }

  async listItemFiles(kind: CatalogKind, id: string): Promise<string[]> {
    if (!AI_APP_KINDS.has(kind)) return [];
    for (const source of await this.sources()) {
      const files = await source.listItemFiles(kind, id);
      if (files.length > 0) return files;
    }
    return [];
  }

  private async registry(): Promise<GezappRegistry> {
    try {
      return GezappRegistrySchema.parse(
        JSON.parse(await readFile(aiAppsRegistryFile(this.home), 'utf8')),
      );
    } catch {
      return { schemaVersion: 1, apps: [] };
    }
  }

  private async sources(): Promise<BundledSource[]> {
    const registry = await this.registry();
    return registry.apps
      .filter((entry) => entry.enabled)
      .map((entry) => this.slice(entry.appId, entry.version));
  }

  private slice(appId: string, version: string): BundledSource {
    return new BundledSource({
      dataDir: aiAppItemsDir(this.home, appId, version),
      id: `gezapp:${appId}@${version}`,
      label: this.label,
      noIndex: true,
      ...(this.gezelVersion !== undefined ? { gezelVersion: this.gezelVersion } : {}),
    });
  }

  /**
   * An older version of an installed, enabled app, still on disk. Installing
   * a newer `.gezapp` mounts only the new slice; projects stamped with the old
   * version read their page and scripts from here until they are updated.
   * Explicit-version reads only: listings and "latest" never see it.
   */
  private async retainedSource(appId: string, version: string): Promise<BundledSource | null> {
    // The version reaches a path; callers can pass it from a query string.
    if (!isSemver(version)) return null;
    const registry = await this.registry();
    const entry = registry.apps.find((app) => app.appId === appId && app.enabled);
    if (!entry || entry.version === version) return null;
    try {
      if (!(await stat(aiAppItemsDir(this.home, appId, version))).isDirectory()) return null;
    } catch {
      return null;
    }
    return this.slice(appId, version);
  }

  private rescope<T extends CatalogItemSummary | CatalogItemDetail>(item: T): T {
    const { logoUrl: _ignored, ...rest } = item;
    const logo = item.manifest.logo;
    const logoUrl =
      logo && /^https?:\/\//.test(logo)
        ? logo
        : logo
          ? `/api/catalog/${item.kind}/${encodeURIComponent(item.manifest.id)}/file/${encodeURIComponent(logo)}?source=${encodeURIComponent(this.id)}`
          : undefined;
    return {
      ...rest,
      sourceId: this.id,
      ...(logoUrl ? { logoUrl } : {}),
    } as T;
  }
}
