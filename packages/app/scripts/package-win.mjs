#!/usr/bin/env node
/**
 * Package the Windows app for the arch this host builds: the NSIS installer,
 * or with `--store` the MSIX (appx) package.
 *
 * The arch is named explicitly (`nsis:arm64`, `appx:arm64`) because the
 * service bundle, its native addons and the bundled runtimes all match the
 * build host. A bare `electron-builder --win` on an ARM64 machine would wrap
 * that arm64 payload in the config's default x64 app, which installs and then
 * fails to start its service.
 *
 * Environment:
 *   GEZEL_BUNDLE_ARCH — package for this arch instead of the host's (x64 or
 *                       arm64); every bundle step honors the same variable.
 *
 * `--store` only packages: release-msix.yml stages the model pack and the
 * store marker before calling it, and a local store build without them is not
 * the package the Store receives.
 *
 * Any further arguments are passed to electron-builder.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_ARCHES = new Set(['x64', 'arm64']);

const args = process.argv.slice(2);
const store = args.includes('--store');
const passthrough = args.filter((arg) => arg !== '--store');

const arch = process.env.GEZEL_BUNDLE_ARCH ?? process.arch;
if (!WINDOWS_ARCHES.has(arch)) {
  console.error(`[package-win] cannot package Windows for arch "${arch}" (x64 or arm64)`);
  process.exit(1);
}

/**
 * 7-Zip 23+ compresses ARM64 executables through its ARM64 branch filter,
 * which the 7-Zip plugin inside the NSIS installer predates: it skips every
 * file stored that way, so an arm64 installer laid down the app without one
 * .exe or .dll and still exited 0. A forced filter replaces the automatic
 * choice; BCJ is one that plugin has always decoded. Same in release CI.
 */
function nsisArchiveFilterEnv(targetArch, storePackage) {
  return targetArch === 'arm64' && !storePackage ? { ELECTRON_BUILDER_7Z_FILTER: 'BCJ' } : {};
}

const builderArgs = [
  '--win',
  `${store ? 'appx' : 'nsis'}:${arch}`,
  ...(store ? ['--config', 'electron-builder.appx.yml'] : []),
  ...(passthrough.includes('--publish') ? [] : ['--publish', 'never']),
  ...passthrough,
];
console.log(`[package-win] electron-builder ${builderArgs.join(' ')}`);
const result = spawnSync('electron-builder', builderArgs, {
  cwd: appRoot,
  stdio: 'inherit',
  // electron-builder is a .cmd shim on Windows, which only a shell can run.
  shell: process.platform === 'win32',
  env: { ...process.env, ...nsisArchiveFilterEnv(arch, store) },
});
process.exit(result.status ?? 1);
