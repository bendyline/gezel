import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBaseName, previewFolder } from './folder-preview.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-folder-preview-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('folderBaseName', () => {
  it('handles both separators and trailing slashes', () => {
    expect(folderBaseName('D:\\gh\\client-project')).toBe('client-project');
    expect(folderBaseName('/home/dev/petshop/')).toBe('petshop');
    expect(folderBaseName('/home/dev/petshop')).toBe('petshop');
  });
});

describe('previewFolder', () => {
  it('returns the basename when no agent doc is present', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'index.js'), 'console.log(1)\n');
    const res = await previewFolder(dir);
    expect(res.name).toBe(folderBaseName(dir));
    expect(res.about).toBeUndefined();
    expect(res.source).toBeUndefined();
  });

  it('reads AGENTS.md into about, case-insensitively', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'Agents.md'), '# Guide\n\nDo the thing.\n');
    const res = await previewFolder(dir);
    expect(res.source).toBe('Agents.md');
    expect(res.about).toContain('Do the thing.');
  });

  it('prefers the doc with the most content when several exist', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    await writeFile(join(dir, 'AGENTS.md'), `# Full guide\n\n${'x'.repeat(500)}\n`);
    const res = await previewFolder(dir);
    expect(res.source).toBe('AGENTS.md');
    expect(res.about).toContain('Full guide');
  });

  it('caps a very long agent doc', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'AGENTS.md'), 'y'.repeat(10_000));
    const res = await previewFolder(dir);
    expect(res.about?.endsWith('…(truncated)')).toBe(true);
    expect(res.about?.length ?? 0).toBeLessThan(10_000);
  });

  it('never throws for a missing folder', async () => {
    const res = await previewFolder(join(tmpdir(), 'gezel-does-not-exist-xyz'));
    expect(res.name).toBe('gezel-does-not-exist-xyz');
    expect(res.about).toBeUndefined();
  });
});
