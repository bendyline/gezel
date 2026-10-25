#!/usr/bin/env node
/**
 * Copy the Visual C++ runtime DLLs beside the native engines in
 * `packages/app/native-bin/win32-<arch>*`, for the Microsoft Store (MSIX)
 * package only.
 *
 * The engines import MSVCP140.dll and VCRUNTIME140.dll (and some
 * MSVCP140_CODECVT_IDS.dll), which are not Windows components. The NSIS
 * installer provisions them by running Microsoft's redistributable installer
 * (stage-vc-redist.mjs), which Windows Update then services. An MSIX cannot
 * run an installer, and the VCLibs desktop framework package is deprecated,
 * so the Store package carries them app-local instead: Windows looks for a
 * DLL in the loading executable's own folder first, so each engine folder
 * gets its own copy. Microsoft documents app-local deployment of these files
 * as permitted redistribution.
 *
 * The copies come from the build host's Visual Studio, the toolset that
 * compiled the engines, and each must carry Microsoft's Authenticode
 * signature before it is staged.
 *
 * Runs in release-msix.yml after the native payload is verified against its
 * pins, because those pins do not include these files. Locally, a staged
 * native-bin no longer matches the pin, so the next `pnpm app` re-fetches it.
 *
 * Environment:
 *   GEZEL_BUNDLE_ARCH            — the arch being packaged (x64 or arm64),
 *                                  default the host's.
 *   GEZEL_APP_LOCAL_CRT_REQUIRED — fail instead of warning when the runtime
 *                                  cannot be found or verified (store CI).
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAppLocalCrtDir, verifyMicrosoftSignature } from './msvc-redist.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeBinRoot = join(appRoot, 'native-bin');
const required = process.env.GEZEL_APP_LOCAL_CRT_REQUIRED === '1';
const arch = process.env.GEZEL_BUNDLE_ARCH ?? process.arch;

// The C++ standard library and the compiler runtime the engines import.
// ConcRT and the C++/CX library ship in the same folder but nothing loads them.
const RUNTIME_DLL = /^(?:msvcp140|vcruntime140)(?:_\w+)?\.dll$/i;

function bail(message) {
  if (required) {
    console.error(`[app-local-crt] error: ${message}`);
    process.exit(1);
  }
  console.warn(`[app-local-crt] ${message} — the package will ship without it.`);
  process.exit(0);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[app-local-crt] not a Windows build — nothing to stage.');
    return;
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    bail(`no Visual C++ runtime for arch "${arch}"`);
    return;
  }

  const crtDir = await findAppLocalCrtDir(arch);
  if (!crtDir) {
    bail(`no ${arch} Microsoft.VC*.CRT folder in any Visual Studio installation`);
    return;
  }
  const runtime = readdirSync(crtDir).filter((name) => RUNTIME_DLL.test(name));
  if (!runtime.some((name) => /^vcruntime140\.dll$/i.test(name))) {
    bail(`${crtDir} holds no vcruntime140.dll`);
    return;
  }
  for (const name of runtime) {
    const signature = verifyMicrosoftSignature(join(crtDir, name));
    if (!signature.valid) {
      bail(`refusing to stage an unverified ${name} (${signature.detail})`);
      return;
    }
  }

  const keys = existsSync(nativeBinRoot)
    ? readdirSync(nativeBinRoot).filter(
        (key) => key === `win32-${arch}` || key.startsWith(`win32-${arch}-`),
      )
    : [];
  const engineKeys = keys.filter((key) =>
    readdirSync(join(nativeBinRoot, key)).some((name) => /\.(?:exe|dll)$/i.test(name)),
  );
  if (engineKeys.length === 0) {
    bail(`no win32-${arch} engines are staged under ${nativeBinRoot}`);
    return;
  }
  for (const key of engineKeys) {
    for (const name of runtime) {
      copyFileSync(join(crtDir, name), join(nativeBinRoot, key, name));
    }
    console.log(`[app-local-crt] ${key}: ${runtime.join(', ')}`);
  }
  console.log(`[app-local-crt] source: ${crtDir}`);
}

main().catch((error) => {
  console.error(`[app-local-crt] ${error?.stack ?? error}`);
  process.exit(1);
});
