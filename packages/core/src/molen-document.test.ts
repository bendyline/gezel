import { describe, expect, it } from 'vitest';
import {
  claimedMolenKind,
  molenCheckText,
  molenDocumentKind,
  molenNoticeLines,
} from './molen-document.js';
import { GateCheckSchema } from './schemas/gate.js';
import { MolenCheckResponseSchema } from './schemas/molen.js';
import { gateCheckLabel } from './tasks/gate-checks.js';

describe('recognizing a Molen document', () => {
  it('reads the kind from a parsed document of any version', () => {
    expect(molenDocumentKind({ format: 'molen/film@1' })).toBe('film');
    expect(molenDocumentKind({ format: 'molen/game@2' })).toBe('game');
    expect(molenDocumentKind({ format: 'molen/scene@3' })).toBe('scene');
    expect(molenDocumentKind({ format: 'molen/prefab@1' })).toBeNull();
    expect(molenDocumentKind([{ format: 'molen/film@1' }])).toBeNull();
    expect(molenDocumentKind('molen/film@1')).toBeNull();
  });

  it('reads the claimed kind from text that does not parse yet', () => {
    expect(claimedMolenKind('{ "format": "molen/film@1", "name": "Cut off')).toBe('film');
    expect(claimedMolenKind('{"format":"molen/scene@3"}')).toBe('scene');
    expect(claimedMolenKind('{ "format": "squisq/doc@1" }')).toBeNull();
    expect(claimedMolenKind('{ "title": "molen/film@1" }')).toBeNull();
  });
});

describe('what a model reads about a check', () => {
  const pass = MolenCheckResponseSchema.parse({
    ok: true,
    kind: 'film',
    summary: 'a film "Dusk" 8.0 s long with 2 cast members and 1 prop',
    issues: [],
    notices: [
      {
        path: '/shots/0',
        code: 'subject_hidden',
        message: 'in the wide shot at 0.0 s, "ana" is mostly hidden behind "house"',
      },
    ],
  });

  it('says what a document that plays is, and what is worth fixing', () => {
    expect(molenCheckText('film.json', pass, 'unused')).toBe(
      '[Molen check] film.json plays: a film "Dusk" 8.0 s long with 2 cast members and 1 prop.\nWorth fixing:\n- in the wide shot at 0.0 s, "ana" is mostly hidden behind "house"',
    );
  });

  it('gives Molen’s own issues and the repair the session can make', () => {
    const text = molenCheckText(
      'film.json',
      {
        ok: false,
        kind: 'film',
        issues: [{ path: '/beats/0/who', code: 'unknown_cast', message: 'no cast member "anna"' }],
        notices: [],
        formatted:
          '✖ film "Dusk" failed validation (1 issue)\n\n1. /beats/0/who\n   no cast member "anna"',
      },
      'Fix these with replace_in_file, or write the whole document again.',
    );
    expect(text).toBe(
      '[Molen check] film.json does not play yet:\n✖ film "Dusk" failed validation (1 issue)\n\n1. /beats/0/who\n   no cast member "anna"\nFix these with replace_in_file, or write the whole document again.',
    );
  });

  it('caps the notices it lists', () => {
    const notices = Array.from({ length: 7 }, (_, i) => ({
      path: `/shots/${i}`,
      code: 'subject_out_of_frame',
      message: `shot ${i}`,
    }));
    expect(molenNoticeLines(notices, 2)).toBe('- shot 0\n- shot 1\n- and 5 more');
    expect(molenNoticeLines([])).toBe('');
  });
});

describe('the molenDocument gate check', () => {
  it('parses with an optional kind and labels itself stably', () => {
    const check = GateCheckSchema.parse({
      kind: 'molenDocument',
      file: 'tasks/3/film.json',
      as: 'film',
      artifact: true,
    });
    expect(gateCheckLabel(check)).toBe('molenDocument tasks/3/film.json as=film');
    expect(() =>
      GateCheckSchema.parse({ kind: 'molenDocument', file: 'x.json', as: 'movie' }),
    ).toThrow();
  });
});
