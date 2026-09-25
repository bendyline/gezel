import type { ProjectFileEntry } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  filterWorkspaceFilesForPrompt,
  roleGetsWorkspaceOrientation,
  workspacePromptProfileForRole,
} from './workspace-prompt-listing.js';

function entries(paths: string[]): ProjectFileEntry[] {
  return paths.map((path) => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    isDirectory: !path.slice(path.lastIndexOf('/') + 1).includes('.'),
  }));
}

describe('workspacePromptProfileForRole', () => {
  it('resolves free-form developer and writer titles through the canonical role registry', () => {
    expect(workspacePromptProfileForRole('Backend Engineer')).toBe('code');
    expect(workspacePromptProfileForRole('Technical Writer')).toBe('writing');
    expect(workspacePromptProfileForRole('Visual Designer')).toBe('design');
    expect(workspacePromptProfileForRole('Research Analyst')).toBe('research');
  });

  it('does not preload a workspace for coordinators, generalists, generators, or unknown roles', () => {
    for (const role of [
      'Meester',
      'Voorman',
      'Planner',
      'Generalist',
      'Image Generator',
      'Video Generator',
      'Chief of Staff',
      undefined,
    ]) {
      expect(workspacePromptProfileForRole(role)).toBe('none');
      expect(roleGetsWorkspaceOrientation(role)).toBe(false);
    }
  });
});

describe('filterWorkspaceFilesForPrompt', () => {
  const workspace = entries([
    'src',
    'docs',
    'assets',
    'dist',
    'node_modules',
    'src/components',
    'docs/research',
    'assets/icons',
    'dist/chunks',
    'node_modules/pkg',
    'package.json',
    'pnpm-lock.yaml',
    'README.md',
    'src/app.ts',
    'src/components/button.tsx',
    'src/components/demo.png',
    'docs/brief.md',
    'docs/research/results.csv',
    'assets/icons/logo.svg',
    'assets/icons/logo.png',
    'dist/chunks/app.js',
    'node_modules/pkg/index.js',
    'archive.zip',
  ]);

  it('shows developers code/config paths and their ancestors, without dependency/build/binary clutter', () => {
    expect(
      filterWorkspaceFilesForPrompt(workspace, 'Developer').map((entry) => entry.path),
    ).toEqual([
      'src',
      'src/components',
      'package.json',
      'README.md',
      'src/app.ts',
      'src/components/button.tsx',
    ]);
  });

  it('shows writers prose sources rather than code or binary documents', () => {
    expect(filterWorkspaceFilesForPrompt(workspace, 'Writer').map((entry) => entry.path)).toEqual([
      'docs',
      'README.md',
      'docs/brief.md',
    ]);
  });

  it('shows researchers prose and text data, while designers get editable design sources', () => {
    expect(
      filterWorkspaceFilesForPrompt(workspace, 'Researcher').map((entry) => entry.path),
    ).toEqual(['docs', 'docs/research', 'README.md', 'docs/brief.md', 'docs/research/results.csv']);

    expect(filterWorkspaceFilesForPrompt(workspace, 'Designer').map((entry) => entry.path)).toEqual(
      ['docs', 'assets', 'assets/icons', 'README.md', 'docs/brief.md', 'assets/icons/logo.svg'],
    );
  });

  it('returns no inventory for a Meester even when the workspace is populated', () => {
    expect(filterWorkspaceFilesForPrompt(workspace, 'Meester')).toEqual([]);
  });
});
