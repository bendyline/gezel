import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { type LanguageProfile, detectAndPersistProjectType, scoreProjectTypes } from './detect.js';

function profile(
  extensions: Record<string, number>,
  modalities: Record<string, number> = {},
): LanguageProfile {
  const fileCount = Object.values(extensions).reduce((a, b) => a + b, 0);
  return { fileCount, extensions, modalities };
}

describe('scoreProjectTypes', () => {
  it('classifies an HTML/canvas game with a game-y about as browser-game', () => {
    const ranked = scoreProjectTypes({
      profile: profile({ html: 1, js: 2, css: 1 }),
      aboutText: 'Space Shooter Arcade — a game where the player shoots enemies to score points.',
    });
    expect(ranked[0]?.id).toBe('browser-game');
    expect(ranked[0]!.score).toBeGreaterThan(ranked.find((r) => r.id === 'web-app')!.score);
  });

  it('uses keywords to disambiguate shared extensions (api-service over library)', () => {
    const ranked = scoreProjectTypes({
      profile: profile({ ts: 8, js: 2 }),
      aboutText: 'A REST API backend with database-backed endpoints and webhooks.',
    });
    expect(ranked[0]?.id).toBe('api-service');
  });

  it('detects a data project from notebooks/CSV plus analysis keywords', () => {
    const ranked = scoreProjectTypes({
      profile: profile({ ipynb: 2, csv: 3, py: 1 }),
      aboutText: 'Analysis of a sales dataset: charts, statistics, and a metrics report.',
    });
    expect(ranked[0]?.id).toBe('data-analysis');
  });

  it('falls back to keyword signal when there is no index yet', () => {
    const ranked = scoreProjectTypes({
      profile: null,
      aboutText: 'A blog and marketing website with a landing page and SEO copy.',
    });
    expect(ranked[0]?.id).toBe('static-site');
  });

  it('returns nothing when there are no signals at all', () => {
    expect(scoreProjectTypes({ profile: null, aboutText: '' })).toEqual([]);
  });

  it('ranks deterministically (stable id tiebreak)', () => {
    const a = scoreProjectTypes({ profile: profile({ html: 1 }), aboutText: '' });
    const b = scoreProjectTypes({ profile: profile({ html: 1 }), aboutText: '' });
    expect(a).toEqual(b);
  });
});

// Default holds a bit of every kind of work; a detected type there titled its
// recipe shelf "Recommended for Email / Inbox" and gave it an envelope.
describe('detectAndPersistProjectType', () => {
  it('never types Default, and clears a detection left there', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-detect-'));
    try {
      const store = new Store({ home });
      await store.ensureDefaultProject();
      await store.updateProject('default', {
        detectedProjectType: { id: 'email', score: 9, scannedAt: '2026-09-28T00:00:00.000Z' },
      });
      await store.writeProjectDoc('default', 'about.md', 'Triage the inbox and reply to email.');

      await expect(detectAndPersistProjectType({ store }, 'default')).resolves.toBeNull();
      expect((await store.getProject('default'))?.detectedProjectType).toBeUndefined();

      const mail = await store.createProject({ name: 'Mail' });
      await store.writeProjectDoc(mail.id, 'about.md', 'Triage the inbox and reply to email.');
      await detectAndPersistProjectType({ store }, mail.id);
      expect((await store.getProject(mail.id))?.detectedProjectType?.id).toBe('email');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
