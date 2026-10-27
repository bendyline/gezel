/**
 * electron-builder `beforePack` hook: on Windows, compile the installer's
 * permission helper (gezel-acl.exe) so `win.extraFiles` can ship it.
 *
 * It runs before electron-builder copies anything, so the exe is in place
 * for the copy and the afterPack signing sweep signs it with the rest of the
 * payload. A failed compile fails the build: without the helper the
 * installer cannot secure the machine data folder and never registers the
 * machine service. See build-installer-security.cjs.
 */
const { compileInstallerSecurity } = require('./build-installer-security.cjs');

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const built = compileInstallerSecurity();
  console.log(`[installer-security] built ${built}`);
};
