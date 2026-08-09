import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedRecord } from './types.js';
import { pruneRecords, sha8, writeRecord } from './writer.js';

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-writer-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function record(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    recordId: 'rec-1',
    dirSegments: [],
    fileStem: 'first-title',
    frontmatter: { direction: 'inbound', title: 'First title' },
    bodyMarkdown: 'original body',
    scanOrigin: 'test-conn',
    quarantineNamespace: 'test-conn',
    quarantineLabel: 'Record rec-1',
    ...overrides,
  };
}

const write = (rec: NormalizedRecord) =>
  writeRecord({ workspaceDir: ws, corpusDir: 'data/c', record: rec });

async function corpusFiles(): Promise<string[]> {
  return (await readdir(join(ws, 'data', 'c'))).filter((f) => f.endsWith('.md')).sort();
}

describe('writeRecord refresh-in-place', () => {
  it('skips an unchanged record, refreshes a changed one in place (stable ordinal)', async () => {
    const first = await write(record());
    expect(first.status).toBe('written');
    expect(first.relPath).toMatch(/^data\/c\/001--first-title--[0-9a-f]{8}\.md$/);

    const unchanged = await write(record());
    expect(unchanged.status).toBe('exists');

    const changed = await write(
      record({
        fileStem: 'renamed-title',
        frontmatter: { direction: 'inbound', title: 'Renamed title' },
        bodyMarkdown: 'edited body',
      }),
    );
    expect(changed.status).toBe('refreshed');
    expect(changed.relPath).toMatch(/^data\/c\/001--renamed-title--[0-9a-f]{8}\.md$/);

    const files = await corpusFiles();
    expect(files).toHaveLength(1); // old file replaced, not accumulated
    const content = await readFile(join(ws, 'data', 'c', files[0]!), 'utf8');
    expect(content).toContain('edited body');
    expect(content).not.toContain('original body');
  });

  it('content hash ignores frontmatter key order', async () => {
    await write(record({ frontmatter: { a: '1', b: '2' } }));
    const r = await write(record({ frontmatter: { b: '2', a: '1' } }));
    expect(r.status).toBe('exists');
  });

  it('rewrites a pre-refresh record (no sidecar hash) exactly once', async () => {
    await write(record());
    // Simulate a pre-refresh corpus: sidecar entries without contentHash.
    const sidecarPath = join(ws, 'data', 'c', '_flags.json');
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
    for (const key of Object.keys(sidecar)) {
      sidecar[key] = { read: false, flags: [] };
    }
    await writeFile(sidecarPath, JSON.stringify(sidecar));

    const first = await write(record());
    expect(first.status).toBe('refreshed'); // hash backfilled
    const second = await write(record());
    expect(second.status).toBe('exists');
  });

  it('replaces attachments on refresh instead of accumulating them', async () => {
    await write(
      record({ attachments: [{ filename: 'old.txt', content: new TextEncoder().encode('old') }] }),
    );
    await write(
      record({
        bodyMarkdown: 'v2',
        attachments: [{ filename: 'new.txt', content: new TextEncoder().encode('new') }],
      }),
    );
    const att = await readdir(join(ws, 'data', 'c', 'attachments', '001'));
    expect(att).toEqual(['new.txt']);
  });

  it('allocates ordinals from the max, so pruned gaps are never reused', async () => {
    await write(record({ recordId: 'a', fileStem: 'a' }));
    await write(record({ recordId: 'b', fileStem: 'b' }));
    await write(record({ recordId: 'c', fileStem: 'c' }));
    await pruneRecords({
      workspaceDir: ws,
      corpusDir: 'data/c',
      keepHashes: new Set([sha8('a'), sha8('c')]), // drop 'b' (ordinal 002)
    });
    const r = await write(record({ recordId: 'd', fileStem: 'd' }));
    expect(r.relPath).toMatch(/^data\/c\/004--d--/); // max+1, not count+1
  });
});

describe('pruneRecords', () => {
  it('removes absent records, their attachments, and sidecar entries; keeps the rest', async () => {
    await write(
      record({
        recordId: 'keep',
        fileStem: 'keep',
        attachments: [{ filename: 'k.txt', content: new TextEncoder().encode('k') }],
      }),
    );
    await write(
      record({
        recordId: 'drop',
        fileStem: 'drop',
        attachments: [{ filename: 'd.txt', content: new TextEncoder().encode('d') }],
      }),
    );

    const r = await pruneRecords({
      workspaceDir: ws,
      corpusDir: 'data/c',
      keepHashes: new Set([sha8('keep')]),
    });
    expect(r.pruned).toBe(1);

    const files = await corpusFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('keep');
    const attDirs = await readdir(join(ws, 'data', 'c', 'attachments'));
    expect(attDirs).toEqual(['001']); // drop's 002 removed
    const sidecar = JSON.parse(await readFile(join(ws, 'data', 'c', '_flags.json'), 'utf8'));
    expect(Object.keys(sidecar)).toEqual([sha8('keep')]);
  });

  it('walks nested group dirs but never touches _-prefixed entries', async () => {
    await write(record({ recordId: 'nested', fileStem: 'nested', dirSegments: ['group-a'] }));
    const actionsDir = join(ws, 'data', 'c', '_actions', '_drafts');
    await rm(actionsDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(actionsDir, { recursive: true });
    await writeFile(join(actionsDir, '001--draft--deadbeef.md'), 'a draft');

    const r = await pruneRecords({
      workspaceDir: ws,
      corpusDir: 'data/c',
      keepHashes: new Set(),
    });
    expect(r.pruned).toBe(1); // the nested record
    await expect(readFile(join(actionsDir, '001--draft--deadbeef.md'), 'utf8')).resolves.toBe(
      'a draft',
    );
  });
});
