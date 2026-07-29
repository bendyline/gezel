import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

test('release stamping updates packages, runtime constant, service metadata, and SBOM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-version-stamp-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'service'), { recursive: true });
    await mkdir(join(root, 'artifacts'), { recursive: true });

    await Promise.all([
      copyFile(join(here, 'stamp-version.mjs'), join(root, 'scripts', 'stamp-version.mjs')),
      copyFile(
        join(here, 'verify-release-version.mjs'),
        join(root, 'scripts', 'verify-release-version.mjs'),
      ),
    ]);

    for (const path of [
      join(root, 'package.json'),
      join(root, 'packages', 'app', 'package.json'),
      join(root, 'packages', 'core', 'package.json'),
      join(root, 'packages', 'service', 'package.json'),
    ]) {
      await writeFile(path, `${JSON.stringify({ name: 'fixture', version: '0.0.0' }, null, 2)}\n`);
    }
    await writeFile(
      join(root, 'packages', 'core', 'src', 'index.ts'),
      "export const BEFORE = true;\nexport const GEZEL_VERSION = '0.0.0';\n",
    );

    const version = '1.26123.45';
    await execFileP(process.execPath, [
      join(root, 'scripts', 'stamp-version.mjs'),
      '--version',
      version,
    ]);

    for (const path of [
      join(root, 'package.json'),
      join(root, 'packages', 'app', 'package.json'),
      join(root, 'packages', 'core', 'package.json'),
      join(root, 'packages', 'service', 'package.json'),
    ]) {
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(pkg.version, version);
    }
    assert.match(
      await readFile(join(root, 'packages', 'core', 'src', 'index.ts'), 'utf8'),
      /GEZEL_VERSION = '1\.26123\.45'/,
    );

    const serviceMeta = join(root, 'service-bundle.meta.json');
    const sbom = join(root, 'artifacts', 'gezel.cdx.json');
    await writeFile(serviceMeta, JSON.stringify({ version }));
    await writeFile(
      sbom,
      JSON.stringify({
        metadata: {
          component: {
            version,
            'bom-ref': `pkg:npm/gezel@${version}`,
          },
        },
      }),
    );

    await execFileP(
      process.execPath,
      [
        join(root, 'scripts', 'verify-release-version.mjs'),
        '--version',
        version,
        '--service-meta',
        'service-bundle.meta.json',
        '--sbom',
        'artifacts/gezel.cdx.json',
      ],
      { cwd: root },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--print computes a release version without mutating the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-version-print-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(join(here, 'stamp-version.mjs'), join(root, 'scripts', 'stamp-version.mjs'));
    const { stdout } = await execFileP(process.execPath, [
      join(root, 'scripts', 'stamp-version.mjs'),
      '--inc',
      '7',
      '--print',
    ]);
    assert.match(stdout.trim(), /^1\.\d{5}\.7$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing runtime version declaration does not partially stamp package files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-version-atomic-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'service'), { recursive: true });
    await copyFile(join(here, 'stamp-version.mjs'), join(root, 'scripts', 'stamp-version.mjs'));

    const paths = [
      join(root, 'package.json'),
      join(root, 'packages', 'app', 'package.json'),
      join(root, 'packages', 'core', 'package.json'),
      join(root, 'packages', 'service', 'package.json'),
    ];
    for (const path of paths) {
      await writeFile(path, `${JSON.stringify({ name: 'fixture', version: '0.0.0' }, null, 2)}\n`);
    }
    await writeFile(
      join(root, 'packages', 'core', 'src', 'index.ts'),
      'export const WRONG_CONSTANT = true;\n',
    );

    await assert.rejects(
      execFileP(process.execPath, [
        join(root, 'scripts', 'stamp-version.mjs'),
        '--version',
        '1.26123.45',
      ]),
    );
    for (const path of paths) {
      expectVersion(await readFile(path, 'utf8'), '0.0.0');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function expectVersion(source, version) {
  assert.equal(JSON.parse(source).version, version);
}
