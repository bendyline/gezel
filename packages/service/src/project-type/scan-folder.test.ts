import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_MIN_SCORE, scoreProjectTypes } from './detect.js';
import { profileFromFiles, scanFolderProfile } from './scan-folder.js';

describe('profileFromFiles', () => {
  it('counts extensions lowercased and without the dot, matching the indexed profile', () => {
    const profile = profileFromFiles([
      { path: 'src/App.TSX', size: 100 },
      { path: 'src/main.ts', size: 100 },
      { path: 'index.html', size: 100 },
    ]);
    expect(profile.fileCount).toBe(3);
    expect(profile.extensions).toEqual({ tsx: 1, ts: 1, html: 1 });
  });

  it('ignores dotfiles and extensionless files when counting extensions', () => {
    const profile = profileFromFiles([
      { path: '.gitignore', size: 10 },
      { path: 'Makefile', size: 10 },
      { path: 'notes.md', size: 10 },
    ]);
    expect(profile.extensions).toEqual({ md: 1 });
    // Every file still counts toward the denominator — a tree that is mostly
    // extensionless should not score as if those files were absent.
    expect(profile.fileCount).toBe(3);
  });

  it('derives modalities through classifyFile so the vocabulary matches the index', () => {
    const profile = profileFromFiles([
      { path: 'a.ts', size: 100 },
      { path: 'b.png', size: 100 },
      { path: 'c.jpg', size: 100 },
      { path: 'd.docx', size: 100 },
      { path: 'e.md', size: 100 },
    ]);
    expect(profile.modalities).toEqual({ code: 1, image: 2, doc: 1, text: 1 });
  });
});

describe('scanFolderProfile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-scan-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for an empty folder', async () => {
    expect(await scanFolderProfile(dir)).toBeNull();
  });

  it('skips node_modules and other never-useful trees', async () => {
    await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x');
    await writeFile(join(dir, 'main.py'), 'print(1)');

    const profile = await scanFolderProfile(dir);
    expect(profile?.fileCount).toBe(1);
    expect(profile?.extensions).toEqual({ py: 1 });
  });

  it('honors the file cap', async () => {
    for (let i = 0; i < 12; i++) await writeFile(join(dir, `f${i}.ts`), 'x');
    const profile = await scanFolderProfile(dir, { maxFiles: 5 });
    expect(profile?.fileCount).toBe(5);
  });

  it('produces a profile a folder of prose is detected from, with no index and no about text', async () => {
    // The gap this scan closes: before it, an unindexed folder had a null
    // profile, so detection ran on about-text keywords alone — and a fresh
    // CLI project's about text is boilerplate.
    await writeFile(join(dir, 'chapter-01.md'), '# One');
    await writeFile(join(dir, 'chapter-02.md'), '# Two');
    await writeFile(join(dir, 'outline.md'), '# Outline');

    const profile = await scanFolderProfile(dir);
    const ranked = scoreProjectTypes({ profile, aboutText: '' });
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(PROJECT_TYPE_MIN_SCORE);
    // Several prose-shaped types tie on a pure-markdown tree; what matters is
    // that a code/game type never wins one.
    expect(['content-writing', 'static-site', 'social-media', 'email', 'job-hunt']).toContain(
      ranked[0]?.id,
    );
  });
});
