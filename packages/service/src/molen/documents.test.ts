import {
  MOLEN_FILM_PRIMER,
  MOLEN_GAME_PRIMER,
  MOLEN_SCENE_PRIMER,
  MolenCheckResponseSchema,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  MOLEN_CHECK_UNAVAILABLE,
  checkMolenDocument,
  loadMolenStage,
  useMolenStageForTests,
} from './documents.js';

// @bendyline/molen-stage is optional until its first npm release (pnpm link:molen).
const installed = (await loadMolenStage()) !== null;

const film = {
  format: 'molen/film@1',
  name: 'Dusk',
  look: 'evening',
  set: { props: [{ id: 'bench', shape: 'bench', at: [0, 0] }] },
  cast: [
    { id: 'ana', preset: 'human.adult', at: [-5, 2] },
    { id: 'rex', preset: 'dog', at: [4, 1] },
  ],
  beats: [
    { at: 1, who: 'ana', do: 'walk-to', target: 'bench' },
    { at: 5, who: 'ana', do: 'sit', target: 'bench' },
  ],
  shots: [{ at: 0, kind: 'wide', on: ['ana', 'rex'] }],
};

const game = {
  format: 'molen/game@1',
  name: 'Seed Hunt',
  kind: 'top-down',
  layout: 'garden',
  pieces: {
    P: { role: 'player', figure: 'human.child' },
    o: { role: 'pickup', count: 4 },
    b: { role: 'hazard', shape: 'sphere', move: 'patrol', speed: 2 },
  },
  win: { collect: 'all' },
  lose: { lives: 3 },
};

/** The check, asserting it ran: these tests need the package. */
async function molenCheck(input: unknown) {
  const result = await checkMolenDocument(input);
  if (!result) throw new Error(MOLEN_CHECK_UNAVAILABLE);
  return result;
}

describe.runIf(installed)('checkMolenDocument', () => {
  it('compiles a film and a game and says what each is', async () => {
    const f = MolenCheckResponseSchema.parse(await checkMolenDocument(film));
    expect(f.ok).toBe(true);
    expect(f.kind).toBe('film');
    expect(f.summary).toMatch(/^a film "Dusk" [\d.]+ s long with 2 cast members and 1 prop$/);
    const g = MolenCheckResponseSchema.parse(await checkMolenDocument(JSON.stringify(game)));
    expect(g.ok).toBe(true);
    expect(g.summary).toMatch(/^a top-down game "Seed Hunt" on a level \d+ cells wide/);
  });

  it('validates a data-only scene, figures included', async () => {
    const r = await molenCheck({
      format: 'molen/scene@3',
      name: 'yard',
      seed: 'yard',
      tickRate: 30,
      entities: [
        {
          id: 'kid',
          components: {
            transform: { pos: [0, 0, 0] },
            renderable: { kind: 'figure' },
            figure: { preset: 'human.child' },
          },
        },
      ],
    });
    expect(r.ok, r.formatted).toBe(true);
    expect(r.summary).toBe('a data-only scene "yard" with 1 entity');
  });

  it('refuses a scene with scripts: nothing a gezel writes is run as code', async () => {
    const r = await molenCheck({
      format: 'molen/scene@3',
      name: 'trap',
      seed: 'trap',
      tickRate: 30,
      entities: [],
      scripts: [{ id: 'run', code: 'export default {}' }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['scripts_not_allowed']);
  });

  it('returns Molen’s issues with their paths and did-you-mean hints', async () => {
    const r = await molenCheck({
      ...film,
      beats: [{ at: 1, who: 'anna', do: 'walk-to', target: 'bench' }],
    });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('film');
    expect(r.issues[0]?.path).toBe('/beats/0/who');
    expect(r.formatted).toContain('did you mean "ana"?');
  });

  it('answers a document cut off mid-write instead of skipping it', async () => {
    const r = await molenCheck('{ "format": "molen/game@1", "name": "Half');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('game');
    expect(r.issues[0]?.code).toBe('invalid_json');
    expect(r.formatted).toContain('Write it again as one complete JSON object.');
  });

  it('names the formats it reads for anything else', async () => {
    const r = await molenCheck({ format: 'squisq/doc@1' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBeNull();
    expect(r.formatted).toContain('"molen/film@1", "molen/game@1", "molen/scene@3"');
  });
});

describe.runIf(installed)('the primer snapshot in core', () => {
  // Core carries a copy so it needs no Molen dependency. When this fails, run
  // `node scripts/snapshot-molen-primers.mjs` after moving the pin.
  it('matches the primers of the molen-stage the service installs', async () => {
    const specifier: string = '@bendyline/molen-stage';
    const stage = (await import(/* @vite-ignore */ specifier)) as Record<string, string>;
    expect(MOLEN_FILM_PRIMER).toBe(stage.filmPrimer);
    expect(MOLEN_GAME_PRIMER).toBe(stage.gamePrimer);
    expect(MOLEN_SCENE_PRIMER).toBe(stage.scenePrimer);
  });
});

describe('without @bendyline/molen-stage', () => {
  it('answers null, so each caller can say the check is unavailable', async () => {
    const restore = useMolenStageForTests(null);
    try {
      expect(await checkMolenDocument({ format: 'molen/film@1' })).toBeNull();
    } finally {
      restore();
    }
  });
});
