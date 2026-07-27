import {
  type AffinityEdge,
  type FileMapResponse,
  type FileMapScope,
  type LayoutFileInput,
  type MapBlock,
  type MapBuilding,
  type MapPlaza,
  type MapStreet,
  type PersistNode,
  type PriorNode,
  type Rect,
  type VillageDomainState,
  type VillageJournalNode,
  deriveAnchorsFromPrior,
  layoutBuildingsInBlock,
  layoutFileMap,
  nowIso,
} from '@bendyline/gezel';
import {
  GIT_CHURN_WINDOW_DAYS,
  GIT_META_COMMITS,
  GIT_META_LAST_COMMIT,
  gitStatsAvailable,
} from '../index-store/git-stats.js';
import type { IndexStore } from '../index-store/index-store.js';
import { importRoads } from './affinity.js';
import { computeImportance } from './centrality.js';
import { composeFileMapScopes } from './compose.js';
import { computeLevels, landmarkLevels, selectLandmarks } from './elevation.js';
import { civicThreshold, computeHealth, normalizeSeverity } from './health.js';
import { collectCodeMap } from './providers/code.js';
import { isExcludedFromCodeMap } from './sections.js';
import { computeUrbanity, settlementFor } from './urbanity.js';
import type { VillageFileStore } from './village-file.js';

/**
 * Orchestrates one Village build: pick the domain provider, load the prior
 * persisted layout, run the stable layout engine, persist the new layout back,
 * and assemble the `MapModel` (districts + blocks + buildings + roads) the UI
 * renders. Pure-spatial work lives in the engine; this is the impure boundary
 * (it reads/writes the store and stamps timestamps).
 */

/** Keep the payload bounded on huge repos; the renderer culls buildings by LoD. */
const BUILDING_CAP = 20_000;
const TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Bump to force a one-time clean re-seed when the layout algorithm changes.
 *  v2 = bottom-up packing (replaced the overlapping per-file treemap seed).
 *  v3 = tight free-space bin-packing (replaced the sparse shelf-row packer).
 *  v4 = city layout: tiered streets + varied-aspect lots (parcel rows).
 *  v5 = planned town: compass macro + ladder packing, plates, plazas, and the
 *       durable city file (anchors derived from the v4 layout on migration). */
const LAYOUT_VERSION = 5;

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1600;

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export interface BuildFileMapOptions {
  /** Which slice to map (default 'core' — excludes tests). */
  scope?: FileMapScope;
  /** When false, compute the map but don't write the layout back (read-only preview). */
  persist?: boolean;
  /** The durable city file (anchors + overrides + journal). Optional so
   *  headless/test callers can run store-only. */
  villageFile?: VillageFileStore;
  /** True when a user asked for this map (the HTTP path). Gates village-file
   *  CREATION — background ticks only update an existing file. */
  userFacing?: boolean;
}

/** Hydrate engine prior rows from a village-file journal (index-loss recovery). */
function journalToPrior(journal: VillageJournalNode[], scope: FileMapScope): PriorNode[] {
  return journal
    .filter((j) => !(j.k === 'block' && isExcludedFromCodeMap(j.id, scope)))
    .map((j) => ({
      nodeKind: j.k,
      nodeId: j.id,
      parentId: j.p ?? null,
      contentHash: j.h ?? null,
      rect: { x: j.r[0], y: j.r[1], w: j.r[2], h: j.r[3] },
      weight: j.w ?? 0,
      placedAt: j.a ?? null,
      removedAt: j.d ?? null,
    }));
}

/**
 * The journal mirror of this build's persist rows (districts are derived).
 *
 * Timestamps are emitted for BLOCKS ONLY. A block's `placedAt` drives the age
 * lens and its `removedAt` drives tombstone pruning, so both are data. Streets,
 * plates, and plazas have timestamps too, but nothing ever reads them — and
 * because they are re-derived geometry, writing them meant every rebuild
 * rewrote a third of the file for no reason. This file is meant to be
 * committed; an unchanged rebuild must produce no diff.
 */
