import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installerDir = fileURLToPath(new URL('../installer/windows/', import.meta.url));

it('ships both handle-based ACL repair resources outside ASAR', () => {
  const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  expect(config).toContain('from: installer/windows');
  expect(config).toContain('to: resources/installer-security');
  expect(config).toContain('- ResetTreeAcl.cs');
  expect(config).toContain('- reset-tree-acl.ps1');
});

describe.skipIf(process.platform !== 'win32')('Windows handle-based ACL repair', () => {
  it('resists interleaved replacements and preserves legitimate links without touching targets', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gezel-acl-race-'));
    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(installerDir, 'test-reset-tree-acl.ps1'),
          '-Scratch',
          scratch,
        ],
        { encoding: 'utf8', timeout: 90_000, windowsHide: true },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('ACL race regression tests passed');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 100_000);
});
