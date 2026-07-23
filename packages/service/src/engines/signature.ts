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
 *                 rejected. The default while the native binaries aren't
 *                 yet code-signed in build-native.yml.
 *   - `require` — accept only `valid` signatures. (`unsupported` platforms
 *                 — Linux, which has no signing standard we use — are
 *                 accepted because sha256 is the integrity gate there.)
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
      ? await verifyWindows(binPath, run)
      : platform === 'darwin'
        ? await verifyMac(binPath, run)
        : { status: 'unsupported' as const, detail: 'no signing standard for this platform' };

  const accepted = policyAccepts(result.status, opts.policy);
  if (!accepted) {
    log.warn(
      `[engine-signature] rejected ${binPath}: status=${result.status} (${result.detail ?? ''})`,
    );
  } else if (result.status === 'unsigned' && opts.policy === 'prefer') {
    log.warn(`[engine-signature] ${binPath} is unsigned (allowed under policy=prefer)`);
  }
  return { result, accepted };
}

function policyAccepts(status: SignatureStatus, policy: SignaturePolicy): boolean {
  if (policy === 'off') return true;
  if (policy === 'prefer') return status !== 'invalid';
  // require
  return status === 'valid' || status === 'unsupported';
}

async function verifyWindows(binPath: string, run: Runner): Promise<SignatureResult> {
  // Get-AuthenticodeSignature.Status: Valid | NotSigned | HashMismatch |
  // NotTrusted | UnknownError | … . -LiteralPath avoids glob expansion;
  // single quotes are doubled to escape (paths are from our own cache).
  const escaped = binPath.replace(/'/g, "''");
  const res = await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`,
  ]);
  if (isSpawnFailure(res.code)) {
    return { status: 'unsupported', detail: `could not run powershell (${res.code})` };
  }
  const status = res.stdout.trim();
  if (status === 'Valid') return { status: 'valid' };
  if (status === 'NotSigned') return { status: 'unsigned' };
  return { status: 'invalid', detail: `Authenticode status: ${status || 'unknown'}` };
}

async function verifyMac(binPath: string, run: Runner): Promise<SignatureResult> {
  // `codesign --verify` exits 0 for a valid signature, non-zero otherwise.
  const verify = await run('codesign', ['--verify', '--strict', binPath]);
  if (isSpawnFailure(verify.code)) {
    return { status: 'unsupported', detail: `could not run codesign (${verify.code})` };
  }
  if (verify.code === 0) return { status: 'valid' };
  // Distinguish unsigned from a bad/tampered signature.
  const info = await run('codesign', ['-dv', binPath]);
  const blob = `${info.stdout}\n${info.stderr}`.toLowerCase();
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
