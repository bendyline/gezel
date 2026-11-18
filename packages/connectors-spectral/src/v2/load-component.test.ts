import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inside, loadComponent, unloadComponentHooks } from './load-component.js';
import type { ComponentRef } from './protocol.js';

/**
 * The loader in process. It installs a module resolve hook and guards
 * `process.getBuiltinModule` for the rest of the runner's one-job life; each
 * test here drops the hook and the suite puts the built-in lookup back.
 */

const runnerRequire = createRequire(resolve(__dirname, '..', 'run.ts'));
const fixtures = resolve(__dirname, '..', '..', 'test-fixtures');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ref = (dir: string, entry: string): ComponentRef => ({
  dir,
  entry,
  entrySha256: sha(join(dir, entry)),
});

const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
const originalGetBuiltinModule = proc.getBuiltinModule;
let scratch: string;

/** A throwaway package whose entry is `source`, beside any `extra` files. */
function makePackage(name: string, source: string, extra: Record<string, string> = {}) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'index.cjs'), source);
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(dir, file), body);
  return ref(dir, 'index.cjs');
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gezel-spectral-load-'));
});

afterEach(() => {
  unloadComponentHooks();
});

afterAll(async () => {
  proc.getBuiltinModule = originalGetBuiltinModule;
  await rm(scratch, { recursive: true, force: true });
});

describe('inside', () => {
  it('holds a path to its root', () => {
    expect(inside('/a/b', '/a/b')).toBe(true);
    expect(inside('/a/b', '/a/b/c/d')).toBe(true);
    expect(inside('/a/b', '/a/bc')).toBe(false);
    expect(inside('/a/b', '/a')).toBe(false);
  });
});

describe('loadComponent', () => {
  it('loads a component whose SDK import resolves to the runner pinned copy', () => {
    const pkg = makePackage(
      'uses-sdk',
      `const spectral = require('@prismatic-io/spectral');
       const lib = require('./lib/helper.cjs');
       module.exports = { actions: { hello: lib.hello }, hasSdk: typeof spectral.action };`,
      { 'lib/helper.cjs': 'module.exports = { hello: async () => ({ data: "hi" }) };' },
    );
    const loaded = loadComponent(pkg, runnerRequire) as { hasSdk: string; actions: object };
    expect(loaded.hasSdk).toBe('function');
    expect(Object.keys(loaded.actions)).toEqual(['hello']);
  });

  it('loads the echo fixture the end-to-end test drives', () => {
    const echo = ref(join(fixtures, 'echo-component'), 'npm-dist/index.cjs');
    const loaded = loadComponent(echo, runnerRequire) as { actions: Record<string, unknown> };
    expect(Object.keys(loaded.actions)).toEqual(['listItems', 'revealKey']);
  });

  it('refuses an entry that does not match its pin, before running it', () => {
    const pkg = makePackage('tampered', 'globalThis.__gezelTampered = true; module.exports = {};');
    expect(() => loadComponent({ ...pkg, entrySha256: '0'.repeat(64) }, runnerRequire)).toThrow(
      /pinned hash/,
    );
    expect((globalThis as Record<string, unknown>).__gezelTampered).toBeUndefined();
  });

  it('refuses an entry outside its package, or the package folder itself', () => {
    const pkg = makePackage('home', 'module.exports = {};');
    const sibling = makePackage('sibling', 'module.exports = {};');
    expect(() =>
      loadComponent(
        { ...pkg, entry: '../sibling/index.cjs', entrySha256: sibling.entrySha256 },
        runnerRequire,
      ),
    ).toThrow(/outside its package/);
    expect(() => loadComponent({ ...pkg, entry: '.' }, runnerRequire)).toThrow(
      /outside its package/,
    );
  });

  it('refuses a socket built-in, a package it does not carry, and a path out of its folder', () => {
    expect(() =>
      loadComponent(
        ref(join(fixtures, 'forbidden-component'), 'npm-dist/index.cjs'),
        runnerRequire,
      ),
    ).toThrow(/node:net, which a connector may not use/);
    expect(() =>
      loadComponent(
        ref(join(fixtures, 'forbidden-component'), 'npm-dist/foreign.cjs'),
        runnerRequire,
      ),
    ).toThrow(/lodash, which is not part of its package/);
    writeFileSync(join(scratch, 'outside.cjs'), 'module.exports = 1;');
    const escapes = makePackage('escapes', "module.exports = require('../outside.cjs');");
    expect(() => loadComponent(escapes, runnerRequire)).toThrow(
      /reached outside its package: \.\.\/outside\.cjs/,
    );
  });

  it('allows the harmless built-ins', () => {
    const pkg = makePackage(
      'harmless',
      "const { join } = require('node:path'); module.exports = { joined: join('a', 'b') };",
    );
    expect(loadComponent(pkg, runnerRequire)).toEqual({ joined: join('a', 'b') });
  });

  it('guards process.getBuiltinModule, which skips module resolution', () => {
    if (!originalGetBuiltinModule) return;
    loadComponent(makePackage('plain', 'module.exports = {};'), runnerRequire);
    expect(() => proc.getBuiltinModule?.('node:child_process')).toThrow(
      /node:child_process, which a connector may not use/,
    );
    expect(() => proc.getBuiltinModule?.('net')).toThrow(/node:net/);
    expect(proc.getBuiltinModule?.('node:path')).toBe(runnerRequire('node:path'));
  });

  it('leaves code outside a component alone while the hook is installed', () => {
    loadComponent(makePackage('quiet', 'module.exports = {};'), runnerRequire);
    expect(typeof runnerRequire('node:net').connect).toBe('function');
  });
});
