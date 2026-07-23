import {
  type FileMapResponse,
  type GithubPullFile,
  type MapBlock,
  type MapPrChange,
  type MapPrOverlay,
  type Rect,
  blockSize,
  placeGhostBlocks,
} from '@bendyline/gezel';

/**
 * Turn a pull request's changed-file list into a map overlay — which blocks the
 * PR touches, and how. Modified/deleted/renamed files resolve to an existing
 * block (the map is built from the local checkout). Files the PR *adds* don't
 * exist as blocks yet, so we synthesize "phantom" blocks ("new construction"),
 * placed in free space near their folder/district, and return them for the
 * caller to append to the map. Pure: no I/O.
 */

const STATUS_TO_CHANGE: Record<string, MapPrChange['change']> = {
  added: 'added',
  copied: 'added',
  modified: 'modified',
  changed: 'modified',
  removed: 'deleted',
  deleted: 'deleted',
  renamed: 'renamed',
};

export interface PrOverlayResult {
  overlay: MapPrOverlay;
  /** Placeholder blocks for PR-added files; append these to the map's blocks. */
  phantomBlocks: MapBlock[];
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function buildPrOverlay(opts: {
  prNumber: number;
  title?: string;
  files: GithubPullFile[];
  map: Pick<FileMapResponse, 'blocks' | 'districts' | 'bounds' | 'streets' | 'plazas'>;
}): PrOverlayResult {
  const { prNumber, title, files, map } = opts;
  const blockIds = new Set(map.blocks.map((b) => b.id));
  const districtById = new Map(map.districts.map((d) => [d.id, d]));

  const changedBlocks: MapPrChange[] = [];
  const seen = new Set<string>();
  const added: Array<{ path: string; additions: number; deletions: number }> = [];

  for (const f of files) {
    const change = STATUS_TO_CHANGE[f.status] ?? 'modified';
    // Prefer the new path; for a rename whose new path isn't indexed, the old one.
    const blockId = blockIds.has(f.filename)
      ? f.filename
      : change === 'renamed' && f.previousFilename && blockIds.has(f.previousFilename)
        ? f.previousFilename
        : null;
    if (blockId) {
      if (seen.has(blockId)) continue;
      seen.add(blockId);
      changedBlocks.push({
        blockId,
        change,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.previousFilename ? { fromPath: f.previousFilename } : {}),
      });
    } else if (change === 'added') {
      added.push({ path: f.filename, additions: f.additions, deletions: f.deletions });
    }
    // modified/deleted/renamed that match nothing in the map are dropped.
  }

  // Phantom "new construction" blocks for added files — placed in free space
  // near their nearest existing district, falling back to the map center.
  const phantomBlocks: MapBlock[] = [];
  if (added.length > 0) {
    // yards, streets, plazas, and district label plates are off-limits too,
    // not just footprints
    const occupied: Rect[] = map.blocks.map((b) => b.lot ?? b.rect);
    for (const st of map.streets ?? []) occupied.push(st.rect);
    for (const pz of map.plazas ?? []) occupied.push(pz.rect);
    for (const d of map.districts) {
      if (d.labelPlate) occupied.push(d.labelPlate);
    }
    const seedFor = (path: string): { x: number; y: number } => {
      let folder = folderOf(path);
      while (folder) {
        const d = districtById.get(folder);
        if (d) return center(d.rect);
        folder = folderOf(folder);
      }
      return center(map.bounds);
    };
    const placed = placeGhostBlocks(
      occupied,
      added.map((a) => {
        const seed = seedFor(a.path);
        return {
          id: a.path,
          size: blockSize(Math.max(1, a.additions)),
          seedX: seed.x,
          seedY: seed.y,
        };
      }),
    );
    for (const a of added) {
      const rect = placed.get(a.path);
      if (!rect || seen.has(a.path)) continue;
      seen.add(a.path);
      phantomBlocks.push({
        id: a.path,
        districtId: folderOf(a.path),
        rect,
        label: basename(a.path),
        weight: a.additions,
        kind: null,
        lang: null,
        state: 'new',
        buildingCount: 0,
        phantom: true,
      });
      changedBlocks.push({
        blockId: a.path,
        change: 'added',
        additions: a.additions,
        deletions: a.deletions,
      });
    }
  }

  return { overlay: { prNumber, ...(title ? { title } : {}), changedBlocks }, phantomBlocks };
}
