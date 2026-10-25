/**
 * Locating Microsoft's Visual C++ runtime in the build host's Visual Studio,
 * and proving a file from it is Microsoft's.
 *
 * Shared by stage-vc-redist.mjs (the NSIS installer runs Microsoft's
 * redistributable installer) and stage-app-local-crt.mjs (the MSIX, which
 * cannot run an installer, carries the DLLs beside the engines). Both take the
 * copy belonging to the toolset on the build host: a CRT must match the
 * toolset that compiled the binaries it serves.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** `vswhere` is installed with every VS 2017+ and knows where VS lives. */
export function vswhereInstallPaths() {
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!existsSync(vswhere)) return [];
  try {
    const out = execFileSync(
      vswhere,
      ['-latest', '-products', '*', '-property', 'installationPath', '-nologo'],
      { encoding: 'utf8' },
    );
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The first `relativePath` that exists under `<VS>/VC/Redist/MSVC/<version>/`,
 * newest toolset version first — it matches the newest compiler present.
 */
export async function findInVsRedist(relativePath) {
  for (const root of vswhereInstallPaths()) {
    const redistRoot = join(root, 'VC', 'Redist', 'MSVC');
    let versions;
    try {
      versions = await readdir(redistRoot);
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(redistRoot, version, relativePath);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The app-local CRT folder for `arch`: `<VS>/VC/Redist/MSVC/<version>/<arch>/
 * Microsoft.VC<toolset>.CRT/`, newest toolset version first. The toolset
 * number (VC143 for Visual Studio 2022) moves with Visual Studio, so it is
 * matched rather than named.
 */
export async function findAppLocalCrtDir(arch) {
  for (const root of vswhereInstallPaths()) {
    const redistRoot = join(root, 'VC', 'Redist', 'MSVC');
    let versions;
    try {
      versions = await readdir(redistRoot);
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      let entries;
      try {
        entries = await readdir(join(redistRoot, version, arch));
      } catch {
        continue;
      }
      const crt = entries
        .filter((name) => /^Microsoft\.VC\d+\.CRT$/i.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      if (crt) return join(redistRoot, version, arch, crt);
    }
  }
  return null;
}

/**
 * Only ship a binary that Windows itself agrees is Microsoft-signed. This is
 * the integrity check that matters for a runtime the engines load or an
 * installer we execute elevated; it is stronger than a checksum pinned against
 * an evergreen URL, which would rot on every Microsoft servicing update.
 */
export function verifyMicrosoftSignature(path) {
  const script = `
    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
    $sig = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}'
    if ($sig.Status -ne 'Valid') { Write-Output "INVALID:$($sig.Status)"; exit 0 }
    Write-Output "OK:$($sig.SignerCertificate.Subject)"
  `;
  // The release workflow's default shell is pwsh 7, whose PSModulePath is
  // inherited by this child Windows PowerShell 5.1 and can stop it autoloading
  // its own Microsoft.PowerShell.Security. Get-AuthenticodeSignature then never
  // runs, $sig stays null, and a perfectly good binary is rejected as
  // "INVALID:" with an empty status. Let the host resolve its own module path.
  const { PSModulePath: _ignored, ...env } = process.env;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env,
    }).trim();
    if (!out.startsWith('OK:')) return { valid: false, detail: out };
    const subject = out.slice(3);
    // Subject must actually name Microsoft; a valid signature from some
    // other publisher is not what we intend to ship as Microsoft's runtime.
    if (!/O=Microsoft Corporation/i.test(subject)) {
      return { valid: false, detail: `unexpected signer: ${subject}` };
    }
    return { valid: true, detail: subject };
  } catch (error) {
    return { valid: false, detail: String(error) };
  }
}
