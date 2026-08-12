import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultNodeBundleDir, installNodeIfNeeded } from './extract-node.js';

let workRoot: string;
let home: string;
let bundleDir: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'gezel-node-test-'));
  home = join(workRoot, 'home');
  bundleDir = join(workRoot, 'bundle');
  await mkdir(home, { recursive: true });
  await mkdir(bundleDir, { recursive: true });
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function writeBundle(version: string, content = 'fake-node-binary'): Promise<void> {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  await writeFile(join(bundleDir, binary), content, 'utf8');
  await writeFile(join(bundleDir, 'version.txt'), `${version}\n`, 'utf8');
}

async function writeVerifiedBundle(version: string, content = 'fake-node-binary'): Promise<void> {
  await writeBundle(version, content);
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  const digest = createHash('sha256').update(content).digest('hex');
  await writeFile(join(bundleDir, 'sha256.txt'), `${digest}  ${binary}\n`, 'utf8');
}

describe('installNodeIfNeeded', () => {
  it('resolves packaged ASAR paths to the real unpacked directory', () => {
    const packagedMain =
      process.platform === 'win32'
        ? 'C:\\Program Files\\Gezel\\resources\\app.asar\\dist\\main.js'
        : '/Applications/Gezel.app/Contents/Resources/app.asar/dist/main.js';
    const expectedBundle =
      process.platform === 'win32'
        ? 'C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\dist\\node-bundle'
        : '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/dist/node-bundle';

    expect(defaultNodeBundleDir(pathToFileURL(packagedMain).href)).toBe(expectedBundle);
  });

  it('returns no-bundle when the bundle directory does not exist', async () => {
    await rm(bundleDir, { recursive: true, force: true });
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
    expect(res.verified).toBe(false);
  });

  it('returns no-bundle when the bundle dir exists but has no binary', async () => {
    // Simulates fetch-node skipping the download (placeholder shas).
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
    expect(res.verified).toBe(false);
  });

  it('installs the binary on a fresh home dir', async () => {
    await writeBundle('24.18.0');
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
    expect(res.version).toBe('24.18.0');
    expect(res.binaryPath).toBeTruthy();
    expect(existsSync(res.binaryPath!)).toBe(true);
    expect(res.verified).toBe(false);
  });

  it('reports up-to-date on a subsequent call with same version', async () => {
    await writeBundle('24.18.0');
    await installNodeIfNeeded({ home, bundleDir });
    const second = await installNodeIfNeeded({ home, bundleDir });
    expect(second.action).toBe('up-to-date');
    expect(second.version).toBe('24.18.0');
  });

  it('upgrades when the shipped version differs from the installed one', async () => {
    await writeBundle('24.18.0');
    await installNodeIfNeeded({ home, bundleDir });
    await writeBundle('22.12.0', 'fake-node-newer');
    const next = await installNodeIfNeeded({ home, bundleDir });
    expect(next.action).toBe('upgraded');
    expect(next.version).toBe('22.12.0');
    const contents = await readFile(next.binaryPath!, 'utf8');
    expect(contents).toBe('fake-node-newer');
  });

  it('sets the executable bit on POSIX', async () => {
    if (process.platform === 'win32') return;
    await writeBundle('24.18.0');
    const res = await installNodeIfNeeded({ home, bundleDir });
    const st = await stat(res.binaryPath!);
    // Owner-execute bit should be set (mode & 0o100).
    expect(st.mode & 0o100).toBeGreaterThan(0);
  });

  it('writes the version marker file for future boot checks', async () => {
    await writeBundle('24.18.0');
    await installNodeIfNeeded({ home, bundleDir });
    const marker = await readFile(join(home, 'bin', 'node.version'), 'utf8');
    expect(marker.trim()).toBe('24.18.0');
  });

  it('installs when the bundle sha256 manifest matches', async () => {
    await writeVerifiedBundle('24.18.0');
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
    expect(res.verified).toBe(true);
  });

  it('repairs an installed binary whose bytes changed behind the version marker', async () => {
    await writeVerifiedBundle('24.18.0');
    const first = await installNodeIfNeeded({ home, bundleDir });
    await writeFile(first.binaryPath!, 'tampered-installed-node');

    const next = await installNodeIfNeeded({ home, bundleDir });
    expect(next.action).toBe('refreshed');
    expect(next.verified).toBe(true);
    await expect(readFile(next.binaryPath!, 'utf8')).resolves.toBe('fake-node-binary');
  });

  it('replaces a corrupt destination symlink without overwriting its target', async () => {
    if (process.platform === 'win32') return;
    await writeVerifiedBundle('24.18.0');
    const installDir = join(home, 'bin');
    const installedBinary = join(installDir, 'node');
    const victim = join(workRoot, 'do-not-overwrite');
    await mkdir(installDir, { recursive: true });
    await writeFile(victim, 'private user data');
    await symlink(victim, installedBinary);
    await writeFile(join(installDir, 'node.version'), '24.18.0\n');

    const next = await installNodeIfNeeded({ home, bundleDir });
    expect(next.action).toBe('refreshed');
    await expect(readFile(victim, 'utf8')).resolves.toBe('private user data');
    expect((await lstat(installedBinary)).isSymbolicLink()).toBe(false);
    await expect(readFile(installedBinary, 'utf8')).resolves.toBe('fake-node-binary');
  });

  it('does not bypass a broken source manifest for an up-to-date install', async () => {
    await writeVerifiedBundle('24.18.0');
    await installNodeIfNeeded({ home, bundleDir });
    const binary = process.platform === 'win32' ? 'node.exe' : 'node';
    const wrongDigest = createHash('sha256').update('different-bytes').digest('hex');
    await writeFile(join(bundleDir, 'sha256.txt'), `${wrongDigest}  ${binary}\n`, 'utf8');

    const next = await installNodeIfNeeded({ home, bundleDir });
    expect(next.action).toBe('no-bundle');
    expect(next.binaryPath).toBeNull();
    expect(next.verified).toBe(false);
  });

  it('refuses to install a bundle whose binary fails the sha256 manifest', async () => {
    await writeBundle('24.18.0');
    const binary = process.platform === 'win32' ? 'node.exe' : 'node';
    const digestOfOtherBytes = createHash('sha256').update('tampered').digest('hex');
    await writeFile(join(bundleDir, 'sha256.txt'), `${digestOfOtherBytes}  ${binary}\n`, 'utf8');
    const warnings: string[] = [];
    const res = await installNodeIfNeeded({
      home,
      bundleDir,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
    expect(existsSync(join(home, 'bin', binary))).toBe(false);
    expect(warnings.join('\n')).toContain('integrity check');
  });

  it('refuses to install when the manifest is present but missing the binary entry', async () => {
    await writeBundle('24.18.0');
    await writeFile(join(bundleDir, 'sha256.txt'), '\n', 'utf8');
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
  });
});
