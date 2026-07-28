import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { MINIMAL_CONTEXT_MAX_WINDOW } from '../model-profile/behaviors/prompt-minimal-context.js';
import { type BuildInstructionsOptions, buildInstructions } from './manager.js';

/**
 * `prompt.minimal-context` fixes the "can't even say hi" failure on a 2K
 * model: the standing prompt (guardrail + about + project + conduct core +
 * tools block) overflowed the window before the first token. In minimal
 * mode buildInstructions must return ONLY header + capped about + a short
 * conduct line, dropping every other layer.
 */
describe('buildInstructions — minimal-context mode', () => {
  const project = {
    id: 'p1',
    name: 'Some Work Project',
    mode: 'scaffold',
    about: 'A long project brief. '.repeat(50),
    missionObjectives: 'Ship the thing. '.repeat(20),
  } as unknown as ProjectDetail;

  const opts = {
    name: 'Liesel',
    role: 'writer',
    about: 'You are Liesel, a writer with a warm 1930s voice.',
    project,
    workspaceFiles: ['a.ts', 'b.ts', 'c.ts'],
    availableTools: [
      { name: 'write_file', description: 'Write a workspace file.' },
      { name: 'search_code', description: 'Search the codebase.' },
    ],
  } as unknown as BuildInstructionsOptions;

  it('keeps the header and the about body', () => {
    const { full } = buildInstructions({ ...opts, minimalContext: true });
    expect(full).toContain('You are acting as the agent "Liesel".');
    expect(full).toContain('warm 1930s voice');
  });

  it('drops project context, tools block, and the full conduct core', () => {
    const { full } = buildInstructions({ ...opts, minimalContext: true });
    expect(full).not.toContain('Some Work Project');
    expect(full).not.toMatch(/Mission objectives/i);
    expect(full).not.toMatch(/Tools available this turn/i);
    expect(full).not.toMatch(/ask_user_question/i);
    expect(full).not.toMatch(/Workspace files/i);
  });

  it('emits the no-tools conversational steer', () => {
    const { full } = buildInstructions({ ...opts, minimalContext: true });
    expect(full).toMatch(/no tools and no workspace/i);
    expect(full).toMatch(/just converse/i);
  });

  it('is dramatically smaller than the standard prompt', () => {
    const minimal = buildInstructions({ ...opts, minimalContext: true }).full;
    const standard = buildInstructions({ ...opts, minimalContext: false }).full;
    expect(minimal.length).toBeLessThan(standard.length);
    // Comfortably under a 2K window at ~4 chars/token (~512 tok ≈ 2048 ch).
    expect(minimal.length).toBeLessThan(2048);
  });

  it('caps a long about body with a visible marker', () => {
    const longAbout = 'Liesel writes in a vintage register. '.repeat(80);
    const { full } = buildInstructions({ ...opts, about: longAbout, minimalContext: true });
    expect(full).toContain('condensed to fit');
    expect(full.length).toBeLessThan(2048);
  });

  it('is byte-identical to the normal build when the flag is off', () => {
    const off = buildInstructions({ ...opts, minimalContext: false }).full;
    const absent = buildInstructions(opts).full;
    expect(off).toBe(absent);
  });

  it('exposes a sane auto-activation threshold', () => {
    expect(MINIMAL_CONTEXT_MAX_WINDOW).toBeGreaterThanOrEqual(2048);
    expect(MINIMAL_CONTEXT_MAX_WINDOW).toBeLessThan(8192);
  });
});
