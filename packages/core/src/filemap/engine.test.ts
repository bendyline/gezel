import { describe, expect, it } from 'vitest';
import type { Rect } from '../schemas/api.js';
import { layoutBuildingsInBlock, layoutFileMap } from './engine.js';
import { lotSpec } from './lots.js';
import type { LayoutFileInput, LayoutResult, PriorNode } from './types.js';

/** Re-feed a build's persisted layout as the prior for the next build. */
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

const NOW = '2026-06-21T00:00:00.000Z';
const file = (path: string, loc: number, hash = `h:${path}`): LayoutFileInput => ({
  path,
  weight: loc,
  contentHash: hash,
});

const FILES: LayoutFileInput[] = [
  file('src/a.ts', 120),
  file('src/b.ts', 40),
  file('src/util/x.ts', 200),
  file('src/util/y.ts', 30),
  file('docs/readme.md', 80),
];

const disjoint = (a: Rect, b: Rect): boolean =>
  a.x + a.w <= b.x + 0.001 ||
  b.x + b.w <= a.x + 0.001 ||
  a.y + a.h <= b.y + 0.001 ||
  b.y + b.h <= a.y + 0.001;

describe('layoutFileMap', () => {
  it('is deterministic: same input → identical coordinates', () => {
    const a = layoutFileMap(FILES, [], [], { nowIso: NOW });
    const b = layoutFileMap(FILES, [], [], { nowIso: NOW });
    expect(b.blocks).toEqual(a.blocks);
    expect(b.districts).toEqual(a.districts);
    expect(b.streets).toEqual(a.streets);
  });

  it('first build produces no overlapping lots (bottom-up packing)', () => {
    // a denser, deeper tree with skewed sizes — the case that overlapped before
    const files: LayoutFileInput[] = [];
    for (let i = 0; i < 30; i++) files.push(file(`pkg/a/sub/f${i}.ts`, 5 + (i % 7) * 80));
    for (let i = 0; i < 20; i++) files.push(file(`pkg/b/g${i}.ts`, 3));
    for (let i = 0; i < 10; i++) files.push(file(`pkg/c/deep/deeper/h${i}.ts`, 400));
    const r = layoutFileMap(files, [], [], { nowIso: NOW });
    const rects = [...r.blocks.values()].map((p) => p.lot);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(disjoint(rects[i]!, rects[j]!), `lots ${i} and ${j} overlap`).toBe(true);
      }
    }
  });

  it('packs a folder densely, not in sparse rows', () => {
    // 40 equal blocks in one folder — parcel rows fill a near-square area; the
    // lane/sidewalk whitespace between rows is deliberate street space.
    const files = Array.from({ length: 40 }, (_, i) => file(`pkg/f${i}.ts`, 100));
    const r = layoutFileMap(files, [], [], { nowIso: NOW });
    const rects = [...r.blocks.values()].map((p) => p.lot);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let lotArea = 0;
    for (const rr of rects) {
      minX = Math.min(minX, rr.x);
      minY = Math.min(minY, rr.y);
      maxX = Math.max(maxX, rr.x + rr.w);
      maxY = Math.max(maxY, rr.y + rr.h);
      lotArea += rr.w * rr.h;
    }
    const bboxArea = (maxX - minX) * (maxY - minY);
    expect(lotArea / bboxArea).toBeGreaterThan(0.4); // dense, minus streets
    const aspect = (maxX - minX) / (maxY - minY);
    expect(aspect).toBeGreaterThan(0.5); // roughly square
    expect(aspect).toBeLessThan(2.5);
  });

  it('first build places every file and districts enclose their blocks', () => {
    const r = layoutFileMap(FILES, [], [], { nowIso: NOW });
    expect([...r.blocks.keys()].sort()).toEqual(FILES.map((f) => f.path).sort());
    const srcUtil = r.districts.find((d) => d.id === 'src/util');
    expect(srcUtil).toBeDefined();
    for (const path of ['src/util/x.ts', 'src/util/y.ts']) {
      const blk = r.blocks.get(path)!.lot;
      const d = srcUtil!.rect;
      expect(blk.x).toBeGreaterThanOrEqual(d.x);
      expect(blk.y).toBeGreaterThanOrEqual(d.y);
      expect(blk.x + blk.w).toBeLessThanOrEqual(d.x + d.w + 0.001);
      expect(blk.y + blk.h).toBeLessThanOrEqual(d.y + d.h + 0.001);
    }
  });

  it('gives every block a footprint inside its lot, with varied aspects', () => {
    const files = Array.from({ length: 24 }, (_, i) => file(`pkg/v${i}.ts`, 150));
    const r = layoutFileMap(files, [], [], { nowIso: NOW });
    const aspects = new Set<string>();
    for (const pl of r.blocks.values()) {
      expect(pl.footprint.x).toBeGreaterThanOrEqual(pl.lot.x);
      expect(pl.footprint.y).toBeGreaterThanOrEqual(pl.lot.y);
      expect(pl.footprint.x + pl.footprint.w).toBeLessThanOrEqual(pl.lot.x + pl.lot.w + 0.001);
      expect(pl.footprint.y + pl.footprint.h).toBeLessThanOrEqual(pl.lot.y + pl.lot.h + 0.001);
      aspects.add((pl.footprint.w / pl.footprint.h).toFixed(2));
    }
    expect(aspects.size).toBeGreaterThan(5); // not a carpet of identical squares
  });

  it('adding a file moves no existing block (the familiarity guarantee)', () => {
    const first = layoutFileMap(FILES, [], [], { nowIso: NOW });
    const grown = [...FILES, file('src/c.ts', 60)];
    const second = layoutFileMap(grown, [], asPrior(first), { nowIso: NOW });
    for (const f of FILES) {
      expect(second.blocks.get(f.path)!.lot).toEqual(first.blocks.get(f.path)!.lot);
    }
    expect(second.blocks.get('src/c.ts')!.state).toBe('new');
  });

  it('an LoC change keeps the lot frozen; the footprint grows inside it', () => {
    const first = layoutFileMap(FILES, [], [], { nowIso: NOW });
    const edited = FILES.map((f) => (f.path === 'src/a.ts' ? file('src/a.ts', 900) : f));
    const second = layoutFileMap(edited, [], asPrior(first), { nowIso: NOW });
    expect(second.blocks.get('src/a.ts')!.lot).toEqual(first.blocks.get('src/a.ts')!.lot);
    const before = first.blocks.get('src/a.ts')!.footprint;
    const after = second.blocks.get('src/a.ts')!.footprint;
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.w).toBeGreaterThan(before.w); // grew in place, clamped to the lot
    const lot = second.blocks.get('src/a.ts')!.lot;
    expect(after.x + after.w).toBeLessThanOrEqual(lot.x + lot.w);
    // every other block is untouched
    for (const f of FILES.filter((f) => f.path !== 'src/a.ts')) {
      expect(second.blocks.get(f.path)!.lot).toEqual(first.blocks.get(f.path)!.lot);
    }
  });

  it('a deleted file is kept as a tombstone (vacant lot)', () => {
    const first = layoutFileMap(FILES, [], [], { nowIso: NOW });
    const fewer = FILES.filter((f) => f.path !== 'src/b.ts');
    const second = layoutFileMap(fewer, [], asPrior(first), { nowIso: NOW });
    const ghost = second.blocks.get('src/b.ts');
    expect(ghost?.state).toBe('tombstoned');
    expect(ghost?.lot).toEqual(first.blocks.get('src/b.ts')!.lot);
  });

  it('prunes tombstones older than the cutoff', () => {
    const fewer = FILES.filter((f) => f.path !== 'src/b.ts');
    const first = layoutFileMap(FILES, [], [], { nowIso: '2026-01-01T00:00:00.000Z' });
    // b.ts is removed here, so it's tombstoned with removedAt = this build's time
    const second = layoutFileMap(fewer, [], asPrior(first), { nowIso: '2026-02-01T00:00:00.000Z' });
    expect(second.blocks.get('src/b.ts')?.state).toBe('tombstoned');
    // a later build whose cutoff post-dates the removal prunes the vacant lot
    const third = layoutFileMap(fewer, [], asPrior(second), {
      nowIso: '2026-06-21T00:00:00.000Z',
      tombstoneCutoffIso: '2026-03-01T00:00:00.000Z',
    });
    expect(third.blocks.has('src/b.ts')).toBe(false);
  });

  it('renames transplant the old coordinate by content hash', () => {
    const first = layoutFileMap(FILES, [], [], { nowIso: NOW });
    const oldLot = first.blocks.get('src/b.ts')!.lot;
    // src/b.ts disappears; src/renamed.ts appears with the SAME content hash
    const renamed = [
      ...FILES.filter((f) => f.path !== 'src/b.ts'),
      file('src/renamed.ts', 40, 'h:src/b.ts'),
    ];
    const second = layoutFileMap(renamed, [], asPrior(first), { nowIso: NOW });
    expect(second.blocks.get('src/renamed.ts')!.lot.x).toBe(oldLot.x);
    expect(second.blocks.get('src/renamed.ts')!.lot.y).toBe(oldLot.y);
    expect(second.blocks.has('src/b.ts')).toBe(false); // old lot reclaimed
  });
});

