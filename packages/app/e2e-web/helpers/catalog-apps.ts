import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface CatalogPageApp {
  id: string;
  dir: string;
  entry: string;
}

/** Opt-in checkout coverage: ordinary UI tests need only the pinned release. */
export function catalogPages(): CatalogPageApp[] {
  if (process.env.GEZEL_APP_AUDIT_MANIFEST) {
    return JSON.parse(readFileSync(process.env.GEZEL_APP_AUDIT_MANIFEST, 'utf8'));
  }
  const gilde = process.env.GILDE_DIR;
  if (!gilde) return [];
  const root = join(gilde, 'data/project-types');
  return readdirSync(root, { withFileTypes: true })
    .filter((s) => s.isDirectory())
    .flatMap((shard) =>
      readdirSync(join(root, shard.name)).flatMap((id) => {
        const base = join(root, shard.name, id);
        const identity = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'));
        const version = readdirSync(join(base, 'versions'))
          .filter((v) => !identity.yankedVersions?.includes(v))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1)!;
        const dir = join(base, 'versions', version);
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        return manifest.pages ? [{ id, dir, entry: manifest.pages.entry }] : [];
      }),
    );
}
