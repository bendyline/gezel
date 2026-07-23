import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { MEESTER_ABOUT_MD } from './prompt.js';

describe('MEESTER_ABOUT_MD', () => {
  it('keeps repo intake fetch-first (an empty project cannot be reviewed)', () => {
    expect(MEESTER_ABOUT_MD).toContain('fetch the source into the project first');
    expect(MEESTER_ABOUT_MD).toContain('an empty project cannot be reviewed');
  });

  it('enumerates no tool names (about.md is for character; schemas carry the tools)', () => {
    // The diet removed the start_project/start_job/fetch_repo
    // mechanics — the meester-build-prelude delivers those per-turn. A
    // backticked call shape reappearing here means the drift the style
    // guide warns about (AGENTS.md "about.md is for character") is back.
    expect(MEESTER_ABOUT_MD).not.toMatch(/`[a-z_]+\(/);
    expect(MEESTER_ABOUT_MD).not.toContain('start_project');
    expect(MEESTER_ABOUT_MD).not.toContain('fetch_repo');
    expect(MEESTER_ABOUT_MD).not.toContain('message_gezel');
  });

  it('stays in sync with the latest catalog meester template', () => {
    const versionsDir = join(gildeDataDir(), 'gezel-templates/me/meester/versions');
    const latest = readdirSync(versionsDir).sort().at(-1);
    expect(latest).toBeTruthy();
    const catalogAbout = readFileSync(join(versionsDir, latest ?? '', 'about.md'), 'utf8');
    expect(catalogAbout.trim()).toBe(MEESTER_ABOUT_MD.trim());
  });
});
