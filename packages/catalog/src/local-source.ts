import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
} from '@bendyline/gezel';
import { BundledSource } from './source.js';

/**
 * User-local catalog tier — reads `.gzl`-imported / user-installed catalog
 * items from under a GEZEL_HOME, laid out exactly like the bundled catalog
 * (`{home}/project-types/{shard}/{id}/…`, `{home}/gezel-templates/…`).
 *
 * Deliberately scoped. Local craftbook templates already have their own home
 * (`{home}/craftbook-templates`) managed by the `Store` and surfaced through
 * a separate path, so serving them here too would double-list them. Models
 * are never imported this way. Toolsets ARE served (`{home}/toolsets/…`):
 * a locally-dropped manifest installs through the same
 * `POST /api/catalog/toolset/:id/install` rail as bundled entries — still
 * behind the `allowExternalServices` security gate for non-builtin runtimes.
 * The eval harness relies on this to register per-trial fake MCP endpoints
 * as real toolsets.
 */
const LOCAL_KINDS: ReadonlySet<CatalogKind> = new Set([
  'project-type',
  'gezel-template',
  'connector-type',
  'toolset',
]);

export class LocalCatalogSource extends BundledSource {
  constructor(home: string) {
    // No index.json here — imported items are written straight to disk, so the
    // disk walk is the source of truth.
    super({ dataDir: home, id: 'local', label: 'Installed', noIndex: true });
  }

  override async listKinds(): Promise<CatalogKind[]> {
    return [...LOCAL_KINDS];
  }

  override async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (!LOCAL_KINDS.has(kind)) return [];
    return super.list(kind);
  }

  override async get(
    kind: CatalogKind,
    id: string,
    version?: string,
  ): Promise<CatalogItemDetail | null> {
    if (!LOCAL_KINDS.has(kind)) return null;
    return super.get(kind, id, version);
  }

  override async listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]> {
    if (!LOCAL_KINDS.has(kind)) return [];
    return super.listVersions(kind, id);
  }

  override async readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    version?: string,
  ): Promise<Buffer | null> {
    if (!LOCAL_KINDS.has(kind)) return null;
    return super.readItemFile(kind, id, relPath, version);
  }

  override async listItemFiles(kind: CatalogKind, id: string): Promise<string[]> {
    if (!LOCAL_KINDS.has(kind)) return [];
    return super.listItemFiles(kind, id);
  }
}
