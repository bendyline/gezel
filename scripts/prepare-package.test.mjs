import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clearReleasePackageState, readReleasePackageState } from './release-package-state.mjs';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const DECLARATION =
  "export const GEZEL_VERSION = '0.0.0';\nexport const GEZEL_CONTENT_COMPAT = '0.0.0';\n";

/** A throwaway repo root holding a copy of the script and a core source file. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gezel-prepare-package-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true });
  await mkdir(join(root, 'packages', 'client'), { recursive: true });
  await mkdir(join(root, 'packages', 'cli'), { recursive: true });
  await copyFile(join(here, 'prepare-package.mjs'), join(root, 'scripts', 'prepare-package.mjs'));
  await copyFile(
    join(here, 'workspace-dependencies.mjs'),
    join(root, 'scripts', 'workspace-dependencies.mjs'),
  );
  await copyFile(
    join(here, 'release-package-state.mjs'),
    join(root, 'scripts', 'release-package-state.mjs'),
  );
  // prepare-package imports it to derive the content-compat calendar line.
  await copyFile(join(here, 'calver.mjs'), join(root, 'scripts', 'calver.mjs'));
  await copyFile(join(here, 'pnpm-cli.mjs'), join(root, 'scripts', 'pnpm-cli.mjs'));
  await writeFile(join(root, 'packages', 'core', 'src', 'index.ts'), DECLARATION);
  await writeFile(
    join(root, 'packages', 'core', 'package.json'),
    `${JSON.stringify({ name: '@bendyline/gezel', version: '0.1.0' }, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'packages', 'client', 'package.json'),
    `${JSON.stringify({ name: '@bendyline/gezel-client', version: '0.1.0' }, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'packages', 'cli', 'package.json'),
    `${JSON.stringify(
      {
        name: '@bendyline/gezel-cli',
        version: '0.1.0',
        dependencies: { '@bendyline/gezel-client': 'workspace:*' },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

const script = (root) => join(root, 'scripts', 'prepare-package.mjs');
const dryRun = { GEZEL_RELEASE_DRY_RUN: '1' };

async function run(root, cwd, args, env = {}) {
  return execFileP('node', [script(root), ...args], {
    cwd: join(root, cwd),
    env: { ...process.env, ...env },
  });
}

test('preserves release state for an unchanged workspace edge without rebuilding core', async () => {
  const root = await fixture();
  const packageName = '@bendyline/gezel-cli';
  try {
    const { stdout } = await run(root, 'packages/cli', ['1.2.3']);
    assert.equal(stdout.trim(), '');
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);
    const releaseState = readReleasePackageState({
      repoRoot: root,
      packageName,
      packageVersion: '0.1.0',
    });
    assert.ok(releaseState, 'workspace:* edge did not produce fail-closed publish state');
    assert.equal(
      JSON.parse(releaseState.source).dependencies['@bendyline/gezel-client'],
      'workspace:*',
    );
  } finally {
    clearReleasePackageState({ repoRoot: root, packageName });
    await rm(root, { recursive: true, force: true });
  }
});

test('publish fails closed when a package with workspace edges has no prepare state', async () => {
  const root = await fixture();
  await copyFile(join(here, 'publish-package.mjs'), join(root, 'scripts', 'publish-package.mjs'));
  try {
    await assert.rejects(
      () =>
        execFileP(process.execPath, [join(root, 'scripts', 'publish-package.mjs')], {
          cwd: join(root, 'packages', 'cli'),
          env: process.env,
        }),
      (err) =>
        err.code === 1 &&
        /refusing to publish .* without prepare-time release state/.test(err.stderr),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restores workspace dependency specifiers before a non-core release commit', async () => {
  const root = await fixture();
  const packageName = '@bendyline/gezel-cli';
  try {
    const manifestPath = join(root, 'packages', 'cli', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dependencies['@bendyline/gezel-client'] = '1.0.0';
    manifest.dependencies.commander = '^15.0.0';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const { stdout } = await run(root, 'packages/cli', ['1.2.3']);
    assert.match(stdout, /restored 1 workspace dependency specifier/);
    const normalized = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(normalized.dependencies['@bendyline/gezel-client'], 'workspace:*');
    assert.equal(normalized.dependencies.commander, '^15.0.0');
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);

    const releaseState = readReleasePackageState({
      repoRoot: root,
      packageName,
      packageVersion: '0.1.0',
    });
    assert.ok(releaseState, 'computed dependency versions were not preserved for publish');
    assert.equal(JSON.parse(releaseState.source).dependencies['@bendyline/gezel-client'], '1.0.0');
  } finally {
    clearReleasePackageState({ repoRoot: root, packageName });
    await rm(root, { recursive: true, force: true });
  }
});

test('dry run reports dependency normalization without changing the manifest', async () => {
  const root = await fixture();
  try {
    const manifestPath = join(root, 'packages', 'cli', 'package.json');
    const source = (await readFile(manifestPath, 'utf8')).replace('workspace:*', '1.0.0');
    await writeFile(manifestPath, source);

    const { stdout } = await run(root, 'packages/cli', ['1.2.3'], dryRun);
    assert.match(stdout, /would restore 1 workspace dependency specifier/);
    assert.equal(await readFile(manifestPath, 'utf8'), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing or malformed version argument', async () => {
  const root = await fixture();
  try {
    for (const args of [[], ['not-a-version'], ['1.2']]) {
      await assert.rejects(
        () => run(root, 'packages/core', args, dryRun),
        (err) => err.code === 1 && /expected a version argument/.test(err.stderr),
        `expected rejection for ${JSON.stringify(args)}`,
      );
    }
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails loudly when the GEZEL_VERSION declaration has drifted', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'packages', 'core', 'src', 'index.ts'),
      'export const GEZEL_VERSION = "0.0.0";\n',
    );
    await assert.rejects(
      () => run(root, 'packages/core', ['1.2.3'], dryRun),
      (err) => err.code === 1 && /could not find GEZEL_VERSION declaration/.test(err.stderr),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails loudly when the GEZEL_CONTENT_COMPAT declaration has drifted', async () => {
  // Without the stamp the published build keeps the '0.0.0' dev sentinel, which
  // satisfiesMinGezelVersion reads as "dev build, gate nothing" — every content
  // floor silently stops applying for everyone on that release.
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'packages', 'core', 'src', 'index.ts'),
      "export const GEZEL_VERSION = '0.0.0';\n",
    );
    await assert.rejects(
      () => run(root, 'packages/core', ['1.2.3'], dryRun),
      (err) => err.code === 1 && /could not find GEZEL_CONTENT_COMPAT declaration/.test(err.stderr),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry run reports both stamps without writing or rebuilding', async () => {
  const root = await fixture();
  try {
    const { stdout } = await run(root, 'packages/core', ['1.2.3'], dryRun);
    assert.match(stdout, /would stamp GEZEL_VERSION = '1\.2\.3'/);
    // The compat line is derived from today, not from the published version.
    assert.match(stdout, /GEZEL_CONTENT_COMPAT = '1\.\d{5}'/);
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('core preparation rebuilds through the cross-platform pnpm JavaScript launcher', async () => {
  const root = await fixture();
  const pnpmCli = join(root, 'pnpm.mjs');
  try {
    await writeFile(
      pnpmCli,
      [
        "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "import { resolve } from 'node:path';",
        "const source = readFileSync(resolve('packages/core/src/index.ts'), 'utf8');",
        "const version = source.match(/GEZEL_VERSION = '([^']+)'/)?.[1];",
        "const compat = source.match(/GEZEL_CONTENT_COMPAT = '([^']+)'/)?.[1];",
        "mkdirSync(resolve('packages/core/dist'), { recursive: true });",
        "writeFileSync(resolve('packages/core/dist/index.js'), `var GEZEL_VERSION = \"${version}\";\\nvar GEZEL_CONTENT_COMPAT = \"${compat}\";\\n`);",
      ].join('\n'),
    );
    const { stdout } = await run(root, 'packages/core', ['1.2.3'], {
      GEZEL_PNPM_CLI: pnpmCli,
    });
    assert.match(stdout, /core dist carries 1\.2\.3/);
    assert.match(
      await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'),
      /GEZEL_VERSION = '1\.2\.3'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the release config normalizes package state before committing without creating GitHub Releases', async () => {
  // A dropped hook is the exact failure this script exists to prevent: the
  // release succeeds and every published package reports 0.0.0 forever.
  const config = JSON.parse(await readFile(join(here, '..', '.releaserc.json'), 'utf8'));
  const exec = config.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec',
  );
  assert.ok(exec, '@semantic-release/exec is not configured');
  assert.match(
    exec[1].prepareCmd ?? '',
    /scripts\/prepare-package\.mjs \$\{nextRelease\.version\}/,
  );
  assert.match(exec[1].prepareCmd ?? '', /scripts\/format-release-manifest\.mjs/);
  assert.match(exec[1].publishCmd ?? '', /scripts\/publish-package\.mjs/);
  const execIndex = config.plugins.indexOf(exec);
  const npmIndex = config.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/npm',
  );
  const gitIndex = config.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/git',
  );
  assert.ok(
    npmIndex < execIndex,
    '@semantic-release/npm must stamp the package version before prepare-package runs',
  );
  assert.ok(
    execIndex < gitIndex,
    'prepare-package must normalize package.json before git commits it',
  );
  assert.equal(
    config.plugins.some(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/github',
    ),
    false,
    'npm package tags must not create one public GitHub Release per package',
  );
});

test('the real core source carries the declarations the script rewrites', async () => {
  const source = await readFile(join(here, '..', 'packages', 'core', 'src', 'index.ts'), 'utf8');
  assert.match(source, /export const GEZEL_VERSION = '[^']*';/);
  assert.match(source, /export const GEZEL_CONTENT_COMPAT = '[^']*';/);
});