describe('streets', () => {
  it('materializes streets on the first build, none overlapping a lot', () => {
    const files: LayoutFileInput[] = [];
    for (let i = 0; i < 12; i++) files.push(file(`app/ui/c${i}.ts`, 80 + i * 20));
    for (let i = 0; i < 12; i++) files.push(file(`app/core/d${i}.ts`, 60 + i * 30));
    for (let i = 0; i < 6; i++) files.push(file(`lib/e${i}.ts`, 200));
    const r = layoutFileMap(files, [], [], { nowIso: NOW });
    expect(r.streets.length).toBeGreaterThan(0);
    for (const st of r.streets) {
      expect(st.tier).toBeGreaterThanOrEqual(0);
      expect(st.tier).toBeLessThanOrEqual(3);
      expect(st.rect.w).toBeGreaterThan(0);
      expect(st.rect.h).toBeGreaterThan(0);
      for (const [path, pl] of r.blocks) {
        expect(disjoint(st.rect, pl.lot), `street ${st.id} overlaps lot ${path}`).toBe(true);
      }
    }
    // top-level gaps are wider than the deepest lanes
    const tiers = new Set(r.streets.map((s) => s.tier));
    expect(Math.min(...tiers)).toBeLessThan(Math.max(...tiers));
  });

  it('persists streets and passes them through rebuilds verbatim', () => {
    const files = Array.from({ length: 16 }, (_, i) => file(`app/m${i % 4}/f${i}.ts`, 120));
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    const second = layoutFileMap(files, [], asPrior(first), { nowIso: NOW });
    const key = (s: { id: string; rect: Rect }) => `${s.id}:${JSON.stringify(s.rect)}`;
    expect(second.streets.map(key).sort()).toEqual(first.streets.map(key).sort());
  });

  it('keeps new files off the streets', () => {
    const files = Array.from({ length: 16 }, (_, i) => file(`app/m${i % 4}/f${i}.ts`, 120));
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    const grown = [...files, file('app/m1/new.ts', 90)];
    const second = layoutFileMap(grown, [], asPrior(first), { nowIso: NOW });
    const lot = second.blocks.get('app/m1/new.ts')!.lot;
    for (const st of second.streets) {
      expect(disjoint(st.rect, lot), `new lot landed on street ${st.id}`).toBe(true);
    }
  });

  it('drops a folder’s streets once its blocks are fully pruned', () => {
    const files = [
      ...Array.from({ length: 9 }, (_, i) => file(`gone/g${i}.ts`, 300)),
      file('keep/c.ts', 100),
    ];
    const first = layoutFileMap(files, [], [], { nowIso: '2026-01-01T00:00:00.000Z' });
    expect(first.streets.some((s) => s.districtId === 'gone')).toBe(true);
    const fewer = [file('keep/c.ts', 100)];
    const second = layoutFileMap(fewer, [], asPrior(first), {
      nowIso: '2026-02-01T00:00:00.000Z',
    });
    // still tombstoned → streets stay (rubble keeps its lanes)
    expect(second.streets.some((s) => s.districtId === 'gone')).toBe(true);
    const third = layoutFileMap(fewer, [], asPrior(second), {
      nowIso: '2026-06-21T00:00:00.000Z',
      tombstoneCutoffIso: '2026-03-01T00:00:00.000Z',
    });
    expect(third.blocks.has('gone/g0.ts')).toBe(false);
    expect(third.streets.some((s) => s.districtId === 'gone')).toBe(false);
  });
});

