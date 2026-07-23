/**
 * electron-builder `afterPack` hook — works around an asar packing bug in
 * electron-builder 26.x where the staged `package.json` rewrite drops the
 * first ~13 bytes from the file, leaving the asar's content offsets
 * out of sync with its manifest. Every file after the corrupted
 * `package.json` reads shifted bytes; in particular `dist/main.js` starts
 * with ` = Object.defineProperty;` instead of `var __defProp = …`, and
 * Electron's main process crashes silently with exit code 1 — no window,
 * no log output, no crash dump.
 *
 * Fix strategy: take advantage of Electron's "asar.unpacked overrides
 * asar" transparency. The critical Electron entry files (package.json,
 * dist/main.js, dist/main.js.map, dist/preload.cjs) are listed in
 * electron-builder.yml's `asarUnpack` so electron-builder copies them to
 * `app.asar.unpacked/` in addition to packing them into the (corrupted)
 * asar. When Electron resolves `app.asar/<path>`, its patched fs first
 * checks `app.asar.unpacked/<path>` and reads from disk when present —
 * bypassing the corrupted asar window entirely.
 *
 * This hook's job is to make sure the asar.unpacked copies are correct.
 * electron-builder rewrites package.json before staging (the same rewrite
 * that triggers the bug), so the asar.unpacked copy may inherit the
 * corruption — we forcibly overwrite from canonical source after pack.
 * dist/main.js is bundled by tsup and is *not* rewritten, so it should
 * be correct on disk already, but we re-copy as belt-and-braces in case
 * electron-builder modifies it for any other reason in the future.
 *
 * If electron-builder eventually fixes this (track the issue at
 * https://github.com/electron-userland/electron-builder), delete this
 * hook and the `afterPack` reference + asarUnpack entries in
 * electron-builder.yml.
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const resourcesDir =
    process.platform === 'darwin'
      ? path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');

  if (!fs.existsSync(unpackedDir)) {
    console.warn(`[fix-asar] no app.asar.unpacked at ${unpackedDir} — nothing to fix`);
  } else {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const appPkgRoot = path.join(repoRoot, 'packages', 'app');
    const overrides = [
      { src: path.join(appPkgRoot, 'package.json'), dest: 'package.json' },
      { src: path.join(appPkgRoot, 'dist', 'main.js'), dest: 'dist/main.js' },
      { src: path.join(appPkgRoot, 'dist', 'main.js.map'), dest: 'dist/main.js.map' },
      { src: path.join(appPkgRoot, 'dist', 'preload.cjs'), dest: 'dist/preload.cjs' },
    ];

    for (const { src, dest } of overrides) {
      if (!fs.existsSync(src)) {
        console.warn(`[fix-asar] missing canonical source ${src}; skipping`);
        continue;
      }
      const destPath = path.join(unpackedDir, dest);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(src, destPath);
      const sz = fs.statSync(destPath).size;
      console.log(`[fix-asar] restored ${dest} (${sz} bytes)`);
    }
  }

  const verifierPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'scripts',
    'verify-packaged-licenses.mjs',
  );
  const { verifyLicenseBundle } = await import(pathToFileURL(verifierPath).href);
  const result = await verifyLicenseBundle(path.join(resourcesDir, 'licenses'));
  console.log(
    `[licenses] verified ${result.files} legal files for ${result.packages} production packages`,
  );
};
