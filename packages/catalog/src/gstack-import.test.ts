import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CraftbookDoc, CraftbookDocSchema, serializeCraftbookDoc } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';
import {
  GSTACK_BASED_ON,
  type Overlay,
  VERSION,
  WAVE,
  applyOverlay,
  convertSnapshotSkill,
} from './gstack-import.js';
import { CAREFUL_MODE, FREEZE_SCOPE } from './guardrail-books.js';

/**
 * Regen fidelity for the shipped skill conversions: a fresh run of the
 * deterministic converter + overlays over the committed snapshot must
 * reproduce the committed data bytes exactly. Fails when someone edits
 * a generated book by hand (edit the overlay or freeze it instead),
 * when the snapshot changes without a regen, or when the converter's
 * output drifts.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = join(gildeDataDir(), 'craftbook-templates');
const snapshotRoot = join(here, '..', 'scripts', 'gstack-skills');

function readOverlayFixture(source: string): Overlay {
  try {
    return JSON.parse(
      readFileSync(join(here, '..', 'scripts', 'gstack-overlays', `${source}.json`), 'utf8'),
    ) as Overlay;
  } catch {
    return {};
  }
}

function committedBytes(id: string): string {
  return readFileSync(
    join(dataRoot, id.slice(0, 2).toLowerCase(), id, 'versions', VERSION, 'craftbook.json'),
    'utf8',
  );
}

describe('shipped skill conversions — regen fidelity', () => {
  for (const book of WAVE) {
    it(`${book.id}: committed bytes match a fresh conversion`, async () => {
      const overlay = readOverlayFixture(book.source);
      if (overlay.frozen) return; // hand-owned — regen deliberately skips it
      const raw = readFileSync(join(snapshotRoot, book.source, 'SKILL.md'), 'utf8');
      const { doc } = convertSnapshotSkill(book, raw, overlay);
      expect(serializeCraftbookDoc(doc, 'json')).toBe(committedBytes(book.id));
    });
  }

  it('shipped conversions credit gstack without leaking source branding into their content', () => {
    for (const book of WAVE) {
      const parsed = CraftbookDocSchema.parse(JSON.parse(committedBytes(book.id)));
      expect(parsed.basedOn).toEqual(GSTACK_BASED_ON);
      const { basedOn: _basedOn, ...content } = parsed;
      const contentBytes = JSON.stringify(content).toLowerCase();
      expect(contentBytes, `${book.id} names gstack outside basedOn`).not.toContain('gstack');
      expect(contentBytes, `${book.id} names gbrain`).not.toContain('gbrain');
      expect(contentBytes).not.toContain('converted from');
    }
  });

  it('guardrail books match their writer definitions byte-for-byte', () => {
    for (const doc of [CAREFUL_MODE, FREEZE_SCOPE]) {
      const parsed = CraftbookDocSchema.parse(doc);
      expect(parsed.basedOn).toEqual(GSTACK_BASED_ON);
      expect(serializeCraftbookDoc(parsed, 'json')).toBe(committedBytes(parsed.id!));
    }
  });
});

describe('applyOverlay', () => {
  const base: CraftbookDoc = CraftbookDocSchema.parse({
    id: 'gs-demo',
    name: 'Demo',
    plan: 'Original plan.',
    steps: [
      { id: 'a', name: 'A', next: 'b' },
      { id: 'b', name: 'B', terminal: true },
    ],
    scripts: { keeper: 'export const meta = 1;' },
  });

  it('set replaces fields shallowly and planAppend extends the plan', () => {
    const out = applyOverlay(base, {
      set: { name: 'Renamed' },
      planAppend: 'Appended guidance.',
    });
    expect(out.name).toBe('Renamed');
    expect(out.plan).toBe('Original plan.\n\nAppended guidance.');
  });

  it('planAppend on a plan-less doc becomes the plan', () => {
    const { plan: _plan, ...noPlanRaw } = base;
    const noPlan = CraftbookDocSchema.parse(noPlanRaw);
    const out = applyOverlay(noPlan, { planAppend: 'Only guidance.' });
    expect(out.plan).toBe('Only guidance.');
  });

  it('steps patch by id and null removes a step; scripts null removes an entry', () => {
    const out = applyOverlay(
      CraftbookDocSchema.parse({
        ...base,
        steps: [
          { id: 'a', name: 'A', next: 'b' },
          { id: 'b', name: 'B', next: 'c' },
          { id: 'c', name: 'C', terminal: true },
        ],
      }),
      {
        steps: { b: { prompt: 'patched' }, c: null },
        scripts: { keeper: null, added: 'export const meta = 2;' },
      },
    );
    expect(out.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out.steps[1]!.prompt).toBe('patched');
    expect(Object.keys(out.scripts ?? {})).toEqual(['added']);
  });
});
