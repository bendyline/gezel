import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecFailure, type ExecFn, isProcessRunning } from './exec.js';
import {
  buildUnopkgAddArgs,
  buildUnopkgRemoveArgs,
  installLibreOfficeExtension,
  isLibreOfficeExtensionInstalled,
  parseUnopkgListed,
  uninstallLibreOfficeExtension,
} from './libreoffice-register.js';
import {
  WEF_DEVELOPER_KEY,
  buildRegAddArgs,
  isOfficeAddinRegistered,
  macManifestCopyPath,
  parseRegQueryValue,
  registerOfficeAddin,
  unregisterOfficeAddin,
} from './office-register.js';
import {
  buildCertutilAddArgs,
  buildDarwinAddTrustedArgs,
  buildDarwinVerifyLeafArgs,
  installTrust,
  isTrusted,
  parseFindCertificateSha1,
} from './trust-store.js';

const HOSTILE_WIN = `C:\\Users\\Test & User\\.gezel\\integrations\\office\\manifests\\It's "mine".xml`;
const ID = '6f1c2f7e-2a7b-4c1e-9f5e-0a1b2c3d4e5f';

function recorder(responses: Record<string, { stdout?: string; fail?: ExecFailure }> = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
    const key = `${command.split(/[\\/]/).pop()} ${args[0] ?? ''}`;
    const response = responses[key];
    if (response?.fail) throw response.fail;
    return { stdout: response?.stdout ?? '', stderr: '' };
  };
  return { exec, calls };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-office-int-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Windows registration', () => {
  it('passes a hostile manifest path as one argument, never through a shell', async () => {
    expect(buildRegAddArgs(ID, HOSTILE_WIN)).toEqual([
      'add',
      WEF_DEVELOPER_KEY,
      '/v',
      ID,
      '/t',
      'REG_SZ',
      '/d',
      HOSTILE_WIN,
      '/f',
    ]);
    const { exec, calls } = recorder();
    await registerOfficeAddin(
      { app: 'word', manifestId: ID, manifestPath: HOSTILE_WIN },
      { exec, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    );
    expect(calls[0]!.command).toBe(join('C:\\Windows', 'System32', 'reg.exe'));
  });

  it('parses captured `reg query` output', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer',
      `    ${ID}    REG_SZ    ${HOSTILE_WIN}`,
      '',
    ].join('\r\n');
    expect(parseRegQueryValue(stdout, ID)).toBe(HOSTILE_WIN);
    expect(parseRegQueryValue(stdout, 'other')).toBeNull();
  });

  it('checks registration by comparing the stored path', async () => {
    const { exec } = recorder({
      'reg.exe query': { stdout: `\r\nKEY\r\n    ${ID}    REG_SZ    ${HOSTILE_WIN}\r\n` },
    });
    const reg = { app: 'word' as const, manifestId: ID, manifestPath: HOSTILE_WIN };
    expect(await isOfficeAddinRegistered(reg, { exec, platform: 'win32' })).toBe(true);
    expect(
      await isOfficeAddinRegistered(
        { ...reg, manifestPath: 'C:\\elsewhere.xml' },
        { exec, platform: 'win32' },
      ),
    ).toBe(false);
  });

  it('treats an already-absent value as unregistered', async () => {
    const { exec } = recorder({
      'reg.exe delete': {
        fail: new ExecFailure('not found', 1, '', 'ERROR: The system was unable to find'),
      },
    });
    await expect(
      unregisterOfficeAddin({ app: 'word', manifestId: ID }, { exec, platform: 'win32' }),
    ).resolves.toBeUndefined();
  });
});

