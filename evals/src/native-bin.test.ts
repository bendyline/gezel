import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installedAppRoots, resolveLlamaBinary } from './native-bin.ts';

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
});
