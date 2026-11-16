import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectLinks, isEnforcing } from './local-link-guard.mjs';
import { readProductionLicenseInventory } from './production-dependency-inventory.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inventory = Object.values(readProductionLicenseInventory()).flat();

/**
 * The copies a linked sibling checkout (`pnpm link:squisq`) resolves for
 * itself. Its dependencies never enter Gezel's lockfile, so while it is linked
 * a package only Squisq brings (Tiptap) is missing from the production graph,
 * yet a local build still bundles one. Resolving from each linked package the
 * way Node and Vite do tests that copy, which keeps the gate runnable while
 * linked (scripts/local-link-guard.mjs). CI and releases judge the lockfile
 * graph alone.
 */
function linkedCopies(name) {
  if (isEnforcing()) return [];
  const found = new Map();
  for (const { spec } of collectLinks('@bendyline/')) {
    for (let dir = resolve(root, spec.slice('link:'.length)); ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) {
        const path = realpathSync(candidate);
        found.set(path, JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version);
        break;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return [...found].map(([path, version]) => ({ path, version }));
}

function copies(name) {
  const paths = new Map();
  for (const pkg of inventory.filter((pkg) => pkg.name === name)) {
    for (const [i, version] of pkg.versions.entries()) paths.set(pkg.paths[i], version);
  }
  if (paths.size === 0) {
    const linked = linkedCopies(name);
    if (linked.length > 0) return linked;
  }
  assert.ok(paths.size, `${name} must be present in the tested production graph`);
  return [...paths].map(([path, version]) => ({ path, version }));
}

for (const { path, version } of copies('undici')) {
  test(`undici ${version} survives excessive content encodings and still fetches valid gzip`, () => {
    const child = spawnSync(
      process.execPath,
      [join(root, 'scripts/fixtures/undici-malformed-response.cjs'), path],
      {
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /malformed-response-rejected; healthy-gzip-ok/);
  });
}

async function assertV3Bounds(z) {
  let visits = 0;
  const element = z.preprocess((value) => {
    visits += 1;
    return value;
  }, z.string());
  for (const [schema, input] of [
    [z.array(element).max(1), [1, 2, 3]],
    [z.array(element).length(1), [1, 2, 3]],
    [z.set(element).max(1), new Set([1, 2, 3])],
  ]) {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, 'too_big');
    const asyncResult = await schema.safeParseAsync(input);
    assert.equal(asyncResult.success, false);
    assert.equal(asyncResult.error.issues.length, 1);
  }
  assert.equal(visits, 0, 'a size-rejected collection must not inspect its elements');
  assert.deepEqual(z.array(z.string()).max(2).parse(['valid']), ['valid']);
  assert.equal(z.array(z.string()).max(2).safeParse([1]).success, false);
  assert.equal(z.array(z.string()).length(2).safeParse(['short']).success, false);
}

async function assertV4Bounds(z, mini = false) {
  let visits = 0;
  const element = z.any().check(
    z.refine(() => {
      visits += 1;
      return false;
    }),
  );
  const schemas = [
    [z.array(element).check(z.maxLength(1)), [1, 2, 3]],
    [z.array(element).check(z.length(1)), [1, 2, 3]],
    [z.set(element).check(z.maxSize(1)), new Set([1, 2, 3])],
    [
      z.map(element, element).check(z.maxSize(1)),
      new Map([
        [1, 1],
        [2, 2],
      ]),
    ],
  ];
  for (const [schema, input] of schemas) {
    for (const result of [schema.safeParse(input), await schema.safeParseAsync(input)]) {
      assert.equal(result.success, false);
      assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big');
    }
  }
  assert.equal(visits, 0);
  assert.deepEqual(z.array(z.string()).check(z.maxLength(2)).parse(['valid']), ['valid']);
  assert.equal(z.array(z.string()).check(z.maxLength(2)).safeParse('wrong type').success, false);
  if (!mini) {
    assert.deepEqual(
      z
        .array(z.number())
        .overwrite((a) => a.slice(0, 1))
        .max(1)
        .parse([1, 2]),
      [1],
    );
  }
}

for (const { path, version } of copies('zod')) {
  for (const format of ['cjs', 'js']) {
    test(`zod ${version} ${format} bounds v3, v4 and mini before element allocation`, async () => {
      const require = createRequire(join(path, 'package.json'));
      const load = (entry) =>
        format === 'cjs'
          ? require(join(path, entry, 'index.cjs'))
          : import(pathToFileURL(join(path, entry, 'index.js')).href);
      await assertV3Bounds(await load('v3'));
      await assertV4Bounds(await load('v4'));
      await assertV4Bounds(await load('v4/mini'), true);
    });
  }
}

for (const { path, version } of copies('@tiptap/core')) {
  for (const format of ['cjs', 'js']) {
    test(`Tiptap ${version} ${format} never inherits JSON-origin DOM attributes`, async () => {
      const require = createRequire(join(path, 'package.json'));
      const { mergeAttributes } =
        format === 'cjs'
          ? require(join(path, 'dist/index.cjs'))
          : await import(pathToFileURL(join(path, 'dist/index.js')).href);
      const input = JSON.parse('{"__proto__":{"onerror":"canary","src":"canary"}}');
      const attrs = mergeAttributes({ class: 'first' }, input, { class: 'second' });
      assert.equal(Object.getPrototypeOf(attrs), Object.prototype);
      assert.equal(attrs.onerror, undefined);
      assert.equal(attrs.src, undefined);
      const enumerable = [];
      for (const key in attrs) enumerable.push(key);
      assert.ok(!enumerable.includes('onerror'));
      assert.equal(attrs.class, 'first second');
    });
  }
}
