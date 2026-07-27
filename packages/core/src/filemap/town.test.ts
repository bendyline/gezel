import { describe, expect, it } from 'vitest';
import type { Rect } from '../schemas/api.js';
import { deriveAnchorsFromPrior, regionOf } from './anchors.js';
import { layoutFileMap } from './engine.js';
import { PLATE_H, collapseFiles, displayLabels } from './plates.js';
import { folderPad } from './streets.js';
import { packTownRoot } from './town.js';
import type { LayoutFileInput, LayoutResult, PriorNode } from './types.js';

const NOW = '2026-06-21T00:00:00.000Z';
const file = (
  path: string,
  loc: number,
  extra: Partial<LayoutFileInput> = {},
): LayoutFileInput => ({
  path,
  weight: loc,
  contentHash: `h:${path}`,
  ...extra,
});

const disjoint = (a: Rect, b: Rect): boolean =>
  a.x + a.w <= b.x + 0.001 ||
  b.x + b.w <= a.x + 0.001 ||
  a.y + a.h <= b.y + 0.001 ||
  b.y + b.h <= a.y + 0.001;

const touchesOrOverlaps = (a: Rect, b: Rect, slop: number): boolean =>
  a.x <= b.x + b.w + slop &&
  a.x + a.w + slop >= b.x &&
  a.y <= b.y + b.h + slop &&
  a.y + a.h + slop >= b.y;

function asPrior(result: LayoutResult): PriorNode[] {
  return result.persist.map((p) => ({
    nodeKind: p.nodeKind,
    nodeId: p.nodeId,
    parentId: p.parentId,
    rect: p.rect,
    contentHash: p.contentHash,
    weight: p.weight,
    placedAt: p.placedAt,
    removedAt: p.removedAt,
  }));
}

/** A mid-sized fixture: three top-level folders, one pass-through chain. */
function fixture(): LayoutFileInput[] {
  const files: LayoutFileInput[] = [];
  for (let i = 0; i < 12; i++) files.push(file(`packages/service/src/f${i}.ts`, 100 + i * 30));
  for (let i = 0; i < 8; i++) files.push(file(`packages/ui/g${i}.ts`, 150));
  for (let i = 0; i < 6; i++) files.push(file(`docs/d${i}.md`, 60));
  for (let i = 0; i < 5; i++) files.push(file(`evals/e${i}.ts`, 300));
  return files;
}

describe('collapseFiles / displayLabels', () => {
  it('folds pass-through chains into one display district labeled once', () => {
    const files = [file('a/b/c/x.ts', 10), file('a/b/c/y.ts', 10)];
    const root = collapseFiles(files);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.path).toBe('a/b/c');
    expect(root.children[0]!.label).toBe('a/b/c');
    const labels = displayLabels(files);
    expect(labels.get('a/b/c')).toBe('a/b/c');
    expect(labels.has('a')).toBe(false);
    expect(labels.has('a/b')).toBe(false);
  });

  it('labels nested display districts relative to their parent display node', () => {
    const labels = displayLabels(fixture());
    expect(labels.get('packages')).toBe('packages');
    // packages/service/src is a chain under packages (service has one child, no files)
    expect(labels.get('packages/service/src')).toBe('service/src');
    expect(labels.has('packages/service')).toBe(false);
    expect(labels.get('packages/ui')).toBe('ui');
  });

  it('keeps folderPad + PLATE_H under the router bridge distance at every depth', () => {
    for (let depth = 0; depth <= 6; depth++) {
      expect(folderPad(depth) + PLATE_H).toBeLessThan(20);
    }
  });
});

