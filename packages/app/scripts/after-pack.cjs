/**
 * electron-builder `afterPack` hook — two jobs, in order:
 *
 * 1. Run the asar offset-bug workaround + license verification that used
 *    to be the hook directly (see fix-asar.cjs for the full story).
 *
 * 2. On Windows, sweep the packed app directory and Authenticode-sign
 *    every `.exe`/`.dll` that doesn't already carry a valid signature.
 *    electron-builder's own signing pass only covers `gezel.exe` and the
 *    installer executable — it never descends into the asar-unpacked
 *    payload (pnpm.exe, our-built ggml/llama engine DLLs). Anything
 *    already validly signed is left byte-identical: node.exe (OpenJS),
 *    and the gezel-* engine exes plus gezel-service-host.exe signed at
 *    birth by build-native.yml — re-signing those would break the "one
 *    artifact, one hash, verifiable in the native release and in the
 *    installer" provenance property.
 *
 *    Third-party binaries we redistribute verbatim are skipped outright —
 *    see scripts/third-party-binaries.cjs for the list and the reasoning.
 *    We sign what we compile; NVIDIA's cuBLAS and Astral's uv ship exactly
 *    as their vendors released them, byte-identical and hash-comparable
 *    against the vendors' own manifests. (They arrive unsigned: NVIDIA's
 *    CUDA DLLs have no certificate table at all, and uv.exe is unsigned as
 *    Astral publishes it. So this is "leave them alone", not "preserve an
 *    existing signature" — except node.exe, which does carry OpenJS's.)
 *
 *    The release workflow's "Verify Windows signatures" gate exempts the
 *    same list, read from that module rather than re-declared in YAML.
 *    Keep it an explicit allowlist: a first-party DLL that silently failed
 *    to get signed must still fail the release.
 *
 * The sweep no-ops entirely when Trusted Signing env vars are unset
 * (every local dev build), matching sign.cjs behavior. The release
 * workflow's "Verify Windows signatures" step asserts the sweep worked:
 * every exe/dll in the shipped payload must validate.
 */
const path = require('node:path');
const fs = require('node:fs');

const fixAsar = require('./fix-asar.cjs');
const { isValidlySigned, signFile, signingConfigured } = require('./sign.cjs');
const { isThirdPartyBinary, thirdPartySource } = require('./third-party-binaries.cjs');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

async function signSweep(appOutDir) {
  if (!signingConfigured()) {
    console.log('[sign-sweep] Trusted Signing env not set — skipping payload sweep');
    return;
  }
  const candidates = walk(appOutDir);
  let signed = 0;
  let kept = 0;
  const vendor = [];
  for (const file of candidates) {
    if (isThirdPartyBinary(file)) {
      vendor.push(`${path.basename(file)} (${thirdPartySource(file)})`);
      continue;
    }
    if (isValidlySigned(file)) {
      kept += 1;
      continue;
    }
    signFile(file);
    signed += 1;
  }
  for (const entry of vendor) {
    console.log(`[sign-sweep] left vendor binary untouched: ${entry}`);
  }
  console.log(
    `[sign-sweep] ${candidates.length} exe/dll files: signed ${signed}, ` +
      `kept ${kept} existing signatures, skipped ${vendor.length} third-party`,
  );
}

module.exports = async function afterPack(context) {
  await fixAsar(context);
  if (context.electronPlatformName === 'win32') {
    await signSweep(context.appOutDir);
  }
};
