import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const installerDir = fileURLToPath(new URL('../installer/windows/', import.meta.url));
const { compileInstallerSecurity } = createRequire(import.meta.url)(
  '../scripts/build-installer-security.cjs',
) as { compileInstallerSecurity(outFile: string): string };

it('ships the compiled permission helper outside ASAR, and no PowerShell', () => {
  const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  expect(config).toContain('beforePack: scripts/before-pack.cjs');
  expect(config).toContain('from: dist/installer-security');
  expect(config).toContain('to: resources/installer-security');
  expect(config).toContain('- gezel-acl.exe');
  expect(config).not.toMatch(/\.ps1\b/);
  expect(config).not.toContain('ResetTreeAcl.cs');
  // Gone, so nothing can quietly go back to launching them.
  expect(existsSync(join(installerDir, 'reset-tree-acl.ps1'))).toBe(false);
  expect(existsSync(join(installerDir, 'grant-service-sid.ps1'))).toBe(false);
});

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

describe.skipIf(process.platform !== 'win32')('gezel-acl.exe', () => {
  let buildDir = '';
  let helper = '';

  beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), 'gezel-acl-build-'));
    helper = compileInstallerSecurity(join(buildDir, 'gezel-acl.exe'));
  }, 120_000);

  afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(helper, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  }

  function runGrant(path: string, grant: string, service = 'GezelService') {
    return run('grant-service-sid', '-Path', path, '-Service', service, '-Grant', grant);
  }

  describe('command line', () => {
    // NSIS treats any nonzero exit as a refusal; 2 tells a malformed hook
    // invocation apart from a refused repair in the installer log.
    it.each([
      [[]],
      [['repair']],
      [['reset-tree-acl']],
      [['reset-tree-acl', '-Root']],
      [['reset-tree-acl', 'C:\\Gezel']],
      [['reset-tree-acl', '-Root', 'C:\\a', '-Root', 'C:\\b']],
      [['reset-tree-acl', '-Root', 'C:\\a', '-Recurse', 'yes']],
      [['grant-service-sid', '-Path', 'C:\\a', '-Service', 'GezelService']],
      [['grant-service-sid', '-Path', 'C:\\a', '-Service', 'GezelService', '-Grant', '']],
    ])('exits 2 with usage for %j', (args) => {
      const result = run(...args);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain('usage: gezel-acl');
    });

    it('matches option names case-insensitively, as the PowerShell parameters did', () => {
      const missing = join(tmpdir(), `gezel-acl-missing-${process.pid}`);
      const result = run('reset-tree-acl', '-root', missing);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('[reset-tree-acl] Refusing incomplete ACL repair:');
    });
  });

  describe('grant-service-sid', () => {
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
        expect(first.stdout).toContain(`GezelService (${sid})`);
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

        for (const refused of [
          runGrant(link, '(OI)(CI)(M)'),
          runGrant('relative\\dir', '(OI)(CI)(M)'),
          runGrant(target, '(OI)(CI)(W)'),
          runGrant(target, '(OI)(CI)M'),
          runGrant(target, '(OI)(CI)(M)', 'NT SERVICE\\GezelService'),
        ]) {
          expect(refused.status, refused.stdout + refused.stderr).toBe(1);
          expect(refused.stderr).toContain('[grant-service-sid] ');
        }
        expect(sddl(target)).toBe(before);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 120_000);
  });

  describe('reset-tree-acl', () => {
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
            '-Launcher',
            helper,
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
});
