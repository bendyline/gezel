import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { craftbookScriptHeader } from './install.js';
import { readScriptSource, scriptSourceHash, writeScriptSource } from './source.js';

const VALID = `import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'sample',
  description: 'A perfectly fine sample script.',
  outputs: { ok: { type: 'boolean', description: 'Done flag.' } },
  requires: [],
});

gezel.output({ ok: true });
`;

describe('readScriptSource / writeScriptSource', () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-source-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips source with hash and parsed meta', async () => {
    const { hash } = await writeScriptSource(home, 'p1', 'sample', VALID);
    expect(hash).toBe(scriptSourceHash(VALID));
    const read = await readScriptSource(home, 'p1', 'sample');
    expect(read?.source).toBe(VALID);
    expect(read?.hash).toBe(hash);
    expect(read?.meta?.name).toBe('sample');
    expect(read?.metaError).toBeUndefined();
    expect(read?.provenance).toBeUndefined();
  });

  it('returns the raw file with metaError when meta is broken', async () => {
    await writeScriptSource(home, 'p1', 'broken', 'const nope = true;\n');
    const read = await readScriptSource(home, 'p1', 'broken');
    expect(read?.source).toContain('nope');
    expect(read?.meta).toBeUndefined();
    expect(read?.metaError).toContain('meta');
  });

  it('surfaces craftbook provenance from the marker line', async () => {
    const marked = `${craftbookScriptHeader('pu/pull-request-review', '1.0.0')}${VALID}`;
    await writeScriptSource(home, 'p1', 'bundled', marked);
    const read = await readScriptSource(home, 'p1', 'bundled');
    expect(read?.provenance).toEqual({
      kind: 'craftbook',
      ref: 'pu/pull-request-review@1.0.0',
    });
  });

  it('returns null for a missing script', async () => {
    expect(await readScriptSource(home, 'p1', 'nope')).toBeNull();
  });

  it('rejects path-traversal names before touching the filesystem', async () => {
    await expect(readScriptSource(home, 'p1', '../escape')).rejects.toThrow();
    await expect(writeScriptSource(home, 'p1', 'a/b', 'x')).rejects.toThrow();
  });
});
