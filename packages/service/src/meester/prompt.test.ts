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
    // Gilde 0.1.13 predates the single-project-kickoff surface. Normalize
    // only those two legacy sentences so every other catalog change still
    // has to be mirrored here. Once gilde publishes the new wording these
    // replacements become harmless no-ops.
    const projectOnlyCatalogAbout = catalogAbout
      .replace(
        'One macro call per deliverable: a crew with a lead for substantive builds, a single specialist when the user scopes the job to one pair of hands ("quick prototype", "just for me", "single file").',
        'One project kickoff per deliverable. The runtime assigns the appropriate lead or team for the effective execution mode.',
      )
      .replace(
        'a second job for the same deliverable creates racing writers, and reading a file is a question for the existing assignee, not a new job.',
        'a second project for the same deliverable creates racing writers, and reading a file is a question for the existing assignee, not a new project.',
      );
    expect(projectOnlyCatalogAbout.trim()).toBe(MEESTER_ABOUT_MD.trim());
  });
});
