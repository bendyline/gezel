import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MXC_EXECUTOR_SHA256,
  MXC_TARBALL_INTEGRITY,
  MXC_TARBALL_SHA256,
  MXC_TARBALL_URL,
  MXC_VERIFIED_SENTINEL,
  MXC_VERSION,
  mxcArch,
  mxcInstallDir,
  mxcInstalledExecutor,
  readVerifiedMxcExecutor,
} from './mxc-pin.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-mxc-pin-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function install(sentinel: Record<string, unknown> | string, executor = true) {
  mkdirSync(mxcInstallDir(home), { recursive: true });
  if (executor) writeFileSync(mxcInstalledExecutor(home), 'launcher');
  writeFileSync(
    join(mxcInstallDir(home), MXC_VERIFIED_SENTINEL),
    typeof sentinel === 'string' ? sentinel : JSON.stringify(sentinel),
  );
}

describe('mxcArch', () => {
  it.each([
    ['x86_64', 'x64'],
    ['AMD64', 'x64'],
    ['arm64', 'arm64'],
    ['ARM64', 'arm64'],
    ['aarch64', 'arm64'],
    ['i686', null],
    ['armv7l', null],
  ] as const)('maps %s to %s', (machineType, expected) => {
    expect(mxcArch(machineType)).toBe(expected);
  });
});

describe('pin', () => {
  it('is real, not a placeholder', () => {
    for (const sha of [MXC_TARBALL_SHA256, ...Object.values(MXC_EXECUTOR_SHA256)]) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(sha).not.toMatch(/^0+$/);
    }
    expect(MXC_TARBALL_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(MXC_TARBALL_URL).toContain(`mxc-sdk-${MXC_VERSION}.tgz`);
  });

  it('installs into the versioned engines directory', () => {
    expect(mxcInstalledExecutor(home)).toBe(
      join(home, 'engines', 'mxc', MXC_VERSION, 'wxc-exec.exe'),
    );
  });
});

describe('readVerifiedMxcExecutor', () => {
  it('returns the launcher when the sentinel matches this pin and arch', () => {
    install({ engine: 'mxc', version: MXC_VERSION, arch: 'x64', sha256: MXC_EXECUTOR_SHA256.x64 });
    expect(readVerifiedMxcExecutor(home, 'x64')).toBe(mxcInstalledExecutor(home));
  });

  it('refuses the other arch’s launcher', () => {
    install({
      engine: 'mxc',
      version: MXC_VERSION,
      arch: 'arm64',
      sha256: MXC_EXECUTOR_SHA256.arm64,
    });
    expect(readVerifiedMxcExecutor(home, 'x64')).toBeNull();
  });

  it('refuses a sentinel from another version', () => {
    install({ engine: 'mxc', version: '0.9.0', arch: 'x64', sha256: MXC_EXECUTOR_SHA256.x64 });
    expect(readVerifiedMxcExecutor(home, 'x64')).toBeNull();
  });

  it('refuses an unpinned digest', () => {
    install({ engine: 'mxc', version: MXC_VERSION, arch: 'x64', sha256: 'f'.repeat(64) });
    expect(readVerifiedMxcExecutor(home, 'x64')).toBeNull();
  });

  it('refuses a sentinel with no launcher beside it', () => {
    install(
      { engine: 'mxc', version: MXC_VERSION, arch: 'x64', sha256: MXC_EXECUTOR_SHA256.x64 },
      false,
    );
    expect(readVerifiedMxcExecutor(home, 'x64')).toBeNull();
  });

  it('refuses a launcher with no sentinel, or a corrupt one', () => {
    expect(readVerifiedMxcExecutor(home, 'x64')).toBeNull();
    install('{not json');
    expect(readVerifiedMxcExecutor(home, 'x64')).toBeNull();
  });

  it('returns null where MXC ships no launcher', () => {
    install({ engine: 'mxc', version: MXC_VERSION, arch: 'x64', sha256: MXC_EXECUTOR_SHA256.x64 });
    expect(readVerifiedMxcExecutor(home, null)).toBeNull();
  });
});
