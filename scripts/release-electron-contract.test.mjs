import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('Electron release configuration pins the audited packaging contracts', async () => {
  const [builder, workflow, tsup, main, stamp, corePackage, lockfile, frontmatter] =
    await Promise.all([
      readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8'),
      readFile(join(root, '.github', 'workflows', 'release-electron.yml'), 'utf8'),
      readFile(join(root, 'packages', 'app', 'tsup.config.ts'), 'utf8'),
      readFile(join(root, 'packages', 'app', 'src', 'main.ts'), 'utf8'),
      readFile(join(root, 'scripts', 'stamp-version.mjs'), 'utf8'),
      readFile(join(root, 'packages', 'core', 'package.json'), 'utf8'),
      readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
      readFile(join(root, 'packages', 'core', 'src', 'markdown', 'frontmatter.ts'), 'utf8'),
    ]);

  assert.match(tsup, /noExternal:/);
  assert.match(tsup, /@bendyline\\\/gezel-client/);
  assert.match(tsup, /dist\/main\.js still contains a runtime import/);
  assert.match(tsup, /__gezelCreateRequire/);
  assert.doesNotMatch(corePackage, /gray-matter/);
  assert.doesNotMatch(lockfile, /gray-matter/);
  assert.match(corePackage, /"yaml": "\^2\.9\.0"/);
  assert.doesNotMatch(frontmatter, /node:fs|from ['"]fs/);

  assert.match(main, /GEZEL_PACKAGED_SMOKE/);
  assert.match(main, /apiClient\.health\(\)/);
  assert.match(main, /webContents\.executeJavaScript/);
  assert.match(main, /bundled Node runtime did not pass integrity verification and install/);
  assert.match(main, /bundled pnpm runtime did not pass integrity verification and install/);
  assert.equal(
    workflow.match(/- name: Smoke-test packaged (?:Windows|macOS|Linux) app/g)?.length,
    3,
    'every packaged desktop platform must execute its final unpacked app',
  );
  assert.ok(
    (workflow.match(/180(?:000|s| seconds)/g)?.length ?? 0) >= 3,
    'every packaged smoke test must have a bounded timeout',
  );

  assert.match(builder, /minimumSystemVersion: '13\.5'/);
  assert.match(builder, /- target: pkg[\s\S]*?- target: zip/);
  assert.match(workflow, /latest-mac\.yml/);
  assert.match(workflow, /packages\/app\/dist\/installers\/\*\.zip\.blockmap/);

  const rpmSection = builder.slice(builder.indexOf('\nrpm:'), builder.length);
  assert.match(rpmSection, /^\s{4}- gtk3$/m);
  assert.doesNotMatch(rpmSection, /^\s+- libgtk-3-0$/m);
  assert.match(workflow, /rpm -qpR/);

  assert.match(stamp, /packages\/core\/src\/index\.ts/);
  assert.equal(
    workflow.match(/node scripts\/verify-release-version\.mjs/g)?.length,
    4,
    'quality plus every platform build must verify release-version propagation',
  );

  assert.match(workflow, /mkdir -p release-assets/);
  assert.match(workflow, /release asset basename collision/);
  assert.doesNotMatch(workflow, /artifacts\/flat/);
  assert.doesNotMatch(workflow, /find artifacts .* -exec ln/);
});
