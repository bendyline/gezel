/**
 * The user autostart unit was renamed from `gezeld.service` (which collided
 * with the machine installer's system-scope unit of the same name, making
 * unscoped `systemctl` queries ambiguous) to `gezeld-user.service`. These
 * tests pin the rename, the enable-new-before-removing-legacy migration
 * order, and that both names are cleaned up on uninstall.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUnit,
  install,
  isCurrent,
  isInstalled,
  registeredHome,
  stop,
  uninstall,
} from './linux.js';

let configDir: string;
let calls: Array<readonly string[]>;

const fakeExec = async (_command: string, args: readonly string[]) => {
  calls.push(args);
  return { stdout: '', stderr: '' };
};

const opts = {
  nodePath: '/home/tester/.gezel/bin/node',
  pnpmPath: '/home/tester/.gezel/bin/pnpm-runtime/bin/pnpm.mjs',
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
    expect(calls).toContainEqual(['--user', 'enable', 'gezeld-user.service']);
    // `enable --now` would leave an already-running unit on its old ExecStart.
    expect(calls.at(-1)).toEqual(['--user', 'restart', 'gezeld-user.service']);
    // Every call is user-scope; the system unit of the legacy name is never
    // this module's business.
    for (const args of calls) expect(args[0]).toBe('--user');
  });

  it('persists the bundled runtime without relying on the login PATH', async () => {
    await install(opts, { exec: fakeExec, configDir });
    const unit = await readFile(join(configDir, 'gezeld-user.service'), 'utf8');
    expect(unit).toContain('ExecStart="/home/tester/.gezel/bin/node" "/opt/gezel/gezeld.js"');
    expect(unit).toContain('Environment="GEZEL_NODE_PATH=/home/tester/.gezel/bin/node"');
    expect(unit).toContain(
      'Environment="GEZEL_PNPM_PATH=/home/tester/.gezel/bin/pnpm-runtime/bin/pnpm.mjs"',
    );
    // Lets gezeld exit 0 when another daemon owns the home, which
    // Restart=on-failure then leaves alone.
    expect(unit).toContain('Environment="GEZEL_AUTOSTART=1"');
  });

  it('migrates a legacy user unit only after the replacement is enabled', async () => {
    await writeFile(join(configDir, 'gezeld.service'), 'legacy');
    await install(opts, { exec: fakeExec, configDir });
    expect(existsSync(join(configDir, 'gezeld.service'))).toBe(false);
    expect(existsSync(join(configDir, 'gezeld-user.service'))).toBe(true);
    const enableNew = calls.findIndex((a) => a[1] === 'enable' && a[2] === 'gezeld-user.service');
    const disableLegacy = calls.findIndex((a) => a[1] === 'disable' && a[3] === 'gezeld.service');
    const startNew = calls.findIndex((a) => a[1] === 'restart' && a[2] === 'gezeld-user.service');
    expect(enableNew).toBeGreaterThanOrEqual(0);
    expect(disableLegacy).toBeGreaterThan(enableNew);
    // The legacy daemon holds the home; starting the new one first would only
    // make it stand down.
    expect(startNew).toBeGreaterThan(disableLegacy);
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

  it('reports the home a registered unit serves, including a pre-rename unit', async () => {
    await expect(registeredHome({ exec: fakeExec, configDir })).resolves.toBeNull();
    const quoted = { ...opts, gezelHome: '/home/te"ster/.gezel' };
    await writeFile(join(configDir, 'gezeld.service'), buildUnit(quoted));
    await expect(registeredHome({ exec: fakeExec, configDir })).resolves.toBe(
      '/home/te"ster/.gezel',
    );
    await writeFile(join(configDir, 'gezeld-user.service'), buildUnit(opts));
    await expect(registeredHome({ exec: fakeExec, configDir })).resolves.toBe(opts.gezelHome);
  });

  it('is current only for the exact unit install would write, with no legacy unit left', async () => {
    await expect(isCurrent(opts, { exec: fakeExec, configDir })).resolves.toBe(false);
    await writeFile(
      join(configDir, 'gezeld-user.service'),
      buildUnit({ ...opts, gezeldPath: '/home/tester/.gezel/service/dist/bin/gezeld.js' }),
    );
    await expect(isCurrent(opts, { exec: fakeExec, configDir })).resolves.toBe(false);
    await writeFile(join(configDir, 'gezeld-user.service'), buildUnit(opts));
    await expect(isCurrent(opts, { exec: fakeExec, configDir })).resolves.toBe(true);
    await writeFile(join(configDir, 'gezeld.service'), 'legacy');
    await expect(isCurrent(opts, { exec: fakeExec, configDir })).resolves.toBe(false);
  });

  it('stops the daemon without disabling the unit for the next login', async () => {
    await stop({ exec: fakeExec, configDir });
    expect(calls).toContainEqual(['--user', 'stop', 'gezeld-user.service']);
    expect(calls.some((a) => a[1] === 'disable')).toBe(false);
  });
});
