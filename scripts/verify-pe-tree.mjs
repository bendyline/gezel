/**
 * Assert every Windows binary in a directory tree is either validly signed or
 * an explicitly allowlisted third-party file.
 *
 * The service bundle ships as an opaque `service-bundle.tar.gz` inside
 * `app.asar.unpacked`. Both existing Windows signing passes — the afterPack
 * sweep in `packages/app/scripts/after-pack.cjs` and the release workflow's
 * "Verify Windows signatures" step — walk the unpacked payload, so neither
 * can see the ~21 PE binaries inside that archive. Until this module existed
 * they were exempt because nothing looked, not because anyone decided they
 * should be: a first-party DLL that silently failed to get signed would have
 * shipped in the daemon without failing the build, which is exactly what the
 * allowlist in third-party-binaries.cjs exists to prevent.
 *
 * This deliberately verifies rather than signs. Every unsigned binary in the
 * bundle today is a prebuilt npm artifact (node-pty, sqlite-vec, resvg-js,
 * napi-rs keyring) — we compile none of them, and Windows imposes no
 * notarization requirement that would force our name onto their bytes. That
 * is the difference from macOS, where `sign-macho-tree.mjs` does re-sign
 * third-party Mach-O files because Apple's notary rejects the build
 * otherwise. Same gap, different remedy, for the reason recorded at the top
 * of third-party-binaries.cjs.
 *
 * Runs before the tarball is created, from build-service-bundle.mjs. On
 * non-Windows hosts it no-ops: a Windows bundle is only ever built on
 * Windows (pnpm resolves host-arch optional deps), and `signtool` exists
 * nowhere else.
 */

import { open, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const {
  isThirdPartyBinary,
  thirdPartySource,
} = require('../packages/app/scripts/third-party-binaries.cjs');
const { isValidlySigned } = require('../packages/app/scripts/sign.cjs');

/** `MZ` — the DOS header every PE image still starts with. */
const MZ_MAGIC = 0x4d5a;
/** `PE\0\0` at the offset stored in the DOS header's e_lfanew field. */
const PE_SIGNATURE = 0x50450000;

/**
 * True when the file is a PE image (exe/dll/node/sys). Detected by content
 * rather than extension for the same reason the Mach-O walker does it: node
 * addons use `.node`, winpty ships a bare `.exe`, and an extension list is
 * one forgotten suffix away from silently skipping something.
 */
export function isPeImage(header) {
  if (!header || header.length < 0x40) return false;
  if (header.readUInt16BE(0) !== MZ_MAGIC) return false;
  const peOffset = header.readUInt32LE(0x3c);
  // e_lfanew must land inside the header we read; anything else is a DOS
  // executable or a file that merely happens to start with "MZ".
  if (peOffset + 4 > header.length) return false;
  return header.readUInt32BE(peOffset) === PE_SIGNATURE;
}

async function readHeader(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    // 1 KiB covers every realistic e_lfanew; PE offsets past that do not
    // occur in compiler output.
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead >= 0x40 ? header.subarray(0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Collect every PE image under `root`, skipping symlinks. */
export async function findPeBinaries(root) {
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
      // Symlinks are skipped deliberately: following one would either audit
      // the same target twice or escape the tree entirely.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isPeImage(await readHeader(full))) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

/**
 * Classify every PE binary under `root`. Pure with respect to the filesystem
 * apart from reads, so tests can assert the partition without a certificate.
 *
 * `checkSigned` is injected so tests need neither signtool nor a real signed
 * binary; production passes `isValidlySigned` from sign.cjs, the same
 * `signtool verify /pa` the afterPack sweep uses.
 */
export async function auditPeTree(root, { checkSigned = isValidlySigned } = {}) {
  const binaries = await findPeBinaries(root);
  const signed = [];
  const exempt = [];
  const unsigned = [];
  for (const file of binaries) {
    const rel = relative(root, file);
    // Signature first, allowlist second: a vendor binary that ships WITH a
    // valid signature (onnxruntime, node-pty's ConPTY helpers) should be
    // reported as signed, so the allowlist only ever excuses files that are
    // genuinely unsigned and the log tells the truth about which is which.
    if (checkSigned(file)) {
      signed.push(rel);
    } else if (isThirdPartyBinary(file)) {
      exempt.push({ file: rel, source: thirdPartySource(file) });
    } else {
      unsigned.push(rel);
    }
  }
  return { binaries: binaries.length, signed, exempt, unsigned };
}

/**
 * Fail the build when the bundle contains an unsigned binary that is not on
 * the third-party allowlist.
 *
 * No-ops off Windows. When `GEZEL_REQUIRE_BUNDLE_PE_VERIFY=1` the absence of
 * signtool is itself fatal — the release workflow sets it so a runner missing
 * the Windows SDK cannot turn this gate into a silent pass. Local builds
 * without the SDK warn and continue, matching how sign.cjs treats a missing
 * Trusted Signing config.
 */
export async function verifyPeTree(root, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return null;

  const required = env.GEZEL_REQUIRE_BUNDLE_PE_VERIFY === '1';
  const result = await auditPeTree(root);

  if (result.binaries === 0) {
    // A Windows service bundle always carries native addons. Zero means the
    // walk looked at the wrong directory, which must not read as success.
    throw new Error(
      [
        `[verify-pe-tree] no PE binaries found under ${root} —`,
        'a Windows service bundle always contains native addons,',
        'so this is a bad root, not a clean tree',
      ].join(' '),
    );
  }

  // signtool reports "unsigned" for everything when it is missing, so a tree
  // where nothing at all validates is far more likely a toolchain problem
  // than 21 genuinely broken signatures.
  if (result.signed.length === 0) {
    const message = [
      `[verify-pe-tree] not one of ${result.binaries} binaries under ${root} validated —`,
      'signtool is probably unavailable (Windows SDK not installed)',
    ].join(' ');
    if (required) throw new Error(`${message}; refusing to ship an unverified service bundle`);
    console.warn(`${message}; skipping bundle signature verification`);
    return null;
  }

  for (const { file, source } of result.exempt) {
    console.log(`[verify-pe-tree] third-party, unsigned by policy: ${file} (${source})`);
  }

  if (result.unsigned.length > 0) {
    const count = result.unsigned.length;
    throw new Error(
      [
        `[verify-pe-tree] ${count} unsigned ${count === 1 ? 'binary' : 'binaries'} in the`,
        'service bundle not on the third-party allowlist:',
        '',
        ...result.unsigned.map((file) => `  - ${file}`),
        '',
        'If we built these, they must be signed. If a vendor ships them prebuilt,',
        'add them to packages/app/scripts/third-party-binaries.cjs with the source recorded.',
      ].join('\n'),
    );
  }

  console.log(
    [
      `[verify-pe-tree] ${result.binaries} PE binaries:`,
      `${result.signed.length} validly signed,`,
      `${result.exempt.length} third-party by policy,`,
      '0 unaccounted for',
    ].join(' '),
  );
  return result;
}
