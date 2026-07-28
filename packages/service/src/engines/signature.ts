import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('engine-signature');
const execFileAsync = promisify(execFile);

/**
 * How strictly a downloaded engine binary's code signature is enforced.
 *
 *   - `off`     — skip the check entirely (escape hatch).
 *   - `prefer`  — verify if signed; an unsigned binary is allowed (with a
 *                 warning), but a *tampered* signature (`invalid`) is
 *                 rejected. Reserved for explicitly allowlisted upstream
 *                 binaries that their publisher ships unsigned.
 *   - `require` — accept only `valid` signatures. (`unsupported` platforms
 *                 — Linux, which has no signing standard we use — are
 *                 accepted because sha256 is the integrity gate there.)
 *                 Missing verification tools on Windows/macOS fail closed.
 */
export type SignaturePolicy = 'require' | 'prefer' | 'off';

export type SignatureStatus = 'valid' | 'invalid' | 'unsigned' | 'unsupported';

export interface SignatureResult {
  status: SignatureStatus;
  detail?: string;
}

export interface VerifyOutcome {
  result: SignatureResult;
  /** Whether {@link VerifyOptions.policy} accepts this result. */
  accepted: boolean;
}

/** (code, stdout, stderr) of a finished command; never rejects. */
type RunResult = { code: number | string; stdout: string; stderr: string };
type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface VerifyOptions {
  policy: SignaturePolicy;
  /** Test seam — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Expected organization in the Authenticode/Developer ID identity. */
  expectedPublisher?: string;
  /**
   * Require Gatekeeper to identify a parent `.app` bundle as Notarized
   * Developer ID. Never use this for a bare command-line binary: Apple
   * notarizes its submitted archive, but `spctl` does not assess it as an app.
   */
  requireNotarizedApp?: boolean;
  /** Test seam — defaults to a real `execFile` runner. */
  run?: Runner;
}

const defaultRun: Runner = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: e.code ?? 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
};

/** Did the tool fail to launch at all (missing binary)? Then we can't verify. */
function isSpawnFailure(code: number | string): boolean {
  return typeof code === 'string'; // 'ENOENT', 'EACCES', …
}

/**
 * Verify a binary's code signature and decide whether `policy` accepts it.
 * Pure-ish: all process interaction goes through the injectable `run`.
 */
export async function verifyCodeSignature(
  binPath: string,
  opts: VerifyOptions,
): Promise<VerifyOutcome> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const result =
    platform === 'win32'
      ? await verifyWindows(binPath, run, opts.expectedPublisher)
      : platform === 'darwin'
        ? await verifyMac(binPath, run, opts.expectedPublisher, opts.requireNotarizedApp === true)
        : { status: 'unsupported' as const, detail: 'no signing standard for this platform' };

  const accepted = policyAccepts(result.status, opts.policy, platform);
  if (!accepted) {
    log.warn(
      `[engine-signature] rejected ${binPath}: status=${result.status} (${result.detail ?? ''})`,
    );
  } else if (result.status === 'unsigned' && opts.policy === 'prefer') {
    log.warn(`[engine-signature] ${binPath} is unsigned (allowed under policy=prefer)`);
  }
  return { result, accepted };
}

function policyAccepts(
  status: SignatureStatus,
  policy: SignaturePolicy,
  platform: NodeJS.Platform,
): boolean {
  if (policy === 'off') return true;
  if (policy === 'prefer') return status !== 'invalid';
  // require
  return (
    status === 'valid' ||
    (status === 'unsupported' && platform !== 'win32' && platform !== 'darwin')
  );
}

async function verifyWindows(
  binPath: string,
  run: Runner,
  expectedPublisher?: string,
): Promise<SignatureResult> {
  // Get-AuthenticodeSignature.Status: Valid | NotSigned | HashMismatch |
  // NotTrusted | UnknownError | … . -LiteralPath avoids glob expansion;
  // single quotes are doubled to escape (paths are from our own cache).
  const escaped = binPath.replace(/'/g, "''");
  const res = await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$sig = Get-AuthenticodeSignature -LiteralPath '${escaped}'; Write-Output ([string]$sig.Status); Write-Output ([string]$sig.SignerCertificate.Subject)`,
  ]);
  if (isSpawnFailure(res.code)) {
    return { status: 'unsupported', detail: `could not run powershell (${res.code})` };
  }
  const [status = '', ...subjectLines] = res.stdout.trim().split(/\r?\n/);
  const subject = subjectLines.join(' ').trim();
  if (status === 'Valid') {
    if (expectedPublisher && !subject.toLowerCase().includes(expectedPublisher.toLowerCase())) {
      return {
        status: 'invalid',
        detail: `unexpected Authenticode publisher: ${subject || 'missing signer subject'}`,
      };
    }
    return { status: 'valid', ...(subject ? { detail: subject } : {}) };
  }
  if (status === 'NotSigned') return { status: 'unsigned' };
  return { status: 'invalid', detail: `Authenticode status: ${status || 'unknown'}` };
}

async function verifyMac(
  binPath: string,
  run: Runner,
  expectedPublisher?: string,
  requireNotarizedApp = false,
): Promise<SignatureResult> {
  // `codesign --verify` exits 0 for a valid signature, non-zero otherwise.
  const verify = await run('codesign', ['--verify', '--strict', binPath]);
  if (isSpawnFailure(verify.code)) {
    return { status: 'unsupported', detail: `could not run codesign (${verify.code})` };
  }
  const info = await run('codesign', ['-dv', binPath]);
  const blob = `${info.stdout}\n${info.stderr}`.toLowerCase();
  if (verify.code === 0) {
    if (
      expectedPublisher &&
      !blob.includes(`authority=developer id application: ${expectedPublisher.toLowerCase()}`)
    ) {
      return {
        status: 'invalid',
        detail: `unexpected Developer ID authority for ${binPath}`,
      };
    }
    if (requireNotarizedApp) {
      if (!/\.app\/?$/i.test(binPath)) {
        return {
          status: 'invalid',
          detail: 'Gatekeeper notarization assessment requires a parent .app bundle',
        };
      }
      const assessment = await run('spctl', [
        '--assess',
        '--type',
        'execute',
        '--verbose=4',
        binPath,
      ]);
      if (isSpawnFailure(assessment.code)) {
        return {
          status: 'unsupported',
          detail: `could not run Gatekeeper assessment (${assessment.code})`,
        };
      }
      const assessmentText = `${assessment.stdout}\n${assessment.stderr}`.toLowerCase();
      if (assessment.code !== 0 || !assessmentText.includes('source=notarized developer id')) {
        return {
          status: 'invalid',
          detail: `Gatekeeper did not confirm notarization: ${assessmentText.trim() || 'assessment failed'}`,
        };
      }
    }
    return { status: 'valid' };
  }
  // Distinguish unsigned from a bad/tampered signature.
  if (blob.includes('not signed at all') || blob.includes('no signature')) {
    return { status: 'unsigned' };
  }
  return { status: 'invalid', detail: 'codesign --verify failed' };
}

/**
 * Best-effort: clear the macOS `com.apple.quarantine` xattr so a
 * freshly-downloaded binary isn't blocked by Gatekeeper on first exec.
 * No-op (and never throws) off macOS or when the attr isn't present.
 */
export async function stripQuarantine(
  binPath: string,
  opts: { platform?: NodeJS.Platform; run?: Runner } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return;
  const run = opts.run ?? defaultRun;
  await run('xattr', ['-d', 'com.apple.quarantine', binPath]).catch(() => {});
}
