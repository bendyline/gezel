import { describe, expect, it } from 'vitest';
import { BENDYLINE_APPLE_TEAM_ID, BENDYLINE_PUBLISHER, verifyCodeSignature } from './signature.js';

type RunResult = { code: number | string; stdout: string; stderr: string };
type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const ok = (stdout = '', code: number | string = 0): RunResult => ({ code, stdout, stderr: '' });

/** Windows runner: returns the given Get-AuthenticodeSignature status. */
const winRun =
  (status: string, subject = ''): Runner =>
  async () =>
    ok(`${status}\n${subject}`);

/** macOS runner: `codesign --verify` exits `verifyCode`; `codesign -dvv` emits `dvStderr`. */
const macRun =
  (verifyCode: number, dvStderr = ''): Runner =>
  async (_cmd, args) =>
    args.includes('--verify')
      ? { code: verifyCode, stdout: '', stderr: '' }
      : { code: 0, stdout: '', stderr: dvStderr };

/**
 * Verbatim `codesign -dvv` output for a released `gezel-ds4-server`
 * (native-v0.1.29, darwin-arm64). Do NOT hand-edit this into a tidier shape:
 * the previous fixture invented `Developer ID Application: Bendyline LLC
 * (TEAMID)` — no comma, fake team — and that fiction kept the suite green
 * while every real macOS engine install failed closed. Refresh it by pasting
 * real output, never by adjusting it to suit the matcher.
 */
const REAL_CODESIGN_DVV = [
  'Executable=/Users/x/.gezel/engines/native-bin/0.1.29/darwin-arm64/gezel-ds4-server',
  'Identifier=gezel-ds4-server',
  'Format=Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=4188 flags=0x10000(runtime) hashes=125+2 location=embedded',
  'Signature size=8978',
  'Authority=Developer ID Application: Bendyline, LLC (JXA5M4VK3V)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Jul 31, 2026 at 12:06:39 PM',
  'Info.plist=not bound',
  'TeamIdentifier=JXA5M4VK3V',
  'Runtime Version=26.5.0',
  'Sealed Resources=none',
  'Internal requirements count=1 size=176',
].join('\n');

/** Real `codesign -dv` (single v): no `Authority=` line is emitted at all. */
const REAL_CODESIGN_DV = [
  'Executable=/Users/x/.gezel/engines/native-bin/0.1.29/darwin-arm64/gezel-ds4-server',
  'Identifier=gezel-ds4-server',
  'Format=Mach-O thin (arm64)',
  'Signature size=8978',
  'TeamIdentifier=JXA5M4VK3V',
].join('\n');

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

  it('requires the expected Authenticode publisher when configured', async () => {
    const valid = await verifyCodeSignature('x.exe', {
      policy: 'require',
      platform: 'win32',
      expectedPublisher: BENDYLINE_PUBLISHER,
      run: winRun('Valid', 'CN=Bendyline LLC, O=Bendyline LLC, C=US'),
    });
    expect(valid.result.status).toBe('valid');
    expect(valid.accepted).toBe(true);

    const wrong = await verifyCodeSignature('x.exe', {
      policy: 'require',
      platform: 'win32',
      expectedPublisher: BENDYLINE_PUBLISHER,
      run: winRun('Valid', 'CN=Somebody Else, O=Somebody Else, C=US'),
    });
    expect(wrong.result.status).toBe('invalid');
    expect(wrong.accepted).toBe(false);
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
    expect(o.accepted).toBe(false);
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

  it('accepts the real released Developer ID authority (comma in the org name)', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      expectedAppleTeamId: BENDYLINE_APPLE_TEAM_ID,
      run: macRun(0, REAL_CODESIGN_DVV),
    });
    expect(o.result.status).toBe('valid');
    expect(o.accepted).toBe(true);
  });

  it('asks codesign for -dvv, since -dv prints no Authority line', async () => {
    const seen: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      seen.push(args);
      return args.includes('--verify')
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: '', stderr: REAL_CODESIGN_DVV };
    };
    await verifyCodeSignature('bin', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      run,
    });
    const display = seen.find((a) => !a.includes('--verify'));
    expect(display?.[0]).toBe('-dvv');
  });

  it('rejects when codesign emits no Developer ID authority at all', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      run: macRun(0, REAL_CODESIGN_DV),
    });
    expect(o.result.status).toBe('invalid');
    expect(o.accepted).toBe(false);
  });

  it('rejects a different org signed under a valid Developer ID', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      run: macRun(0, 'Authority=Developer ID Application: Somebody Else, LLC (ZZZZZZZZZZ)'),
    });
    expect(o.result.status).toBe('invalid');
    expect(o.accepted).toBe(false);
  });

  it('rejects our org name under a foreign Apple team id', async () => {
    const o = await verifyCodeSignature('bin', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      expectedAppleTeamId: BENDYLINE_APPLE_TEAM_ID,
      run: macRun(0, 'Authority=Developer ID Application: Bendyline, LLC (ZZZZZZZZZZ)'),
    });
    expect(o.result.status).toBe('invalid');
    expect(o.accepted).toBe(false);
  });

  it('requires a Notarized Developer ID Gatekeeper result when requested', async () => {
    const run: Runner = async (cmd, args) => {
      if (cmd === 'spctl') {
        return { code: 0, stdout: '', stderr: 'source=Notarized Developer ID' };
      }
      return args.includes('--verify')
        ? { code: 0, stdout: '', stderr: '' }
        : {
            code: 0,
            stdout: '',
            stderr: REAL_CODESIGN_DVV,
          };
    };
    const o = await verifyCodeSignature('/Applications/Gezel.app', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      requireNotarizedApp: true,
      run,
    });
    expect(o.result.status).toBe('valid');
    expect(o.accepted).toBe(true);
  });

  it('rejects a signed but non-notarized binary when notarization is required', async () => {
    const run: Runner = async (cmd, args) => {
      if (cmd === 'spctl') {
        return { code: 3, stdout: '', stderr: 'source=Developer ID' };
      }
      return args.includes('--verify')
        ? { code: 0, stdout: '', stderr: '' }
        : {
            code: 0,
            stdout: '',
            stderr: REAL_CODESIGN_DVV,
          };
    };
    const o = await verifyCodeSignature('/Applications/Gezel.app', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      requireNotarizedApp: true,
      run,
    });
    expect(o.result.status).toBe('invalid');
    expect(o.accepted).toBe(false);
  });

  it('never uses Gatekeeper app assessment for a bare command-line binary', async () => {
    const commands: string[] = [];
    const run: Runner = async (cmd, args) => {
      commands.push(cmd);
      return args.includes('--verify')
        ? { code: 0, stdout: '', stderr: '' }
        : {
            code: 0,
            stdout: '',
            stderr: REAL_CODESIGN_DVV,
          };
    };
    const o = await verifyCodeSignature('/usr/local/bin/gezel-llama-server', {
      policy: 'require',
      platform: 'darwin',
      expectedPublisher: BENDYLINE_PUBLISHER,
      requireNotarizedApp: true,
      run,
    });
    expect(o.result.status).toBe('invalid');
    expect(o.result.detail).toMatch(/parent \.app bundle/i);
    expect(o.accepted).toBe(false);
    expect(commands).not.toContain('spctl');
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
