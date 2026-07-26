import type { FileMapResponse, MapBlock } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { lodTier } from '../camera.js';
import { buildPalette, prismColors } from '../palette.js';
import { SPRITE_KEYS, type SpriteAtlas, type SpriteKey } from '../sprites.js';
import { geometryForModel, hitTestIso, roofHeadroom } from './geometry.js';
import { createLabelEngineState, renderIso } from './index.js';
import { prismScreen } from './prism.js';
import { fitToBoundsIso, toIso, townRoofRiseIso } from './projection.js';
import type { IsoRenderState } from './state.js';
import { drawTownBuilding } from './town-buildings.js';
import { allArchetypeForms, townStyleForBlock } from './town-style.js';

// jsdom can't build the real atlas (no 2D context) — a stub is enough for the
// recording ctx, which just records the drawImage args.
function fakeAtlas(): SpriteAtlas {
  const index = {} as Record<SpriteKey, number>;
  SPRITE_KEYS.forEach((k, i) => {
    index[k] = i;
  });
  return { canvas: {} as HTMLCanvasElement, cell: 48, index };
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

// jsdom has no real 2D context, so the pipeline is exercised against a
// recording stub: every method call is captured, every property set allowed.
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const target: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (!(prop in t)) {
        t[prop] = (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return null;
        };
      }
      return t[prop];
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const NOW = Date.parse('2026-07-05T12:00:00Z');

/** Recorded ctx methods whose second argument is a y coordinate. */
const POINT_METHODS = new Set(['moveTo', 'lineTo', 'fillRect', 'arc', 'rect', 'strokeRect']);

/** A v5-flavored fixture: displayLabels, plates, plazas, levels, a landmark. */
function model(withOverlay: boolean): FileMapResponse {
  return {
    domain: 'code',
    root: '/repo',
    bounds: { x: 0, y: 0, w: 130, h: 110 },
    builtAt: new Date(NOW).toISOString(),
    indexed: true,
    districts: [
      {
        id: 'src',
        parentId: null,
        rect: { x: 10, y: 10, w: 110, h: 90 },
        label: 'src',
        depth: 1,
        fileCount: 5,
        weight: 6000,
        displayLabel: 'src',
        labelPlate: { x: 14, y: 14, w: 40, h: 11 },
      },
      {
        id: 'src/x',
        parentId: 'src',
        rect: { x: 15, y: 15, w: 100, h: 80 },
        label: 'x',
        depth: 2,
        fileCount: 5,
        weight: 6000,
      },
    ],
    blocks: [
      {
        id: 'src/x/a.ts',
        districtId: 'src/x',
        rect: { x: 20, y: 30, w: 30, h: 30 },
        lot: { x: 18, y: 28, w: 34, h: 34 },
        label: 'a.ts',
        weight: 500,
        lang: 'typescript',
        state: 'live',
        buildingCount: 2,
        levels: 3,
        placedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
        lastTouchedAt: new Date(NOW - 86_400_000).toISOString(),
        health: {
          findings: 0,
          maxSeverity: null,
          fanIn: 1,
          fanOut: 1,
          vibe: 'lush',
          zone: 'residential',
          importance: 0.6,
          churn: 4,
        },
      },
      {
        id: 'src/x/b.ts',
        districtId: 'src/x',
        rect: { x: 60, y: 30, w: 20, h: 20 },
        label: 'b.ts',
        weight: 100,
        lang: 'typescript',
        state: 'new',
        buildingCount: 0,
        placedAt: new Date(NOW).toISOString(),
      },
      {
        id: 'src/x/gone.ts',
        districtId: 'src/x',
        rect: { x: 95, y: 30, w: 16, h: 16 },
        label: 'gone.ts',
        weight: 50,
        lang: 'typescript',
        state: 'tombstoned',
        buildingCount: 0,
        placedAt: null,
      },
      {
        id: 'src/x/ghost.ts',
        districtId: 'src/x',
        rect: { x: 20, y: 70, w: 20, h: 20 },
        label: 'ghost.ts',
        weight: 80,
        lang: 'typescript',
        state: 'new',
        buildingCount: 0,
        phantom: true,
        placedAt: null,
      },
      {
        id: 'src/x/huge.py',
        districtId: 'src/x',
        rect: { x: 60, y: 66, w: 40, h: 30 },
        lot: { x: 58, y: 64, w: 45, h: 35 },
        label: 'huge.py',
        weight: 5000,
        lang: 'python',
        state: 'live',
        buildingCount: 0,
        levels: 5,
        landmark: true,
        placedAt: new Date(NOW - 200 * 86_400_000).toISOString(),
        health: {
          findings: 3,
          maxSeverity: 'critical',
          fanIn: 9,
          fanOut: 0,
          vibe: 'blighted',
          zone: 'civic',
          importance: 1,
          churn: 30,
        },
      },
    ],
    buildings: [
      {
        id: 'src/x/a.ts#Klass',
        blockId: 'src/x/a.ts',
        rect: { x: 22, y: 32, w: 8, h: 8 },
        height: 0.9,
        label: 'Klass',
        kind: 'class',
      },
      {
        id: 'src/x/a.ts#doIt',
        blockId: 'src/x/a.ts',
        rect: { x: 34, y: 32, w: 8, h: 8 },
        height: 0.4,
        label: 'doIt',
        kind: 'function',
      },
    ],
    roads: [
      { a: 'src/x/a.ts', b: 'src/x/huge.py', affinity: 1, source: 'import', bidirectional: false },
      { a: 'src/x/b.ts', b: 'src/x/a.ts', affinity: 1, source: 'import', bidirectional: true },
    ],
    streets: [
      { id: 'st:1', rect: { x: 10, y: 62, w: 110, h: 4 }, tier: 0, districtId: null },
      { id: 'st:2', rect: { x: 55, y: 10, w: 4, h: 90 }, tier: 2, districtId: 'src' },
    ],
    plazas: [
      {
        id: 'plaza:src/x/huge.py',
        districtId: 'src/x',
        rect: { x: 102, y: 66, w: 12, h: 12 },
        kind: 'plaza',
        blockId: 'src/x/huge.py',
      },
      { id: 'green:src:0', districtId: 'src', rect: { x: 20, y: 92, w: 20, h: 6 }, kind: 'green' },
    ],
    ...(withOverlay
      ? {
          overlay: {
            prNumber: 7,
            title: 'test pr',
            changedBlocks: [
              { blockId: 'src/x/a.ts', change: 'modified' as const, additions: 5, deletions: 2 },
              { blockId: 'src/x/ghost.ts', change: 'added' as const, additions: 40, deletions: 0 },
            ],
          },
        }
      : {}),
  };
}

function state(scale: number, m: FileMapResponse, extra?: Partial<IsoRenderState>): IsoRenderState {
  return {
    cam: { scale, offsetX: -60, offsetY: 0 },
    model: m,
    palette: buildPalette(true),
    tier: lodTier(scale),
    viewW: 800,
    viewH: 600,
    selectedId: null,
    hoverId: null,
    now: NOW,
    geom: geometryForModel(m),
    ...extra,
  };
}

const fullViewportFills = (calls: RecordedCall[]) =>
  calls.filter(
    (c) =>
      c.method === 'fillRect' &&
      c.args[0] === 0 &&
      c.args[1] === 0 &&
      c.args[2] === 800 &&
      c.args[3] === 600,
  );

describe('iso render pipeline smoke', () => {
  it.each([
    ['city', 0.2],
    ['district', 1.0],
    ['street', 2.0],
  ])('draws the %s tier without throwing', (_tier, scale) => {
    const { ctx, calls } = recordingCtx();
    renderIso(ctx, state(scale, model(false)));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('labels display districts only, blocks join at street zoom', () => {
    const street = recordingCtx();
    renderIso(street.ctx, state(2.0, model(false)));
    const texts = street.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('src');
    expect(texts).toContain('a.ts');
    // src/x has no displayLabel (collapsed-chain interior) — never labeled
    expect(texts).not.toContain('x');
  });

  it('reveals compact symbol tags only at close-detail zoom', () => {
    const street = recordingCtx();
    renderIso(street.ctx, state(2.0, model(false)));
    const streetTexts = street.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(streetTexts).not.toContain('doIt');

    const detail = recordingCtx();
    renderIso(detail.ctx, state(3.0, model(false)));
    const detailTexts = detail.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(detailTexts).toContain('doIt');
  });

  it('paints the PR scrim as a second full-viewport fill, after the base city', () => {
    const base = recordingCtx();
    renderIso(base.ctx, state(1.0, model(false)));
    expect(fullViewportFills(base.calls)).toHaveLength(1);

    const withPr = recordingCtx();
    renderIso(withPr.ctx, state(1.0, model(true), { affectedIds: new Set(['src/x/huge.py']) }));
    const fills = fullViewportFills(withPr.calls);
    expect(fills).toHaveLength(2);
    const scrimIndex = withPr.calls.indexOf(fills[1]!);
    expect(scrimIndex).toBeGreaterThan(withPr.calls.length / 3);
  });

  it('survives the age lens, selection, and hover in one frame', () => {
    const { ctx, calls } = recordingCtx();
    renderIso(
      ctx,
      state(2.0, model(false), {
        ageLens: true,
        selectedId: 'src/x/a.ts',
        hoverId: 'src/x/huge.py',
      }),
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it('handles the phantom scaffold path without a canvas pattern (jsdom)', () => {
    const { ctx, calls } = recordingCtx();
    renderIso(ctx, state(1.0, model(true)));
    expect(calls.some((c) => c.method === 'setLineDash')).toBe(true);
  });

  it('blits yard decor only with an atlas, and never under the age lens', () => {
    const bare = recordingCtx();
    renderIso(bare.ctx, state(2.0, model(false)));
    expect(bare.calls.some((c) => c.method === 'drawImage')).toBe(false);

    const decorated = recordingCtx();
    renderIso(decorated.ctx, state(2.0, model(false), { atlas: fakeAtlas() }));
    expect(decorated.calls.some((c) => c.method === 'drawImage')).toBe(true);

    const lensed = recordingCtx();
    renderIso(lensed.ctx, state(2.0, model(false), { atlas: fakeAtlas(), ageLens: true }));
    expect(lensed.calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('keeps the label engine stable across identical frames (hysteresis)', () => {
    const labels = createLabelEngineState();
    const a = recordingCtx();
    renderIso(a.ctx, state(2.0, model(false), { labels }));
    const first = new Set(labels.accepted);
    const b = recordingCtx();
    renderIso(b.ctx, state(2.0, model(false), { labels }));
    expect(labels.accepted).toEqual(first);
    expect(first.size).toBeGreaterThan(0);
  });

  it('hit-tests prisms exactly: top-face clicks select the tall building', () => {
    const m = model(false);
    const geom = geometryForModel(m);
    const cam = fitToBoundsIso(m.bounds, geom.maxHIso, 800, 600);
    const huge = m.blocks.find((b) => b.id === 'src/x/huge.py')!;
    const g = geom.geoms.find((x) => x.block.id === 'src/x/huge.py')!;
    const c = toIso(huge.rect.x + huge.rect.w / 2, huge.rect.y + huge.rect.h / 2);
    // Screen point of the prism's top-face center.
    const sx = (c.u - cam.offsetX) * cam.scale;
    const sy = (c.v - g.hIso - cam.offsetY) * cam.scale;
    expect(hitTestIso(geom, cam, sx, sy)?.id).toBe('src/x/huge.py');
    // The pitched roof extends above the old cuboid and remains clickable.
    const roofSy =
      (c.v - g.hIso - townRoofRiseIso(huge.rect, cam.scale) * 0.8 - cam.offsetY) * cam.scale;
    expect(hitTestIso(geom, cam, sx, roofSy)?.id).toBe('src/x/huge.py');
    // The same point with a ground-plane-only test would miss the block:
    // the unprojected ground point sits north of the footprint.
    const groundY = (c.v - cam.offsetY) * cam.scale;
    expect(hitTestIso(geom, cam, sx, groundY)?.id).toBe('src/x/huge.py');
  });
});

/** One block per roof form, laid out on a wide row so none occlude. */
function roofModel(
  settlement: 'village' | 'town' | 'city',
  zone: MapBlock['health'] extends infer _H | undefined
    ? NonNullable<MapBlock['health']>['zone']
    : never,
): FileMapResponse {
  const blocks: MapBlock[] = Array.from({ length: 8 }, (_, i) => ({
    id: `pkg/f${i}.ts`,
    districtId: 'pkg',
    rect: { x: i * 60, y: 0, w: 40, h: 32 },
    lot: { x: i * 60 - 3, y: -3, w: 46, h: 38 },
    label: `f${i}.ts`,
    weight: 400,
    lang: 'typescript',
    state: 'live' as const,
    buildingCount: 0,
    levels: 3,
    settlement,
    urbanity: settlement === 'village' ? 0.2 : settlement === 'town' ? 0.6 : 0.9,
    placedAt: new Date(NOW).toISOString(),
    health: {
      findings: 0,
      maxSeverity: null,
      fanIn: 2,
      fanOut: 2,
      vibe: 'tidy' as const,
      zone,
      importance: 0.5,
      churn: 3,
    },
  }));
  return {
    domain: 'code',
    root: '/repo',
    bounds: { x: -10, y: -10, w: 8 * 60 + 20, h: 60 },
    builtAt: new Date(NOW).toISOString(),
    indexed: true,
    districts: [
      {
        id: 'pkg',
        parentId: null,
        rect: { x: -6, y: -6, w: 8 * 60 + 12, h: 46 },
        label: 'pkg',
        depth: 1,
        fileCount: blocks.length,
        weight: 3200,
      },
    ],
    blocks,
    buildings: [],
    roads: [],
  };
}

const ZONES = ['residential', 'commercial', 'civic', 'industrial'] as const;
const BANDS = ['village', 'town', 'city'] as const;

describe('roof vocabulary', () => {
  it('renders every band × zone at street zoom without throwing', () => {
    for (const band of BANDS) {
      for (const zone of ZONES) {
        const m = roofModel(band, zone);
        const { ctx, calls } = recordingCtx();
        renderIso(ctx, state(3, m));
        expect(calls.length, `${band}/${zone} drew nothing`).toBeGreaterThan(0);
        // Every drawn coordinate must be finite — a NaN silently blanks the
        // rest of the canvas rather than erroring.
        for (const c of calls) {
          for (const a of c.args) {
            if (typeof a === 'number') {
              expect(Number.isFinite(a), `${band}/${zone} ${c.method} got ${a}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('exercises every roof form across the vocabulary', () => {
    const seen = new Set<string>();
    for (const band of BANDS) {
      for (const zone of ZONES) {
        for (const b of roofModel(band, zone).blocks) seen.add(townStyleForBlock(b).roof);
      }
    }
    // The village and city signatures in particular must be reachable.
    expect(seen.has('thatch') || seen.has('catslide')).toBe(true);
    expect(seen.has('parapet') || seen.has('barrel')).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it('no roof or cap draws past the headroom its style declares', () => {
    // The invariant behind roofFactor: culling, hit-testing, and the issue
    // marker all budget `townRoofRiseIso * roofFactor` above the prism. A roof
    // that paints higher pops in on scroll and swallows clicks over its own
    // silhouette.
    //
    // Driven over the full archetype x roof x ridge cross-product, not over a
    // sampled fixture: the forms most likely to overrun (conical kilns, clock
    // towers, pyramids) are exactly the rarest ones, so sampling would let a
    // regression through while the suite stayed green.
    const m = roofModel('town', 'residential');
    const s = state(3, m);
    const g = geometryForModel(m).geoms[0]!;
    const base = townStyleForBlock(g.block);
    let checked = 0;

    for (const form of allArchetypeForms()) {
      for (const roof of form.roofs) {
        for (const ridge of ['x', 'y'] as const) {
          const style = {
            ...base,
            archetype: form.archetype,
            roof,
            ridge,
            cap: form.cap,
            cupola: form.cap === 'cupola',
            clock: form.cap === 'clock-tower',
            sawteeth: roof === 'sawtooth' ? 3 : 0,
            chimneys: 2,
            dormers: 2,
            ...(form.roofFactor !== 1 ? { roofFactor: form.roofFactor } : {}),
          };
          const prism = prismScreen(s.cam, g.block.rect, g.hIso);
          const budget = townRoofRiseIso(g.block.rect, s.cam.scale) * form.roofFactor * s.cam.scale;
          const ceiling = prism.tn.y - budget;
          const { ctx, calls } = recordingCtx();
          drawTownBuilding(ctx, s, prism, style, prismColors(g.block.lang, s.palette));
          for (const call of calls) {
            if (!POINT_METHODS.has(call.method)) continue;
            const y = call.args[1];
            if (typeof y !== 'number') continue;
            expect(
              y,
              `${form.archetype}/${roof}/${ridge} cap=${form.cap} painted y=${y.toFixed(1)}, above its ${ceiling.toFixed(1)} budget`,
            ).toBeGreaterThanOrEqual(ceiling - 0.01);
          }
          checked++;
        }
      }
    }
    // 34 archetypes, 1-2 roofs each, 2 ridge axes.
    expect(checked).toBeGreaterThanOrEqual(34 * 2);
  });
});

describe('lots and streetscape', () => {
  it('draws a hedge boundary in the village and none in the paved core', () => {
    const village = roofModel('village', 'residential');
    const city = roofModel('city', 'residential');
    const strokesOf = (m: FileMapResponse) => {
      const { ctx, calls } = recordingCtx();
      renderIso(ctx, state(3, m));
      // A hedge is a run of short ticks: many moveTo/lineTo pairs in one path.
      return calls.filter((c) => c.method === 'moveTo').length;
    };
    expect(strokesOf(village)).toBeGreaterThan(strokesOf(city));
  });

  it('keeps the city overview quiet — no lots, no hedges, no lane surfaces', () => {
    // The overview has to tell one story. Everything the village work adds is
    // district-and-closer, or a 20k-block map stops holding frame rate.
    const m = roofModel('village', 'residential');
    const { ctx, calls } = recordingCtx();
    renderIso(ctx, state(0.2, m));
    const styles = new Set(
      calls.filter((c) => c.method === 'fill' || c.method === 'stroke').map((c) => c.method),
    );
    expect(styles.size).toBeGreaterThan(0);
    // The lot pass returns immediately at city tier; hedge ticks would show up
    // as a large moveTo count and must not.
    expect(calls.filter((c) => c.method === 'moveTo').length).toBeLessThan(60);
  });

  it('suppresses lots and material under the age lens', () => {
    // One clean surface per file, or the recency ramp competes with hedges,
    // garden greens, and nine material treatments at once.
    const m = roofModel('village', 'residential');
    const plain = recordingCtx();
    renderIso(plain.ctx, state(3, m));
    const lensed = recordingCtx();
    renderIso(lensed.ctx, state(3, m, { ageLens: true }));
    expect(lensed.calls.filter((c) => c.method === 'moveTo').length).toBeLessThan(
      plain.calls.filter((c) => c.method === 'moveTo').length,
    );
  });
});
