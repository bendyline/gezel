import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';

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

/**
 * Our signing identity, as it actually appears in each platform's certificate.
 *
 * The two platforms disagree on punctuation for the same legal entity, which
 * is why the name is matched punctuation-insensitively and the Apple team id
 * is matched exactly:
 *
 *   macOS   `Developer ID Application: Bendyline, LLC (JXA5M4VK3V)`   ← comma
 *   Windows `CN=Bendyline LLC,O=Bendyline LLC,L=Sammamish,ST=…,C=US`  ← none
 *
 * A literal `includes('… Application: Bendyline LLC')` therefore never matched
 * a real macOS binary, and every native engine download failed closed once the
 * default policy became `require`. The team id is the durable anchor — it is
 * bound to the certificate and cannot drift with a display-name reissue.
 */
export const BENDYLINE_PUBLISHER = 'Bendyline LLC';
export const BENDYLINE_APPLE_TEAM_ID = 'JXA5M4VK3V';

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
   * Expected Apple Developer team id (macOS only). Matched exactly against the
   * `(TEAMID)` suffix of the leaf `Developer ID Application` authority.
   */
  expectedAppleTeamId?: string;
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
      // Native installation verifies four toolkit executables in sequence.
      // On Windows, detaching these short-lived PowerShell checks gives each
      // one a new console window; hide the owned children instead.
      ...windowsHeadlessSpawnOptions(),
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
        ? await verifyMac(binPath, run, {
            expectedPublisher: opts.expectedPublisher,
            expectedAppleTeamId: opts.expectedAppleTeamId,
            requireNotarizedApp: opts.requireNotarizedApp === true,
          })
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
    // Substring, not equality: this is a full DN
    // (`CN=Bendyline LLC,O=Bendyline LLC,L=…`), and normalizing both sides
    // keeps the match working if the CN is ever reissued with the comma form
    // Apple's certificate already uses.
    if (
      expectedPublisher &&
      !normalizeIdentityName(subject).includes(normalizeIdentityName(expectedPublisher))
    ) {
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

/**
 * Collapse case, punctuation, and spacing so the same organization compares
 * equal across certificates that spell it differently — `Bendyline, LLC` on
 * Apple's leaf vs `Bendyline LLC` on the Authenticode DN.
 */
function normalizeIdentityName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Leaf `Developer ID Application` authority, split into name and team id. */
function parseDeveloperIdAuthority(text: string): { name: string; teamId?: string } | null {
  const withTeam = /^Authority=Developer ID Application:\s*(.*?)\s*\(([A-Za-z0-9]+)\)\s*$/im.exec(
    text,
  );
  if (withTeam?.[1] && withTeam[2]) return { name: withTeam[1], teamId: withTeam[2] };
  const bare = /^Authority=Developer ID Application:\s*(.+?)\s*$/im.exec(text);
  return bare?.[1] ? { name: bare[1] } : null;
}

async function verifyMac(
  binPath: string,
  run: Runner,
  opts: {
    expectedPublisher?: string;
    expectedAppleTeamId?: string;
    requireNotarizedApp?: boolean;
  } = {},
): Promise<SignatureResult> {
  const { expectedPublisher, expectedAppleTeamId, requireNotarizedApp = false } = opts;
  // `codesign --verify` exits 0 for a valid signature, non-zero otherwise.
  const verify = await run('codesign', ['--verify', '--strict', binPath]);
  if (isSpawnFailure(verify.code)) {
    return { status: 'unsupported', detail: `could not run codesign (${verify.code})` };
  }
  // `-dvv`, not `-dv`: `Authority=` lines only appear from the second
  // verbosity level up. At `-dv` the publisher check can never pass, because
  // the string it looks for is never printed.
  const info = await run('codesign', ['-dvv', binPath]);
  const raw = `${info.stdout}\n${info.stderr}`;
  const blob = raw.toLowerCase();
  if (verify.code === 0) {
    if (expectedPublisher || expectedAppleTeamId) {
      const authority = parseDeveloperIdAuthority(raw);
      if (!authority) {
        return {
          status: 'invalid',
          detail: `no Developer ID Application authority for ${binPath}`,
        };
      }
      if (
        expectedPublisher &&
        normalizeIdentityName(authority.name) !== normalizeIdentityName(expectedPublisher)
      ) {
        return {
          status: 'invalid',
          detail: `unexpected Developer ID authority for ${binPath}: ${authority.name}`,
        };
      }
      if (expectedAppleTeamId && authority.teamId !== expectedAppleTeamId) {
        return {
          status: 'invalid',
          detail: `unexpected Apple team for ${binPath}: ${authority.teamId ?? 'none'}`,
        };
      }
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
