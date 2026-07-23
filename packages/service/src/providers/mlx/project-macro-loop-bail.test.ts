import { describe, expect, it } from 'vitest';
import {
  PROJECT_MACRO_INTERCEPT_CAP,
  deriveProjectMacroClosing,
} from './project-macro-loop-bail.js';

describe('deriveProjectMacroClosing', () => {
  it('parses a start_project success result into a voorman closing', () => {
    const firstResult =
      'Started project "Ikari Warriors Style Shooter" (ikari-warriors-style-shooter). Recruited Vivian as voorman. Created task ikari-warriors-style-shooter/1 ("Build Ikari Warriors Style Shooter"). Vivian is on it — their reply will land in your next turn. Tell the user Vivian is starting on the Ikari Warriors Style Shooter project; the user can watch the work surface in this thread.';
    const closing = deriveProjectMacroClosing(firstResult);
    expect(closing).toContain('Ikari Warriors Style Shooter');
    expect(closing).toContain('Vivian');
    expect(closing).toContain('leading the crew');
    expect(closing).toContain('this thread');
  });

  it('parses a start_job success result into an ambachtsman closing', () => {
    const firstResult =
      'Started job "Logo Iteration" (logo-iteration). Recruited Maya as ambachtsman (template: designer). Created task logo-iteration/1 ("Build Logo Iteration"). Maya is on it — their reply will land in your next turn.';
    const closing = deriveProjectMacroClosing(firstResult);
    expect(closing).toContain('Logo Iteration');
    expect(closing).toContain('Maya');
    // Jobs don't say "crew" — single specialist, no team to lead.
    expect(closing).not.toContain('crew');
  });

  it('falls back gracefully when the result text shape is unexpected', () => {
    const closing = deriveProjectMacroClosing(
      'unexpected: project succeeded but the result text was reformatted',
    );
    expect(closing).toContain('kickoff is on it');
    expect(closing.length).toBeGreaterThan(0);
  });

  it('falls back when only the project name is parseable (lead extraction failed)', () => {
    const closing = deriveProjectMacroClosing('Started project "Half Parsed". (no recruit line)');
    expect(closing).toContain('Half Parsed');
    expect(closing).toContain('taking it from here');
  });

  it('never returns an empty string — synthetic closing is always user-facing', () => {
    for (const input of ['', '   ', 'garbage', 'Started project no quotes here']) {
      const closing = deriveProjectMacroClosing(input);
      expect(closing.length).toBeGreaterThan(0);
    }
  });
});

describe('PROJECT_MACRO_INTERCEPT_CAP', () => {
  it('is small enough to bound the user-visible wait', () => {
    // 2 redundant attempts past the first success = 3 total macro
    // calls in one turn before the runtime steps in. Each MLX
    // stream takes ~10–15s on gemma4-26b, so the wait stays under
    // a minute even when the cap is hit. If this bumps higher, the
    // user-facing latency starts to feel broken.
    expect(PROJECT_MACRO_INTERCEPT_CAP).toBeLessThanOrEqual(3);
    expect(PROJECT_MACRO_INTERCEPT_CAP).toBeGreaterThanOrEqual(1);
  });
});
