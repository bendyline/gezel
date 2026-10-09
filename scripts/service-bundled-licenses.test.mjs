/**
 * The published service shipped about 250 packages minified into dist/ui and
 * dist/office with no license text, including Mediabunny (MPL-2.0), which a
 * dependency had already bundled into its own dist. These tests pin the
 * inventory read from source maps, the carried third-party notice files, and
 * the reviewed registry for code a dependency inlined without its license.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  bundledPackagesFromSourceMaps,
  embeddedLicenseRecords,
  embeddedPackagesOf,
  loadEmbeddedLicenses,
  matchesRecordedSha,
  stageServiceBundledLicenses,
  verifyServiceBundledLicenses,
} from './service-bundled-licenses.mjs';

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
}

const store = (name, version) =>
  `node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}`;

/**
 * A pnpm-shaped tree: `alpha` with a LICENSE, `@scope/beta` with no license
 * file but a THIRD_PARTY_LICENSES.txt and its own map showing it inlined
 * `inlined`, and a workspace chunk whose map pulls in `gamma`. Vite wrote the
 * bundle map under build/ui; the service copy sits one level deeper.
 */
async function fixture(dir) {
  const alpha = store('alpha', '1.0.0');
  const beta = store('@scope/beta', '2.0.0');
  const gamma = store('gamma', '4.0.0');
  const bundleMap = {
    version: 3,
    sources: [
      `../../../${alpha}/index.js`,
      `../../../${beta}/lib.js`,
      '../../../workspace/core/dist/chunk.js',
      '\u0000vite/preload-helper.js',
      '../../src/App.tsx',
    ],
  };
  await writeFiles(dir, {
    [`${alpha}/package.json`]: { name: 'alpha', version: '1.0.0', license: 'MIT' },
    [`${alpha}/LICENSE`]: 'MIT License\n\nCopyright alpha authors\n',
    [`${alpha}/index.js`]: '',
    [`${beta}/package.json`]: {
      name: '@scope/beta',
      version: '2.0.0',
      license: 'MIT',
      author: 'Beta Author',
    },
    [`${beta}/THIRD_PARTY_LICENSES.txt`]: 'inlined-dep: MIT\n',
    [`${beta}/lib.js`]: '',
    [`${beta}/lib.js.map`]: {
      version: 3,
      sources: [
        '../../../../../node_modules/.pnpm/inlined@3.1.0/node_modules/inlined/src/a.ts',
        '../node_modules/src/garbled.ts',
        './own.ts',
      ],
    },
    [`${gamma}/package.json`]: { name: 'gamma', version: '4.0.0', license: 'ISC' },
    [`${gamma}/LICENSE`]: 'ISC License\n',
    [`${gamma}/g.js`]: '',
    'workspace/core/dist/chunk.js': '',
    'workspace/core/dist/chunk.js.map': {
      version: 3,
      sources: [`../../../${gamma}/g.js`],
    },
    'build/ui/assets/app.js.map': bundleMap,
    'svc/dist/ui/assets/app.js.map': bundleMap,
  });
  return {
    surfaces: [{ dir: join(dir, 'svc', 'dist', 'ui'), builtIn: join(dir, 'build', 'ui') }],
    serviceDist: join(dir, 'svc', 'dist'),
  };
}

async function registry(dir, carriers) {
  const root = join(dir, 'embedded');
  const text = 'MIT License\n\nCopyright inlined authors\n';
  await writeFiles(root, {
    'inlined@3.1.0-LICENSE': text,
    'manifest.json': {
      schemaVersion: 1,
      carriers,
      texts: {
        'inlined@3.1.0-LICENSE': {
          source: 'npm:inlined@3.1.0/LICENSE',
          sha256: createHash('sha256').update(text).digest('hex'),
        },
      },
    },
  });
  return root;
}

const betaCarrier = (version = '2.0.0') => ({
  '@scope/beta': {
    version,
    unattributedReferences: { src: 'the map garbles nested paths as node_modules/src' },
    components: [
      { name: 'inlined', version: '3.1.0', license: 'MIT', texts: ['inlined@3.1.0-LICENSE'] },
    ],
  },
});

test('map sources name each package once, nested packages included', () => {
  assert.deepEqual(
    embeddedPackagesOf(
      '../../node_modules/.pnpm/@chevrotain+gast@11.1.2/node_modules/@chevrotain/gast/src/model.ts',
    ),
    [{ name: '@chevrotain/gast', version: '11.1.2' }],
  );
  assert.deepEqual(
    embeddedPackagesOf('../node_modules/css-line-break/node_modules/utrie/node_modules/src/i.ts'),
    [
      { name: 'css-line-break', version: null },
      { name: 'utrie', version: null },
      { name: 'src', version: null },
    ],
  );
  assert.deepEqual(embeddedPackagesOf('../../src/App.tsx'), []);
});

