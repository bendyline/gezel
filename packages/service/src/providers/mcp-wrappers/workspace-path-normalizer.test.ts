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

    const verdict = await WorkspacePathNormalizer.preProcess!('write_file', args, {} as never);

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

  it('normalizes every nested path in a read_files batch', async () => {
    const args = {
      files: [
        { path: 'workspace/src/a.ts', startLine: 10, endLine: 20 },
        { path: 'src/workspace/b.ts' },
        { path: 'workspace/README.md' },
      ],
    };

    await expect(
      WorkspacePathNormalizer.preProcess!('read_files', args, {} as never),
    ).resolves.toEqual({
      kind: 'allow',
      args: {
        files: [
          { path: 'src/a.ts', startLine: 10, endLine: 20 },
          { path: 'src/workspace/b.ts' },
          { path: 'README.md' },
        ],
      },
    });
    expect(args.files[0]?.path).toBe('workspace/src/a.ts');
  });

  it('normalizes the simple paths form of a read_files batch', async () => {
    const args = { paths: ['workspace/src/a.ts', 'src/workspace/b.ts', './workspace/README.md'] };

    await expect(
      WorkspacePathNormalizer.preProcess!('read_files', args, {} as never),
    ).resolves.toEqual({
      kind: 'allow',
      args: { paths: ['src/a.ts', 'src/workspace/b.ts', 'README.md'] },
    });
    expect(args.paths[0]).toBe('workspace/src/a.ts');
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
