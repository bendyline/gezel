import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoopbackCert } from './http/cert.js';
import { writeRuntime } from './runtime-discovery.js';

const CERT: LoopbackCert = {
  certPem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
  // Never written anywhere by writeRuntime — the private key is memory-only,
  // which is part of what this test protects.
  keyPem: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  sha256Hex: 'ab'.repeat(32),
  fingerprintBase64: 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=',
};

describe('writeRuntime rendezvous mirror', () => {
  let home: string;
  let mirror: string;
  const savedMirrorEnv = process.env.GEZEL_RUNTIME_MIRROR_DIR;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-runtime-'));
    mirror = join(await mkdtemp(join(tmpdir(), 'gezel-mirror-')), 'runtime');
    await writeFile(join(home, '.keep'), '');
  });

  afterEach(async () => {
    if (savedMirrorEnv === undefined) delete process.env.GEZEL_RUNTIME_MIRROR_DIR;
    else process.env.GEZEL_RUNTIME_MIRROR_DIR = savedMirrorEnv;
    await rm(home, { recursive: true, force: true });
    await rm(join(mirror, '..'), { recursive: true, force: true });
  });

  async function write(overrides: { cert?: typeof CERT | null; token?: string } = {}) {
    const paths = gezelPaths(home);
    await rm(paths.runtime.dir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(paths.runtime.dir, { recursive: true });
    await writeRuntime({
      paths,
      port: 6228,
      token: overrides.token ?? 'client-token-abc',
      pid: process.pid,
      cert: overrides.cert === undefined ? CERT : overrides.cert,
      webUiToken: null,
      serviceRole: 'user',
    });
  }

  it('does not publish a mirror unless one is configured', async () => {
    delete process.env.GEZEL_RUNTIME_MIRROR_DIR;
    await write();
    await expect(readdir(mirror)).rejects.toThrow();
  });

  it('publishes the discovery set a sandboxed client needs', async () => {
    process.env.GEZEL_RUNTIME_MIRROR_DIR = mirror;
    await write();
    expect(await readFile(join(mirror, 'port'), 'utf8')).toBe('6228\n');
    expect(await readFile(join(mirror, 'auth-token'), 'utf8')).toBe('client-token-abc');
    expect(await readFile(join(mirror, 'service-role'), 'utf8')).toBe('user\n');
    expect(await readFile(join(mirror, 'cert.pem'), 'utf8')).toBe(CERT.certPem);
    expect((await readFile(join(mirror, 'cert-fingerprint'), 'utf8')).trim()).toBe(CERT.sha256Hex);
    expect((await readFile(join(mirror, 'version'), 'utf8')).trim().length).toBeGreaterThan(0);
  });

  it('never mirrors the pid — a store client must not manage the daemon', async () => {
    process.env.GEZEL_RUNTIME_MIRROR_DIR = mirror;
    await write();
    expect(await readdir(mirror)).not.toContain('pid');
  });

  it('never mirrors private key material', async () => {
    process.env.GEZEL_RUNTIME_MIRROR_DIR = mirror;
    await write();
    for (const name of await readdir(mirror)) {
      const body = await readFile(join(mirror, name), 'utf8');
      expect(body, `${name} must not carry the private key`).not.toContain('PRIVATE KEY');
    }
  });

  it('rewrites a rotated token rather than failing on the existing file', async () => {
    process.env.GEZEL_RUNTIME_MIRROR_DIR = mirror;
    await write({ token: 'first-token' });
    await write({ token: 'second-token' });
    expect(await readFile(join(mirror, 'auth-token'), 'utf8')).toBe('second-token');
  });

  it('clears mirrored cert material when the daemon restarts insecure', async () => {
    process.env.GEZEL_RUNTIME_MIRROR_DIR = mirror;
    await write();
    await write({ cert: null });
    const entries = await readdir(mirror);
    expect(entries).not.toContain('cert.pem');
    expect(entries).not.toContain('cert-fingerprint');
  });

  it('never fails a daemon launch when the mirror cannot be written', async () => {
    // A file where the directory should be: mkdir fails, and the daemon must
    // still come up with its primary runtime dir intact.
    const blocked = join(home, 'blocked-mirror');
    await writeFile(blocked, 'not a directory');
    process.env.GEZEL_RUNTIME_MIRROR_DIR = join(blocked, 'runtime');
    await expect(write()).resolves.toBeUndefined();
    expect(await readFile(gezelPaths(home).runtime.port, 'utf8')).toBe('6228\n');
  });
});
