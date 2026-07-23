import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installNodeIfNeeded } from './extract-node.js';

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

describe('installNodeIfNeeded', () => {
  it('returns no-bundle when the bundle directory does not exist', async () => {
    await rm(bundleDir, { recursive: true, force: true });
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
  });

  it('returns no-bundle when the bundle dir exists but has no binary', async () => {
    // Simulates fetch-node skipping the download (placeholder shas).
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('no-bundle');
    expect(res.binaryPath).toBeNull();
  });

  it('installs the binary on a fresh home dir', async () => {
    await writeBundle('24.18.0');
    const res = await installNodeIfNeeded({ home, bundleDir });
    expect(res.action).toBe('fresh-install');
    expect(res.version).toBe('24.18.0');
    expect(res.binaryPath).toBeTruthy();
    expect(existsSync(res.binaryPath!)).toBe(true);
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
});