describe('packTownRoot geometry', () => {
  it('reserves plates that never intersect lots, streets, or plazas', () => {
    const town = packTownRoot(fixture(), { nowIso: NOW });
    expect(town.plates.length).toBeGreaterThan(0);
    for (const plate of town.plates) {
      for (const [path, cell] of town.lots) {
        expect(disjoint(plate.rect, cell.lot), `plate ${plate.folder} vs lot ${path}`).toBe(true);
      }
      for (const st of town.streets) {
        expect(disjoint(plate.rect, st.rect), `plate ${plate.folder} vs street`).toBe(true);
      }
      for (const pz of town.plazas) {
        expect(disjoint(plate.rect, pz.rect), `plate ${plate.folder} vs plaza ${pz.id}`).toBe(true);
      }
    }
  });

  it('emits one plate per display district (collapsed chains get exactly one)', () => {
    const town = packTownRoot(fixture(), { nowIso: NOW });
    const folders = town.plates.map((p) => p.folder).sort();
    expect(folders).toContain('packages');
    expect(folders).toContain('packages/service/src');
    expect(folders).not.toContain('packages/service');
    expect(new Set(folders).size).toBe(folders.length);
  });

  it('keeps every street axis-aligned with tier 0..3 and connected to the network', () => {
    const town = packTownRoot(fixture(), { nowIso: NOW });
    expect(town.streets.length).toBeGreaterThan(0);
    for (const st of town.streets) {
      expect(st.tier).toBeGreaterThanOrEqual(0);
      expect(st.tier).toBeLessThanOrEqual(3);
      expect(st.rect.w).toBeGreaterThan(0);
      expect(st.rect.h).toBeGreaterThan(0);
    }
    // Connectivity: BFS over the touches-within-bridge graph from the widest
    // street reaches every other street (the router bridges gaps ≤ 20).
    const BRIDGE = 20;
    const n = town.streets.length;
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (touchesOrOverlaps(town.streets[i]!.rect, town.streets[j]!.rect, BRIDGE)) {
          adj[i]!.push(j);
          adj[j]!.push(i);
        }
      }
    }
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      for (const nb of adj[queue.pop()!]!) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    expect(seen.size).toBe(n);
  });

  it('spans boulevards across the full extent when several regions are occupied', () => {
    // Enough top-level folders to occupy multiple compass cells.
    const files: LayoutFileInput[] = [];
    for (const top of ['alpha', 'beta', 'gamma', 'delta']) {
      for (let i = 0; i < 8; i++) files.push(file(`${top}/f${i}.ts`, 200));
    }
    const town = packTownRoot(files, { nowIso: NOW });
    const boulevards = town.streets.filter((s) => s.tier === 0 && s.folder === '');
    expect(boulevards.length).toBeGreaterThan(0);
    const full = boulevards.filter(
      (b) =>
        (b.rect.w >= b.rect.h && b.rect.w >= town.w - 0.5) ||
        (b.rect.h > b.rect.w && b.rect.h >= town.h - 0.5),
    );
    expect(full.length).toBe(boulevards.length);
  });

  it('packs with deliberate slack: district fill lands in the breathing band', () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`pkg/f${i}.ts`, 100));
    const town = packTownRoot(files, { nowIso: NOW });
    let lotArea = 0;
    for (const [, cell] of town.lots) lotArea += cell.lot.w * cell.lot.h;
    const fill = lotArea / (town.w * town.h);
    expect(fill).toBeGreaterThan(0.3);
    expect(fill).toBeLessThan(0.85);
  });

  it('reserves a plaza beside a landmark file and greens in leftover columns', () => {
    const files = [
      file('src/hub.ts', 400, { landmark: true, importance: 1 }),
      ...Array.from({ length: 9 }, (_, i) => file(`src/f${i}.ts`, 120)),
    ];
    const town = packTownRoot(files, { nowIso: NOW });
    const plaza = town.plazas.find((p) => p.id === 'plaza:src/hub.ts');
    expect(plaza).toBeDefined();
    expect(plaza!.kind).toBe('plaza');
    expect(plaza!.blockId).toBe('src/hub.ts');
    // The plaza is open ground: intersects no lot.
    for (const [path, cell] of town.lots) {
      expect(disjoint(plaza!.rect, cell.lot), `plaza vs ${path}`).toBe(true);
    }
  });

  it('records one anchor per top-level display district, echoing existing ones', () => {
    const town = packTownRoot(fixture(), { nowIso: NOW });
    const paths = town.anchors.map((a) => a.path).sort();
    expect(paths).toEqual(['docs', 'evals', 'packages']);
    for (const a of town.anchors) {
      expect(regionOf(a.cx, a.cy)).toBeDefined();
    }
    // Re-seed with the recorded anchors: they are echoed verbatim.
    const again = packTownRoot(fixture(), {
      nowIso: '2027-01-01T00:00:00.000Z',
      anchors: town.anchors,
    });
    expect(again.anchors).toEqual(town.anchors);
  });

  it('honors anchor regions on re-seed (packages stays where it was)', () => {
    const files = fixture();
    const anchors = [
      { path: 'packages', region: 'SE' as const, cx: 0.9, cy: 0.9, recordedAt: NOW },
      { path: 'docs', region: 'NW' as const, cx: 0.1, cy: 0.1, recordedAt: NOW },
    ];
    const town = packTownRoot(files, { nowIso: NOW, anchors });
    const centroid = (prefix: string): { cx: number; cy: number } => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const [path, cell] of town.lots) {
        if (!path.startsWith(`${prefix}/`)) continue;
        sx += cell.lot.x + cell.lot.w / 2;
        sy += cell.lot.y + cell.lot.h / 2;
        n++;
      }
      return { cx: sx / n / town.w, cy: sy / n / town.h };
    };
    const pk = centroid('packages');
    const dc = centroid('docs');
    // packages sits down-right of docs, matching the anchored regions.
    expect(pk.cx).toBeGreaterThan(dc.cx);
    expect(pk.cy).toBeGreaterThan(dc.cy);
  });

  it('places a rect-overridden top-level folder at exact coordinates', () => {
    const files = fixture();
    const town = packTownRoot(files, {
      nowIso: NOW,
      overrides: [{ path: 'evals', rect: { x: 900, y: 700, w: 0, h: 0 } }],
    });
    for (const [path, cell] of town.lots) {
      if (!path.startsWith('evals/')) continue;
      expect(cell.lot.x).toBeGreaterThanOrEqual(900);
      expect(cell.lot.y).toBeGreaterThanOrEqual(700);
    }
  });

  it('is deterministic', () => {
    const a = packTownRoot(fixture(), { nowIso: NOW });
    const b = packTownRoot(fixture(), { nowIso: NOW });
    expect(b.lots).toEqual(a.lots);
    expect(b.streets).toEqual(a.streets);
    expect(b.plates).toEqual(a.plates);
    expect(b.plazas).toEqual(a.plazas);
    expect(b.anchors).toEqual(a.anchors);
  });
});

