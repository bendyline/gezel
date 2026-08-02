import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPnpmBundleDir, installPnpmIfNeeded } from './extract-pnpm.js';

let workRoot: string;
let home: string;
let bundleDir: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'gezel-pnpm-test-'));
  home = join(workRoot, 'home');
  bundleDir = join(workRoot, 'bundle');
  await mkdir(home, { recursive: true });
  await mkdir(bundleDir, { recursive: true });
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function writeBundle(version: string, content = '// fake pnpm entry\n'): Promise<void> {
  await mkdir(join(bundleDir, 'bin'), { recursive: true });
  await mkdir(join(bundleDir, 'dist'), { recursive: true });
  await writeFile(join(bundleDir, 'bin', 'pnpm.mjs'), content, 'utf8');
  await writeFile(join(bundleDir, 'dist', 'pnpm.mjs'), '// fake runtime\n', 'utf8');
  await writeFile(join(bundleDir, 'dist', 'worker.js'), '// fake worker\n', 'utf8');
  await writeFile(
    join(bundleDir, 'dist', 'gezel-reflink-compat.cjs'),
    '// fake reflink compatibility\n',
    'utf8',
  );
  await writeFile(join(bundleDir, 'version.txt'), `${version}\n`, 'utf8');
}

function bundleManifest(entryDigest: string): string {
  const runtimeDigest = createHash('sha256').update('// fake runtime\n').digest('hex');
  const workerDigest = createHash('sha256').update('// fake worker\n').digest('hex');
  const compatDigest = createHash('sha256').update('// fake reflink compatibility\n').digest('hex');
  return (
    `${entryDigest}  bin/pnpm.mjs\n` +
    `${runtimeDigest}  dist/pnpm.mjs\n` +
    `${workerDigest}  dist/worker.js\n` +
    `${compatDigest}  dist/gezel-reflink-compat.cjs\n`
  );
}

describe('installPnpmIfNeeded', () => {
  it('resolves packaged ASAR paths to the real unpacked directory', () => {
    const packagedMain =
      process.platform === 'win32'
        ? 'C:\\Program Files\\Gezel\\resources\\app.asar\\dist\\main.js'
        : '/Applications/Gezel.app/Contents/Resources/app.asar/dist/main.js';
    const expectedBundle =
      process.platform === 'win32'
        ? 'C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\dist\\pnpm-bundle'
        : '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/dist/pnpm-bundle';

    expect(defaultPnpmBundleDir(pathToFileURL(packagedMain).href)).toBe(expectedBundle);
  });

  it('returns no-bundle when the bundle directory does not exist', async () => {
    await rm(bundleDir, { recursive: true, force: true });
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.entryPath).toBeNull();
  });

  it('returns no-bundle when the bundle dir exists but has no entrypoint', async () => {
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.entryPath).toBeNull();
  });

  it('installs the JavaScript package on a fresh home dir', async () => {
    await writeBundle('11.15.1');
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
    expect(res.version).toBe('11.15.1');
    expect(res.entryPath).toBeTruthy();
    expect(existsSync(res.entryPath!)).toBe(true);
  });

  it('reports up-to-date on a subsequent call with same version', async () => {
    await writeBundle('11.15.1');
    await installPnpmIfNeeded({ home, bundleDir });
    const second = await installPnpmIfNeeded({ home, bundleDir });
    expect(second.action).toBe('up-to-date');
    expect(second.version).toBe('11.15.1');
  });

  it('upgrades when the shipped version differs from the installed one', async () => {
    await writeBundle('11.15.1');
    await installPnpmIfNeeded({ home, bundleDir });
    await writeBundle('10.34.0', '// fake pnpm newer\n');
    const next = await installPnpmIfNeeded({ home, bundleDir });
    expect(next.action).toBe('upgraded');
    expect(next.version).toBe('10.34.0');
    const contents = await readFile(next.entryPath!, 'utf8');
    expect(contents).toBe('// fake pnpm newer\n');
  });

  it('writes the version marker file for future boot checks', async () => {
    await writeBundle('11.15.1');
    await installPnpmIfNeeded({ home, bundleDir });
    const marker = await readFile(join(home, 'bin', 'pnpm.version'), 'utf8');
    expect(marker.trim()).toBe('11.15.1');
  });

  it('installs when the bundle sha256 manifest matches', async () => {
    await writeBundle('11.15.1');
    const entryDigest = createHash('sha256').update('// fake pnpm entry\n').digest('hex');
    await writeFile(join(bundleDir, 'sha256.txt'), bundleManifest(entryDigest), 'utf8');
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
  });

  it('upgrades the same pnpm version when the staged bundle manifest changes', async () => {
    await writeBundle('11.15.1');
    const firstDigest = createHash('sha256').update('// fake pnpm entry\n').digest('hex');
    await writeFile(join(bundleDir, 'sha256.txt'), bundleManifest(firstDigest), 'utf8');
    await installPnpmIfNeeded({ home, bundleDir });

    await writeBundle('11.15.1', '// packaging patch at same pnpm version\n');
    const nextDigest = createHash('sha256')
      .update('// packaging patch at same pnpm version\n')
      .digest('hex');
    await writeFile(join(bundleDir, 'sha256.txt'), bundleManifest(nextDigest), 'utf8');
    const next = await installPnpmIfNeeded({ home, bundleDir });

    expect(next.action).toBe('upgraded');
    expect(await readFile(next.entryPath!, 'utf8')).toBe(
      '// packaging patch at same pnpm version\n',
    );
  });

  it('refuses to install a bundle whose files fail the sha256 manifest', async () => {
    await writeBundle('11.15.1');
    const wrongDigest = createHash('sha256').update('tampered').digest('hex');
    await writeFile(join(bundleDir, 'sha256.txt'), bundleManifest(wrongDigest), 'utf8');
    const warnings: string[] = [];
    const res = await installPnpmIfNeeded({
      home,
      bundleDir,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(res.action).toBe('no-bundle');
    expect(res.entryPath).toBeNull();
    expect(existsSync(join(home, 'bin', 'pnpm-runtime'))).toBe(false);
    expect(warnings.join('\n')).toContain('integrity check');
  });
});
