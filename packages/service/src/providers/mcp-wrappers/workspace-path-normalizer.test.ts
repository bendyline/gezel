import { describe, expect, it } from 'vitest';
import {
  WorkspacePathNormalizer,
  normalizeWorkspaceToolPath,
} from './workspace-path-normalizer.js';

describe('normalizeWorkspaceToolPath', () => {
  it('strips one redundant workspace-root label', () => {
    expect(normalizeWorkspaceToolPath('workspace/index.html')).toBe('index.html');
    expect(normalizeWorkspaceToolPath('./workspace/src/app.ts')).toBe('src/app.ts');
    expect(normalizeWorkspaceToolPath('workspace\\src\\app.ts')).toBe('src\\app.ts');
  });

  it('leaves legitimate non-leading workspace segments unchanged', () => {
    expect(normalizeWorkspaceToolPath('src/workspace/index.ts')).toBe('src/workspace/index.ts');
    expect(normalizeWorkspaceToolPath('index.html')).toBe('index.html');
  });
});

describe('WorkspacePathNormalizer', () => {
  it('rewrites workspace-relative write paths without mutating the original args', async () => {
    const args = { path: 'workspace/index.html', content: '<!doctype html>' };

    const verdict = await WorkspacePathNormalizer.preProcess!('writeFile', args, {} as never);

    expect(verdict).toEqual({
      kind: 'allow',
      args: { path: 'index.html', content: '<!doctype html>' },
    });
    expect(args.path).toBe('workspace/index.html');
  });

  it('normalizes both rename paths', async () => {
    await expect(
      WorkspacePathNormalizer.preProcess!(
        'rename',
        { fromPath: 'workspace/old.txt', toPath: 'workspace/new.txt' },
        {} as never,
      ),
    ).resolves.toEqual({
      kind: 'allow',
      args: { fromPath: 'old.txt', toPath: 'new.txt' },
    });
  });

  it('does not reinterpret artifact validation paths as workspace paths', async () => {
    await expect(
      WorkspacePathNormalizer.preProcess!(
        'validate',
        { path: 'workspace/report.md', where: 'artifact' },
        {} as never,
      ),
    ).resolves.toEqual({ kind: 'allow' });
  });
});
