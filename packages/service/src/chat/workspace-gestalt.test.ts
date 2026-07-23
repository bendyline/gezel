import type { MapRepoResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { renderWorkspaceGestalt } from './workspace-gestalt.js';

function map(partial: Partial<MapRepoResponse>): MapRepoResponse {
  return {
    root: '/w',
    languages: [],
    areas: [],
    entryPoints: [],
    keyFiles: [],
    fileCount: 10,
    indexed: true,
    ...partial,
  };
}

describe('renderWorkspaceGestalt', () => {
  it('is empty when the index is unbuilt or the deep pass has not run', () => {
    expect(renderWorkspaceGestalt(map({ indexed: false, architecture: 'x' }))).toBe('');
    expect(renderWorkspaceGestalt(map({ areas: [{ path: 'src', fileCount: 5 }] }))).toBe('');
  });

  it('renders architecture, purposeful areas, and entry points', () => {
    const block = renderWorkspaceGestalt(
      map({
        architecture: 'A small shop simulator with a UI and an engine.',
        areas: [
          { path: 'src', fileCount: 12, purpose: 'Game engine and\n  state machine.' },
          { path: 'assets', fileCount: 30 },
          { path: '.', fileCount: 2, purpose: 'Build config.' },
        ],
        entryPoints: ['src/main.ts'],
      }),
    );
    expect(block).toContain('### Workspace map');
    expect(block).toContain('A small shop simulator');
    expect(block).toContain('- `src/` (12 files) — Game engine and state machine.');
    expect(block).toContain('- `(root)` (2 files) — Build config.');
    expect(block).not.toContain('assets'); // no purpose → no line
    expect(block).toContain('Entry points: `src/main.ts`');
    expect(block).toContain('`search_code`');
  });

  it('caps areas and entry points', () => {
    const areas = Array.from({ length: 20 }, (_, i) => ({
      path: `dir${i}`,
      fileCount: 1,
      purpose: `Purpose ${i}`,
    }));
    const entryPoints = Array.from({ length: 12 }, (_, i) => `e${i}/main.ts`);
    const block = renderWorkspaceGestalt(map({ areas, entryPoints }));
    expect(block).toContain('dir7');
    expect(block).not.toContain('dir8/');
    expect(block).toContain('e5/main.ts');
    expect(block).not.toContain('e6/main.ts');
  });
});