describe('incremental city growth', () => {
  it('a new file claims a vacant sibling lot of workable size', () => {
    const first = layoutFileMap(FILES, [], [], { nowIso: NOW });
    const vacatedLot = first.blocks.get('src/b.ts')!.lot;
    // delete b.ts (tombstone), then add a same-sized sibling with a new hash
    const fewer = FILES.filter((f) => f.path !== 'src/b.ts');
    const second = layoutFileMap(fewer, [], asPrior(first), { nowIso: NOW });
    expect(second.blocks.get('src/b.ts')?.state).toBe('tombstoned');
    const grown = [...fewer, file('src/bb.ts', 40)];
    const third = layoutFileMap(grown, [], asPrior(second), { nowIso: NOW });
    const placed = third.blocks.get('src/bb.ts')!;
    expect(placed.state).toBe('new');
    expect(placed.lot).toEqual(vacatedLot);
    // the tombstone was consumed, not left as duplicate rubble
    expect(third.blocks.has('src/b.ts')).toBe(false);
    // nothing else moved
    for (const f of fewer) {
      expect(third.blocks.get(f.path)!.lot).toEqual(first.blocks.get(f.path)!.lot);
    }
  });

  it('a wholly-new folder arrives as one cohesive block with its own lanes', () => {
    const files = Array.from({ length: 16 }, (_, i) => file(`app/m${i % 4}/f${i}.ts`, 120));
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    const arrivals = Array.from({ length: 10 }, (_, i) => file(`app/fresh/n${i}.ts`, 250));
    const second = layoutFileMap([...files, ...arrivals], [], asPrior(first), { nowIso: NOW });

    // every pre-existing lot is byte-identical
    for (const f of files) {
      expect(second.blocks.get(f.path)!.lot).toEqual(first.blocks.get(f.path)!.lot);
    }
    // the new folder's bbox intersects no pre-existing lot
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const a of arrivals) {
      const lot = second.blocks.get(a.path)!.lot;
      minX = Math.min(minX, lot.x);
      minY = Math.min(minY, lot.y);
      maxX = Math.max(maxX, lot.x + lot.w);
      maxY = Math.max(maxY, lot.y + lot.h);
    }
    const bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    for (const f of files) {
      expect(disjoint(bbox, second.blocks.get(f.path)!.lot)).toBe(true);
    }
    // enough files for multiple parcel rows → internal lanes for the folder
    expect(second.streets.some((s) => s.districtId === 'app/fresh')).toBe(true);
    // and no arrival landed on any street
    for (const a of arrivals) {
      const lot = second.blocks.get(a.path)!.lot;
      for (const st of second.streets) {
        if (st.districtId === 'app/fresh') continue; // its own lanes touch its lots' edges
        expect(disjoint(st.rect, lot), `arrival ${a.path} on street ${st.id}`).toBe(true);
      }
    }
  });

  it('growth into an existing folder never overlaps siblings or streets', () => {
    // enough files that the strip has an uneven last row → append has room
    const files = Array.from({ length: 7 }, (_, i) => file(`pkg/mod/f${i}.ts`, 100));
    const first = layoutFileMap(files, [], [], { nowIso: NOW });
    const grown = [...files, file('pkg/mod/new.ts', 100)];
    const second = layoutFileMap(grown, [], asPrior(first), { nowIso: NOW });
    const lot = second.blocks.get('pkg/mod/new.ts')!.lot;
    for (const f of files) {
      const sibling = second.blocks.get(f.path)!.lot;
      expect(sibling).toEqual(first.blocks.get(f.path)!.lot);
      expect(disjoint(lot, sibling), `new lot overlaps ${f.path}`).toBe(true);
    }
    for (const st of second.streets) {
      expect(disjoint(st.rect, lot), `new lot on street ${st.id}`).toBe(true);
    }
  });
});

