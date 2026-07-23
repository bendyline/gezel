import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { BUILTIN_RUBRICS, resolveRubrics } from './rubrics.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-rubrics-'));
  store = new Store({ home });
});
afterEach(async () => {
  delete process.env.GEZEL_FILE_REVIEWS;
  await rm(home, { recursive: true, force: true });
});

describe('resolveRubrics', () => {
  it('ships built-ins for code/markdown/doc/config and nothing else', async () => {
    const rubrics = await resolveRubrics(store);
    expect([...rubrics.keys()].sort()).toEqual(['code', 'config', 'doc', 'markdown']);
    for (const r of rubrics.values()) {
      expect(r.source).toBe('builtin');
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('an override file replaces the built-in and changes the hash', async () => {
    const builtinHash = (await resolveRubrics(store)).get('code')!.hash;
    await mkdir(join(home, 'rubrics'), { recursive: true });
    await writeFile(join(home, 'rubrics', 'code.md'), 'My stricter code rubric.\n');
    const rubrics = await resolveRubrics(store);
    const code = rubrics.get('code')!;
    expect(code.source).toBe('override');
    expect(code.text).toBe('My stricter code rubric.');
    expect(code.hash).not.toBe(builtinHash);
  });

  it('an override for an uncovered kind ADDS eligibility', async () => {
    await mkdir(join(home, 'rubrics'), { recursive: true });
    await writeFile(join(home, 'rubrics', 'text.md'), 'Plain-text rubric.\n');
    const rubrics = await resolveRubrics(store);
    expect(rubrics.get('text')?.source).toBe('override');
    expect(rubrics.size).toBe(5);
  });

  it('blank override files are ignored', async () => {
    await mkdir(join(home, 'rubrics'), { recursive: true });
    await writeFile(join(home, 'rubrics', 'code.md'), '   \n');
    expect((await resolveRubrics(store)).get('code')?.source).toBe('builtin');
  });

  it('disabledKinds removes kinds; enabled:false and GEZEL_FILE_REVIEWS=0 disable everything', async () => {
    await store.writeConfig({ fileReviews: { enabled: true, disabledKinds: ['config'] } });
    const rubrics = await resolveRubrics(store);
    expect(rubrics.has('config')).toBe(false);
    expect(rubrics.has('code')).toBe(true);

    await store.writeConfig({ fileReviews: { enabled: false } });
    expect((await resolveRubrics(store)).size).toBe(0);

    await store.writeConfig({ fileReviews: { enabled: true } });
    process.env.GEZEL_FILE_REVIEWS = '0';
    expect((await resolveRubrics(store)).size).toBe(0);
  });

  it('hash folds in the built-in text (a text change re-reviews lazily)', async () => {
    const a = (await resolveRubrics(store)).get('code')!.hash;
    const b = (await resolveRubrics(store)).get('markdown')!.hash;
    expect(a).not.toBe(b);
    expect(BUILTIN_RUBRICS.code).toContain('Health rubric for source code');
  });

  it('degrades to built-ins on a half-mocked Store', async () => {
    const rubrics = await resolveRubrics({});
    expect(rubrics.size).toBe(4);
  });
});
