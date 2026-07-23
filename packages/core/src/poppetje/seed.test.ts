import { describe, expect, it } from 'vitest';
import { GROWTH_COSMETICS } from '../growth-cosmetics.js';
import {
  BODY_SHAPE_KEYS,
  EXPRESSION_OPTIONS,
  FACIAL_HAIR_OPTIONS,
  FIGURE_SCALE_KEYS,
  HAIR_SHAPES,
  MARK_OPTIONS,
  PALETTE,
  SHIRT_PATTERN_OPTIONS,
} from './catalogs.js';
import { PoppetjeSchema } from './schema.js';
import {
  ROLLABLE_ACCESSORIES,
  ROLLABLE_DRESSES,
  ROLLABLE_HATS,
  initialPoppetjeForGezel,
  poppetjeFromSeed,
  seedFromKey,
} from './seed.js';

describe('seedFromKey', () => {
  it('is stable for the same input', () => {
    expect(seedFromKey('imara')).toBe(seedFromKey('imara'));
    expect(seedFromKey('imara')).toBe(seedFromKey('imara'));
  });

  it('produces different values for different inputs', () => {
    const a = seedFromKey('imara');
    const b = seedFromKey('alejandro');
    expect(a).not.toBe(b);
  });

  it('stays in [0, 100)', () => {
    for (const key of ['a', 'imara', 'very-long-gezel-identifier-abc-123']) {
      const s = seedFromKey(key);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(100);
    }
  });

  it('handles empty input deterministically', () => {
    expect(typeof seedFromKey('')).toBe('number');
  });
});

describe('poppetjeFromSeed', () => {
  it('is deterministic for the same seed', () => {
    const a = poppetjeFromSeed(42);
    const b = poppetjeFromSeed(42);
    expect(a).toEqual(b);
  });

  it('produces different structs for different seeds', () => {
    const a = poppetjeFromSeed(1);
    const b = poppetjeFromSeed(2);
    // At least one slot should differ; testing all-equal would be a coincidence.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('emits only catalog-valid values for n=1..50', () => {
    const skinHexes = new Set<string>(PALETTE.skins.map((s) => s.skin));
    const shirtHexes = new Set<string>(PALETTE.shirts.map((s) => s.shirt));
    const accentHexes = new Set<string>(PALETTE.shirts.map((s) => s.accent));
    for (let n = 1; n <= 50; n++) {
      const p = poppetjeFromSeed(n);
      expect(BODY_SHAPE_KEYS).toContain(p.bodyShape);
      expect(HAIR_SHAPES).toContain(p.hairShape);
      expect(EXPRESSION_OPTIONS).toContain(p.expression);
      expect(skinHexes.has(p.skin)).toBe(true);
      expect(shirtHexes.has(p.shirt)).toBe(true);
      expect(accentHexes.has(p.shirtAccent)).toBe(true);
    }
  });

  it('passes the Zod schema', () => {
    for (let n = 1; n <= 12; n++) {
      const p = poppetjeFromSeed(n);
      expect(() => PoppetjeSchema.parse(p)).not.toThrow();
    }
  });

  it('respects the key + name options', () => {
    const p = poppetjeFromSeed(7, { key: 'imara', name: 'Imara' });
    expect(p.key).toBe('imara');
    expect(p.name).toBe('Imara');
  });

  it('hits each body archetype across a reasonable seed range', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 200; n++) {
      seen.add(poppetjeFromSeed(n).bodyShape);
    }
    for (const shape of BODY_SHAPE_KEYS) {
      expect(seen.has(shape)).toBe(true);
    }
  });

  it('never assigns beard or mustache when gender is female', () => {
    // Sweep 200 seeds — without the gate, facial hair would land ~18% of
    // the time. Facial hair now lives in its own slot, never `accessory`.
    for (let n = 0; n < 200; n++) {
      const p = poppetjeFromSeed(n, { gender: 'female' });
      expect(p.facialHair).toBeNull();
    }
  });

  it('does assign beard / mustache to male gezels across enough seeds', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 500; n++) {
      const a = poppetjeFromSeed(n, { gender: 'male' }).facialHair;
      if (a) seen.add(a);
    }
    expect(seen.has('beard')).toBe(true);
    expect(seen.has('mustache')).toBe(true);
  });

  it('treats non-binary and undefined gender as no facial-hair gate', () => {
    const nbSeen = new Set<string>();
    const undefSeen = new Set<string>();
    for (let n = 0; n < 500; n++) {
      const nb = poppetjeFromSeed(n, { gender: 'non-binary' }).facialHair;
      const un = poppetjeFromSeed(n).facialHair;
      if (nb) nbSeen.add(nb);
      if (un) undefSeen.add(un);
    }
    expect(nbSeen.has('beard') || nbSeen.has('mustache')).toBe(true);
    expect(undefSeen.has('beard') || undefSeen.has('mustache')).toBe(true);
  });
});

