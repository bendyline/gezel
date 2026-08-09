/**
 * The user autostart unit was renamed from `gezeld.service` (which collided
 * with the machine installer's system-scope unit of the same name, making
 * unscoped `systemctl` queries ambiguous) to `gezeld-user.service`. These
 * tests pin the rename, the enable-new-before-removing-legacy migration
 * order, and that both names are cleaned up on uninstall.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install, isInstalled, uninstall } from './linux.js';

let configDir: string;
let calls: Array<readonly string[]>;

const fakeExec = async (_command: string, args: readonly string[]) => {
  calls.push(args);
  return { stdout: '', stderr: '' };
};

const opts = {
  nodePath: '/usr/bin/node',
  gezeldPath: '/opt/gezel/gezeld.js',
  gezelHome: '/home/tester/.gezel',
};

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'gezel-autostart-'));
  calls = [];
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('linux autostart unit', () => {
  it('installs the renamed user unit', async () => {
    await install(opts, { exec: fakeExec, configDir });
    expect(existsSync(join(configDir, 'gezeld-user.service'))).toBe(true);
    expect(existsSync(join(configDir, 'gezeld.service'))).toBe(false);
    expect(calls).toContainEqual(['--user', 'enable', '--now', 'gezeld-user.service']);
    // Every call is user-scope; the system unit of the legacy name is never
    // this module's business.
    for (const args of calls) expect(args[0]).toBe('--user');
  });

  it('migrates a legacy user unit only after the replacement is enabled', async () => {
    await writeFile(join(configDir, 'gezeld.service'), 'legacy');
    await install(opts, { exec: fakeExec, configDir });
    expect(existsSync(join(configDir, 'gezeld.service'))).toBe(false);
    expect(existsSync(join(configDir, 'gezeld-user.service'))).toBe(true);
    const enableNew = calls.findIndex((a) => a[1] === 'enable' && a[3] === 'gezeld-user.service');
    const disableLegacy = calls.findIndex((a) => a[1] === 'disable' && a[3] === 'gezeld.service');
    expect(enableNew).toBeGreaterThanOrEqual(0);
    expect(disableLegacy).toBeGreaterThan(enableNew);
  });

  it('uninstall removes both unit names', async () => {
    await writeFile(join(configDir, 'gezeld.service'), 'legacy');
    await writeFile(join(configDir, 'gezeld-user.service'), 'current');
    await uninstall({ exec: fakeExec, configDir });
    expect(existsSync(join(configDir, 'gezeld.service'))).toBe(false);
    expect(existsSync(join(configDir, 'gezeld-user.service'))).toBe(false);
    expect(calls).toContainEqual(['--user', 'disable', '--now', 'gezeld-user.service']);
    expect(calls).toContainEqual(['--user', 'disable', '--now', 'gezeld.service']);
  });

  it('isInstalled recognizes either unit name before migration has run', async () => {
    await expect(isInstalled({ exec: fakeExec, configDir })).resolves.toBe(false);
    await writeFile(join(configDir, 'gezeld.service'), 'legacy');
    await expect(isInstalled({ exec: fakeExec, configDir })).resolves.toBe(true);
    await rm(join(configDir, 'gezeld.service'));
    await writeFile(join(configDir, 'gezeld-user.service'), 'current');
    await expect(isInstalled({ exec: fakeExec, configDir })).resolves.toBe(true);
  });
});