describe('macOS registration', () => {
  it('refuses when the app has never been opened', async () => {
    const manifest = join(home, 'm.xml');
    await writeFile(manifest, '<xml/>');
    await expect(
      registerOfficeAddin(
        { app: 'word', manifestId: ID, manifestPath: manifest },
        { platform: 'darwin', homedir: home },
      ),
    ).rejects.toMatchObject({ code: 'app-never-opened' });
  });

  it('copies the manifest into the container wef folder, named by GUID', async () => {
    const manifest = join(home, 'manifest dir', `It's "mine".xml`);
    await mkdir(join(home, 'manifest dir'), { recursive: true });
    await writeFile(manifest, '<OfficeApp/>');
    await mkdir(join(home, 'Library', 'Containers', 'com.microsoft.Word', 'Data'), {
      recursive: true,
    });
    const reg = { app: 'word' as const, manifestId: ID, manifestPath: manifest };
    await registerOfficeAddin(reg, { platform: 'darwin', homedir: home });
    const copy = macManifestCopyPath('word', ID, home);
    expect(copy).toBe(
      join(home, 'Library/Containers/com.microsoft.Word/Data/Documents/wef', `gezel-${ID}.xml`),
    );
    expect(await readFile(copy, 'utf8')).toBe('<OfficeApp/>');
    expect(await isOfficeAddinRegistered(reg, { platform: 'darwin', homedir: home })).toBe(true);
    await writeFile(manifest, '<OfficeApp v2/>');
    expect(await isOfficeAddinRegistered(reg, { platform: 'darwin', homedir: home })).toBe(false);
    await unregisterOfficeAddin(reg, { platform: 'darwin', homedir: home });
    expect(await isOfficeAddinRegistered(reg, { platform: 'darwin', homedir: home })).toBe(false);
  });
});

describe('trust store', () => {
  const anchor = {
    caPem: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
    sha1Hex: 'AB'.repeat(20),
    commonName: 'Gezel Office Local CA (1234abcd)',
  };

  it('builds the user-scope commands', () => {
    expect(
      buildDarwinAddTrustedArgs('/tmp/x y.pem', '/Users/me/Library/Keychains/login.keychain-db'),
    ).toEqual([
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'ssl',
      '-k',
      '/Users/me/Library/Keychains/login.keychain-db',
      '/tmp/x y.pem',
    ]);
    expect(buildCertutilAddArgs('C:\\t\\ca.cer')).toEqual([
      '-user',
      '-addstore',
      'Root',
      'C:\\t\\ca.cer',
    ]);
    expect(buildDarwinVerifyLeafArgs('/tmp/leaf.pem')).toEqual([
      'verify-cert',
      '-c',
      '/tmp/leaf.pem',
      '-p',
      'ssl',
      '-n',
      'localhost',
      '-L',
      '-q',
    ]);
  });

  it('installs into the login keychain on macOS and removes its temp file', async () => {
    const { exec, calls } = recorder();
    await installTrust(anchor, { exec, platform: 'darwin', homedir: '/Users/me', tmpRoot: home });
    expect(calls[0]!.command).toBe('/usr/bin/security');
    expect(calls[0]!.args.slice(0, 7)).toEqual([
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'ssl',
      '-k',
      '/Users/me/Library/Keychains/login.keychain-db',
    ]);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(home)).toEqual([]);
  });

  it('verifies with the leaf when it has one, else falls back to the keychain listing', async () => {
    const trusted = recorder();
    expect(
      await isTrusted(
        { ...anchor, leafPem: 'LEAF' },
        { exec: trusted.exec, platform: 'darwin', tmpRoot: home },
      ),
    ).toBe(true);
    expect(trusted.calls[0]!.args[0]).toBe('verify-cert');

    const untrusted = recorder({
      'security verify-cert': { fail: new ExecFailure('no', 1, '', '') },
    });
    expect(
      await isTrusted(
        { ...anchor, leafPem: 'LEAF' },
        { exec: untrusted.exec, platform: 'darwin', tmpRoot: home },
      ),
    ).toBe(false);

    const listing = recorder({
      'security find-certificate': {
        stdout: `SHA-256 hash: ${'CD'.repeat(32)}\nSHA-1 hash: ${'AB'.repeat(20)}\nkeychain: "/Users/me/Library/Keychains/login.keychain-db"\n`,
      },
    });
    expect(
      await isTrusted(anchor, { exec: listing.exec, platform: 'darwin', homedir: '/Users/me' }),
    ).toBe(true);
  });

  it('parses find-certificate output', () => {
    expect(
      parseFindCertificateSha1(`SHA-1 hash: ${'ef'.repeat(20)}\nSHA-1 hash: ${'AB'.repeat(20)}`),
    ).toEqual(['ef'.repeat(20), 'ab'.repeat(20)]);
  });
});

