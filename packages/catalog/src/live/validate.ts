import { join } from 'node:path';
import type { CatalogKind } from '@bendyline/gezel';
import { CommunitySource } from '../community-source.js';
import { CatalogService } from '../service.js';
import { BundledSource } from '../source.js';

/**
 * The empirical no-regression gate for live gilde activation. The loader in
 * this build parses content with this build's Zod schemas, and an
 * unparseable item silently vanishes from the catalog — acceptable for a
 * brand-new item authored against newer schemas, catastrophic for one the
 * install already relies on (an installed model would lose its tuning, a
 * scheduled craftbook would stop resolving). So before activating a
 * candidate content root, every item resolvable from the current root must
 * still resolve from the candidate; anything less refuses the update.
 */

export interface GildeContentRegression {
  kind: CatalogKind;
  id: string;
}

const MAX_REPORTED_REGRESSIONS = 25;

export type GildeContentValidation =
  | { ok: true; checked: number }
  | { ok: false; regressions: GildeContentRegression[] };

export async function validateGildeContentUpgrade(opts: {
  currentDataDir: string;
  candidateDataDir: string;
  /**
   * App version for `minGezelVersion` gating — defaults to `GEZEL_VERSION`
   * inside the sources. Both sides run on the same build, so gating is
   * symmetric: a candidate that retro-gates a currently-resolvable item
   * fails this gate (correctly — that item would vanish for this install),
   * while a brand-new gated item passes (it never resolved here before).
   * Injectable for tests; dev builds (`0.0.0`) never gate.
   */
  gezelVersion?: string;
}): Promise<GildeContentValidation> {
  const gezelVersion = opts.gezelVersion;
  const versionOpt = gezelVersion !== undefined ? { gezelVersion } : {};
  const currentBundled = new BundledSource({ dataDir: opts.currentDataDir, ...versionOpt });
  // Bundled + community per side, mirroring production shadowing semantics.
  // Builtin/local sources are deliberately absent: they are not gilde
  // content and cannot regress from a content swap.
  const current = new CatalogService([
    currentBundled,
    new CommunitySource(join(opts.currentDataDir, 'community'), gezelVersion),
  ]);
  const candidate = new CatalogService([
    new BundledSource({ dataDir: opts.candidateDataDir, ...versionOpt }),
    new CommunitySource(join(opts.candidateDataDir, 'community'), gezelVersion),
  ]);

  const kinds = await currentBundled.listKinds();
  const regressions: GildeContentRegression[] = [];
  let checked = 0;
  for (const kind of kinds) {
    const items = await current.list(kind);
    for (const item of items) {
      checked += 1;
      // A throw (unreadable staging dir, permission fault) counts as a
      // regression too — the safe direction is refusing activation.
      const resolved = await candidate.get(kind, item.manifest.id).catch(() => null);
      if (!resolved) {
        regressions.push({ kind, id: item.manifest.id });
        if (regressions.length >= MAX_REPORTED_REGRESSIONS) {
          return { ok: false, regressions };
        }
      }
    }
  }
  if (regressions.length > 0) return { ok: false, regressions };
  return { ok: true, checked };
}
