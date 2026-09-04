/**
 * Ensure every Mach-O binary in a directory tree has a distribution-ready
 * Developer ID signature.
 *
 * The service bundle ships as an opaque `service-bundle.tar.gz` inside
 * `app.asar.unpacked`. electron-builder signs the Mach-O binaries it can see
 * in the .app, but it cannot see into a tarball — while Apple's notary
 * service reads straight through it. A July 2026 release was rejected with
 * `status: Invalid` over 15 native binaries in there (sharp, keyring, resvg,
 * onnxruntime, node-pty, sqlite-vec): "not signed", "signature does not
 * include a secure timestamp", "does not have the hardened runtime enabled".
 *
 * So the binaries have to be signed before the tarball is created, which is
 * why the release workflow imports the Apple certificate before building the
 * bundle rather than after. A binary that already carries a valid,
 * distribution-ready third-party Developer ID signature is preserved
 * byte-for-byte instead of being re-signed as Bendyline code.
 *
 * No-ops unless GEZEL_MACOS_SIGN_BUNDLE=1, so ordinary local `pnpm
 * build:bundle` runs stay fast and need no certificate. When it IS set, a
 * missing identity is fatal if any binary needs signing: a release must never
 * quietly ship unsigned.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Mach-O magic numbers, both byte orders, plus the fat/universal wrappers.
 * Detecting by content rather than extension is what catches node-pty's
 * `spawn-helper`, which has no extension at all.
 */
const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xcefaedfe, // 32-bit, byte-swapped
  0xfeedfacf, // 64-bit
  0xcffaedfe, // 64-bit, byte-swapped
  0xcafebabe, // fat/universal
  0xbebafeca, // fat/universal, byte-swapped
]);

/** True when the first four bytes are a Mach-O magic number. */
export function isMachOMagic(header) {
  if (!header || header.length < 4) return false;
  return MACHO_MAGICS.has(header.readUInt32BE(0));
}

async function readHeader(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 ? header : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Collect every Mach-O file under `root`, skipping symlinks. */
export async function findMachOBinaries(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Symlinks are skipped deliberately: signing through one would either
      // sign the same target twice or escape the tree entirely.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isMachOMagic(await readHeader(full))) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

/**
 * The two signing worlds this tree can be prepared for, and everything that
 * differs between them.
 *
 * Direct distribution notarizes: it needs the hardened runtime and a secure
 * timestamp, and it must leave a vendor's own Developer ID signature alone,
 * because replacing it would substitute our attestation for theirs and break
 * the source-pinned reuse that standalone clients rely on.
 *
 * The Mac App Store does neither. It is not notarized, hardened runtime is not
 * how a sandboxed app is signed, and — the important one — a vendor signature
 * cannot be kept: under the sandbox every child must carry OUR identity and
 * the inherit entitlements or it will not launch. So the preservation that is
 * mandatory in one mode is a build failure in the other.
 */
const SIGN_MODES = Object.freeze({
  'developer-id': {
    identityPattern: /"(Developer ID Application: [^"]+)"/,
    identityLabel: 'Developer ID Application',
    hardenedRuntime: true,
    preserveVendorSignatures: true,
  },
  'apple-distribution': {
    identityPattern: /"(Apple Distribution: [^"]+)"/,
    identityLabel: 'Apple Distribution',
    hardenedRuntime: false,
    preserveVendorSignatures: false,
  },
});

/**
 * Which mode to sign in. Defaults to `developer-id` so every existing caller —
 * and every local build — behaves exactly as before.
 */
export function resolveSignMode(env = process.env) {
  const requested = env.GEZEL_MACOS_SIGN_IDENTITY_KIND ?? 'developer-id';
  const mode = SIGN_MODES[requested];
  if (!mode) {
    throw new Error(
      `unknown GEZEL_MACOS_SIGN_IDENTITY_KIND "${requested}" — ` +
        `expected one of: ${Object.keys(SIGN_MODES).join(', ')}`,
    );
  }
  return { name: requested, ...mode };
}

/**
 * The signing identity in the keychain the release workflow just imported.
 * Read from the keychain rather than a secret so no new repository secret is
 * needed.
 */
function findSigningIdentity(mode) {
  const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const match = out.match(mode.identityPattern);
  if (!match) {
    throw new Error(
      `no "${mode.identityLabel}" identity in the keychain — import the Apple certificate before building the service bundle`,
    );
  }
  return match[1];
}

