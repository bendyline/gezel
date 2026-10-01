import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureHandboekGezk,
  handboekInputsHash,
  writeHandboekLock,
} from '../../../../scripts/handboek-gezk-lock.mjs';

/**
 * The service build's guard for the committed Handboek catalog. v1.26273.82
 * shipped an archive built one commit before its release notes were renamed.
 */

let root: string;

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-handboek-lock-'));
  await put('docs/handboek/whats-new/1.26273.md', '# 1.26273\n');
  await put('packages/service/src/handboek/engine.ts', 'export {};\n');
  await put('packages/catalog/src/source.ts', 'export {};\n');
  await put('packages/catalog/package.json', '{"name":"cat"}\n');
  await put('packages/service/scripts/build-handboek-gezk.ts', '// builder\n');
  await put('packages/service/assets/handboek/handboek.gezk', 'archive');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = {} as NodeJS.ProcessEnv;
const quiet = () => {};

describe('handboekInputsHash', () => {
  it('moves with the docs tree and ignores tests and line endings', async () => {
    const before = handboekInputsHash(root, env);
    await put('packages/service/src/handboek/engine.test.ts', 'it()\n');
    expect(handboekInputsHash(root, env)).toBe(before);
    await put('docs/handboek/whats-new/1.26273.md', '# 1.26273\r\n');
    expect(handboekInputsHash(root, env)).toBe(before);
    await put('docs/handboek/whats-new/1.26273.md', '# 1.26273 — renamed\n');
    expect(handboekInputsHash(root, env)).not.toBe(before);
  });

  it('moves with the Gilde content it renders', () => {
    const pinned = handboekInputsHash(root, env);
    const linked = handboekInputsHash(root, { GEZEL_GILDE_DATA_DIR: '/checkout/gilde/data' });
    expect(linked).not.toBe(pinned);
  });

  it('agrees across checkouts at different paths, so a committed lock holds on CI', async () => {
    const gilde = 'node_modules/@bendyline/gilde/package.json';
    await put(gilde, '{"name":"@bendyline/gilde","version":"0.1.78"}\n');
    const first = handboekInputsHash(root, env);
    const other = await mkdtemp(join(tmpdir(), 'gezel-handboek-lock-other-'));
    try {
      await cp(root, other, { recursive: true });
      expect(handboekInputsHash(other, env)).toBe(first);
      await put(gilde, '{"name":"@bendyline/gilde","version":"0.1.79"}\n');
      expect(handboekInputsHash(root, env)).not.toBe(first);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('ensureHandboekGezk', () => {
  it('does nothing while the lock matches the sources', () => {
    writeHandboekLock({ inputs: handboekInputsHash(root, env), content: 'c' }, root);
    let calls = 0;
    const result = ensureHandboekGezk({
      repoRoot: root,
      env,
      log: quiet,
      runBuilder: () => ++calls > 0,
    });
    expect(result).toBe('fresh');
    expect(calls).toBe(0);
  });

  it('runs the builder when a source changed after the archive was built', async () => {
    writeHandboekLock({ inputs: handboekInputsHash(root, env), content: 'c' }, root);
    await put('docs/handboek/whats-new/1.26273.md', '# 1.26273 — renamed\n');
    let calls = 0;
    const result = ensureHandboekGezk({
      repoRoot: root,
      env,
      log: quiet,
      runBuilder: () => ++calls > 0,
    });
    expect(result).toBe('refreshed');
    expect(calls).toBe(1);
  });

  it('refuses to ship a stale archive under CI when the rebuild fails', () => {
    expect(() =>
      ensureHandboekGezk({
        repoRoot: root,
        env: { CI: 'true' },
        log: quiet,
        runBuilder: () => false,
      }),
    ).toThrow(/refusing to ship/);
  });

  it('keeps a local build going on the committed archive when the rebuild fails', () => {
    const logged: string[] = [];
    const result = ensureHandboekGezk({
      repoRoot: root,
      env,
      log: (m) => logged.push(m),
      runBuilder: () => false,
    });
    expect(result).toBe('stale');
    expect(logged.at(-1)).toMatch(/keeping the committed archive/);
  });

  it('only warns in watch mode, and honours the skip switch', () => {
    let calls = 0;
    const runBuilder = () => ++calls > 0;
    expect(ensureHandboekGezk({ repoRoot: root, env, watch: true, log: quiet, runBuilder })).toBe(
      'stale',
    );
    expect(
      ensureHandboekGezk({
        repoRoot: root,
        env: { GEZEL_SKIP_HANDBOEK_GEZK: '1', CI: 'true' },
        log: quiet,
        runBuilder,
      }),
    ).toBe('skipped');
    expect(calls).toBe(0);
  });
});
