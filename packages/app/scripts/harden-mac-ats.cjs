/**
 * Narrow the macOS App Transport Security block that electron-builder injects.
 *
 * app-builder-lib's `configureLocalhostAts` sets `NSAllowsArbitraryLoads = true`
 * on every non-MAS macOS build so electron-updater's proxy support works
 * against arbitrary feed hosts. It is a blanket opt-out of ATS for every
 * destination, and Gezel does not need one: the only plaintext HTTP the product
 * speaks is loopback (the daemon's preview port, the bundled llama.cpp / ds4 /
 * whisper servers, the Ollama-compatible listener on 11434), and the two
 * exception domains electron-builder writes alongside it already authorize
 * exactly that.
 *
 * `mac.extendInfo` cannot fix this, which is why the work happens here.
 * `applyCommonInfo` deep-assigns extendInfo into the plist (macPackager), and
 * `configureLocalhostAts` runs three lines later in electronMac with an
 * unconditional `ats.NSAllowsArbitraryLoads = true`. Verified against
 * app-builder-lib 26.15.3 by packing `--mac --arm64 --dir` with
 * `NSAllowsArbitraryLoads: false` in extendInfo: the built Info.plist still
 * came out `true`.
 *
 * afterPack is the first hook that runs after the plist is written and before
 * codesign seals it, so what we leave here is what ships and what the
 * notarized bundle is signed over.
 *
 * What stays, deliberately:
 *   - `NSAllowsLocalNetworking` — the purpose-built key for loopback and
 *     local-network destinations, which is what Gezel actually uses.
 *   - the `127.0.0.1` / `localhost` exception domains — explicit plaintext-HTTP
 *     permission for the local engines and the preview server.
 *
 * Practically this changes little: Chromium and Node both bypass CFNetwork, so
 * ATS governs almost nothing in an Electron app. It is a posture fix — the
 * shipped Info.plist should not advertise a blanket exemption the product does
 * not use, for the same reason the v1.26211.26 audit removed four unneeded
 * entitlements and five usage strings for hardware Gezel never touches.
 *
 * Edits go through `plutil -replace` rather than a parse/serialize round-trip.
 * Converting the plist to JSON and back would throw away any `data` or `date`
 * value it might grow later (JSON cannot express them), and a surgical key
 * replacement cannot disturb ElectronAsarIntegrity or anything else.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ATS_KEYPATH = 'NSAppTransportSecurity.NSAllowsArbitraryLoads';

/**
 * Both macOS lanes. electron-builder reports the Mac App Store target as its
 * own platform name, so these must be listed rather than compared to `darwin`.
 * On the `mas` lane `configureLocalhostAts` does not inject the blanket key at
 * all, and `decideAtsAction` reads that absence as "already strict" — the hook
 * runs, finds nothing to narrow, and says so. Which is the point: it should be
 * a verified no-op there, not an unreached branch.
 */
const MACOS_PLATFORMS = new Set(['darwin', 'mas']);

/**
 * Map the current value of the key to what the hook should do. Split out as a
 * pure function so the policy is testable without packing an application.
 *
 * `null` means the key is absent — either electron-builder stopped injecting
 * it or this is a plist we do not recognize. Both are already the strict
 * default, so there is nothing to narrow and nothing to complain about.
 */
function decideAtsAction(currentValue) {
  if (currentValue === null) return { act: false, reason: 'absent' };
  if (currentValue === false) return { act: false, reason: 'already-narrow' };
  if (currentValue === true) return { act: true, reason: 'narrowing' };
  return { act: false, reason: `unexpected-value:${String(currentValue)}` };
}

/** Read one boolean keypath, or null when it is not present. */
function readBooleanKeypath(plistPath, keypath) {
  try {
    const raw = execFileSync(
      '/usr/bin/plutil',
      ['-extract', keypath, 'raw', '-o', '-', plistPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return raw;
  } catch {
    return null;
  }
}

module.exports = async function hardenMacAts(context) {
  // `mas` is a distinct electronPlatformName from `darwin`, so a bare
  // `!== 'darwin'` check silently skipped the App Store build — the one lane
  // where shipping a blanket NSAllowsArbitraryLoads goes in front of a
  // reviewer. Both macOS lanes get the narrowing.
  if (!MACOS_PLATFORMS.has(context.electronPlatformName)) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const plistPath = path.join(context.appOutDir, appName, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    // The plist is electron-builder's own output. Its absence means the pack
    // shape moved underneath us; fail loudly rather than silently ship the
    // blanket exemption because a path changed.
    throw new Error(`[mac-ats] Info.plist not found at ${plistPath}`);
  }

  const decision = decideAtsAction(readBooleanKeypath(plistPath, ATS_KEYPATH));
  if (!decision.act) {
    console.log(`[mac-ats] leaving ${ATS_KEYPATH} alone (${decision.reason})`);
    return;
  }

  execFileSync('/usr/bin/plutil', ['-replace', ATS_KEYPATH, '-bool', 'NO', plistPath]);

  // Re-read rather than trust the exit code: this value is a security posture
  // claim in a signed, notarized bundle, and the release gate asserts it.
  if (readBooleanKeypath(plistPath, ATS_KEYPATH) !== false) {
    throw new Error(`[mac-ats] ${ATS_KEYPATH} did not take effect`);
  }
  const localNetworking = readBooleanKeypath(
    plistPath,
    'NSAppTransportSecurity.NSAllowsLocalNetworking',
  );
  console.log(
    `[mac-ats] NSAllowsArbitraryLoads=false (NSAllowsLocalNetworking=${localNetworking})`,
  );
};

module.exports.decideAtsAction = decideAtsAction;
module.exports.ATS_KEYPATH = ATS_KEYPATH;
