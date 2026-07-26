import type { FileMapResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { lodTier } from '../camera.js';
import { buildPalette } from '../palette.js';
import { SPRITE_KEYS, type SpriteAtlas, type SpriteKey } from '../sprites.js';
import { render } from './index.js';
import type { RenderState } from './state.js';

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
        depth: 0,
        fileCount: 5,
        weight: 6000,
      },
      {
        id: 'src/x',
        parentId: 'src',
        rect: { x: 15, y: 15, w: 100, h: 80 },
        label: 'x',
        depth: 1,
        fileCount: 5,
        weight: 6000,
      },
    ],
    blocks: [
      {
        id: 'src/x/a.ts',
        districtId: 'src/x',
        rect: { x: 20, y: 20, w: 30, h: 30 },
        lot: { x: 18, y: 18, w: 34, h: 34 },
        label: 'a.ts',
        weight: 500,
        lang: 'typescript',
        state: 'live',
        buildingCount: 2,
        placedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
        health: {
          findings: 0,
          maxSeverity: null,
          fanIn: 1,
          fanOut: 1,
          vibe: 'lush',
          zone: 'residential',
        },
      },
      {
        id: 'src/x/b.ts',
        districtId: 'src/x',
        rect: { x: 60, y: 20, w: 20, h: 20 },
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
        rect: { x: 90, y: 20, w: 16, h: 16 },
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
        rect: { x: 20, y: 60, w: 20, h: 20 },
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
        rect: { x: 60, y: 60, w: 40, h: 40 },
        lot: { x: 58, y: 58, w: 45, h: 45 },
        label: 'huge.py',
        weight: 5000,
        lang: 'python',
        state: 'live',
        buildingCount: 0,
        placedAt: new Date(NOW - 200 * 86_400_000).toISOString(),
        health: {
          findings: 3,
          maxSeverity: 'critical',
          fanIn: 9,
          fanOut: 0,
          vibe: 'blighted',
          zone: 'civic',
        },
      },
    ],
    buildings: [
      {
        id: 'src/x/a.ts#Klass',
        blockId: 'src/x/a.ts',
        rect: { x: 22, y: 22, w: 8, h: 8 },
        height: 0.9,
        label: 'Klass',
        kind: 'class',
      },
      {
        id: 'src/x/a.ts#doIt',
        blockId: 'src/x/a.ts',
        rect: { x: 34, y: 22, w: 8, h: 8 },
        height: 0.4,
        label: 'doIt',
        kind: 'function',
      },
    ],
    roads: [
      { a: 'src/x/a.ts', b: 'src/x/huge.py', affinity: 1, source: 'import', bidirectional: false },
      { a: 'src/x/b.ts', b: 'src/x/a.ts', affinity: 1, source: 'import', bidirectional: true },
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

function state(scale: number, m: FileMapResponse, extra?: Partial<RenderState>): RenderState {
  return {
    cam: { scale, offsetX: 0, offsetY: 0 },
    model: m,
    palette: buildPalette(true),
    tier: lodTier(scale),
    viewW: 800,
    viewH: 600,
    selectedId: null,
    hoverId: null,
    now: NOW,
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

describe('render pipeline smoke', () => {
  it.each([
    ['city', 0.2],
    ['district', 1.0],
    ['street', 2.0],
  ])('draws the %s tier without throwing', (_tier, scale) => {
    const { ctx, calls } = recordingCtx();
    render(ctx, state(scale, model(false)));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('gates labels by tier: none at city zoom, block labels at street zoom', () => {
    const city = recordingCtx();
    render(city.ctx, state(0.2, model(false)));
    expect(city.calls.some((c) => c.method === 'fillText')).toBe(false);

    const street = recordingCtx();
    render(street.ctx, state(2.0, model(false)));
    const texts = street.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('a.ts');
    expect(texts).toContain('src');
  });

  it('paints the PR scrim as a second full-viewport fill, after the base city', () => {
    const base = recordingCtx();
    render(base.ctx, state(1.0, model(false)));
    expect(fullViewportFills(base.calls)).toHaveLength(1);

    const withPr = recordingCtx();
    render(withPr.ctx, state(1.0, model(true), { affectedIds: new Set(['src/x/huge.py']) }));
    const fills = fullViewportFills(withPr.calls);
    expect(fills).toHaveLength(2);
    const scrimIndex = withPr.calls.indexOf(fills[1]!);
    // the scrim must land late enough to dim the buildings under it
    expect(scrimIndex).toBeGreaterThan(withPr.calls.length / 3);
  });

  it('survives the age lens, selection, and hover in one frame', () => {
    const { ctx, calls } = recordingCtx();
    render(
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
    render(ctx, state(1.0, model(true)));
    expect(calls.some((c) => c.method === 'setLineDash')).toBe(true);
  });

  it('blits yard decor only with an atlas, and never under the age lens', () => {
    const bare = recordingCtx();
    render(bare.ctx, state(2.0, model(false)));
    expect(bare.calls.some((c) => c.method === 'drawImage')).toBe(false);

    const decorated = recordingCtx();
    render(decorated.ctx, state(2.0, model(false), { atlas: fakeAtlas() }));
    expect(decorated.calls.some((c) => c.method === 'drawImage')).toBe(true);

    const lensed = recordingCtx();
    render(lensed.ctx, state(2.0, model(false), { atlas: fakeAtlas(), ageLens: true }));
    expect(lensed.calls.some((c) => c.method === 'drawImage')).toBe(false);
  });
});

describe('flat renderer parity with the iso vocabulary', () => {
  it('reads the shared architectural style, not just health.zone', () => {
    // The two renderers disagreed for as long as the flat one re-derived its
    // own architecture from `zone`. Hold zone fixed and vary only the urbanity
    // band: if the flat view still draws the same roof, it is not reading the
    // shared style and the views have drifted apart again.
    const paint = (settlement: 'village' | 'city') => {
      const m = model(false);
      m.blocks = m.blocks.map((b) =>
        b.state === 'live' && !b.phantom
          ? { ...b, settlement, urbanity: settlement === 'village' ? 0.15 : 0.95 }
          : b,
      );
      const { ctx, calls } = recordingCtx();
      render(ctx, state(3, m));
      return calls.map((c) => `${c.method}:${c.args.length}`).join('|');
    };
    expect(paint('village')).not.toBe(paint('city'));
  });
});
