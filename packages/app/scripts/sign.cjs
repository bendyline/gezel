/**
 * Windows code-signing for electron-builder — the `signtoolOptions.sign`
 * hook (called for `gezel.exe`, the NSIS installer, and executable files
 * electron-builder discovers in the unpacked payload) plus the
 * `signFile`/`isValidlySigned` helpers the afterPack sweep in
 * `after-pack.cjs` uses to cover the rest of the payload (our-built engine
 * DLLs). We use
 * `signtool.exe` with the Azure Trusted Signing dlib so the signing key
 * lives in a cloud HSM, not on disk.
 *
 * Required environment variables (set by the release workflow from repo
 * secrets; see .github/workflows/release-electron.yml):
 *   TRUSTED_SIGNING_DLIB_PATH     — absolute path to Azure.CodeSigning.Dlib.dll
 *   TRUSTED_SIGNING_METADATA_PATH — absolute path to metadata.json with
 *                                   Endpoint / Account / Profile
 *
 * Authentication uses DefaultAzureCredential, which reads:
 *   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 *
 * When any of these env vars are unset — including every local dev build —
 * this script no-ops. The resulting .exe is unsigned but still runs locally;
 * it just triggers Windows SmartScreen warnings on other machines.
 */

const { execSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const { isThirdPartyBinary, thirdPartySource } = require('./third-party-binaries.cjs');

/**
 * Resolve `signtool.exe` from the Windows SDK. GitHub Actions runners have
 * the SDK installed but don't always add it to PATH, so we find it by
 * walking the standard install dir and picking the newest version.
 */
function findSignTool() {
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (existsSync(sdkRoot)) {
    const versions = readdirSync(sdkRoot)
      .filter((d) => d.startsWith('10.'))
      .sort()
      .reverse();
    for (const ver of versions) {
      const candidate = path.join(sdkRoot, ver, 'x64', 'signtool.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'signtool.exe';
}

/**
 * True when Trusted Signing is configured for this build. When false,
 * every signing entry point below no-ops (local dev builds stay unsigned).
 */
function signingConfigured() {
  const dlibPath = process.env.TRUSTED_SIGNING_DLIB_PATH;
  const metadataPath = process.env.TRUSTED_SIGNING_METADATA_PATH;
  return Boolean(dlibPath && metadataPath && existsSync(dlibPath));
}

/**
 * Does this file already carry a signature that validates under the
 * default Authenticode policy? Used by both signing passes to leave
 * upstream-signed binaries (node.exe/OpenJS, NVIDIA redistributables,
 * born-signed gezel-* engines) untouched.
 */
function isValidlySigned(filePath) {
  const signtool = findSignTool();
  try {
    execSync(`"${signtool}" verify /pa /q "${filePath}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Authenticode-sign one file via signtool + the Trusted Signing dlib. */
function signFile(filePath) {
  const signtool = findSignTool();
  console.log(`[sign] signing ${filePath} with ${signtool}`);

  const args = [
    `"${signtool}"`,
    'sign',
    '/v',
    '/fd',
    'SHA256',
    '/tr',
    'http://timestamp.acs.microsoft.com',
    '/td',
    'SHA256',
    '/dlib',
    `"${process.env.TRUSTED_SIGNING_DLIB_PATH}"`,
    '/dmdf',
    `"${process.env.TRUSTED_SIGNING_METADATA_PATH}"`,
    `"${filePath}"`,
  ];

  try {
    execSync(args.join(' '), { stdio: 'inherit' });
    console.log(`[sign] signed ${filePath}`);
  } catch (err) {
    console.error(`[sign] signing failed for ${filePath}`);
    throw err;
  }
}

exports.signingConfigured = signingConfigured;
exports.isValidlySigned = isValidlySigned;
exports.signFile = signFile;

exports.default = async function sign(configuration) {
  if (!signingConfigured()) {
    console.log(`[sign] skipping (no Trusted Signing SDK env): ${configuration.path}`);
    return;
  }
  // electron-builder descends into app.asar.unpacked and calls this hook for
  // what it finds there. Preserve explicitly exempt third-party files and
  // every already-valid signature, just as afterPack does. Re-signing a
  // born-signed native executable would keep Authenticode valid but change
  // the source-pinned bytes recorded in NATIVE_FILE_MANIFESTS.json.
  if (isThirdPartyBinary(configuration.path)) {
    console.log(
      `[sign] left vendor binary untouched: ${path.basename(configuration.path)} ` +
        `(${thirdPartySource(configuration.path)})`,
    );
    return;
  }
  if (isValidlySigned(configuration.path)) {
    console.log(`[sign] preserved existing valid signature: ${path.basename(configuration.path)}`);
    return;
  }
  signFile(configuration.path);
};
