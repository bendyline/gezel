import { describe, expect, it } from 'vitest';
import { verifyCodeSignature } from './signature.js';

type RunResult = { code: number | string; stdout: string; stderr: string };
type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const ok = (stdout = '', code: number | string = 0): RunResult => ({ code, stdout, stderr: '' });

/** Windows runner: returns the given Get-AuthenticodeSignature status. */
const winRun =
  (status: string): Runner =>
  async () =>
    ok(status);

/** macOS runner: `codesign --verify` exits `verifyCode`; `codesign -dv` emits `dvStderr`. */
const macRun =
  (verifyCode: number, dvStderr = ''): Runner =>
  async (_cmd, args) =>
    args.includes('--verify')
      ? { code: verifyCode, stdout: '', stderr: '' }
      : { code: 0, stdout: '', stderr: dvStderr };

describe('verifyCodeSignature — windows', () => {
  it('Valid → valid, accepted by every policy', async () => {
    for (const policy of ['off', 'prefer', 'require'] as const) {
      const o = await verifyCodeSignature('x.exe', {
        policy,
        platform: 'win32',
        run: winRun('Valid'),
      });
      expect(o.result.status).toBe('valid');
      expect(o.accepted).toBe(true);
    }
  });

  it('NotSigned → unsigned; prefer accepts, require rejects', async () => {
    const base = { platform: 'win32' as const, run: winRun('NotSigned') };
    expect((await verifyCodeSignature('x.exe', { ...base, policy: 'prefer' })).accepted).toBe(true);
    const req = await verifyCodeSignature('x.exe', { ...base, policy: 'require' });
    expect(req.result.status).toBe('unsigned');
    expect(req.accepted).toBe(false);
  });

  it('HashMismatch → invalid; rejected by prefer and require, allowed by off', async () => {
    const base = { platform: 'win32' as const, run: winRun('HashMismatch') };
    expect((await verifyCodeSignature('x.exe', { ...base, policy: 'prefer' })).result.status).toBe(
      'invalid',
    );
    expect((await verifyCodeSignature('x.exe', { ...base, policy: 'prefer' })).accepted).toBe(
      false,
    );
    expect((await verifyCodeSignature('x.exe', { ...base, policy: 'require' })).accepted).toBe(
      false,
    );
    expect((await verifyCodeSignature('x.exe', { ...base, policy: 'off' })).accepted).toBe(true);
  });

  it('powershell missing (spawn failure) → unsupported', async () => {
    const run: Runner = async () => ({ code: 'ENOENT', stdout: '', stderr: '' });
    const o = await verifyCodeSignature('x.exe', { policy: 'require', platform: 'win32', run });
    expect(o.result.status).toBe('unsupported');
    expect(o.accepted).toBe(true); // require accepts unsupported — sha is the gate there
  });
});

describe('verifyCodeSignature — macos', () => {
  it('codesign --verify exit 0 → valid', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'require',
      platform: 'darwin',
      run: macRun(0),
    });
    expect(o.result.status).toBe('valid');
    expect(o.accepted).toBe(true);
  });

  it('verify fails + "not signed at all" → unsigned', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'prefer',
      platform: 'darwin',
      run: macRun(1, 'bin: code object is not signed at all'),
    });
    expect(o.result.status).toBe('unsigned');
    expect(o.accepted).toBe(true);
  });

  it('verify fails with a real signature → invalid (rejected under prefer)', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'prefer',
      platform: 'darwin',
      run: macRun(1, 'bin: a sealed resource is missing or invalid'),
    });
    expect(o.result.status).toBe('invalid');
    expect(o.accepted).toBe(false);
  });
});

describe('verifyCodeSignature — linux', () => {
  it('is unsupported and accepted under every policy (sha256 is the gate)', async () => {
    for (const policy of ['off', 'prefer', 'require'] as const) {
      const o = await verifyCodeSignature('bin', { policy, platform: 'linux' });
      expect(o.result.status).toBe('unsupported');
      expect(o.accepted).toBe(true);
    }
  });
});
