/**
 * The vendored MXC launcher resolve path.
 *
 * Hermetic: a stand-in npm tarball is served from a stub fetch and the
 * signature check is overridden, so nothing here touches the network or
 * PowerShell, and it runs on every platform through the `platform` seam. The
 * live path (Microsoft's real tarball and signature) is exercised by hand when
 * the pin moves; what must never regress silently is the rejection behaviour.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ResolveVendoredMxcOptions,
  resolveVendoredMxc,
} from '@bendyline/gezel-inference/internal/engines/resolver';
import type { verifyCodeSignature } from '@bendyline/gezel-inference/internal/engines/signature';
import { MXC_VERSION, mxcInstallDir } from '@bendyline/gezel/native';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let home: string;
let scratch: string;
const priorProfile = process.env.GEZEL_DISTRIBUTION_PROFILE;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mxc-resolve-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-mxc-tarball-'));
  delete process.env.GEZEL_DISTRIBUTION_PROFILE;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  if (priorProfile === undefined) delete process.env.GEZEL_DISTRIBUTION_PROFILE;
  else process.env.GEZEL_DISTRIBUTION_PROFILE = priorProfile;
});

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

interface FakePackage {
  tarball: Buffer;
  integrity: string;
  tarballSha: string;
  executorSha: string;
  licenseSha: string;
}

/** An npm-shaped tarball holding a stand-in launcher per arch. */
async function fakePackage(launcher = 'x64-launcher'): Promise<FakePackage> {
  const root = join(scratch, 'src');
  await rm(root, { recursive: true, force: true });
  for (const arch of ['x64', 'arm64']) {
    await mkdir(join(root, 'package', 'bin', arch), { recursive: true });
    await writeFile(
      join(root, 'package', 'bin', arch, 'wxc-exec.exe'),
      arch === 'x64' ? launcher : 'arm64-launcher',
    );
  }
  await writeFile(join(root, 'package', 'LICENSE.md'), 'MIT License');
  await writeFile(join(root, 'package', 'unrelated.dll'), 'not shipped');
  const file = join(scratch, 'package.tgz');
  await tar.create({ gzip: true, cwd: root, file, portable: true }, ['package']);
  const tarball = await readFile(file);
  return {
    tarball,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    tarballSha: sha256(tarball),
    executorSha: sha256(launcher),
    licenseSha: sha256('MIT License'),
  };
}

function stubFetch(body: Buffer, calls: { count: number }): typeof fetch {
  return (async () => {
    calls.count += 1;
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    });
  }) as unknown as typeof fetch;
}

const accept: typeof verifyCodeSignature = async () => ({
  result: { status: 'valid' },
  accepted: true,
});

function opts(pkg: FakePackage, calls = { count: 0 }): ResolveVendoredMxcOptions {
  return {
    platform: 'win32',
    arch: 'x64',
    fetchImpl: stubFetch(pkg.tarball, calls),
    tarballUrl: 'https://example.invalid/mxc-sdk.tgz',
    expectedIntegrity: pkg.integrity,
    expectedTarballSha256: pkg.tarballSha,
    expectedExecutorSha256: pkg.executorSha,
    expectedLicenseSha256: pkg.licenseSha,
    verifyOverride: accept,
  };
}

const executorPath = () => join(mxcInstallDir(home), 'wxc-exec.exe');