test('the inventory follows workspace maps, rebases copied maps, and records inlined packages', async (t) => {
  const dir = await tempDir(t, 'gezel-bundled-licenses-');
  const { surfaces } = await fixture(dir);
  const { packages, embedded } = await bundledPackagesFromSourceMaps(surfaces);
  assert.deepEqual([...packages.values()].map((pkg) => pkg.name).sort(), [
    '@scope/beta',
    'alpha',
    'gamma',
  ]);
  const beta = [...packages.values()].find((pkg) => pkg.name === '@scope/beta');
  assert.deepEqual(Object.fromEntries(embedded.get(beta.path)), { inlined: '3.1.0', src: null });
});

test('staging carries third-party notice files and reviewed texts, and verification catches drift', async (t) => {
  const dir = await tempDir(t, 'gezel-bundled-licenses-');
  const { surfaces, serviceDist } = await fixture(dir);
  const embeddedRoot = await registry(dir, betaCarrier());
  const options = { serviceDist, surfaces, extraPackageRoots: [], embeddedRoot };

  const result = await stageServiceBundledLicenses(options);
  assert.deepEqual(result, { packages: 3, embedded: 1 });
  const manifestPath = join(serviceDist, 'licenses', 'npm', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const record = (name) => manifest.packages.find((pkg) => pkg.name === name);
  assert.deepEqual(
    record('@scope/beta').texts.map((text) => text.source),
    ['THIRD_PARTY_LICENSES.txt'],
    'a third-party notice file counts as license material',
  );
  assert.equal(record('alpha').texts[0].source, 'LICENSE');
  assert.equal(record('inlined').embeddedIn, '@scope/beta@2.0.0');
  await verifyServiceBundledLicenses(options);

  manifest.packages = manifest.packages.filter((pkg) => pkg.name !== 'gamma');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    () => verifyServiceBundledLicenses(options),
    /bundled but unlisted: gamma@4\.0\.0/,
  );
});

test('an inlined package needs a reviewed text for the exact carrier version', async (t) => {
  const dir = await tempDir(t, 'gezel-bundled-licenses-');
  const { surfaces } = await fixture(dir);
  const { packages, embedded } = await bundledPackagesFromSourceMaps(surfaces);

  const bumped = await loadEmbeddedLicenses(await registry(join(dir, 'a'), betaCarrier('1.9.0')));
  assert.throws(
    () => embeddedLicenseRecords(packages, embedded, bumped),
    /@scope\/beta@2\.0\.0 inlines inlined@3\.1\.0, src; review them/,
  );

  const unexplained = betaCarrier();
  delete unexplained['@scope/beta'].unattributedReferences;
  const strict = await loadEmbeddedLicenses(await registry(join(dir, 'b'), unexplained));
  assert.throws(
    () => embeddedLicenseRecords(packages, embedded, strict),
    /inlines src, which legal\/embedded-licenses\/manifest\.json does not list/,
  );
});

for (const lineEnding of ['\n', '\r\n']) {
  test(`staged license digests match the shipped bytes after checkout conversion to ${JSON.stringify(lineEnding)}`, async (t) => {
    const dir = await tempDir(t, 'gezel-bundled-license-endings-');
    const { surfaces, serviceDist } = await fixture(dir);
    const embeddedRoot = await registry(dir, betaCarrier());
    const sourcePath = join(embeddedRoot, 'inlined@3.1.0-LICENSE');
    const source = (await readFile(sourcePath, 'utf8')).replace(/\n/g, lineEnding);
    const registryPath = join(embeddedRoot, 'manifest.json');
    const reviewed = JSON.parse(await readFile(registryPath, 'utf8'));
    const otherEnding = lineEnding === '\n' ? '\r\n' : '\n';
    const recorded = source.replace(/\r?\n/g, otherEnding);
    reviewed.texts['inlined@3.1.0-LICENSE'].sha256 = createHash('sha256')
      .update(recorded)
      .digest('hex');
    await writeFile(registryPath, JSON.stringify(reviewed));
    await writeFile(sourcePath, source);
    const options = { serviceDist, surfaces, extraPackageRoots: [], embeddedRoot };

    await stageServiceBundledLicenses(options);
    const { packages } = await verifyServiceBundledLicenses(options);
    const text = packages.find((pkg) => pkg.name === 'inlined').texts[0];
    const stagedPath = join(serviceDist, 'licenses', 'npm', text.file);
    assert.equal(await readFile(stagedPath, 'utf8'), source);
    assert.equal(text.sha256, createHash('sha256').update(source).digest('hex'));
    assert.ok(text.file.includes(text.sha256));

    await writeFile(stagedPath, `${source}altered`);
    await assert.rejects(() => verifyServiceBundledLicenses(options), /missing or altered/);
  });
}

test('a recorded license hash survives a line-ending conversion, not an edit', () => {
  const crlf = Buffer.from('MIT License\r\n\r\nCopyright inlined authors\r\n');
  const recorded = createHash('sha256').update(crlf).digest('hex');
  const lf = Buffer.from('MIT License\n\nCopyright inlined authors\n');
  assert.equal(matchesRecordedSha(crlf, recorded), true);
  assert.equal(matchesRecordedSha(lf, recorded), true, 'an LF checkout of a CRLF-recorded text');
  assert.equal(
    matchesRecordedSha(Buffer.from('MIT License\n\nCopyright someone else\n'), recorded),
    false,
  );
  assert.equal(matchesRecordedSha(lf, undefined), false);
});
