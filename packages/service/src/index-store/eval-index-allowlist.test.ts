import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evalIndexAllowlist } from './eval-index-allowlist.js';

describe('the evaluation index allowlist', () => {
  let dir: string;
  const before = process.env.GEZEL_EVAL_INDEX_ALLOWLIST;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-eval-allowlist-'));
  });

  afterEach(async () => {
    if (before === undefined) delete process.env.GEZEL_EVAL_INDEX_ALLOWLIST;
    else process.env.GEZEL_EVAL_INDEX_ALLOWLIST = before;
    await rm(dir, { recursive: true, force: true });
  });

  it('changes nothing when unset', () => {
    delete process.env.GEZEL_EVAL_INDEX_ALLOWLIST;
    expect(evalIndexAllowlist(dir)).toEqual({});
  });

  it('skips every file not listed', async () => {
    const list = join(dir, 'allow.txt');
    await writeFile(list, `${join(dir, 'repo', 'src', 'kept.ts')}\n`);
    process.env.GEZEL_EVAL_INDEX_ALLOWLIST = list;
    const { ignorePath } = evalIndexAllowlist(join(dir, 'repo'));
    expect(ignorePath?.('src/kept.ts')).toBe(false);
    expect(ignorePath?.('src/other.ts')).toBe(true);
  });
});