describe('resolveVendoredMxc', () => {
  it('lands only the launcher, its license and a sentinel in the shared directory', async () => {
    const pkg = await fakePackage();
    const path = await resolveVendoredMxc(home, opts(pkg));

    expect(path).toBe(executorPath());
    expect(await readFile(path as string, 'utf8')).toBe('x64-launcher');
    expect(existsSync(join(mxcInstallDir(home), 'LICENSE.txt'))).toBe(true);
    expect(existsSync(join(mxcInstallDir(home), 'unrelated.dll'))).toBe(false);
    expect(existsSync(join(mxcInstallDir(home), 'package'))).toBe(false);
    const sentinel = JSON.parse(
      await readFile(join(mxcInstallDir(home), '.verified.json'), 'utf8'),
    );
    expect(sentinel).toMatchObject({
      engine: 'mxc',
      version: MXC_VERSION,
      arch: 'x64',
      sha256: pkg.executorSha,
      source: 'npm-download',
    });
  });

  it('serves the second call from the verified install', async () => {
    const pkg = await fakePackage();
    const calls = { count: 0 };
    await resolveVendoredMxc(home, opts(pkg, calls));
    expect(await resolveVendoredMxc(home, opts(pkg, calls))).toBe(executorPath());
    expect(calls.count).toBe(1);
  });

  it('shares one download between concurrent callers', async () => {
    const pkg = await fakePackage();
    const calls = { count: 0 };
    const both = await Promise.all([
      resolveVendoredMxc(home, opts(pkg, calls)),
      resolveVendoredMxc(home, opts(pkg, calls)),
    ]);
    expect(both).toEqual([executorPath(), executorPath()]);
    expect(calls.count).toBe(1);
  });

  it('never downloads when told not to', async () => {
    const pkg = await fakePackage();
    const calls = { count: 0 };
    expect(await resolveVendoredMxc(home, { ...opts(pkg, calls), allowDownload: false })).toBe(
      null,
    );
    expect(calls.count).toBe(0);

    await resolveVendoredMxc(home, opts(pkg, calls));
    expect(await resolveVendoredMxc(home, { ...opts(pkg, calls), allowDownload: false })).toBe(
      executorPath(),
    );
  });

  it('refuses to download in a store build', async () => {
    process.env.GEZEL_DISTRIBUTION_PROFILE = 'store';
    const pkg = await fakePackage();
    const calls = { count: 0 };
    expect(await resolveVendoredMxc(home, opts(pkg, calls))).toBeNull();
    expect(calls.count).toBe(0);
  });

  it('refuses a tarball whose integrity does not match the pin', async () => {
    const pkg = await fakePackage();
    const result = await resolveVendoredMxc(home, {
      ...opts(pkg),
      expectedIntegrity: `sha512-${'A'.repeat(86)}==`,
    });
    expect(result).toBeNull();
    expect(existsSync(executorPath())).toBe(false);
  });

  it('refuses a correctly-hashed tarball whose launcher is not the pinned one', async () => {
    const pkg = await fakePackage();
    const result = await resolveVendoredMxc(home, {
      ...opts(pkg),
      expectedExecutorSha256: 'a'.repeat(64),
    });
    expect(result).toBeNull();
    expect(existsSync(executorPath())).toBe(false);
  });

  it('refuses a launcher that fails the Microsoft signature check', async () => {
    const pkg = await fakePackage();
    let asked: unknown;
    const result = await resolveVendoredMxc(home, {
      ...opts(pkg),
      verifyOverride: async (_path, verify) => {
        asked = verify;
        return { result: { status: 'invalid', detail: 'wrong publisher' }, accepted: false };
      },
    });
    expect(result).toBeNull();
    expect(asked).toMatchObject({ policy: 'require', expectedPublisher: 'Microsoft Corporation' });
    expect(existsSync(executorPath())).toBe(false);
  });

  it('replaces an install whose bytes no longer match its sentinel', async () => {
    const pkg = await fakePackage();
    await resolveVendoredMxc(home, opts(pkg));
    await writeFile(executorPath(), 'tampered');

    expect(await resolveVendoredMxc(home, { ...opts(pkg), allowDownload: false })).toBeNull();
    expect(await resolveVendoredMxc(home, opts(pkg))).toBe(executorPath());
    expect(await readFile(executorPath(), 'utf8')).toBe('x64-launcher');
  });

  it('returns null off Windows and where MXC ships no launcher', async () => {
    const pkg = await fakePackage();
    const calls = { count: 0 };
    expect(await resolveVendoredMxc(home, { ...opts(pkg, calls), platform: 'linux' })).toBeNull();
    expect(await resolveVendoredMxc(home, { ...opts(pkg, calls), arch: null })).toBeNull();
    expect(calls.count).toBe(0);
  });
});

describe('resolveVendoredMxc — installed launcher that fails its signature', () => {
  it('does not re-download bytes that already match the pin', async () => {
    const pkg = await fakePackage();
    const calls = { count: 0 };
    await resolveVendoredMxc(home, opts(pkg, calls));
    const rejected = await resolveVendoredMxc(home, {
      ...opts(pkg, calls),
      verifyOverride: async () => ({ result: { status: 'invalid' }, accepted: false }),
    });
    expect(rejected).toBeNull();
    expect(calls.count).toBe(1);
  });
});
