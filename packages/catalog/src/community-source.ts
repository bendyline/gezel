import { join } from 'node:path';
import { gildeDataDir } from './gilde-data.js';
import { BundledSource } from './source.js';

function defaultCommunityDataDir(): string {
  return join(gildeDataDir(), 'community');
}

/**
 * The community catalog tier — entries auto-imported from the upstream
 * MCP registry (registry.modelcontextprotocol.io). Same on-disk layout
 * as the bundled catalog, just rooted at `data/community/` so the
 * hand-curated bundled tier stays small and visually distinct.
 *
 * Layout under the community root mirrors `BundledSource`'s expected
 * shape:
 *
 *   data/community/toolsets/{shard}/{id}/manifest.json
 *   data/community/toolsets/{shard}/{id}/versions/{semver}/manifest.json
 *
 * Only the `toolsets` kind is populated today; other kinds can land
 * here later without further plumbing.
 *
 * Identity collisions are resolved by `CatalogService` priority:
 * BundledSource is registered ahead of CommunitySource, so a community
 * entry with the same id as a bundled one is shadowed.
 */
export class CommunitySource extends BundledSource {
  constructor(dataDir: string | (() => string) = defaultCommunityDataDir()) {
    super({ dataDir, id: 'community', label: 'MCP Registry (community)' });
  }
}
