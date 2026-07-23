/**
 * Contract test: the latest Voorman + Reviewer about.md prompts must
 * agree on the verification-format markers. The Voorman's about tells
 * it to "consult a Reviewer and copy their verification text close to
 * verbatim into `set_task_status`"; the Reviewer's about tells it to
 * end its reply with either `Verification: ship it.` or
 * `Recommendation: address the gaps above before closing.` — and to
 * structure each per-objective line as `- Objective N (<label>):
 * met|UNMET — <evidence>.`
 *
 * If either side drifts (e.g. Reviewer's reply shape changes but the
 * Voorman's about still tells it to look for the old marker), the two
 * roles silently miscoordinate. This test catches that — runs against
 * the latest version of each template under `data/gezel-templates`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

const templatesRoot = join(gildeDataDir(), 'gezel-templates');

async function readLatestAbout(shard: string, id: string): Promise<string> {
  const versionsDir = join(templatesRoot, shard, id, 'versions');
  const versions = (await readdir(versionsDir)).sort().reverse(); // newest first via lex sort
  const latest = versions[0];
  if (!latest) throw new Error(`no versions found for ${id}`);
  return readFile(join(versionsDir, latest, 'about.md'), 'utf8');
}

describe('Voorman / Reviewer contract', () => {
  it('Meester keeps repo intake fetch-first (an empty project cannot be reviewed)', async () => {
    // diet: the fetch_repo/fetch_diff call mechanics moved to
    // the tool descriptions + build prelude; the about keeps the intent.
    const meester = await readLatestAbout('me', 'meester');
    expect(meester).toContain('fetch the source into the project first');
    expect(meester).toContain('cannot be reviewed');
  });

  it('Voorman about ties a reviewer check to the closing checklist', async () => {
    const voorman = await readLatestAbout('vo', 'voorman');
    // Intent-level since the diet: the literal
    // ask_specialist({ role: "reviewer" }) shape was actively stale —
    // under the universal `tools.gezels-as-roles` default the surviving
    // dispatcher is consult_reviewer, so the about names the ROLE and
    // lets the schema carry the call.
    expect(voorman).toMatch(/have a reviewer check/i);
    // And the consult must be tied to the closing checklist.
    expect(voorman.toLowerCase()).toContain('before you close a task');
  });

  it('Reviewer about ends replies with the contract markers the Voorman expects', async () => {
    const reviewer = await readLatestAbout('re', 'reviewer');
    // Both reply shapes the Voorman pattern-matches must be defined.
    expect(reviewer).toContain('Verification: ship it.');
    expect(reviewer).toContain('Recommendation: address the gaps above before closing.');
  });

  it('Both prompts agree that the Reviewer text feeds the close verification', async () => {
    const voorman = await readLatestAbout('vo', 'voorman');
    const reviewer = await readLatestAbout('re', 'reviewer');
    // Voorman side: use the Reviewer's verdict as the verification.
    expect(voorman).toContain('verification');
    expect(voorman).toMatch(/reviewer.*verification/is);
    // Reviewer side: knows its reply IS the verification text (the
    // set_task_status destination is carried by the voorman's tooling,
    // not re-stated here since the diet).
    expect(reviewer).toMatch(/reply becomes the verification/i);
  });

  it('Voorman about.md has the closing checklist near the top (matrix #7 finding: buried sections do not fire)', async () => {
    const voorman = await readLatestAbout('vo', 'voorman');
    // Sections are h2-prefixed (##). Find the section ordering.
    const headings = voorman.match(/^## .+$/gm) ?? [];
    expect(headings.length).toBeGreaterThan(1);
    const beforeCloseIdx = headings.findIndex((h) => /before you close/i.test(h));
    expect(beforeCloseIdx).toBeGreaterThanOrEqual(0);
    // Must be among the first 3 sections — empirically the matrix #7 trial
    // showed the model doesn't reliably re-read sections buried below
    // the working-style + delivery procedural content.
    expect(beforeCloseIdx).toBeLessThan(3);
  });

  it('Voorman about does not instruct direct workspace writes', async () => {
    const voorman = await readLatestAbout('vo', 'voorman');
    expect(voorman).not.toContain('writeFile');
    expect(voorman).not.toMatch(/write (?:the )?file directly/i);
    expect(voorman).toContain('Single-file deliverables: one direct handoff');
    expect(voorman).toContain('Your deliverable is the brief, not the artifact');
  });

  it('Reviewer about tells the model to run `validate` on each shipping file', async () => {
    // `validate` stays named despite the no-tool-enumeration diet: it is
    // in SELF_CHECK_TOOL_CAP_ALWAYS_KEEP, so the drift risk the style
    // guide protects against cannot apply to it.
    const reviewer = await readLatestAbout('re', 'reviewer');
    expect(reviewer).toMatch(/`validate`/);
  });
});
