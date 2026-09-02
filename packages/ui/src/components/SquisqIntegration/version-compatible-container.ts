import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { VERSIONS_PREFIX, buildVersionPath, parseVersionPath } from '@bendyline/squisq/versions';

export interface LegacyVersionSource {
  container: ContentContainer;
  /** Only these basenames belong to this document in a shared legacy folder. */
  basenames: readonly string[];
}

interface VersionAlias {
  container: ContentContainer;
  path: string;
}

/**
 * Give Squisq one canonical extensionless version basename without hiding
 * histories written by older Gezel builds.
 *
 * Versions already inside the document's dedicated companion are all safe to
 * alias: that directory belongs to one document. Shared legacy parent folders
 * are filtered to the supplied basenames. Aliases are virtual and
 * non-destructive; new snapshots always write to the primary companion using
 * the canonical name.
 */
export function createVersionCompatibleContentContainer(
  primary: ContentContainer,
  canonicalBasename: string,
  legacySources: readonly LegacyVersionSource[] = [],
  documentContainer: ContentContainer = primary,
): ContentContainer {
  const aliases = new Map<string, VersionAlias>();

  function offerAlias(
    output: ContentEntry[],
    occupied: Set<string>,
    entry: ContentEntry,
    container: ContentContainer,
    allowedBasenames?: ReadonlySet<string>,
  ): void {
    const parsed = parseVersionPath(entry.path);
    if (!parsed || (allowedBasenames && !allowedBasenames.has(parsed.basename))) return;
    const virtualPath = buildVersionPath(canonicalBasename, parsed.timestamp, parsed.collision);
    if (occupied.has(virtualPath)) return;
    occupied.add(virtualPath);
    aliases.set(virtualPath, { container, path: entry.path });
    output.push({ ...entry, path: virtualPath });
  }

  async function readPrimaryThenAlias(path: string): Promise<ArrayBuffer | null> {
    const local = await primary.readFile(path);
    if (local !== null) return local;
    const alias = aliases.get(path);
    return alias ? alias.container.readFile(alias.path) : null;
  }

  const compatible: ContentContainer = {
    mutationLock: primary.mutationLock ?? primary,
    readFile: readPrimaryThenAlias,
    writeFile: (path, data, mimeType) => primary.writeFile(path, data, mimeType),
    async removeFile(path) {
      if (await primary.exists(path)) {
        await primary.removeFile(path);
        return;
      }
      const alias = aliases.get(path);
      if (alias) {
        await alias.container.removeFile(alias.path);
        aliases.delete(path);
      }
    },
    async listFiles(prefix) {
      const local = await primary.listFiles(prefix);
      if (prefix !== VERSIONS_PREFIX) return local;

      aliases.clear();
      const output = [...local];
      const occupied = new Set(local.map((entry) => entry.path));

      // A dedicated companion may contain snapshots from before a rename or
      // from Gezel's former extension-preserving basename behavior.
      for (const entry of local) {
        const parsed = parseVersionPath(entry.path);
        if (parsed?.basename !== canonicalBasename) {
          offerAlias(output, occupied, entry, primary);
        }
      }

      // Before per-document companions, versions lived in the visible file's
      // parent `.versions/` folder. Only alias names known to belong here.
      for (const source of legacySources) {
        const allowed = new Set(source.basenames);
        for (const entry of await source.container.listFiles(prefix)) {
          offerAlias(output, occupied, entry, source.container, allowed);
        }
      }
      return output;
    },
    async exists(path) {
      if (await primary.exists(path)) return true;
      const alias = aliases.get(path);
      return alias ? alias.container.exists(alias.path) : false;
    },
    getDocumentPath: () => documentContainer.getDocumentPath(),
    readDocument: () => documentContainer.readDocument(),
    writeDocument: (markdown, filename) => documentContainer.writeDocument(markdown, filename),
  };

  if (primary.writeFileExclusive) {
    compatible.writeFileExclusive = async (path, data, mimeType) => {
      if (await compatible.exists(path)) return false;
      return primary.writeFileExclusive!(path, data, mimeType);
    };
  }
  return compatible;
}
