import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installedAppRoots,
  pinnedLlamaRevision,
  resolveLlamaBinary,
  shouldProbeLlamaBackend,
} from './native-bin.ts';

/**
 * A stub binary plus the `gezel-llama-build.json` sidecar that `build.sh`
 * stages beside every real one. Each call gets a fresh directory so the
 * per-path probe memoization can't leak between cases.
 */
function stubEngine(opts: { revision?: string; backend?: string; executable?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-llama-bin-'));
  const bin = join(dir, 'gezel-llama-server');
  writeFileSync(bin, '#!/bin/sh\n', { mode: opts.executable ? 0o755 : 0o644 });
  if (opts.revision) {
    writeFileSync(
      join(dir, 'gezel-llama-build.json'),
      JSON.stringify({
        schemaVersion: 1,
        engine: 'llama-cpp',
        revision: opts.revision,
        platform: 'linux-arm64',
        backend: opts.backend ?? 'cuda',
        cudaArchitectures: ['121a-real'],
      }),
    );
  }
  return bin;
}

describe('installedAppRoots', () => {
  it('points at the packaged Gezel.app native-bin on macOS, nothing elsewhere', () => {
    const roots = installedAppRoots();
    if (process.platform === 'darwin') {
      expect(roots).toHaveLength(2);
      for (const r of roots) {
        expect(r).toContain(
          join('Gezel.app', 'Contents', 'Resources', 'app.asar.unpacked', 'native-bin'),
        );
      }
      expect(roots[0]).toBe(
        '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin',
      );
    } else {
      expect(roots).toEqual([]);
    }
  });
});

describe('shouldProbeLlamaBackend', () => {
  it('skips automatic CUDA probes on Windows when nvcuda.dll is absent', () => {
    const windowsRoot = mkdtempSync(join(tmpdir(), 'gezel-no-cuda-driver-'));
    expect(shouldProbeLlamaBackend('cuda', 'win32', windowsRoot)).toBe(false);
  });

  it('allows CUDA probes on Windows when the NVIDIA driver DLL exists', () => {
    const windowsRoot = mkdtempSync(join(tmpdir(), 'gezel-cuda-driver-'));
    const system32 = join(windowsRoot, 'System32');
    mkdirSync(system32);
    writeFileSync(join(system32, 'nvcuda.dll'), 'fixture');
    expect(shouldProbeLlamaBackend('cuda', 'win32', windowsRoot)).toBe(true);
  });

  it('does not gate CUDA discovery on non-Windows platforms', () => {
    expect(shouldProbeLlamaBackend('cuda', 'linux', undefined)).toBe(true);
  });
});

describe('resolveLlamaBinary — GEZEL_LLAMA_SERVER_BIN override', () => {
  const prev = process.env.GEZEL_LLAMA_SERVER_BIN;
  afterEach(() => {
    if (prev === undefined) delete process.env.GEZEL_LLAMA_SERVER_BIN;
    else process.env.GEZEL_LLAMA_SERVER_BIN = prev;
  });

  it('returns the env path verbatim when it exists, tagged variant=env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gezel-llama-bin-'));
    const fake = join(dir, 'llama-server');
    writeFileSync(fake, '#!/bin/sh\n');
    process.env.GEZEL_LLAMA_SERVER_BIN = fake;

    const resolved = resolveLlamaBinary();
    expect(resolved.path).toBe(fake);
    expect(resolved.variant).toBe('env');
  });

  it('throws a clear error when the env override is set but missing (likely a typo)', () => {
    process.env.GEZEL_LLAMA_SERVER_BIN = join(tmpdir(), 'definitely-not-a-real-llama-server-xyz');
    expect(() => resolveLlamaBinary()).toThrowError(/GEZEL_LLAMA_SERVER_BIN.*no file exists/s);
  });

  it('reads build provenance for an override instead of trusting it blindly', () => {
    const pin = pinnedLlamaRevision();
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
    process.env.GEZEL_LLAMA_SERVER_BIN = stubEngine({ revision: pin!, backend: 'cuda' });

    const resolved = resolveLlamaBinary();
    expect(resolved.build?.revision).toBe(pin);
    expect(resolved.build?.backend).toBe('cuda');
    expect(resolved.build?.cudaArchitectures).toEqual(['121a-real']);
    expect(resolved.build?.sidecarPresent).toBe(true);
    expect(resolved.warnings.join('\n')).not.toMatch(/checkout pins/);
  });

  it.skipIf(process.platform === 'win32')(
    'warns about a hand-built engine sitting on the pinned revision',
    () => {
      // 0.1.31 changed only cmake flags at 0.1.29's commit, so a local
      // build.sh tree matches the pin by revision while being a different
      // binary. Revision alone therefore cannot clear it — the missing
      // sidecar is the only thing that marks it.
      const pin = pinnedLlamaRevision()!;
      const dir = mkdtempSync(join(tmpdir(), 'gezel-llama-bin-'));
      const bin = join(dir, 'gezel-llama-server');
      writeFileSync(bin, `#!/bin/sh\necho "version: 10099 (${pin.slice(0, 8)})" >&2\n`, {
        mode: 0o755,
      });
      process.env.GEZEL_LLAMA_SERVER_BIN = bin;

      const resolved = resolveLlamaBinary();
      expect(resolved.build?.revision).toBe(pin.slice(0, 8));
      expect(resolved.build?.sidecarPresent).toBe(false);
      const warnings = resolved.warnings.join('\n');
      expect(warnings).toMatch(/hand-built or hand-copied/);
      expect(warnings).not.toMatch(/checkout pins/);
    },
  );

  it('stays quiet for a fetched tree whose sidecar matches the pin', () => {
    process.env.GEZEL_LLAMA_SERVER_BIN = stubEngine({ revision: pinnedLlamaRevision()! });
    expect(resolveLlamaBinary().warnings.join('\n')).not.toMatch(/hand-built|checkout pins/);
  });

  it('warns when the override was built from a different revision than the checkout pins', () => {
    process.env.GEZEL_LLAMA_SERVER_BIN = stubEngine({
      revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    const warnings = resolveLlamaBinary().warnings.join('\n');
    expect(warnings).toMatch(/built from deadbeef/);
    expect(warnings).toMatch(/checkout pins/);
    expect(warnings).toMatch(/GEZEL_LLAMA_SERVER_BIN/);
  });

  it('accepts a short revision as matching the pinned full sha', () => {
    const pin = pinnedLlamaRevision()!;
    process.env.GEZEL_LLAMA_SERVER_BIN = stubEngine({ revision: pin.slice(0, 8) });

    expect(resolveLlamaBinary().warnings.join('\n')).not.toMatch(/checkout pins/);
  });

  it('warns rather than throws when an override cannot be identified at all', () => {
    process.env.GEZEL_LLAMA_SERVER_BIN = stubEngine({});

    const warnings = resolveLlamaBinary().warnings.join('\n');
    expect(warnings).toMatch(/could not determine the build identity/);
    expect(warnings).toMatch(/cannot be checked against the pin/);
  });

  it('prefers an explicit --llama-bin path over the env override, tagged variant=flag', () => {
    const pin = pinnedLlamaRevision()!;
    process.env.GEZEL_LLAMA_SERVER_BIN = stubEngine({ revision: pin });
    const flagBin = stubEngine({ revision: 'cafebabecafebabecafebabecafebabecafebabe' });

    const resolved = resolveLlamaBinary(flagBin);
    expect(resolved.path).toBe(flagBin);
    expect(resolved.variant).toBe('flag');
    expect(resolved.warnings.join('\n')).toMatch(/--llama-bin/);
  });

  it.skipIf(process.platform === 'win32')(
    'parses the build number and revision from the --version banner on stderr',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'gezel-llama-bin-'));
      const bin = join(dir, 'gezel-llama-server');
      // The real llama-server writes this banner to stderr, not stdout —
      // reading only stdout silently yields no identity at all.
      writeFileSync(bin, '#!/bin/sh\necho "version: 10099 (1a064ab0)" >&2\n', { mode: 0o755 });
      process.env.GEZEL_LLAMA_SERVER_BIN = bin;

      const resolved = resolveLlamaBinary();
      expect(resolved.build?.buildNumber).toBe('10099');
      expect(resolved.build?.revision).toBe('1a064ab0');
    },
  );
});
