import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyBundleManifest } from './bundle-manifest.js';

let bundleDir: string;

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'gezel-manifest-test-'));
});

afterEach(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

describe('verifyBundleManifest', () => {
  it('skips when no manifest ships (dev bundles)', async () => {
    await writeFile(join(bundleDir, 'bin'), 'payload', 'utf8');
    const res = await verifyBundleManifest(bundleDir, ['bin']);
    expect(res).toEqual({ ok: true, skipped: true });
  });

  it('passes when every requested file matches its manifest entry', async () => {
    await mkdir(join(bundleDir, 'dist'), { recursive: true });
    await writeFile(join(bundleDir, 'bin'), 'payload', 'utf8');
    await writeFile(join(bundleDir, 'dist', 'entry.mjs'), 'runtime', 'utf8');
    await writeFile(
      join(bundleDir, 'sha256.txt'),
      `${sha('payload')}  bin\n${sha('runtime')}  dist/entry.mjs\n`,
      'utf8',
    );
    const res = await verifyBundleManifest(bundleDir, ['bin', 'dist/entry.mjs']);
    expect(res).toEqual({ ok: true, skipped: false });
  });

  it('fails on a hash mismatch', async () => {
    await writeFile(join(bundleDir, 'bin'), 'payload', 'utf8');
    await writeFile(join(bundleDir, 'sha256.txt'), `${sha('other')}  bin\n`, 'utf8');
    const res = await verifyBundleManifest(bundleDir, ['bin']);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('mismatch');
  });

  it('fails when a requested file has no manifest entry', async () => {
    await writeFile(join(bundleDir, 'bin'), 'payload', 'utf8');
    await writeFile(join(bundleDir, 'sha256.txt'), `${sha('payload')}  other-file\n`, 'utf8');
    const res = await verifyBundleManifest(bundleDir, ['bin']);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('no entry');
  });
});
