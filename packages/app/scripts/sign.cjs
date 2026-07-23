/**
 * Windows code-signing hook for electron-builder.
 *
 * Called once per file that needs Authenticode signing — the `gezel.exe`
 * inside the installer payload and the NSIS installer .exe itself. We use
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

exports.default = async function sign(configuration) {
  const dlibPath = process.env.TRUSTED_SIGNING_DLIB_PATH;
  const metadataPath = process.env.TRUSTED_SIGNING_METADATA_PATH;

  if (!dlibPath || !metadataPath) {
    console.log(`[sign] skipping (no Trusted Signing SDK env): ${configuration.path}`);
    return;
  }
  if (!existsSync(dlibPath)) {
    console.log(`[sign] skipping (dlib not found at ${dlibPath}): ${configuration.path}`);
    return;
  }

  const signtool = findSignTool();
  console.log(`[sign] signing ${configuration.path} with ${signtool}`);

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
    `"${dlibPath}"`,
    '/dmdf',
    `"${metadataPath}"`,
    `"${configuration.path}"`,
  ];

  try {
    execSync(args.join(' '), { stdio: 'inherit' });
    console.log(`[sign] signed ${configuration.path}`);
  } catch (err) {
    console.error(`[sign] signing failed for ${configuration.path}`);
    throw err;
  }
};
