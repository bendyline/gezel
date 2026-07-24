import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPnpmIfNeeded } from './extract-pnpm.js';

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

async function writeBundle(version: string, content = 'fake-pnpm-binary'): Promise<void> {
  const binary = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
  await mkdir(join(bundleDir, 'dist'), { recursive: true });
  await writeFile(join(bundleDir, binary), content, 'utf8');
  await writeFile(join(bundleDir, 'dist', 'pnpm.mjs'), '// fake runtime\n', 'utf8');
  await writeFile(join(bundleDir, 'version.txt'), `${version}\n`, 'utf8');
}

describe('installPnpmIfNeeded', () => {
  it('returns no-bundle when the bundle directory does not exist', async () => {
    await rm(bundleDir, { recursive: true, force: true });
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
  });

  it('returns no-bundle when the bundle dir exists but has no binary', async () => {
    // Simulates fetch-pnpm skipping the download (placeholder shas).
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
  });

  it('installs the binary on a fresh home dir', async () => {
    await writeBundle('11.15.1');
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
    expect(res.version).toBe('11.15.1');
    expect(res.binaryPath).toBeTruthy();
    expect(existsSync(res.binaryPath!)).toBe(true);
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
    await writeBundle('10.34.0', 'fake-pnpm-newer');
    const next = await installPnpmIfNeeded({ home, bundleDir });
    expect(next.action).toBe('upgraded');
    expect(next.version).toBe('10.34.0');
    const contents = await readFile(next.binaryPath!, 'utf8');
    expect(contents).toBe('fake-pnpm-newer');
  });

  it('sets the executable bit on POSIX', async () => {
    if (process.platform === 'win32') return;
    await writeBundle('11.15.1');
    const res = await installPnpmIfNeeded({ home, bundleDir });
    const st = await stat(res.binaryPath!);
    // Owner-execute bit should be set (mode & 0o100).
    expect(st.mode & 0o100).toBeGreaterThan(0);
  });

  it('writes the version marker file for future boot checks', async () => {
    await writeBundle('11.15.1');
    await installPnpmIfNeeded({ home, bundleDir });
    const marker = await readFile(join(home, 'bin', 'pnpm.version'), 'utf8');
    expect(marker.trim()).toBe('11.15.1');
  });

  it('installs when the bundle sha256 manifest matches', async () => {
    await writeBundle('11.15.1');
    const binary = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
    const binDigest = createHash('sha256').update('fake-pnpm-binary').digest('hex');
    const mjsDigest = createHash('sha256').update('// fake runtime\n').digest('hex');
    await writeFile(
      join(bundleDir, 'sha256.txt'),
      `${binDigest}  ${binary}\n${mjsDigest}  dist/pnpm.mjs\n`,
      'utf8',
    );
    const res = await installPnpmIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
  });

  it('refuses to install a bundle whose files fail the sha256 manifest', async () => {
    await writeBundle('11.15.1');
    const binary = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
    const wrongDigest = createHash('sha256').update('tampered').digest('hex');
    const mjsDigest = createHash('sha256').update('// fake runtime\n').digest('hex');
    await writeFile(
      join(bundleDir, 'sha256.txt'),
      `${wrongDigest}  ${binary}\n${mjsDigest}  dist/pnpm.mjs\n`,
      'utf8',
    );
    const warnings: string[] = [];
    const res = await installPnpmIfNeeded({
      home,
      bundleDir,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
    expect(existsSync(join(home, 'bin', 'pnpm-runtime'))).toBe(false);
    expect(warnings.join('\n')).toContain('integrity check');
  });
});
