import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  expect(config).toContain('- grant-service-sid.ps1');
});

function runGrant(path: string, grant: string, service = 'GezelService') {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(installerDir, 'grant-service-sid.ps1'),
      '-Path',
      path,
      '-Service',
      service,
      '-Grant',
      grant,
    ],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
}

function sddl(path: string): string {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[System.IO.Directory]::GetAccessControl('${path}').GetSecurityDescriptorSddlForm('Access')`,
    ],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function serviceSid(name: string): string {
  const result = spawnSync('sc.exe', ['showsid', name], { encoding: 'utf8', windowsHide: true });
  const sid = /SERVICE SID:\s*(S-1-5-80-[\d-]+)/.exec(result.stdout)?.[1];
  expect(sid, result.stdout).toBeDefined();
  return sid!;
}

describe.skipIf(process.platform !== 'win32')('Windows service SID grant', () => {
  // The installer grants by SID because the name lookup is what fails after
  // an upgrade re-creates the service, so the SID it writes must be the one
  // Windows derives for the name, not one it looked up.
  it('grants the SID Windows derives for the service name, replacing earlier grants', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gezel-sid-grant-'));
    try {
      const sid = serviceSid('GezelService');
      expect(sid).toBe('S-1-5-80-1786395786-4294646720-3734801101-1595390539-2055821610');
      mkdirSync(join(scratch, 'child'));

      const first = runGrant(scratch, '(OI)(CI)(M);(OI)(CI)(IO)(F)');
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const granted = sddl(scratch);
      expect(granted).toContain(`(A;OICI;0x1301bf;;;${sid})`);
      expect(granted).toContain(`(A;OICIIO;FA;;;${sid})`);
      expect(sddl(join(scratch, 'child'))).toContain(`(A;OICIID;0x1301bf;;;${sid})`);

      const second = runGrant(scratch, '(OI)(CI)(RX)');
      expect(second.status, second.stdout + second.stderr).toBe(0);
      const replaced = sddl(scratch);
      expect(replaced).toContain(`(A;OICI;0x1200a9;;;${sid})`);
      expect(replaced).not.toContain(`0x1301bf;;;${sid}`);
      expect(replaced).not.toContain(`FA;;;${sid}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses links, relative paths, unknown rights and odd service names', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gezel-sid-grant-'));
    try {
      const target = join(scratch, 'target');
      const link = join(scratch, 'link');
      mkdirSync(target);
      symlinkSync(target, link, 'junction');
      const before = sddl(target);

      expect(runGrant(link, '(OI)(CI)(M)').status).not.toBe(0);
      expect(sddl(target)).toBe(before);
      expect(runGrant('relative\\dir', '(OI)(CI)(M)').status).not.toBe(0);
      expect(runGrant(target, '(OI)(CI)(W)').status).not.toBe(0);
      expect(runGrant(target, '(OI)(CI)M').status).not.toBe(0);
      expect(runGrant(target, '(OI)(CI)(M)', 'NT SERVICE\\GezelService').status).not.toBe(0);
      expect(sddl(target)).toBe(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
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
