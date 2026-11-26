import { describe, expect, it } from 'vitest';
import { loadMolenStage, useMolenStageForTests } from '../molen/documents.js';
import { type GateWorkspaceReader, evaluateGate } from './gate-eval.js';

// @bendyline/molen-stage is optional until its first npm release (pnpm link:molen).
const installed = (await loadMolenStage()) !== null;

const film = JSON.stringify({
  format: 'molen/film@1',
  name: 'Harbor',
  cast: [
    { id: 'ana', preset: 'human.adult', at: [-4, 0] },
    { id: 'ben', preset: 'human.adult', at: [4, 0] },
  ],
  beats: [{ at: 1, who: 'ana', do: 'walk-to', target: 'ben' }],
  shots: [{ at: 0, kind: 'wide', on: ['ana', 'ben'] }],
});

const reader = (
  workspace: Record<string, string>,
  artifacts: Record<string, string> = {},
): GateWorkspaceReader => ({
  read: async (f) => workspace[f] ?? null,
  list: async () => Object.keys(workspace),
  readArtifact: async (f) => artifacts[f] ?? null,
  listArtifacts: async () => Object.keys(artifacts),
});

describe.runIf(installed)('the molenDocument gate check', () => {
  it('passes a film that compiles and says what it is', async () => {
    const r = await evaluateGate(
      [{ kind: 'molenDocument', file: 'tasks/4/film.json', artifact: true, as: 'film' }],
      reader({}, { 'tasks/4/film.json': film }),
    );
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.detail).toMatch(/^tasks\/4\/film\.json plays: a film "Harbor" /);
  });

  it('fails with each issue on one line, path and hint included', async () => {
    const broken = film.replace('"who":"ana"', '"who":"anna"');
    const r = await evaluateGate(
      [{ kind: 'molenDocument', file: 'film.json' }],
      reader({ 'film.json': broken }),
    );
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toContain('film.json does not play yet: /beats/0/who: ');
    expect(r.failures[0]).toContain('did you mean "ana"?');
    expect(r.failures[0]).not.toContain('\n');
  });

  it('fails a document of the wrong kind', async () => {
    const r = await evaluateGate(
      [{ kind: 'molenDocument', file: 'film.json', as: 'game' }],
      reader({ 'film.json': film }),
    );
    expect(r.failures).toEqual([
      'film.json must be a Molen game document ("format": "molen/game@…"), but it is a film.',
    ]);
  });

  it('fails a missing file, reading the drawer the check names', async () => {
    const r = await evaluateGate(
      [{ kind: 'molenDocument', file: 'film.json', artifact: true }],
      reader({ 'film.json': film }),
    );
    expect(r.failures).toEqual(['film.json not found (needed for the Molen document check)']);
  });
});

describe('the molenDocument gate check without @bendyline/molen-stage', () => {
  it('fails, and says so, rather than pass a document nobody checked', async () => {
    const restore = useMolenStageForTests(null);
    try {
      const r = await evaluateGate(
        [{ kind: 'molenDocument', file: 'film.json' }],
        reader({ 'film.json': film }),
      );
      expect(r.pass).toBe(false);
      expect(r.failures).toEqual([
        'film.json: this install cannot check Molen documents: it does not include @bendyline/molen-stage, so this check cannot pass.',
      ]);
    } finally {
      restore();
    }
  });
});
