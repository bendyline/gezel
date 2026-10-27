/**
 * electron-builder `beforePack` hook: on Windows, compile the installer's
 * permission helper (gezel-acl.exe) so `win.extraFiles` can ship it.
 *
 * It runs before electron-builder copies anything, so the exe is in place
 * for the copy. electron-builder signs an extraFiles executable as it copies
 * it (through sign.cjs), and the afterPack sweep catches one that copy missed.
 * Not the native release: the helper is .NET IL, the same for every arch,
 * and its arguments must match this release's NSIS hooks.
 * A failed compile fails the build: without the helper the
 * installer cannot secure the machine data folder and never registers the
 * machine service. See build-installer-security.cjs.
 */
const { compileInstallerSecurity } = require('./build-installer-security.cjs');

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const built = compileInstallerSecurity();
  console.log(`[installer-security] built ${built}`);
};
