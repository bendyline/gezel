import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authoringNote } from './authoring-notes.js';
import { squisqAuthoringNote } from './squisq-dialect.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('authoringNote', () => {
  it('keeps the Squisq notes as they were', () => {
    expect(authoringNote('squisq')).toBe(squisqAuthoringNote('squisq'));
    expect(authoringNote('squisq-slideshow')).toBe(squisqAuthoringNote('squisq-slideshow'));
  });

  it('gives a Molen step its primer, asking for a file rather than a reply', () => {
    for (const [kind, title] of [
      ['molen-film', 'molen/film@1'],
      ['molen-game', 'molen/game@1'],
      ['molen-scene', 'molen/scene@3'],
    ] as const) {
      const note = authoringNote(kind);
      expect(note).toContain(title);
      expect(note).not.toContain('Reply with the JSON only');
      expect(note).toContain("in the file the step's procedure names");
      expect(note).toContain('never copy its story');
    }
  });

  it('teaches a game step the layout knobs', () => {
    const note = authoringNote('molen-game');
    for (const word of ['archetype', 'corridors', 'pillars', 'ledges', '"count"']) {
      expect(note).toContain(word);
    }
  });
});

describe('molen primer snapshot', () => {
  it('matches the primers Molen ships, when a source is at hand', () => {
    const script = join(repo, 'scripts/snapshot-molen-primers.mjs');
    let out: string;
    try {
      out = execFileSync(process.execPath, [script, '--check'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      // No installed package and no sibling checkout (CI before the pin lands): nothing to compare.
      if (stderr.includes('No @bendyline/molen-stage installed')) return;
      throw new Error(stderr);
    }
    expect(out).toContain('molen primers match');
  });
});