describe('catalog diversity', () => {
  // The generator must be able to produce EVERY look the renderer knows
  // how to draw — a slot that never rolls is dead catalog weight, and a
  // crowd of gezels should never converge on a handful of looks.
  it('reaches every option of every slot across 2000 seeds', () => {
    const seen = {
      bodyShape: new Set<string>(),
      figureScale: new Set<string>(),
      hairShape: new Set<string>(),
      hairColor: new Set<string>(),
      skin: new Set<string>(),
      shirt: new Set<string>(),
      shirtPattern: new Set<string>(),
      hat: new Set<string>(),
      dress: new Set<string>(),
      accessory: new Set<string>(),
      facialHair: new Set<string>(),
      mark: new Set<string>(),
      expression: new Set<string>(),
    };
    for (let n = 0; n < 2000; n++) {
      const p = poppetjeFromSeed(n);
      seen.bodyShape.add(p.bodyShape);
      seen.figureScale.add(p.figureScale);
      seen.hairShape.add(p.hairShape);
      seen.hairColor.add(p.hair);
      seen.skin.add(p.skin);
      seen.shirt.add(p.shirt);
      seen.shirtPattern.add(p.shirtPattern);
      if (p.hat) seen.hat.add(p.hat);
      if (p.dress) seen.dress.add(p.dress);
      if (p.accessory) seen.accessory.add(p.accessory);
      if (p.facialHair) seen.facialHair.add(p.facialHair);
      if (p.mark) seen.mark.add(p.mark);
      seen.expression.add(p.expression);
    }
    expect([...seen.bodyShape].sort()).toEqual([...BODY_SHAPE_KEYS].sort());
    expect([...seen.figureScale].sort()).toEqual([...FIGURE_SCALE_KEYS].sort());
    expect([...seen.hairShape].sort()).toEqual([...HAIR_SHAPES].sort());
    expect(seen.hairColor.size).toBe(PALETTE.hairs.length);
    expect(seen.skin.size).toBe(PALETTE.skins.length);
    expect(seen.shirt.size).toBe(PALETTE.shirts.length);
    expect([...seen.shirtPattern].sort()).toEqual([...SHIRT_PATTERN_OPTIONS].sort());
    // Growth cosmetics (Hood, Workshop apron, Monocle, …) are earned, never
    // rolled — the generator only reaches the un-gated pool of each slot.
    expect([...seen.hat].sort()).toEqual([...ROLLABLE_HATS].sort());
    expect([...seen.dress].sort()).toEqual([...ROLLABLE_DRESSES].sort());
    expect([...seen.accessory].sort()).toEqual([...ROLLABLE_ACCESSORIES].sort());
    expect([...seen.facialHair].sort()).toEqual([...FACIAL_HAIR_OPTIONS].sort());
    expect([...seen.mark].sort()).toEqual([...MARK_OPTIONS].sort());
    expect([...seen.expression].sort()).toEqual([...EXPRESSION_OPTIONS].sort());
  });

  it('never rolls a level-gated growth cosmetic', () => {
    // Regression: a gezel born (or rerolled) wearing e.g. the Lv-7 Hood can't
    // reselect it after clicking it off in the accessory dialog — it's gated
    // above its level. So the generator must never assign one in the first place.
    const gatedBySlot = {
      hat: GROWTH_COSMETICS.filter((c) => c.slot === 'hat').map((c) => c.option),
      dress: GROWTH_COSMETICS.filter((c) => c.slot === 'dress').map((c) => c.option),
      accessory: GROWTH_COSMETICS.filter((c) => c.slot === 'accessory').map((c) => c.option),
    };
    for (let n = 0; n < 4000; n++) {
      const p = poppetjeFromSeed(n);
      if (p.hat) expect(gatedBySlot.hat).not.toContain(p.hat);
      if (p.dress) expect(gatedBySlot.dress).not.toContain(p.dress);
      if (p.accessory) expect(gatedBySlot.accessory).not.toContain(p.accessory);
    }
  });

  it('rolls figure scales near their configured odds', () => {
    const counts: Record<string, number> = {};
    const N = 2000;
    for (let n = 0; n < N; n++) {
      const p = poppetjeFromSeed(n);
      counts[p.figureScale] = (counts[p.figureScale] ?? 0) + 1;
    }
    // Loose bands: catch a future hardcode (adult = 100%) or an inverted
    // roll, not hash-noise. Empirically: adult ~47%, shorter ~31%,
    // child ~15%, toddler ~7%.
    expect((counts.adult ?? 0) / N).toBeGreaterThan(0.38);
    expect((counts.adult ?? 0) / N).toBeLessThan(0.62);
    expect((counts.shorter ?? 0) / N).toBeGreaterThan(0.18);
    expect((counts.child ?? 0) / N).toBeGreaterThan(0.06);
    expect((counts.toddler ?? 0) / N).toBeGreaterThan(0.02);
    expect((counts.toddler ?? 0) / N).toBeLessThan(0.14);
  });

  it('keeps plain shirts common while most figures carry a pattern', () => {
    const counts: Record<string, number> = {};
    const N = 2000;
    for (let n = 0; n < N; n++) {
      const p = poppetjeFromSeed(n);
      counts[p.shirtPattern] = (counts[p.shirtPattern] ?? 0) + 1;
    }
    const plainShare = (counts.plain ?? 0) / N;
    expect(plainShare).toBeGreaterThan(0.24);
    expect(plainShare).toBeLessThan(0.46);
    for (const pattern of SHIRT_PATTERN_OPTIONS) {
      expect(counts[pattern] ?? 0).toBeGreaterThan(0);
    }
  });

  it('produces unique characters for 200 consecutive seeds', () => {
    const unique = new Set<string>();
    for (let n = 0; n < 200; n++) {
      const { key: _k, name: _n, ...slots } = poppetjeFromSeed(n);
      unique.add(JSON.stringify(slots));
    }
    // ~93M slot combinations; consecutive seeds colliding would mean the
    // hash mixing regressed. Allow a hair of slack so a deliberate catalog
    // shrink doesn't instantly break the test.
    expect(unique.size).toBeGreaterThanOrEqual(198);
  });
});

