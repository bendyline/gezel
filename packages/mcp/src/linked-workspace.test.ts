import { describe, expect, it } from 'vitest';
import {
  isLinkedWorkspacePath,
  linkedDisplayPath,
  linkedProjectEntries,
  prefixLinkedEntry,
  resolveLinkedWorkspacePath,
} from './linked-workspace.js';

describe('linked workspace virtual paths', () => {
  it('recognizes only the explicit virtual sibling prefix', () => {
    expect(isLinkedWorkspacePath('src/app.ts')).toBe(false);
    expect(isLinkedWorkspacePath('nested/../app.ts')).toBe(false);
    expect(isLinkedWorkspacePath('..')).toBe(true);
    expect(isLinkedWorkspacePath('../project-b/src/app.ts')).toBe(true);
    expect(isLinkedWorkspacePath('..\\project-b\\src\\app.ts')).toBe(true);
  });

  it('keeps ordinary paths in the active project', () => {
    expect(resolveLinkedWorkspacePath('a', ['b'], 'src/index.ts')).toEqual({
      kind: 'current',
      projectId: 'a',
      path: 'src/index.ts',
      displayPath: 'src/index.ts',
    });
  });

  it('resolves a direct linked-project path without forwarding traversal', () => {
    expect(resolveLinkedWorkspacePath('a', ['b'], '../b/src/index.ts')).toEqual({
      kind: 'linked',
      projectId: 'b',
      path: 'src/index.ts',
      displayPath: '../b/src/index.ts',
      linkedFromProjectId: 'a',
    });
    expect(resolveLinkedWorkspacePath('a', ['b'], '..\\b\\README.md').path).toBe('README.md');
  });

  it('exposes the virtual links root and rejects unlinked or transitive ids', () => {
    expect(resolveLinkedWorkspacePath('a', ['b'], '..').kind).toBe('links-root');
    expect(() => resolveLinkedWorkspacePath('a', ['b'], '../c/file.txt')).toThrow(/not linked/);
    expect(() => resolveLinkedWorkspacePath('a', ['b'], '../../c/file.txt')).toThrow(/not linked/);
  });

  it('formats linked directory entries for model-facing listings', () => {
    expect(linkedProjectEntries(['b'])).toEqual([{ name: 'b', path: '../b', isDirectory: true }]);
    expect(
      prefixLinkedEntry('b', { name: 'index.ts', path: 'src/index.ts', isDirectory: false }),
    ).toEqual({
      name: 'index.ts',
      path: linkedDisplayPath('b', 'src/index.ts'),
      isDirectory: false,
    });
  });
});
