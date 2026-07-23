import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { craftbookFromDoc, serializeCraftbookDoc } from '../craftbook-doc.js';
import { parseSkillDoc } from './skill-doc.js';
import { skillToCraftbookDoc } from './to-craftbook.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__', import.meta.url));
const read = (rel: string) => readFileSync(join(FIXTURES, rel), 'utf8');

function convertFixture(rel: string, fallbackName: string, sourcePath?: string) {
  const skill = parseSkillDoc(read(rel), { fallbackName });
  return skillToCraftbookDoc(skill, {
    idPrefix: 'proj-skill-',
    ...(sourcePath ? { sourcePath } : {}),
  });
}

describe('skillToCraftbookDoc', () => {
  it('converts investigate into a five-step linear book', () => {
    const { doc, persona } = convertFixture(
      'gstack/investigate/SKILL.md',
      'investigate',
      '.gstack/skills/investigate/SKILL.md',
    );
    expect(doc.id).toBe('proj-skill-investigate');
    expect(doc.name).toBe('Systematic Debugging');
    expect(doc.steps.map((s) => s.id)).toEqual([
      'phase-1',
      'phase-2',
      'phase-3',
      'phase-4',
      'phase-5',
    ]);
    for (let i = 0; i < 4; i++) {
      expect((doc.steps[i] as { next?: string }).next).toBe(doc.steps[i + 1]!.id);
    }
    expect((doc.steps[4] as { terminal?: boolean }).terminal).toBe(true);
    expect(doc.entryStepId).toBe('phase-1');
    // Provenance rides in the description.
    expect(doc.description).toContain('.gstack/skills/investigate/SKILL.md');
    // Round-trip validity: the doc expands into a runtime craftbook.
    const book = craftbookFromDoc(doc, { now: '2026-01-01T00:00:00Z' });
    expect(book.ok).toBe(true);
    void persona;
  });

  it('converts office-hours with persona detection and phase ordinals', () => {
    const { doc, persona } = convertFixture('gstack/office-hours/SKILL.md', 'office-hours');
    expect(doc.steps.length).toBeGreaterThanOrEqual(9);
    expect(doc.steps.map((s) => s.id)).toContain('phase-2a');
    expect(doc.steps.map((s) => s.id)).toContain('phase-2-75');
    expect(persona?.role.toLowerCase()).toContain('office hours partner');
    expect(persona?.about).toContain('## Identity');
    // Persona stamps a suggestedRole on every step.
    for (const step of doc.steps) {
      expect((step as { suggestedRole?: string }).suggestedRole).toBe(persona!.role);
    }
    expect(doc.triggers).toContain('office hours');
    const book = craftbookFromDoc(doc, { now: '2026-01-01T00:00:00Z' });
    expect(book.ok).toBe(true);
  });

  it('converts careful as a single-step book with an honest notes ledger', () => {
    const result = convertFixture('gstack/careful/SKILL.md', 'careful');
    expect(result.doc.steps).toHaveLength(1);
    expect(result.doc.steps[0]!.id).toBe('run');
    expect((result.doc.steps[0] as { terminal?: boolean }).terminal).toBe(true);
    expect(result.notes.some((n) => n.includes('hook declaration'))).toBe(true);
    expect(result.notes.some((n) => n.includes('allowed-tools'))).toBe(true);
    // The telemetry fence was dropped pre-conversion, so no scripts and no
    // untranslated blocks come out of this skill.
    expect(result.scripts).toHaveLength(0);
    expect(result.untranslated).toHaveLength(0);
    const book = craftbookFromDoc(result.doc, { now: '2026-01-01T00:00:00Z' });
    expect(book.ok).toBe(true);
  });

  it('is byte-deterministic', () => {
    const first = convertFixture('gstack/investigate/SKILL.md', 'investigate');
    const second = convertFixture('gstack/investigate/SKILL.md', 'investigate');
    expect(serializeCraftbookDoc(first.doc, 'json')).toBe(
      serializeCraftbookDoc(second.doc, 'json'),
    );
  });

  it('pins the careful conversion output (byte snapshot)', () => {
    const { doc } = convertFixture(
      'gstack/careful/SKILL.md',
      'careful',
      '.claude/skills/careful/SKILL.md',
    );
    expect(serializeCraftbookDoc(doc, 'json')).toMatchSnapshot();
  });

  it('converts a minimal hand-authored skill single-step with no notes noise', () => {
    const result = convertFixture('claude/minimal/SKILL.md', 'minimal');
    expect(result.doc.name).toBe('Tidy Notes');
    expect(result.doc.steps).toHaveLength(1);
    expect(result.doc.steps[0]!.prompt).toContain('## Style');
    expect(result.notes).toHaveLength(0);
    expect(result.persona).toBeUndefined();
  });

  it('derives a terminal deliverable only from an imperative backticked-path bullet', () => {
    const skill = parseSkillDoc(
      [
        '# Report Builder',
        '',
        '## Phase 1: Gather',
        '',
        'Collect the inputs.',
        '',
        '## Phase 2: Write',
        '',
        '- Write the final report to `out/report.md` when done.',
      ].join('\n'),
      { fallbackName: 'report-builder' },
    );
    const { doc } = skillToCraftbookDoc(skill);
    const terminal = doc.steps[doc.steps.length - 1] as { deliverable?: { path: string } };
    expect(terminal.deliverable).toEqual({ path: 'out/report.md' });
    const book = craftbookFromDoc(doc, { now: '2026-01-01T00:00:00Z' });
    expect(book.ok).toBe(true);
  });

  it('attaches statically-transpiled shell blocks to their step', () => {
    const skill = parseSkillDoc(
      [
        '# Checker',
        '',
        '## Phase 1: Lint',
        '',
        '```bash',
        'npm run lint',
        '```',
        '',
        '## Phase 2: Verify',
        '',
        '```bash',
        'git status',
        '```',
        '',
        'Read the output.',
      ].join('\n'),
      { fallbackName: 'checker' },
    );
    const result = skillToCraftbookDoc(skill);
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]!.stepId).toBe('phase-1');
    expect(result.doc.scripts?.[result.scripts[0]!.name]).toContain('run_package_script');
    const phase1 = result.doc.steps[0] as { onExit?: Array<{ name: string; scope: string }> };
    expect(phase1.onExit?.[0]?.name).toBe(result.scripts[0]!.name);
    // git status is not statically expressible → stays prose, noted.
    expect(result.untranslated).toHaveLength(1);
    expect(result.untranslated[0]!.stepId).toBe('phase-2');
    expect(result.notes.some((n) => n.includes('kept as prose'))).toBe(true);
    const book = craftbookFromDoc(result.doc, { now: '2026-01-01T00:00:00Z' });
    expect(book.ok).toBe(true);
  });
});