/**
 * True when verbose `codesign --display` output describes a signature that
 * already meets Apple's distribution requirements. Each condition matters:
 *
 * - Developer ID + Apple trust chain: a real third-party distribution signer,
 *   not an ad-hoc/linker signature or a similarly-named self-signed identity.
 * - Team ID: another guard against ad-hoc signatures (`not set`).
 * - Hardened runtime + secure timestamp: both are required by notarization.
 *
 * The signature's cryptographic validity is checked separately with
 * `codesign --verify --strict` before this parser is consulted.
 */
export function isDistributionReadyDeveloperIdSignature(details) {
  return (
    /^Authority=Developer ID Application: .+$/m.test(details) &&
    /^Authority=Developer ID Certification Authority$/m.test(details) &&
    /^Authority=Apple Root CA$/m.test(details) &&
    /^TeamIdentifier=[A-Z0-9]{10}$/m.test(details) &&
    /^CodeDirectory\b.*\bflags=.*\bruntime\b/im.test(details) &&
    /^Timestamp=.+$/m.test(details)
  );
}

/**
 * Verify and inspect an existing signature without mutating the binary.
 * Verification covers every architecture by default, but display only covers
 * the host-native slice. Ask lipo for the complete architecture list and
 * require every slice to meet the preservation policy. `codesign --display`
 * writes its report to stderr even on success, so combine both streams.
 */
function hasDistributionReadyDeveloperIdSignature(binary) {
  try {
    execFileSync('codesign', ['--verify', '--strict', binary], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    return false;
  }

  const lipo = spawnSync('lipo', ['-archs', binary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (lipo.error || lipo.status !== 0) return false;
  const architectures = lipo.stdout.trim().split(/\s+/).filter(Boolean);
  if (architectures.length === 0) return false;

  return architectures.every((architecture) => {
    const inspected = spawnSync(
      'codesign',
      ['--display', '--verbose=4', '--architecture', architecture, binary],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (inspected.error || inspected.status !== 0) return false;
    return isDistributionReadyDeveloperIdSignature(
      `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`,
    );
  });
}

/**
 * Build the codesign argument list for one binary.
 *
 * Split out so the difference between the two modes is one readable function
 * rather than conditionals threaded through the signing loop, and so a test
 * can assert the arguments without a keychain or a Mac.
 */
export function codesignArgs(identity, binary, mode, entitlements) {
  const args = ['--force', '--sign', identity];
  // Notarization requires both; the store rejects neither but wants neither.
  if (mode.hardenedRuntime) args.push('--options', 'runtime', '--timestamp');
  // Under the sandbox a child with no entitlements cannot inherit the app's
  // capabilities, so it launches with none and fails in ways that look like
  // anything but a signing problem.
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(binary);
  return args;
}

/**
 * Sign every Mach-O binary under `root`. Returns the number signed.
 *
 * In `developer-id` mode (the default) a vendor's own distribution-ready
 * signature is preserved; in `apple-distribution` mode every binary is
 * re-signed, because the App Store sandbox requires one identity across the
 * whole payload. `GEZEL_MACOS_SIGN_ENTITLEMENTS` supplies the child
 * entitlements plist when the mode needs one.
 */
export async function signMachOTree(root) {
  if (process.env.GEZEL_MACOS_SIGN_BUNDLE !== '1') return 0;
  if (process.platform !== 'darwin') {
    console.log('[sign-bundle] not darwin — skipping Mach-O signing');
    return 0;
  }

  const mode = resolveSignMode();
  const entitlements = process.env.GEZEL_MACOS_SIGN_ENTITLEMENTS || null;
  const binaries = await findMachOBinaries(root);
  if (binaries.length === 0) {
    throw new Error(`no Mach-O binaries found under ${root} — expected native modules`);
  }

  let identity;
  let signed = 0;
  let preserved = 0;
  console.log(
    `[sign-bundle] inspecting ${binaries.length} Mach-O binaries (mode=${mode.name}` +
      `${entitlements ? `, entitlements=${entitlements}` : ''})`,
  );
  for (const binary of binaries) {
    if (mode.preserveVendorSignatures && hasDistributionReadyDeveloperIdSignature(binary)) {
      console.log(
        `[sign-bundle] preserved existing Developer ID signature: ${relative(root, binary)}`,
      );
      preserved += 1;
      continue;
    }

    identity ??= findSigningIdentity(mode);
    execFileSync('codesign', codesignArgs(identity, binary, mode, entitlements), {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    signed += 1;
  }
  console.log(
    `[sign-bundle] ✓ ${binaries.length} Mach-O binaries: signed ${signed}, ` +
      `preserved ${preserved}`,
  );
  return signed;
}