describe('accessory rarity weighting', () => {
  // Tally which accessory landed across a big seed sweep for a given gender.
  function accessoryCounts(gender?: NonNullable<Parameters<typeof poppetjeFromSeed>[1]>['gender']) {
    const counts: Record<string, number> = {};
    const N = 4000;
    for (let n = 0; n < N; n++) {
      const a = poppetjeFromSeed(n, gender ? { gender } : undefined).accessory;
      if (a) counts[a] = (counts[a] ?? 0) + 1;
    }
    return counts;
  }

  it('makes a rare accessory far rarer than plain glasses', () => {
    const counts = accessoryCounts();
    // The veryRare pieces (monocle, eyepatch) are level-gated and never roll,
    // so the rarest rollable accessory is a `rare` one like the bowtie.
    // Uniform picking gave bowtie ≈ glasses; `rare` (weight 2) vs `common`
    // (12) should land it well under a third as often.
    expect(counts.bowtie ?? 0).toBeLessThan((counts.glasses ?? 0) / 3);
  });

  it('keeps every rollable accessory reachable (no zero-weight option)', () => {
    const counts = accessoryCounts();
    for (const opt of ROLLABLE_ACCESSORIES) {
      expect(counts[opt] ?? 0).toBeGreaterThan(0);
    }
  });

  it('makes a single-side earring rarer for female than male gezels', () => {
    const female = accessoryCounts('female');
    const male = accessoryCounts('male');
    const femaleSingle = (female['earring-left'] ?? 0) + (female['earring-right'] ?? 0);
    const maleSingle = (male['earring-left'] ?? 0) + (male['earring-right'] ?? 0);
    expect(femaleSingle).toBeLessThan(maleSingle);
  });

  it('is deterministic for the same seed + gender', () => {
    expect(poppetjeFromSeed(42, { gender: 'female' }).accessory).toBe(
      poppetjeFromSeed(42, { gender: 'female' }).accessory,
    );
  });
});