describe('lotSpec', () => {
  it('is deterministic and keeps the footprint inside the lot', () => {
    for (const [path, weight] of [
      ['a/b.ts', 10],
      ['a/c.ts', 500],
      ['deep/nested/file.py', 2000],
    ] as const) {
      const s1 = lotSpec(path, weight);
      const s2 = lotSpec(path, weight);
      expect(s1).toEqual(s2);
      expect(s1.foot.x).toBeGreaterThan(0);
      expect(s1.foot.y).toBeGreaterThan(0);
      expect(s1.foot.x + s1.foot.w).toBeLessThan(s1.lotW);
      expect(s1.foot.y + s1.foot.h).toBeLessThan(s1.lotH);
    }
  });
});

describe('layoutBuildingsInBlock', () => {
  const sym = (name: string, lineStart: number, lineEnd: number, kind = 'function') => ({
    name,
    kind,
    lineStart,
    lineEnd,
  });
  const rect: Rect = { x: 100, y: 100, w: 30, h: 30 };

  it('heights are absolute: the same span gets the same height in any file', () => {
    const solo = layoutBuildingsInBlock('a.ts', rect, [sym('f', 1, 40)]);
    const crowd = layoutBuildingsInBlock('b.ts', rect, [sym('f', 1, 40), sym('giant', 50, 900)]);
    const f = crowd.find((b) => b.label === 'f')!;
    expect(f.height).toBeCloseTo(solo[0]!.height, 10);
    expect(crowd.find((b) => b.label === 'giant')!.height).toBeGreaterThan(f.height);
  });

  it('bounds heights: tiny symbols keep a floor, giants cap at 1', () => {
    const [tiny, giant] = layoutBuildingsInBlock('a.ts', rect, [
      sym('tiny', 1, 2),
      sym('giant', 10, 2000),
    ]);
    expect(tiny!.height).toBeGreaterThan(0.1);
    expect(tiny!.height).toBeLessThan(0.2);
    expect(giant!.height).toBe(1);
  });

  it('bigger symbols get bigger footprints, all inside the block', () => {
    const placed = layoutBuildingsInBlock('a.ts', rect, [sym('small', 1, 5), sym('big', 10, 500)]);
    const small = placed.find((b) => b.label === 'small')!;
    const big = placed.find((b) => b.label === 'big')!;
    expect(big.rect.w * big.rect.h).toBeGreaterThan(small.rect.w * small.rect.h);
    for (const b of placed) {
      expect(b.rect.x).toBeGreaterThanOrEqual(rect.x);
      expect(b.rect.y).toBeGreaterThanOrEqual(rect.y);
      expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(rect.x + rect.w);
      expect(b.rect.y + b.rect.h).toBeLessThanOrEqual(rect.y + rect.h);
    }
  });

  it('caps crowded blocks at a minimum cell size, keeping the largest symbols', () => {
    const tiny: Rect = { x: 0, y: 0, w: 10, h: 10 };
    const symbols = Array.from({ length: 40 }, (_, i) =>
      sym(`f${i}`, i * 100, i * 100 + (i === 7 ? 90 : 4)),
    );
    const placed = layoutBuildingsInBlock('a.ts', tiny, symbols);
    expect(placed.length).toBeLessThan(symbols.length);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.some((b) => b.label === 'f7')).toBe(true); // the big one survives
    for (const b of placed) {
      expect(b.rect.w).toBeGreaterThan(1);
      expect(b.rect.h).toBeGreaterThan(1);
    }
    // survivors stay in source order, left-to-right then row by row
    const ids = placed.map((b) => Number(b.label.slice(1)));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('reports the symbol line span on the wire', () => {
    const [b] = layoutBuildingsInBlock('a.ts', rect, [sym('f', 10, 49)]);
    expect(b).toMatchObject({ lines: 40, lineStart: 10, lineEnd: 49 });
  });
});
