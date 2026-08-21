import {
  ACCESSORY_OPTIONS,
  BODY_SHAPE_KEYS,
  DRESS_OPTIONS,
  EXPRESSION_OPTIONS,
  FACIAL_HAIR_OPTIONS,
  FIGURE_SCALE_KEYS,
  HAIR_SHAPES,
  HAT_OPTIONS,
  MARK_OPTIONS,
  type Poppetje as PoppetjeStruct,
  SHIRT_PATTERN_OPTIONS,
  poppetjeFromSeed,
} from '@bendyline/gezel';
import { render } from '@testing-library/react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Poppetje } from './Poppetje.js';

/** Static markup with all def-id noise removed, for content comparisons. */
function staticMarkup(poppetje: PoppetjeStruct, props: Record<string, unknown> = {}): string {
  const markup = renderToStaticMarkup(
    <Poppetje poppetje={poppetje} svgId="t" variant="full" size={120} {...props} />,
  );
  return markup.replace(/pop[A-Za-z0-9_-]*/g, 'POP');
}

describe('Poppetje', () => {
  it('renders an SVG with the full viewBox by default', () => {
    const p = poppetjeFromSeed(7, { key: 'imara', name: 'Imara' });
    const { container } = render(<Poppetje poppetje={p} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 80 175');
  });

  it('switches viewBox per variant (same content tree)', () => {
    const p = poppetjeFromSeed(7, { key: 'imara', name: 'Imara' });
    const full = render(<Poppetje poppetje={p} variant="full" />);
    const headshot = render(<Poppetje poppetje={p} variant="headshot" />);
    const icon = render(<Poppetje poppetje={p} variant="icon" />);
    const fullVb = full.container.querySelector('svg')!.getAttribute('viewBox');
    const headshotVb = headshot.container.querySelector('svg')!.getAttribute('viewBox');
    const iconVb = icon.container.querySelector('svg')!.getAttribute('viewBox');
    expect(fullVb).not.toBe(headshotVb);
    expect(headshotVb).not.toBe(iconVb);
    expect(fullVb).toBe('0 0 80 175');
  });

  it('widens the headshot crop for a hat so a clipping frame keeps the brim', () => {
    const bare = poppetjeFromSeed(7, { key: 'imara', name: 'Imara' });
    const hatless = { ...bare, hat: null } as PoppetjeStruct;
    const hatted = { ...bare, hat: 'straw' } as PoppetjeStruct;
    const vb = (p: PoppetjeStruct) => {
      const values = render(<Poppetje poppetje={p} variant="headshot" />)
        .container.querySelector('svg')!
        .getAttribute('viewBox')!
        .split(' ')
        .map(Number);
      const [x, y, width, height] = values;
      if (
        x === undefined ||
        y === undefined ||
        width === undefined ||
        height === undefined ||
        values.length !== 4
      ) {
        throw new Error(`Expected a four-part viewBox, received: ${values.join(' ')}`);
      }
      return [x, y, width, height] as const;
    };
    const [bx, by, bw] = vb(hatless);
    const [hx, hy, hw] = vb(hatted);
    // The straw brim reaches 29 head-units either side of centre and the
    // crown climbs above the head ellipse — both must land inside the crop.
    expect(hw).toBeGreaterThan(bw);
    expect(hx).toBeLessThan(bx);
    expect(hy).toBeLessThan(by);
  });

  it('produces identical DOM for the same poppetje (wood-grain stability)', () => {
    const p = poppetjeFromSeed(42, { key: 'imara', name: 'Imara' });
    const first = render(<Poppetje poppetje={p} />);
    const second = render(<Poppetje poppetje={p} />);
    // Filter IDs differ per render (useId), but the geometry/path data should
    // match exactly. Strip ids before comparing.
    const stripIds = (html: string) => html.replace(/pop[:_a-zA-Z0-9-]+/g, 'POP');
    expect(stripIds(first.container.innerHTML)).toBe(stripIds(second.container.innerHTML));
  });

  it('renders every body archetype, hat, dress, and accessory without crashing', () => {
    // 100 seeds covers the full slot space comfortably.
    for (let n = 0; n < 100; n++) {
      const p = poppetjeFromSeed(n);
      expect(() => render(<Poppetje poppetje={p} variant="full" size={120} />)).not.toThrow();
    }
  });

  it('encodes the wood-grain seed deterministically from the key', () => {
    const p1 = poppetjeFromSeed(7, { key: 'alpha', name: 'A' });
    const p2 = poppetjeFromSeed(7, { key: 'beta', name: 'B' });
    const r1 = render(<Poppetje poppetje={p1} />);
    const r2 = render(<Poppetje poppetje={p2} />);
    const seed1 = r1.container.querySelector('feTurbulence')?.getAttribute('seed');
    const seed2 = r2.container.querySelector('feTurbulence')?.getAttribute('seed');
    expect(seed1).toBeDefined();
    expect(seed2).toBeDefined();
    expect(seed1).not.toBe(seed2);
  });

  it('varies wood-fiber width and waviness between gezellen', () => {
    const alpha = render(<Poppetje poppetje={poppetjeFromSeed(7, { key: 'alpha', name: 'A' })} />);
    const beta = render(<Poppetje poppetje={poppetjeFromSeed(7, { key: 'beta', name: 'B' })} />);
    const frequencies = (container: HTMLElement) =>
      [...container.querySelectorAll('feTurbulence')].map((node) =>
        node.getAttribute('baseFrequency'),
      );
    expect(frequencies(alpha.container)).not.toEqual(frequencies(beta.container));
  });

  it('assigns stable fine, flowing, cathedral, and knotty material characters', () => {
    const characterFor = (key: string) => {
      const result = render(<Poppetje poppetje={poppetjeFromSeed(7, { key, name: key })} />);
      return result.container.querySelector('svg')?.getAttribute('data-grain-character');
    };
    expect(characterFor('grain-character-4')).toBe('fine');
    expect(characterFor('grain-character-266')).toBe('flowing');
    expect(characterFor('grain-character-0')).toBe('cathedral');
    expect(characterFor('grain-character-267')).toBe('knotty');
  });

  it('gives half of knotty figures a second deterministic whorl', () => {
    const whorlsFor = (key: string) => {
      const result = render(<Poppetje poppetje={poppetjeFromSeed(7, { key, name: key })} />);
      return result.container.querySelector('svg')?.getAttribute('data-whorl-count');
    };
    expect(whorlsFor('grain-character-267')).toBe('1');
    expect(whorlsFor('grain-character-117')).toBe('2');
  });

  it('skips the wood-grain filter for grainStyle="none"', () => {
    const p = poppetjeFromSeed(7);
    const { container } = render(<Poppetje poppetje={p} grainStyle="none" />);
    expect(container.querySelector('feTurbulence')).toBeNull();
  });

  it('drops sub-pixel grain from tiny icon crops', () => {
    const p = poppetjeFromSeed(7);
    const tiny = render(<Poppetje poppetje={p} variant="icon" size={24} />);
    const regular = render(<Poppetje poppetje={p} variant="icon" size={40} />);
    expect(tiny.container.querySelector('feTurbulence')).toBeNull();
    expect(regular.container.querySelector('feTurbulence')).not.toBeNull();
  });
});

describe('Poppetje svgId (static rendering)', () => {
  // useId restarts per renderToStaticMarkup call, so without an explicit
  // namespace every statically rendered figure shares the same def ids and
  // a page of figures resolves every url(#…) to the FIRST figure's defs —
  // the whole gallery rendered in one shirt color until this existed.
  it('namespaces all def ids and url() references per figure', () => {
    const p = poppetjeFromSeed(7, { key: 'imara', name: 'Imara' });
    const a = renderToStaticMarkup(<Poppetje poppetje={p} svgId="tile-a" />);
    const b = renderToStaticMarkup(<Poppetje poppetje={p} svgId="tile-b" />);
    const idsOf = (s: string) => new Set([...s.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));
    const aIds = idsOf(a);
    for (const id of idsOf(b)) {
      expect(aIds.has(id), `def id ${id} collides across figures`).toBe(false);
    }
    // Every url(#ref) must resolve inside the same document fragment.
    for (const [, ref] of a.matchAll(/url\(#([^)]+)\)/g)) {
      expect(aIds.has(ref!), `dangling url(#${ref})`).toBe(true);
    }
  });

  it('sanitizes svgId into url()-safe ids', () => {
    const p = poppetjeFromSeed(7, { key: 'imara', name: 'Imara' });
    const markup = renderToStaticMarkup(<Poppetje poppetje={p} svgId="a b:c/d" />);
    expect(markup).toContain('id="popabcd-body"');
  });
});

describe('Poppetje diversity rendering', () => {
  const base = poppetjeFromSeed(7, { key: 'fixed', name: 'Fixed' });
  const fixed: PoppetjeStruct = {
    ...base,
    bodyShape: 'tapered',
    figureScale: 'adult',
    hairShape: 'short',
    hat: null,
    dress: null,
    accessory: null,
    facialHair: null,
    mark: null,
    expression: 'smile',
    shirtPattern: 'plain',
  };

  // Every option of every slot must render its own distinct artwork. A new
  // catalog entry that falls through the renderer's conditionals would
  // silently draw the bare figure — this is the test that catches it.
  const slots: Array<[keyof PoppetjeStruct, ReadonlyArray<string | null>]> = [
    ['bodyShape', BODY_SHAPE_KEYS],
    ['figureScale', FIGURE_SCALE_KEYS],
    ['hairShape', HAIR_SHAPES],
    ['hat', [null, ...HAT_OPTIONS]],
    ['dress', [null, ...DRESS_OPTIONS]],
    ['accessory', [null, ...ACCESSORY_OPTIONS]],
    ['facialHair', [null, ...FACIAL_HAIR_OPTIONS]],
    ['mark', [null, ...MARK_OPTIONS]],
    ['expression', EXPRESSION_OPTIONS],
    ['shirtPattern', SHIRT_PATTERN_OPTIONS],
  ];
  for (const [slot, options] of slots) {
    it(`renders every ${slot} option distinctly`, () => {
      const seen = new Map<string, string>();
      for (const option of options) {
        const markup = staticMarkup({ ...fixed, [slot]: option });
        for (const [prevOption, prevMarkup] of seen) {
          expect(
            markup === prevMarkup,
            `${slot}=${option} renders identically to ${slot}=${prevOption}`,
          ).toBe(false);
        }
        seen.set(String(option), markup);
      }
    });
  }

  it('hides hair-zone accessories while a hat is worn, shows them bareheaded', () => {
    for (const acc of ['flower', 'hairclip', 'headband', 'feather', 'pencil', 'ribbon'] as const) {
      const hattedWith = staticMarkup({ ...fixed, hat: 'cap', accessory: acc });
      const hattedWithout = staticMarkup({ ...fixed, hat: 'cap', accessory: null });
      expect(hattedWith, `${acc} should hide under a hat`).toBe(hattedWithout);
      const bareWith = staticMarkup({ ...fixed, hat: null, accessory: acc });
      const bareWithout = staticMarkup({ ...fixed, hat: null, accessory: null });
      expect(bareWith, `${acc} should render bareheaded`).not.toBe(bareWithout);
    }
  });

  it('renders one stud per single-ear option and two for earrings', () => {
    const studsIn = (markup: string) =>
      (markup.match(/fill="rgba\(245,200,80,0\.95\)"/g) ?? []).length;
    expect(studsIn(staticMarkup({ ...fixed, accessory: 'earrings' }))).toBe(2);
    expect(studsIn(staticMarkup({ ...fixed, accessory: 'earring-left' }))).toBe(1);
    expect(studsIn(staticMarkup({ ...fixed, accessory: 'earring-right' }))).toBe(1);
    expect(staticMarkup({ ...fixed, accessory: 'earring-left' })).not.toBe(
      staticMarkup({ ...fixed, accessory: 'earring-right' }),
    );
  });

  it('gives two gezellen with identical catalog slots different faces', () => {
    // Same struct, different key: the key hash drives eye spacing, mouth
    // width, and blush, so visually the two are still individuals. Grain
    // is disabled to prove the difference is face geometry, not noise.
    const alpha = staticMarkup({ ...fixed, key: 'alpha' }, { grainStyle: 'none', whorls: 0 });
    const beta = staticMarkup({ ...fixed, key: 'beta' }, { grainStyle: 'none', whorls: 0 });
    expect(alpha).not.toBe(beta);
  });

  it('keeps the same face for the same key across rerolled outfits', () => {
    // Reroll changes slots but pins the key — the face must not drift.
    const eyes = (markup: string) =>
      [...markup.matchAll(/<circle cx="(-?[\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="#1a1410"/g)]
        .map((m) => m.slice(1).join(','))
        .slice(0, 2);
    const a = staticMarkup({ ...fixed, key: 'imara' }, { grainStyle: 'none', whorls: 0 });
    const b = staticMarkup(
      { ...fixed, key: 'imara', hat: 'straw', shirtPattern: 'stripes' },
      { grainStyle: 'none', whorls: 0 },
    );
    expect(eyes(a)).toEqual(eyes(b));
    expect(eyes(a)).toHaveLength(2);
  });
});
