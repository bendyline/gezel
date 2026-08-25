import { describe, expect, it } from 'vitest';
import { matchReferencedTasksInContent } from './task-references.js';

const KNOWN_REFS = [
  'gezel-ux-roadmap/1',
  'gezel-ux-roadmap/2',
  'atari-adventure-game/3',
  'galactic-war-game/12',
];

describe('matchReferencedTasksInContent', () => {
  it('matches a bare task ref in prose', () => {
    const text = 'I created task gezel-ux-roadmap/2 and assigned it to Maya.';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual(['gezel-ux-roadmap/2']);
  });

  it('matches task refs wrapped in inline backticks', () => {
    const text = 'See `gezel-ux-roadmap/2` for the design notes.';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual(['gezel-ux-roadmap/2']);
  });

  it('matches multiple task refs and returns sorted unique', () => {
    const text = `I created \`atari-adventure-game/3\` first, then gezel-ux-roadmap/1
and gezel-ux-roadmap/2 for the follow-up. Re-mention gezel-ux-roadmap/1
once more for emphasis.`;
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual([
      'atari-adventure-game/3',
      'gezel-ux-roadmap/1',
      'gezel-ux-roadmap/2',
    ]);
  });

  it('refuses unknown refs (not in the validated set)', () => {
    const text = 'Created phantom-project/99 and fake-task/1 — neither exist.';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual([]);
  });

  it('does not promote URL paths that look like refs', () => {
    // `repos/foo/bar/2` would naively match; but the project id has to
    // be a known ref, and this URL fragment isn't one — safety rail.
    const text = 'See https://github.com/owner/repo/issues/2 for context.';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual([]);
  });

  it('does not match version-style strings like 1.0/2.0', () => {
    const text = 'Bumped from version 1.0 to 2.0 — semver matters.';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual([]);
  });

  it('returns empty when the known-refs list is empty', () => {
    const text = 'I created task gezel-ux-roadmap/2.';
    expect(matchReferencedTasksInContent(text, [])).toEqual([]);
  });

  it('returns empty on empty content', () => {
    expect(matchReferencedTasksInContent('', KNOWN_REFS)).toEqual([]);
    expect(matchReferencedTasksInContent('   ', KNOWN_REFS)).toEqual([]);
  });

  it('matches a ref at the start of the content', () => {
    const text = 'gezel-ux-roadmap/2 is now active.';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual(['gezel-ux-roadmap/2']);
  });

  it('matches a ref at the end of the content', () => {
    const text = 'Promoted the work into gezel-ux-roadmap/2';
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual(['gezel-ux-roadmap/2']);
  });

  it('matches the wild-caught Qwen MLX reply shape', () => {
    // Verbatim from the user repro — model lists files + a task ref
    // mid-paragraph; both the markdown link and bare-ref forms appear
    // in the same reply.
    const text = `Phase 4 - Development Handoff: Completed. I've written \`reports/developer-handoff.md\` and created task \`gezel-ux-roadmap/2\` "Implement Mega-Menu v1 (Core Structure)".`;
    expect(matchReferencedTasksInContent(text, KNOWN_REFS)).toEqual(['gezel-ux-roadmap/2']);
  });
});
