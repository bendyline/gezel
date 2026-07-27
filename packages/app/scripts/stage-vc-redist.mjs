#!/usr/bin/env node
/**
 * Stage `vc_redist.x64.exe` into `packages/app/dist/vc-redist/` so the NSIS
 * installer can embed it and run it during customInstall.
 *
 * Why the app needs it at all: every native engine DLL we ship
 * (`ggml-base.dll`, `ggml-cpu.dll`, `llama.dll`, `whisper.dll`, and the
 * `gezel-*-server.exe` binaries) imports `MSVCP140.dll`,
 * `VCRUNTIME140.dll`, and `VCRUNTIME140_1.dll`. Those are not Windows
 * components — they ship in the Microsoft Visual C++ 2015-2022
 * Redistributable. Without it the loader fails the DLL before `main()`, so
 * local models simply never start. Nothing in the installer guaranteed it
 * before native-v0.1.18.
 *
 * Why central deployment (this) rather than copying the DLLs app-local:
 * both are licensed and documented by Microsoft, but a centrally installed
 * runtime is serviced by Windows Update, while app-local copies freeze at
 * build time and only move when we cut a release. A CRT is exactly the
 * component you want receiving security fixes without us in the loop.
 *
 * Why not static-link the CRT instead (`/MT`): the engines are split across
 * several DLLs that hand allocations back and forth. A static CRT gives
 * each module its own heap, so a buffer allocated in `ggml.dll` and freed
 * in `llama.dll` corrupts. Not an option for this layout.
 *
 * Source: the Visual Studio installation on the build host, which is the
 * copy version-matched to the toolset that compiled those DLLs. That is a
 * deliberate choice rather than the "grab whatever the host has" pattern
 * used for OpenSSL — for a CRT, matching the compiling toolset IS the
 * correct version. The staged file is verified to carry a valid Microsoft
 * Authenticode signature before it is allowed into the installer.
 *
 * Environment:
 *   GEZEL_VCREDIST_SKIP=1     — skip staging (dev builds; the NSIS hook
 *                               compiles without the redist and the
 *                               installer just doesn't offer it).
 *   GEZEL_VCREDIST_REQUIRED=1 — fail instead of warning when it cannot be
 *                               found or verified. Set in release CI.
 *   GEZEL_VCREDIST_PATH       — explicit path, bypassing discovery.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const outDir = join(appRoot, 'dist', 'vc-redist');
const outFile = join(outDir, 'vc_redist.x64.exe');

const required = process.env.GEZEL_VCREDIST_REQUIRED === '1';

function bail(message) {
  if (required) {
    console.error(`[vc-redist] error: ${message}`);
    process.exit(1);
  }
  console.warn(`[vc-redist] ${message} — installer will ship without it.`);
  process.exit(0);
}

/** `vswhere` is installed with every VS 2017+ and knows where VS lives. */
function vswhereInstallPaths() {
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

/** VS lays the redist down at <root>/VC/Redist/MSVC/<version>/vc_redist.x64.exe. */
async function findUnderVsRoot(root) {
  const redistRoot = join(root, 'VC', 'Redist', 'MSVC');
  let versions;
  try {
    versions = await readdir(redistRoot);
  } catch {
    return null;
  }
  // Highest toolset version wins — it matches the newest compiler present.
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(redistRoot, version, 'vc_redist.x64.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Only ship a binary that Windows itself agrees is Microsoft-signed. This is
 * the integrity check that matters for a file we execute elevated during
 * install; it is stronger than a checksum pinned against an evergreen URL,
 * which would rot on every Microsoft servicing update.
 */
function verifyMicrosoftSignature(path) {
  const script = `
    $sig = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}'
    if ($sig.Status -ne 'Valid') { Write-Output "INVALID:$($sig.Status)"; exit 0 }
    Write-Output "OK:$($sig.SignerCertificate.Subject)"
  `;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
    if (!out.startsWith('OK:')) return { valid: false, detail: out };
    const subject = out.slice(3);
    // Subject must actually name Microsoft; a valid signature from some
    // other publisher is not what we intend to run elevated.
    if (!/O=Microsoft Corporation/i.test(subject)) {
      return { valid: false, detail: `unexpected signer: ${subject}` };
    }
    return { valid: true, detail: subject };
  } catch (error) {
    return { valid: false, detail: String(error) };
  }
}

async function main() {
  if (process.env.GEZEL_VCREDIST_SKIP === '1') {
    console.log('[vc-redist] GEZEL_VCREDIST_SKIP=1 — skipping.');
    return;
  }
  if (process.platform !== 'win32') {
    // Only the NSIS target consumes this; mac/linux packaging never reads it.
    console.log('[vc-redist] not a Windows build — nothing to stage.');
    return;
  }

  let source = process.env.GEZEL_VCREDIST_PATH ?? null;
  if (source && !existsSync(source)) {
    bail(`GEZEL_VCREDIST_PATH=${source} does not exist`);
    return;
  }
  if (!source) {
    for (const root of vswhereInstallPaths()) {
      source = await findUnderVsRoot(root);
      if (source) break;
    }
  }
  if (!source) {
    bail('vc_redist.x64.exe not found in any Visual Studio installation');
    return;
  }

  const signature = verifyMicrosoftSignature(source);
  if (!signature.valid) {
    bail(`refusing to stage an unverified vc_redist.x64.exe (${signature.detail})`);
    return;
  }

  await mkdir(outDir, { recursive: true });
  await copyFile(source, outFile);
  const { size } = await stat(outFile);
  console.log(`[vc-redist] staged ${outFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[vc-redist] source: ${source}`);
  console.log(`[vc-redist] signer: ${signature.detail}`);
}

main().catch((error) => {
  console.error(`[vc-redist] ${error?.stack ?? error}`);
  process.exit(1);
});
