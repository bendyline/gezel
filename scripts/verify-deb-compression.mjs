#!/usr/bin/env node
/**
 * Prove a built .deb actually carries the compression the config asked for.
 *
 * This exists because every way of getting deb compression wrong is invisible
 * at the point where you would look for it. `packages/app/electron-builder.yml`
 * can say `compression: zst` and be entirely correct, while the artifact ships
 * 1084 MiB of negative-level zstd, because fpm hands zstd its level through
 * `ZSTD_CLEVEL` with a leading dash — a format that is right for GZIP/XZ_OPT
 * and means "fast mode, ratio be damned" to zstd. Nothing errors. The build
 * goes green. The only witness is the artifact itself.
 *
 * So this checks the artifact, not the intent:
 *
 *   1. the data member really is `data.tar.zst` — catches the option being
 *      dropped, renamed, or silently ignored by a future fpm;
 *   2. its zstd frame header records a level-3 window — catches the dash bug
 *      and any other level regression, which a member-name check cannot see
 *      because `zstd --fast=3` output is still a perfectly valid `data.tar.zst`.
 *
 * The level is read from the frame header rather than inferred from the
 * compression ratio, which is what this gate used to do. A ratio measures the
 * payload as much as the codec: native 0.1.46 added a 219 MiB CUDA build of
 * gezel-sd-server on x64 and moved arm64 to CUDA 13, and with the config
 * untouched the ratio fell from 1.72:1 to 1.66:1 on x64 and from 1.85:1 to
 * just under the 1.70:1 floor on arm64, failing both release builds. The ratio
 * is still printed, because a jump in download size is worth seeing.
 *
 * Usage: node scripts/verify-deb-compression.mjs <path-to.deb>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * zstd picks its match window from the compression level and records it in
 * the frame header. For a stream of unknown size — which is what fpm makes,
 * piping tar into zstd — libzstd's parameter table gives:
 *
 *   every negative (fast-mode) level, and level 1   windowLog 19  (512 KiB)
 *   level 2                                         windowLog 20
 *   level 3 through 8 (3 is what we ship)           windowLog 21  (2 MiB)
 *   level 9 and above                               windowLog 22+
 *
 * so `windowLog >= 21` holds exactly when the level is at least 3. Both
 * v1.26261.72 debs carry 21. The test file pins the table against the libzstd
 * Node bundles, so a future zstd that reshuffles it fails there first.
 */
export const MIN_WINDOW_LOG = 21;

const ZSTD_MAGIC = 0xfd2fb528;

const EXPECTED_DATA_MEMBER = 'data.tar.zst';

/** Members of an `ar` archive, in order. Values are offsets into `buf`. */
function readArMembers(buf) {
  if (buf.subarray(0, 8).toString('binary') !== '!<arch>\n') {
    throw new Error('not an ar archive (bad magic) — is this really a .deb?');
  }
  const members = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const header = buf.subarray(off, off + 60);
    const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
    const size = Number.parseInt(header.subarray(48, 58).toString('ascii').trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`corrupt ar member header at offset ${off}`);
    }
    const start = off + 60;
    members.push({ name, size, start });
    off = start + size + (size % 2);
  }
  return members;
}

/**
 * Pull one file out of an uncompressed tar. Hand-parsed rather than pulling in
 * the `tar` package: control tarballs hold a handful of tiny files, and a
 * release-gate script that depends on nothing is one that cannot fail for a
 * reason unrelated to what it is checking.
 */
function readFileFromTar(tar, wanted) {
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0',
      8,
    );
    const body = off + 512;
    if (name.replace(/^\.\//, '') === wanted) {
      return tar.subarray(body, body + size).toString('utf8');
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * log2 of the first zstd frame's window size. Null for a single-segment
 * frame, which omits the descriptor — zstd only writes one when it knew the
 * whole input fits in a single window, never for a data tarball.
 */
export function zstdWindowLog(frame) {
  if (frame.length < 6 || frame.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw new Error('data member does not start with a zstd frame');
  }
  const singleSegment = (frame[4] >> 5) & 1;
  if (singleSegment) return null;
  return 10 + (frame[5] >> 3);
}

function readInstalledBytes(buf, control) {
  let controlTar = buf.subarray(control.start, control.start + control.size);
  if (control.name.endsWith('.zst')) controlTar = zstdDecompressSync(controlTar);
  else if (control.name !== 'control.tar') {
    // xz/gz control members only appear if the compression option regressed,
    // and the data-member assertion reports that far more clearly than a
    // decompression failure here would.
    return null;
  }
  const controlText = readFileFromTar(controlTar, 'control');
  const installedKiB = Number.parseInt(
    /^Installed-Size:\s*(\d+)/m.exec(controlText ?? '')?.[1] ?? '',
    10,
  );
  return Number.isSafeInteger(installedKiB) ? installedKiB * 1024 : null;
}

function parseArgs(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: verify-deb-compression.mjs <path-to.deb>');
  }
  return argv[0];
}

export function inspectDeb(buf) {
  const members = readArMembers(buf);
  const data = members.find((m) => m.name.startsWith('data.tar'));
  if (!data) throw new Error('no data.tar member found');
  const control = members.find((m) => m.name.startsWith('control.tar'));
  if (!control) throw new Error('no control.tar member found');

  return {
    dataMember: data.name,
    windowLog: data.name.endsWith('.zst')
      ? zstdWindowLog(buf.subarray(data.start, data.start + data.size))
      : null,
    installedBytes: readInstalledBytes(buf, control),
  };
}

function main() {
  const debPath = parseArgs(process.argv.slice(2));
  const buf = readFileSync(debPath);
  const { dataMember, windowLog, installedBytes } = inspectDeb(buf);
  const label = basename(debPath);

  if (dataMember !== EXPECTED_DATA_MEMBER) {
    console.error(
      `::error::${label} carries ${dataMember}, expected ${EXPECTED_DATA_MEMBER}. The deb \`compression: zst\` setting in packages/app/electron-builder.yml did not take effect — check that the installed fpm still supports it.`,
    );
    process.exit(1);
  }

  if (windowLog === null) {
    console.error(
      `::error::${label} starts with a single-segment zstd frame, which records no window size, so its compression level cannot be checked.`,
    );
    process.exit(1);
  }

  const windowKiB = 2 ** (windowLog - 10);
  if (windowLog < MIN_WINDOW_LOG) {
    console.error(
      `::error::${label} was compressed with a ${windowKiB} KiB zstd window, which means a level below 3. The most likely cause is fpm passing ZSTD_CLEVEL with a leading dash, which selects zstd fast mode: confirm \`--deb-compression-level 0\` is still first in deb.fpm in packages/app/electron-builder.yml, and that nobody raised it above 0.`,
    );
    process.exit(1);
  }

  const mib = (n) => `${Math.round(n / 1024 / 1024)} MiB`;
  const size =
    installedBytes === null
      ? mib(buf.length)
      : `${mib(buf.length)} from ${mib(installedBytes)} (${(installedBytes / buf.length).toFixed(2)}:1)`;
  console.log(`${label}: ${dataMember}, ${windowKiB} KiB zstd window, ${size}`);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith(basename(import.meta.url))
) {
  main();
}
