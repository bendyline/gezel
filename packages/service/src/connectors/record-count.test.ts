import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countCorpusRecords } from './record-count.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-record-count-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, 'x');
}

describe('countCorpusRecords', () => {
  it('counts record files wherever the adapter put them, and nothing else', async () => {
    await put('data/mail/inbox/thread-a--1a2b3c4d/001--2026-11-17--from-a--1a2b3c4d.md');
    await put('data/mail/inbox/thread-a--1a2b3c4d/002--2026-11-17--from-b--2b3c4d5e.md');
    await put('data/mail/inbox/thread-a--1a2b3c4d/_flags.json');
    await put('data/mail/inbox/thread-a--1a2b3c4d/attachments/001/005--x--deadbeef.md');
    await put('data/mail/sent/1000--reply--3c4d5e6f.md');
    await put('data/mail/_actions/_drafts/001--draft--4d5e6f70.md');
    await put('data/mail/_meta.json');
    await put('data/mail/notes.md');
    await put('data/other/001--elsewhere--5e6f7081.md');
    expect(await countCorpusRecords(root, 'data/mail')).toBe(3);
  });

  it('is zero for a corpus that does not exist yet', async () => {
    expect(await countCorpusRecords(root, 'data/none')).toBe(0);
    expect(await countCorpusRecords(join(root, 'missing'), 'data/none')).toBe(0);
  });
});
