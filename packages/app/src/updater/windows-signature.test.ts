import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type RunPowerShell,
  SIGNATURE_CHECK_ERROR_CODE,
  SIGNATURE_CHECK_TIMEOUT_MS,
  createWindowsUpdateSignatureVerifier,
  parseDistinguishedName,
  signatureCheckEnvironment,
  signerMatchesPublisher,
  verifyWindowsUpdateSignature,
} from './windows-signature.js';

const BENDYLINE_SUBJECT = 'CN=Bendyline LLC, O=Bendyline LLC, L=Sammamish, S=Washington, C=US';
const UPDATE_FILE =
  'C:\\Users\\someone\\AppData\\Local\\@bendylinegezel-app-updater\\pending\\temp-Gezel-1.26300.100-windows-x64.exe';

function reporting(report: unknown): RunPowerShell {
  return async () => JSON.stringify(report);
}

describe('Windows update signature check', () => {
  it('accepts a valid signature from the configured publisher', async () => {
    const verify = createWindowsUpdateSignatureVerifier(
      reporting({ Status: 0, StatusMessage: 'Signature verified.', Subject: BENDYLINE_SUBJECT }),
    );
    await expect(verify(['Bendyline LLC'], UPDATE_FILE)).resolves.toBeNull();
  });

  it('allows far longer than electron-updater and never puts the path in the script', async () => {
    const calls: { command: string; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
    const verify = createWindowsUpdateSignatureVerifier(async (command, env, timeoutMs) => {
      calls.push({ command, env, timeoutMs });
      return JSON.stringify({ Status: 0, StatusMessage: '', Subject: BENDYLINE_SUBJECT });
    });

    await verify(['Bendyline LLC'], UPDATE_FILE);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('the signature check never ran PowerShell');
    const { command, env, timeoutMs } = call;
    expect(timeoutMs).toBe(SIGNATURE_CHECK_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThanOrEqual(10 * 20_000);
    const script = Buffer.from(command, 'base64').toString('utf16le');
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $env:GEZEL_UPDATE_FILE');
    expect(script).not.toContain('temp-Gezel');
    expect(env.GEZEL_UPDATE_FILE).toBe(UPDATE_FILE);
  });

  it('drops a PowerShell 7 module path whatever its casing', () => {
    const env = signatureCheckEnvironment(UPDATE_FILE, {
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      PSMODULEPATH: 'C:\\Program Files\\PowerShell\\7\\Modules',
      Path: 'C:\\Windows\\System32',
    });
    expect(env).toEqual({ Path: 'C:\\Windows\\System32', GEZEL_UPDATE_FILE: UPDATE_FILE });
  });

  it('reports invalid, unsigned, and foreign signatures as mismatches', async () => {
    const tampered = createWindowsUpdateSignatureVerifier(
      reporting({
        Status: 3,
        StatusMessage: 'The hash does not match.',
        Subject: BENDYLINE_SUBJECT,
      }),
    );
    await expect(tampered(['Bendyline LLC'], UPDATE_FILE)).resolves.toBe(
      'Authenticode status 3: The hash does not match.',
    );

    const unsigned = createWindowsUpdateSignatureVerifier(
      reporting({ Status: 2, StatusMessage: 'The file is not signed.', Subject: null }),
    );
    await expect(unsigned(['Bendyline LLC'], UPDATE_FILE)).resolves.toMatch(
      /^Authenticode status 2/,
    );

    const foreign = createWindowsUpdateSignatureVerifier(
      reporting({
        Status: 0,
        StatusMessage: '',
        Subject: 'CN=Bendyline LLC Imposter, O=Elsewhere',
      }),
    );
    await expect(foreign(['Bendyline LLC'], UPDATE_FILE)).resolves.toBe(
      'signed by "CN=Bendyline LLC Imposter, O=Elsewhere", expected Bendyline LLC',
    );
  });

  it('parses distinguished names with quoting and escapes', () => {
    expect([...parseDistinguishedName(BENDYLINE_SUBJECT)]).toEqual([
      ['CN', 'Bendyline LLC'],
      ['O', 'Bendyline LLC'],
      ['L', 'Sammamish'],
      ['S', 'Washington'],
      ['C', 'US'],
    ]);
    expect(parseDistinguishedName('CN="Bendyline, LLC", O=A\\,B; C=US+L=X').get('CN')).toBe(
      'Bendyline, LLC',
    );
    expect(parseDistinguishedName('O=A\\,B, C=US').get('O')).toBe('A,B');
    expect(parseDistinguishedName('O=A\\2CB').get('O')).toBe('A,B');
    expect(parseDistinguishedName('CN=X+L=Y').get('L')).toBe('Y');
    expect(parseDistinguishedName('Bendyline LLC').size).toBe(0);
  });

  it('matches publishers the way electron-updater does', () => {
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['Bendyline LLC'])).toBe(true);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['Bendyline'])).toBe(false);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['Other', 'Bendyline LLC'])).toBe(true);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, [])).toBe(false);
    // A full distinguished name must agree on every attribute it names.
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['CN=Bendyline LLC, C=US'])).toBe(true);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['CN=Bendyline LLC, C=CA'])).toBe(false);
    // Quoted values keep their commas.
    expect(signerMatchesPublisher('CN="Bendyline, LLC", C=US', ['Bendyline, LLC'])).toBe(true);
  });

  it('rejects with a coded error when the check cannot run or answer', async () => {
    const timedOut = createWindowsUpdateSignatureVerifier(async () => {
      throw new Error('timed out after 300 s');
    });
    await expect(timedOut(['Bendyline LLC'], UPDATE_FILE)).rejects.toMatchObject({
      code: SIGNATURE_CHECK_ERROR_CODE,
      message: 'Windows update signature check failed: timed out after 300 s',
    });

    for (const output of ['', 'WARNING: something else', '{"Status":"Valid"}', '[0]']) {
      const garbled = createWindowsUpdateSignatureVerifier(async () => output);
      await expect(garbled(['Bendyline LLC'], UPDATE_FILE)).rejects.toMatchObject({
        code: SIGNATURE_CHECK_ERROR_CODE,
      });
    }
  });

  describe.skipIf(process.platform !== 'win32')('with Windows PowerShell', () => {
    let directory = '';

    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = '';
    });

    it('verifies a real signed file through an awkward path', { timeout: 60_000 }, async () => {
      // Quotes, `$`, and brackets would each break a path spliced into the script.
      directory = await mkdtemp(join(tmpdir(), 'gezel-signature-'));
      const awkward = join(directory, "it's $(not run) [x]");
      await mkdir(awkward);
      const signed = join(awkward, 'cmd.exe');
      await copyFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), signed);

      await expect(verifyWindowsUpdateSignature(['Microsoft Windows'], signed)).resolves.toBeNull();
      await expect(verifyWindowsUpdateSignature(['Bendyline LLC'], signed)).resolves.toMatch(
        /^signed by "CN=Microsoft Windows,/,
      );
    });

    it('reports a failed check in plain text', { timeout: 60_000 }, async () => {
      directory = await mkdtemp(join(tmpdir(), 'gezel-signature-'));
      const missing = join(directory, 'missing.exe');

      await expect(verifyWindowsUpdateSignature(['Bendyline LLC'], missing)).rejects.toMatchObject({
        code: SIGNATURE_CHECK_ERROR_CODE,
        message: `Windows update signature check failed: powershell.exe failed (1): File ${missing} was not found.`,
      });
    });
  });
});