describe('dress rarity weighting', () => {
  function dressCounts() {
    const counts: Record<string, number> = {};
    const N = 4000;
    for (let n = 0; n < N; n++) {
      const d = poppetjeFromSeed(n).dress;
      if (d) counts[d] = (counts[d] ?? 0) + 1;
    }
    return counts;
  }

  it('never rolls the workshop apron (it is level-gated)', () => {
    // The apron is the only non-common dress, and it's a growth cosmetic —
    // so the generator never assigns it and the remaining pool is uniform.
    const counts = dressCounts();
    expect(counts.apron ?? 0).toBe(0);
  });

  it('keeps every rollable dress reachable (no zero-weight option)', () => {
    const counts = dressCounts();
    for (const opt of ROLLABLE_DRESSES) {
      expect(counts[opt] ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('PoppetjeSchema shirtPattern back-compat', () => {
  it('defaults shirtPattern to plain for files written before patterns existed', () => {
    const { shirtPattern: _sp, ...legacy } = poppetjeFromSeed(7, { key: 'old', name: 'Old' });
    const parsed = PoppetjeSchema.parse(legacy);
    expect(parsed.shirtPattern).toBe('plain');
  });

  it('round-trips an explicit pattern', () => {
    const p = { ...poppetjeFromSeed(7), shirtPattern: 'stripes' as const };
    expect(PoppetjeSchema.parse(p).shirtPattern).toBe('stripes');
  });
});

describe('PoppetjeSchema legacy migration', () => {
  const base = poppetjeFromSeed(7, { key: 'legacy', name: 'Legacy' });

  it('moves a legacy accessory beard into facialHair', () => {
    const legacy = { ...base, accessory: 'beard', facialHair: undefined };
    const parsed = PoppetjeSchema.parse(legacy);
    expect(parsed.facialHair).toBe('beard');
    expect(parsed.accessory).toBeNull();
  });

  it('moves a legacy accessory freckles into mark', () => {
    const legacy = { ...base, accessory: 'freckles', mark: undefined };
    const parsed = PoppetjeSchema.parse(legacy);
    expect(parsed.mark).toBe('freckles');
    expect(parsed.accessory).toBeNull();
  });

  it('keeps a real wearable accessory untouched', () => {
    const parsed = PoppetjeSchema.parse({ ...base, accessory: 'glasses' });
    expect(parsed.accessory).toBe('glasses');
  });

  it('migrates the legacy single earring to earrings (both ears)', () => {
    const parsed = PoppetjeSchema.parse({ ...base, accessory: 'earring' });
    expect(parsed.accessory).toBe('earrings');
  });

  it('leaves the explicit earring sides untouched', () => {
    expect(PoppetjeSchema.parse({ ...base, accessory: 'earring-left' }).accessory).toBe(
      'earring-left',
    );
    expect(PoppetjeSchema.parse({ ...base, accessory: 'earring-right' }).accessory).toBe(
      'earring-right',
    );
  });

  it('does not clobber an existing mark when migrating a duplicate', () => {
    const legacy = { ...base, accessory: 'mole', mark: 'freckles' };
    const parsed = PoppetjeSchema.parse(legacy);
    expect(parsed.mark).toBe('freckles');
    expect(parsed.accessory).toBeNull();
  });
});

describe('initialPoppetjeForGezel', () => {
  it('is deterministic from the gezel id alone', () => {
    const a = initialPoppetjeForGezel('imara', 'Imara');
    const b = initialPoppetjeForGezel('imara', 'Imara');
    expect(a).toEqual(b);
  });

  it('pins the key to the gezel id (wood-grain anchor)', () => {
    const p = initialPoppetjeForGezel('alejandro', 'Alejandro');
    expect(p.key).toBe('alejandro');
  });

  it('survives a Zod parse', () => {
    const p = initialPoppetjeForGezel('luciana', 'Luciana');
    expect(() => PoppetjeSchema.parse(p)).not.toThrow();
  });

  it('produces distinct results for distinct ids', () => {
    const cast = ['imara', 'alejandro', 'luciana', 'farjana', 'bram', 'tomas'];
    const seen = new Set(cast.map((id) => JSON.stringify(initialPoppetjeForGezel(id, id))));
    expect(seen.size).toBe(cast.length);
  });

  // Regression: the hashed-id path is the ONLY place the seed-mixing bug
  // showed. `poppetjeFromSeed(n)` swept over small consecutive n (the rest of
  // this file) kept the float multiply exact and looked fine, while real
  // gezels — seeded from a 32-bit FNV hash of their id — collapsed skin onto
  // 2 of 8 tones, body onto 3 of 6, and mark/facial-hair onto a constant.
  // These guards seed from real-looking id slugs and demand an even spread.
  describe('feature distribution across a realistic id corpus', () => {
    // A broad, deliberately varied set of name-slugs (ids are `slugify(name)`).
    const ids = `ezekiel koray liesel manish michael nils owen sipho stanislav sumana trinh wren
      aaliyah abdul aditya ahmed aiko akira alejandro amara amir ana andre aneta anika anton
      arjun arun asha ayaan bao bilal bjorn boris camila carlos cato chen chloe cyrus dae
      dante deshawn dev diego dimitri ebele efe eitan elena eli emeka emre enzo esben esther
      fatima felipe finn frida gabriel gao georgi giulia hana hassan heidi hina hiro ibrahim
      idris ilya imani ines ingrid isabel ivan jamal jana javier jelena jian jin jonas jose
      juan kai kaito kamil karim kasper katarzyna keiko kenji khalid kiara kiran klara kofi
      kwame lars leila lena leon lin liu lucas ludmila luka mads magnus mai malik marek maria
      mateo mei mikael mira mohammed nadia nao naledi nasir nia niko nina nur olga omar oskar
      paavo pablo padma pavel pedro petra priya qasim rafael raj ramesh rania ravi raza rehan
      reza ricardo rin ryo sacha sadia salma samir sanne santiago sara satoshi selim sena
      shanti shreya sofia soren stella sven tadeusz takeshi tamar tariq thabo thandi thomas
      tobias tomas tove uma valentina vikram wei xochitl yara yasmin yohan yuki yusuf zainab
      zara zoltan aayan abena adaeze adebayo adrian agnes akosua alban aleksander amaru amos`
      .split(/\s+/)
      .filter(Boolean);

    const poppetjes = ids.map((id) => initialPoppetjeForGezel(id, id));

    // Chi-square against a uniform expectation. With ~180 samples the 95th
    // percentile for these small pools sits well under these thresholds; the
    // broken hash scored 200-650. Loose enough to never flake on hash noise,
    // tight enough to catch any bucket collapse.
    function expectEvenSpread(values: string[], pool: readonly string[], maxChi: number) {
      const counts = new Map<string, number>(pool.map((k) => [k, 0]));
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      // Every catalog value must be reachable — no dead buckets.
      for (const k of pool) expect(counts.get(k) ?? 0).toBeGreaterThan(0);
      const expected = values.length / pool.length;
      let chi = 0;
      for (const k of pool) {
        const c = counts.get(k) ?? 0;
        chi += ((c - expected) * (c - expected)) / expected;
      }
      expect(chi).toBeLessThan(maxChi);
    }

    it('spreads skin tones evenly (was: only 2 of 8 reachable)', () => {
      expectEvenSpread(
        poppetjes.map((p) => p.skin),
        PALETTE.skins.map((s) => s.skin),
        30,
      );
    });

    it('spreads body shapes evenly (was: only 3 of 6 reachable)', () => {
      expectEvenSpread(
        poppetjes.map((p) => p.bodyShape),
        BODY_SHAPE_KEYS,
        30,
      );
    });

    it('spreads shirt colors evenly', () => {
      expectEvenSpread(
        poppetjes.map((p) => p.shirt),
        PALETTE.shirts.map((s) => s.shirt),
        40,
      );
    });

    it('spreads hair colors and shapes evenly', () => {
      expectEvenSpread(
        poppetjes.map((p) => p.hair),
        PALETTE.hairs,
        30,
      );
      expectEvenSpread(
        poppetjes.map((p) => p.hairShape),
        HAIR_SHAPES,
        30,
      );
    });

    it('reaches both marks and both facial-hair options (was: pinned to one)', () => {
      // These 2-length pools are gated (facial hair by gender/odds, mark by
      // odds), so filter to the ones that actually rolled and assert both show.
      const marks = poppetjes.map((p) => p.mark).filter((m) => m != null);
      const facial = poppetjes.map((p) => p.facialHair).filter((f) => f != null);
      expect(new Set(marks)).toEqual(new Set(MARK_OPTIONS));
      expect(new Set(facial)).toEqual(new Set(FACIAL_HAIR_OPTIONS));
    });
  });
});