describe('engine v5 integration', () => {
  it('persists plates + plazas and passes them through rebuilds verbatim', () => {
    const files = [
      file('src/hub.ts', 400, { landmark: true, importance: 1 }),
      ...Array.from({ length: 9 }, (_, i) => file(`src/f${i}.ts`, 120)),
      ...Array.from({ length: 4 }, (_, i) => file(`docs/d${i}.md`, 60)),
    ];
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    expect(first.persist.some((p) => p.nodeKind === 'plate')).toBe(true);
    expect(first.persist.some((p) => p.nodeKind === 'plaza')).toBe(true);
    expect(first.plazas.some((p) => p.kind === 'plaza' && p.blockId === 'src/hub.ts')).toBe(true);

    const second = layoutFileMap(files, [], asPrior(first), { nowIso: NOW });
    const key = (p: { id?: string; rect: Rect }) => JSON.stringify(p);
    expect(second.plazas.map(key).sort()).toEqual(first.plazas.map(key).sort());
    const plates = (r: LayoutResult) =>
      r.persist
        .filter((p) => p.nodeKind === 'plate')
        .map((p) => `${p.nodeId}:${JSON.stringify(p.rect)}`)
        .sort();
    expect(plates(second)).toEqual(plates(first));
  });

  it('never places incremental arrivals on plates or plazas', () => {
    const files = [
      file('src/hub.ts', 400, { landmark: true, importance: 1 }),
      ...Array.from({ length: 9 }, (_, i) => file(`src/f${i}.ts`, 120)),
    ];
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    const grown = [...files, ...Array.from({ length: 6 }, (_, i) => file(`src/new${i}.ts`, 100))];
    const second = layoutFileMap(grown, [], asPrior(first), { nowIso: NOW });
    const reserved = [
      ...second.plazas.map((p) => p.rect),
      ...second.persist.filter((p) => p.nodeKind === 'plate').map((p) => p.rect),
    ];
    for (let i = 0; i < 6; i++) {
      const lot = second.blocks.get(`src/new${i}.ts`)!.lot;
      for (const r of reserved) {
        expect(disjoint(lot, r), `arrival src/new${i}.ts overlaps reserved geometry`).toBe(true);
      }
    }
  });

  it('annotates districts with displayLabel + labelPlate for display districts only', () => {
    const files = fixture();
    const r = layoutFileMap(files, [], [], { nowIso: NOW });
    const byId = new Map(r.districts.map((d) => [d.id, d]));
    expect(byId.get('packages')?.displayLabel).toBe('packages');
    expect(byId.get('packages')?.labelPlate).toBeDefined();
    expect(byId.get('packages/service/src')?.displayLabel).toBe('service/src');
    // interior chain link: present as a district but unlabeled
    expect(byId.get('packages/service')?.displayLabel).toBeUndefined();
    expect(byId.get('packages/service')?.labelPlate).toBeUndefined();
  });

  it('returns anchors from a seed build and [] from an incremental build', () => {
    const files = fixture();
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    expect(first.anchors.length).toBe(3);
    const second = layoutFileMap(files, [], asPrior(first), { nowIso: NOW });
    expect(second.anchors).toEqual([]);
  });
});

describe('deriveAnchorsFromPrior', () => {
  it('maps old top-level centroids to compass regions', () => {
    const mk = (id: string, x: number, y: number): PriorNode => ({
      nodeKind: 'block',
      nodeId: id,
      parentId: null,
      rect: { x, y, w: 10, h: 10 },
      contentHash: null,
      weight: 1,
      placedAt: null,
      removedAt: null,
    });
    const anchors = deriveAnchorsFromPrior([
      mk('left/a.ts', 0, 0),
      mk('left/b.ts', 10, 20),
      mk('right/c.ts', 500, 500),
    ]);
    const byPath = new Map(anchors.map((a) => [a.path, a]));
    expect(byPath.get('left')?.region).toBe('NW');
    expect(byPath.get('right')?.region).toBe('SE');
    // Anchors carry no timestamp: they are macro memory, not provenance, and a
    // recordedAt on each would dirty the committed village file on every build.
    expect(anchors.every((a) => !('recordedAt' in a))).toBe(true);
  });
});