describe('LibreOffice', () => {
  const unopkgPath = '/Applications/LibreOffice.app/Contents/MacOS/unopkg';

  it('adds per user, replacing, without a license prompt', async () => {
    expect(buildUnopkgAddArgs('/x y/gezel.oxt')).toEqual(['add', '-f', '-s', '/x y/gezel.oxt']);
    expect(buildUnopkgRemoveArgs()).toEqual(['remove', 'com.bendyline.gezel']);
    const { exec, calls } = recorder({ 'pgrep -x': { fail: new ExecFailure('none', 1, '', '') } });
    await installLibreOfficeExtension(
      { unopkgPath, oxtPath: '/x y/gezel.oxt' },
      { exec, platform: 'darwin' },
    );
    expect(calls.at(-1)).toEqual({
      command: unopkgPath,
      args: ['add', '-f', '-s', '/x y/gezel.oxt'],
    });
    expect(calls.some((c) => c.args.includes('--shared'))).toBe(false);
  });

  it('refuses while LibreOffice is running', async () => {
    const { exec, calls } = recorder();
    await expect(
      installLibreOfficeExtension(
        { unopkgPath, oxtPath: '/gezel.oxt' },
        { exec, platform: 'darwin' },
      ),
    ).rejects.toThrow(/Close LibreOffice/);
    expect(calls.every((c) => c.command !== unopkgPath)).toBe(true);
  });

  it('parses captured unopkg list output', async () => {
    const listed = [
      'All deployed extensions:',
      '',
      'Identifier: com.bendyline.gezel',
      '  URL: vnd.sun.star.expand:$UNO_USER_PACKAGES_CACHE/uno_packages/lu1.tmp_/gezel.oxt',
      '  is registered: yes',
    ].join('\n');
    expect(parseUnopkgListed(listed)).toBe(true);
    expect(parseUnopkgListed('Identifier: com.bendyline.gezelx')).toBe(false);
    const { exec } = recorder({ 'unopkg list': { stdout: listed } });
    expect(await isLibreOfficeExtensionInstalled({ unopkgPath }, { exec })).toBe(true);
  });

  it('treats "not deployed" as removed', async () => {
    const { exec } = recorder({
      'pgrep -x': { fail: new ExecFailure('none', 1, '', '') },
      'unopkg remove': {
        fail: new ExecFailure(
          'x',
          1,
          '',
          'ERROR: There is no such extension deployed: com.bendyline.gezel',
        ),
      },
    });
    await expect(
      uninstallLibreOfficeExtension({ unopkgPath }, { exec, platform: 'darwin' }),
    ).resolves.toBeUndefined();
  });
});

describe('isProcessRunning', () => {
  it('reads tasklist CSV on Windows', async () => {
    const { exec } = recorder({
      'tasklist.exe /FI': { stdout: '"WINWORD.EXE","1234","Console","1","200,000 K"\r\n' },
    });
    expect(await isProcessRunning(['WINWORD.EXE'], { exec, platform: 'win32' })).toBe(true);
    const none = recorder({
      'tasklist.exe /FI': {
        stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
      },
    });
    expect(await isProcessRunning(['WINWORD.EXE'], { exec: none.exec, platform: 'win32' })).toBe(
      false,
    );
  });
});