function persistToJournal(persist: PersistNode[]): VillageJournalNode[] {
  const out: VillageJournalNode[] = [];
  for (const p of persist) {
    if (p.nodeKind === 'district') continue;
    const isBlock = p.nodeKind === 'block';
    out.push({
      k: p.nodeKind,
      id: p.nodeId,
      r: [p.rect.x, p.rect.y, p.rect.w, p.rect.h],
      ...(p.parentId !== null ? { p: p.parentId } : {}),
      ...(p.contentHash !== null ? { h: p.contentHash } : {}),
      ...(isBlock || p.nodeKind === 'street' ? { w: p.weight } : {}),
      ...(isBlock && p.placedAt !== null ? { a: p.placedAt } : {}),
      ...(isBlock && p.removedAt !== null ? { d: p.removedAt } : {}),
    });
  }
  return out;
}

export async function buildFileMap(
  index: IndexStore,
  root: string,
  options: BuildFileMapOptions = {},
): Promise<FileMapResponse> {
  const scope = options.scope ?? 'core';
  // "All" is deliberately not a third layout. Build the two durable cities
  // separately, then compose them with a rigid translation so switching scope
  // never changes either neighborhood's internal shape.
  if (scope === 'all') {
    const code = await buildFileMap(index, root, { ...options, scope: 'core' });
    const tests = await buildFileMap(index, root, { ...options, scope: 'tests' });
    return composeFileMapScopes(code, tests);
  }

  // Code and Tests are independently persisted, stable cities.
  const domain = scope === 'core' ? 'code' : `code:${scope}`;
  const provider = collectCodeMap(index, scope);
  const now = nowIso();
  const cutoff = new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString();

  const city = options.villageFile ? await options.villageFile.read() : null;
  const dom: VillageDomainState | undefined = city?.domains[domain];

  // ── signals (pre-layout: the engine consumes importance + landmark) ───────
  const findingsByFile = index.securityFindingCountsByFile();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of provider.edges) {
    fanOut.set(e.src, (fanOut.get(e.src) ?? 0) + 1);
    fanIn.set(e.dst, (fanIn.get(e.dst) ?? 0) + 1);
  }
  const civicFanIn = civicThreshold(provider.files.map((f) => fanIn.get(f.path) ?? 0));

  const hasEdges = provider.edges.length > 0;
  const importanceByPath = computeImportance(
    provider.files.map((f) => f.path),
    provider.edges,
  );
  const gitAvailable = gitStatsAvailable(index);
  const gitMeta = gitAvailable
    ? index.metadataValuesForKeys([GIT_META_COMMITS, GIT_META_LAST_COMMIT])
    : new Map<string, Record<string, string>>();
  const churnOf = (path: string): number => {
    const raw = gitMeta.get(path)?.[GIT_META_COMMITS];
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  // Health first (zones are pre-layout facts), then landmarks — the
  // centrality-ranked head of the civic zone.
  const healthByPath = new Map<string, ReturnType<typeof computeHealth>>();
  for (const f of provider.files) {
    const syms = provider.symbolsByFile.get(f.path) ?? [];
    const findings = findingsByFile.get(f.path);
    healthByPath.set(
      f.path,
      computeHealth(
        {
          loc: f.weight,
          symbolCount: syms.length,
          findings: findings?.count ?? 0,
          maxSeverity: normalizeSeverity(findings?.maxSeverity),
          fanIn: fanIn.get(f.path) ?? 0,
          fanOut: fanOut.get(f.path) ?? 0,
          ...(hasEdges ? { importance: importanceByPath.get(f.path) ?? 0 } : {}),
          ...(gitAvailable ? { churnCommits: churnOf(f.path) } : {}),
        },
        civicFanIn,
      ),
    );
  }
  const landmarks = selectLandmarks(
    [...healthByPath.entries()].map(([path, h]) => ({
      path,
      zone: h.zone,
      importance: importanceByPath.get(path) ?? 0,
      churnCommits: churnOf(path),
    })),
    provider.files.length,
  );

  const layoutFiles: LayoutFileInput[] = provider.files.map((f) => ({
    ...f,
    ...(hasEdges ? { importance: importanceByPath.get(f.path) ?? 0 } : {}),
    ...(landmarks.has(f.path) ? { landmark: true } : {}),
  }));

  // ── prior layout: sqlite first, village-file journal as the durable backup ──
  // A one-time clean re-seed when the layout algorithm changes: maps persisted
  // by an older engine are discarded so the current packing takes over. After
  // that, the per-domain version matches and builds are incremental/stable.
  const versionKey = `map_layout_version:${domain}`;
  const sqliteRows = index.layoutNodes(domain);
  const sqliteVersionOk = index.getMeta(versionKey) === String(LAYOUT_VERSION);
  const journalUsable = dom !== undefined && dom.layoutVersion === LAYOUT_VERSION;

  let prior: PriorNode[];
  let stale: boolean;
  if (sqliteVersionOk && sqliteRows.length > 0) {
    // Drop persisted blocks now excluded from this scope (e.g. JSON placed
    // before the exclusion existed): filtering them out of `prior` means the
    // engine never tombstones them and `replaceLayout` purges them.
    prior = sqliteRows
      .filter((r) => !(r.nodeKind === 'block' && isExcludedFromCodeMap(r.nodeId, scope)))
      .map((r) => ({
        nodeKind: r.nodeKind,
        nodeId: r.nodeId,
        parentId: r.parentId,
        rect: { x: r.x, y: r.y, w: r.w, h: r.h },
        contentHash: r.contentHash,
        weight: r.weight,
        placedAt: r.placedAt,
        removedAt: r.removedAt,
      }));
    stale = false;
  } else if (journalUsable && dom.journal.length > 0) {
    // Index db was rebuilt/deleted: the journal restores the whole city —
    // tombstones, transplant hashes, and the age lens included.
    prior = journalToPrior(dom.journal, scope);
    stale = false;
  } else {
    prior = [];
    stale = true;
  }

  // A version-bump re-seed moves every block, but it must not reset the age
  // lens: carry each block's first-placement timestamp across the re-layout.
  const carriedPlacedAt = stale
    ? new Map([
        ...sqliteRows
          .filter((r) => r.nodeKind === 'block' && r.placedAt)
          .map((r) => [r.nodeId, r.placedAt] as const),
        ...(dom?.journal ?? [])
          .filter((j) => j.k === 'block' && j.a)
          .map((j) => [j.id, j.a!] as const),
      ])
    : null;

  // Macro memory for a re-seed: the city file's anchors, else regions derived
  // from the OLD layout's centroids before it's discarded — either way the
  // re-founded city keeps top-level folders where the user remembers them.
  const seedAnchors = stale
    ? dom?.anchors?.length
      ? dom.anchors
      : deriveAnchorsFromPrior(
          sqliteRows
            .filter((r) => r.nodeKind === 'block')
            .map((r) => ({
              nodeKind: 'block' as const,
              nodeId: r.nodeId,
              parentId: r.parentId,
              rect: { x: r.x, y: r.y, w: r.w, h: r.h },
              contentHash: r.contentHash,
              weight: r.weight,
              placedAt: r.placedAt,
              removedAt: r.removedAt,
            })),
        )
    : (dom?.anchors ?? []);

  // Imports both draw roads and seed where a new file lands (next to what it
  // imports); folder locality is handled by the engine's packing fallback.
  const seedEdges: AffinityEdge[] = provider.edges.map((e) => ({ a: e.src, b: e.dst, weight: 1 }));

  const result = layoutFileMap(layoutFiles, seedEdges, prior, {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    nowIso: now,
    tombstoneCutoffIso: cutoff,
    anchors: seedAnchors,
    overrides: city?.overrides ?? [],
  });

  if (carriedPlacedAt && carriedPlacedAt.size > 0) {
    for (const [path, pl] of result.blocks) {
      const old = carriedPlacedAt.get(path);
      if (old) pl.placedAt = old;
    }
    for (const p of result.persist) {
      if (p.nodeKind !== 'block') continue;
      const old = carriedPlacedAt.get(p.nodeId);
      if (old) p.placedAt = old;
    }
  }

  // Urbanity is post-layout by necessity: the field samples parcel positions
  // and local build density, both of which only exist once the engine has run.
  // Computed unconditionally (the response always carries it); only the sticky
  // downtown parameters are persisted, and only when persisting at all.
  const urbanity = computeUrbanity(
    [...result.blocks]
      .filter(([, pl]) => pl.state !== 'tombstoned')
      .map(([path, pl]) => ({
        path,
        lot: pl.lot,
        footprint: pl.footprint,
        importance: importanceByPath.get(path) ?? 0,
      })),
    { hasEdges, prior: dom?.downtown ?? null },
  );

  if (options.persist !== false) {
    index.replaceLayout(
      domain,
      result.persist.map((p) => ({
        nodeKind: p.nodeKind,
        nodeId: p.nodeId,
        parentId: p.parentId,
        contentHash: p.contentHash,
        x: p.rect.x,
        y: p.rect.y,
        w: p.rect.w,
        h: p.rect.h,
        weight: p.weight,
        placedAt: p.placedAt,
        removedAt: p.removedAt,
      })),
    );
    if (!sqliteVersionOk) index.setMeta(versionKey, String(LAYOUT_VERSION));

    if (options.villageFile) {
      const journal = persistToJournal(result.persist);
      const anchors = result.anchors.length > 0 ? result.anchors : (dom?.anchors ?? []);
      // No `updatedAt`: stamping the write time on every build guaranteed a
      // dirty diff on a committed file even when the village was unchanged,
      // which defeats the whole point of committing it.
      await options.villageFile.update({ userFacing: options.userFacing === true }, (c) => ({
        ...c,
        domains: {
          ...c.domains,
          [domain]: {
            layoutVersion: LAYOUT_VERSION,
            anchors,
            journal,
            downtown: urbanity.downtown,
          },
        },
      }));
    }
  }

  const weightByPath = new Map<string, number>();
  for (const p of result.persist) if (p.nodeKind === 'block') weightByPath.set(p.nodeId, p.weight);

  const blocks: MapBlock[] = [];
  const buildings: MapBuilding[] = [];
  let buildingBudget = BUILDING_CAP;
  for (const [path, pl] of result.blocks) {
    const m = provider.meta.get(path);
    const syms = provider.symbolsByFile.get(path) ?? [];
    const health = pl.state === 'tombstoned' ? undefined : healthByPath.get(path);
    const isLandmark = pl.state !== 'tombstoned' && landmarks.has(path);
    const levels =
      pl.state === 'tombstoned'
        ? undefined
        : computeLevels({
            importance: importanceByPath.get(path) ?? 0,
            loc: weightByPath.get(path) ?? 0,
            churnCommits: churnOf(path),
          });
    const lastTouchedAt = gitMeta.get(path)?.[GIT_META_LAST_COMMIT];
    const u = urbanity.byPath.get(path);
    blocks.push({
      id: path,
      districtId: folderOf(path),
      rect: pl.footprint,
      lot: pl.lot,
      label: basename(path),
      weight: weightByPath.get(path) ?? 0,
      kind: m?.kind ?? null,
      lang: m?.lang ?? null,
      state: pl.state,
      buildingCount: syms.length,
      placedAt: pl.placedAt,
      ...(health ? { health } : {}),
      ...(levels !== undefined ? { levels: isLandmark ? landmarkLevels(levels) : levels } : {}),
      ...(isLandmark ? { landmark: true } : {}),
      ...(lastTouchedAt !== undefined ? { lastTouchedAt } : {}),
      ...(u !== undefined ? { urbanity: u, settlement: settlementFor(u) } : {}),
    });
    if (pl.state !== 'tombstoned' && buildingBudget > 0 && syms.length) {
      const placed = layoutBuildingsInBlock(path, pl.footprint, syms);
      const take = placed.slice(0, buildingBudget);
      buildings.push(...take);
      buildingBudget -= take.length;
    }
  }

  const roads = importRoads(provider.edges);
  const bounds = computeBounds(blocks, result.streets, result.plazas, MAP_WIDTH, MAP_HEIGHT);

  return {
    domain,
    root,
    bounds,
    builtAt: now,
    indexed: provider.files.length > 0,
    districts: result.districts,
    blocks,
    buildings,
    roads,
    streets: result.streets,
    plazas: result.plazas,
    urbanity: {
      center: { x: urbanity.downtown.cx, y: urbanity.downtown.cy },
      radius: urbanity.downtown.r,
      ceiling: urbanity.ceiling,
      peak: urbanity.peak,
      median: urbanity.median,
      settlement: settlementFor(urbanity.peak),
      fileCount: urbanity.fileCount,
    },
    signals: { gitAvailable, churnWindowDays: GIT_CHURN_WINDOW_DAYS },
  };
}

function computeBounds(
  blocks: MapBlock[],
  streets: MapStreet[],
  plazas: MapPlaza[],
  w: number,
  h: number,
): Rect {
  if (blocks.length === 0) return { x: 0, y: 0, w, h };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const fold = (r: Rect): void => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  for (const b of blocks) fold(b.lot ?? b.rect);
  for (const s of streets) fold(s.rect);
  for (const p of plazas) fold(p.rect);
  const pad = 24;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}
