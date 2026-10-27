import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const builderPath = require.resolve('../scripts/build-installer-security.cjs');
const beforePackPath = require.resolve('../scripts/before-pack.cjs');

interface InstallerSecurity {
  compileInstallerSecurity(outFile?: string): string;
  findCompiler(env?: Record<string, string | undefined>): string | null;
}
type BeforePack = (context: { electronPlatformName: string }) => Promise<void>;

const builder = require(builderPath) as InstallerSecurity;

// before-pack.cjs binds the compiler when it loads, so load a fresh copy
// against a stand-in rather than ever running csc from here.
function beforePackWith(compile: InstallerSecurity['compileInstallerSecurity']): BeforePack {
  const original = builder.compileInstallerSecurity;
  builder.compileInstallerSecurity = compile;
  delete require.cache[beforePackPath];
  try {
    return require(beforePackPath) as BeforePack;
  } finally {
    builder.compileInstallerSecurity = original;
    delete require.cache[beforePackPath];
  }
}

describe('beforePack', () => {
  // The Developer ID, MAS and Linux builds load the same hook: compiling there
  // would fail every non-Windows release, since csc exists only on Windows.
  it('compiles the permission helper for Windows targets only', async () => {
    const calls: unknown[][] = [];
    const beforePack = beforePackWith((...args) => {
      calls.push(args);
      return 'gezel-acl.exe';
    });
    for (const platform of ['darwin', 'mas', 'linux']) {
      await beforePack({ electronPlatformName: platform });
    }
    expect(calls).toEqual([]);

    await beforePack({ electronPlatformName: 'win32' });
    expect(calls).toEqual([[]]);
  });

  it('fails the build when the helper does not compile', async () => {
    const beforePack = beforePackWith(() => {
      throw new Error('[installer-security] csc exited 1');
    });
    await expect(beforePack({ electronPlatformName: 'win32' })).rejects.toThrow('csc exited 1');
  });
});

describe('findCompiler', () => {
  it('prefers the 64-bit .NET Framework compiler and falls back to the 32-bit one', () => {
    const windows = mkdtempSync(join(tmpdir(), 'gezel-csc-'));
    try {
      const compiler = (framework: string) =>
        join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
      expect(builder.findCompiler({ SystemRoot: windows })).toBeNull();

      mkdirSync(join(compiler('Framework'), '..'), { recursive: true });
      writeFileSync(compiler('Framework'), '');
      expect(builder.findCompiler({ SystemRoot: windows })).toBe(compiler('Framework'));
      expect(builder.findCompiler({ windir: windows })).toBe(compiler('Framework'));

      mkdirSync(join(compiler('Framework64'), '..'), { recursive: true });
      writeFileSync(compiler('Framework64'), '');
      expect(builder.findCompiler({ SystemRoot: windows })).toBe(compiler('Framework64'));
    } finally {
      rmSync(windows, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.platform === 'win32')('refuses to build the Windows helper off Windows', () => {
  expect(() => builder.compileInstallerSecurity(join(tmpdir(), 'gezel-acl.exe'))).toThrow(
    /package Windows targets on Windows/,
  );
});
