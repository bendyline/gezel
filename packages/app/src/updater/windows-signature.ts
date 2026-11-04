/**
 * Windows update signature check.
 *
 * electron-updater verifies a downloaded NSIS update by running
 * Get-AuthenticodeSignature under a fixed 20 s timeout. Windows reads and
 * hashes the whole installer for that check, and it is slowest on a file it
 * has only just written: a 1.28 GB installer measured 24 s on an otherwise
 * idle machine. Gezel's x64 installer is already 1.19 GB. When the check times
 * out, electron-updater discards the completed download and the next launch
 * downloads it again — the update never lands.
 *
 * This makes the same check — Authenticode status plus electron-updater's
 * publisher matching — with a timeout sized for installers that large. It is
 * wired in through NsisUpdater's documented `verifyUpdateCodeSignature` hook.
 */

import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import type { VerifyUpdateCodeSignature } from 'electron-updater';

/** Generous on purpose: a slow check only delays an error, a short one discards a 1 GB download. */
export const SIGNATURE_CHECK_TIMEOUT_MS = 5 * 60_000;

/** Code on every failure to run the check, as distinct from a signature that fails it. */
export const SIGNATURE_CHECK_ERROR_CODE = 'ERR_GEZEL_SIGNATURE_CHECK';

/** System.Management.Automation.SignatureStatus.Valid */
const AUTHENTICODE_VALID = 0;

/** The update path travels in the environment so it is never parsed as PowerShell. */
const UPDATE_FILE_VARIABLE = 'GEZEL_UPDATE_FILE';

// Cmdlets and core types only. AppLocker and App Control policies run
// PowerShell in Constrained Language Mode, which refuses .NET static members
// and constructors; one `[Console]::OutputEncoding` line made every update
// fail on those PCs, and an installed copy cannot update itself past a broken
// check. A failure comes back as JSON on stdout: left to PowerShell,
// -EncodedCommand reports it on stderr as CLIXML. Every non-ASCII character is
// escaped, because stdout uses the console code page and a localized message
// in Shift-JIS can carry a 0x5C byte that reads as a JSON backslash.
export const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  `  $signature = Get-AuthenticodeSignature -LiteralPath $env:${UPDATE_FILE_VARIABLE}`,
  '  $report = @{ Status = [int]$signature.Status; StatusMessage = [string]$signature.StatusMessage; Subject = $signature.SignerCertificate.Subject }',
  '} catch {',
  '  $report = @{ Error = [string]$_.Exception.Message }',
  '}',
  '$json = $report | ConvertTo-Json -Compress',
  "-join ($json.ToCharArray() | ForEach-Object { if ([int]$_ -lt 128) { [string]$_ } else { '\\u{0:x4}' -f [int]$_ } })",
].join('\n');

/** -EncodedCommand sidesteps powershell.exe's command-line quoting rules entirely. */
const ENCODED_SIGNATURE_SCRIPT = Buffer.from(SIGNATURE_SCRIPT, 'utf16le').toString('base64');

export type RunPowerShell = (
  encodedCommand: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string>;

interface SignatureReport {
  readonly status: number;
  readonly statusMessage: string;
  readonly subject: string | null;
}

function signatureCheckError(detail: string): Error {
  return Object.assign(new Error(`Windows update signature check failed: ${detail}`), {
    code: SIGNATURE_CHECK_ERROR_CODE,
  });
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const windows = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function signatureCheckEnvironment(
  updateFile: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // A PowerShell 7 module path stops Windows PowerShell from loading
    // Get-AuthenticodeSignature; without one it uses its own default.
    if (key.toUpperCase() !== 'PSMODULEPATH') env[key] = value;
  }
  env[UPDATE_FILE_VARIABLE] = updateFile;
  return env;
}

const runWindowsPowerShell: RunPowerShell = (encodedCommand, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      windowsPowerShellPath(env),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', encodedCommand],
      { env, timeout: timeoutMs, ...windowsHeadlessSpawnOptions() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else if (error.killed) {
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
        } else {
          // Not error.message: it echoes the whole encoded command line.
          const detail = stderr.trim().slice(0, 1_000);
          reject(
            new Error(
              `powershell.exe failed (${error.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
            ),
          );
        }
      },
    );
  });

function parseSignatureReport(output: string): SignatureReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const { Status, StatusMessage, Subject, Error: failure } = parsed as Record<string, unknown>;
    if (typeof failure === 'string') throw signatureCheckError(failure);
    if (typeof Status === 'number' && (Subject === null || typeof Subject === 'string')) {
      return {
        status: Status,
        statusMessage: typeof StatusMessage === 'string' ? StatusMessage : '',
        subject: Subject,
      };
    }
  }
  throw signatureCheckError(`unexpected PowerShell output: ${output.trim().slice(0, 200)}`);
}

/**
 * Attribute values of a distinguished name such as
 * `CN=Bendyline LLC, O="Bendyline, LLC", C=US`. Quoted values keep their
 * separators, `\,` and `\2C` escapes are decoded, and a name with no `=` (a
 * bare publisher name) has no attributes.
 */
export function parseDistinguishedName(dn: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let key: string | null = null;
  let value = '';
  let quoted = false;
  const finishAttribute = (): void => {
    if (key !== null) attributes.set(key.trim(), value.trim());
    key = null;
    value = '';
  };
  for (let i = 0; i < dn.length; i++) {
    const ch = dn.charAt(i);
    if (quoted) {
      if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === '\\' && i + 1 < dn.length) {
      const hex = dn.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
      } else {
        value += dn.charAt(i + 1);
        i += 1;
      }
    } else if (ch === '=' && key === null) {
      key = value;
      value = '';
    } else if (ch === ',' || ch === ';' || ch === '+') {
      finishAttribute();
    } else {
      value += ch;
    }
  }
  finishAttribute();
  return attributes;
}

/**
 * electron-updater's publisher rule: a full distinguished name must match the
 * signer on every attribute it names; a bare name is compared with the
 * signer's common name.
 */
export function signerMatchesPublisher(
  subject: string,
  publisherNames: readonly string[],
): boolean {
  const signer = parseDistinguishedName(subject);
  return publisherNames.some((name) => {
    const expected = parseDistinguishedName(name);
    if (expected.size === 0) return name === signer.get('CN');
    return [...expected].every(([key, value]) => signer.get(key) === value);
  });
}

/**
 * Resolves null when the update is validly signed by one of `publisherNames`,
 * or a description of the mismatch, which electron-updater raises as
 * ERR_UPDATER_INVALID_SIGNATURE. Rejects when the check itself cannot run.
 */
export function createWindowsUpdateSignatureVerifier(
  run: RunPowerShell = runWindowsPowerShell,
  timeoutMs: number = SIGNATURE_CHECK_TIMEOUT_MS,
): VerifyUpdateCodeSignature {
  return async (publisherNames, updateFile) => {
    let output: string;
    try {
      output = await run(
        ENCODED_SIGNATURE_SCRIPT,
        signatureCheckEnvironment(updateFile),
        timeoutMs,
      );
    } catch (error: unknown) {
      throw signatureCheckError(error instanceof Error ? error.message : String(error));
    }

    const report = parseSignatureReport(output);
    if (report.status !== AUTHENTICODE_VALID) {
      return `Authenticode status ${report.status}: ${report.statusMessage}`;
    }
    if (report.subject === null || !signerMatchesPublisher(report.subject, publisherNames)) {
      return `signed by "${report.subject ?? 'nobody'}", expected ${publisherNames.join(' | ')}`;
    }
    return null;
  };
}

export const verifyWindowsUpdateSignature = createWindowsUpdateSignatureVerifier();
