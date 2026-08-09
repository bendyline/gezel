import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectUpstreamNames, pruneCommunityToolsets } from './prune.js';
import type { NormalizedRegistryServer } from './types.js';

function server(
  name: string,
  status?: 'active' | 'deprecated' | 'deleted',
): NormalizedRegistryServer {
  return {
    name,
    version: '1.0.0',
    ...(status ? { official: { status } } : {}),
  };
}

async function* iter(
  entries: NormalizedRegistryServer[],
): AsyncGenerator<NormalizedRegistryServer> {
  for (const e of entries) yield e;
}

describe('collectUpstreamNames', () => {
  it('splits live from deleted and counts everything seen', async () => {
    const out = await collectUpstreamNames(
      iter([server('a/one'), server('b/two', 'deprecated'), server('c/three', 'deleted')]),
    );
    expect([...out.live].sort()).toEqual(['a/one', 'b/two']);
    expect([...out.deleted]).toEqual(['c/three']);
    expect(out.seen).toBe(3);
  });

  it('treats a name seen live under any version as live', async () => {
    const out = await collectUpstreamNames(
      iter([server('a/one', 'deleted'), server('a/one', 'active')]),
    );
    expect(out.deleted.size).toBe(0);
    expect(out.live.has('a/one')).toBe(true);
  });
});

describe('pruneCommunityToolsets', () => {
  let root: string;

  async function seed(slug: string): Promise<string> {
    const dir = join(root, 'toolsets', slug.slice(0, 2), slug);
    await mkdir(join(dir, 'versions', '1.0.0'), { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: slug }), 'utf8');
    return dir;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-prune-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes an entry upstream has hard-deleted', async () => {
    await seed('keeper-mcp');
    const goneDir = await seed('gone-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(['io.github.who/keeper']),
      deletedNames: new Set(),
      slugMap: { 'io.github.who/keeper': 'keeper-mcp', 'io.github.who/gone': 'gone-mcp' },
    });
    expect(out.removed.map((r) => r.slug)).toEqual(['gone-mcp']);
    expect(out.removed[0]?.reason).toBe('upstream-absent');
    await expect(readdir(goneDir)).rejects.toBeTruthy();
    await expect(readdir(join(root, 'toolsets', 'ke', 'keeper-mcp'))).resolves.toBeTruthy();
  });

  it('removes an entry upstream still lists as deleted', async () => {
    await seed('dead-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(),
      deletedNames: new Set(['io.github.who/dead']),
      slugMap: { 'io.github.who/dead': 'dead-mcp' },
    });
    expect(out.removed[0]?.reason).toBe('upstream-deleted');
  });

  it('never touches a directory with no slug-map record', async () => {
    const handDir = await seed('handmade-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(),
      deletedNames: new Set(),
      slugMap: {},
    });
    expect(out.unmapped).toEqual(['handmade-mcp']);
    expect(out.removed).toEqual([]);
    await expect(readdir(handDir)).resolves.toBeTruthy();
  });

  it('allows a handful of removals even when they dominate a tiny catalog', async () => {
    await seed('one-mcp');
    await seed('two-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(),
      deletedNames: new Set(),
      slugMap: { 'io.github.who/one': 'one-mcp', 'io.github.who/two': 'two-mcp' },
    });
    expect(out.abortedReason).toBeUndefined();
    expect(out.removed).toHaveLength(2);
  });

  it('aborts without deleting when the removal ratio looks like a truncated sweep', async () => {
    const slugMap: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      await seed(`aa${i}-mcp`);
      slugMap[`io.github.who/aa${i}`] = `aa${i}-mcp`;
    }
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(['io.github.who/aa0']),
      deletedNames: new Set(),
      slugMap,
    });
    expect(out.removed).toEqual([]);
    expect(out.candidates).toHaveLength(19);
    expect(out.abortedReason).toMatch(/truncated listing sweep/);
    await expect(readdir(join(root, 'toolsets', 'aa', 'aa5-mcp'))).resolves.toBeTruthy();
  });

  it('honours a raised ratio ceiling', async () => {
    await seed('one-mcp');
    await seed('two-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(['io.github.who/one']),
      deletedNames: new Set(),
      slugMap: { 'io.github.who/one': 'one-mcp', 'io.github.who/two': 'two-mcp' },
      maxRemovalRatio: 0.5,
    });
    expect(out.abortedReason).toBeUndefined();
    expect(out.removed.map((r) => r.slug)).toEqual(['two-mcp']);
  });

  it('dryRun reports candidates without touching disk', async () => {
    const dir = await seed('gone-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(),
      deletedNames: new Set(),
      slugMap: { 'io.github.who/gone': 'gone-mcp' },
      dryRun: true,
    });
    expect(out.candidates).toHaveLength(1);
    expect(out.removed).toEqual([]);
    await expect(readdir(dir)).resolves.toBeTruthy();
  });

  it('drops a shard directory left empty by a removal', async () => {
    await seed('zz-only-mcp');
    await pruneCommunityToolsets({
      root,
      liveNames: new Set(),
      deletedNames: new Set(),
      slugMap: { 'io.github.who/zz-only': 'zz-only-mcp' },
      maxRemovalRatio: 1,
    });
    const shards = await readdir(join(root, 'toolsets'));
    expect(shards).not.toContain('zz');
  });

  it('is a no-op when every imported entry is still live', async () => {
    await seed('alive-mcp');
    const out = await pruneCommunityToolsets({
      root,
      liveNames: new Set(['io.github.who/alive']),
      deletedNames: new Set(),
      slugMap: { 'io.github.who/alive': 'alive-mcp' },
    });
    expect(out.candidates).toEqual([]);
    expect(out.ownedOnDisk).toBe(1);
  });
});
