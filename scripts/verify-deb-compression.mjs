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
 * goes green. The only witness is the size of the file users download.
 *
 * So this checks the artifact, not the intent:
 *
 *   1. the data member really is `data.tar.zst` — catches the option being
 *      dropped, renamed, or silently ignored by a future fpm;
 *   2. the compression ratio clears a floor — catches the dash bug and any
 *      other level regression, which a member-name check cannot see because
 *      `zstd --fast=3` output is still a perfectly valid `data.tar.zst`.
 *
 * Ratio rather than an absolute size ceiling: the payload grows release to
 * release and a byte ceiling would either rot immediately or be set so loose
 * it stops discriminating. The ratio is a property of the codec settings.
 *
 * Usage: node scripts/verify-deb-compression.mjs <path-to.deb> [--min-ratio N]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * Measured on the v1.26226.50 arm64 payload, which is representative — it is
 * dominated by CUDA blobs plus one already-gzipped inner tarball:
 *
 *   zstd level 3   (what we ship)          1.84:1
 *   zstd level -3  (fpm's dash bug)        1.50:1
 *   zstd level -9  (--deb-compression-level 9, worse still)  1.40:1
 *
 * 1.70 sits in the gap with ~8% headroom above the failure cases and ~8%
 * below the good one. If a future payload legitimately compresses worse
 * (more pre-compressed content), lower this deliberately — do not raise the
 * level flag, which makes things worse. See electron-builder.yml.
 */
const DEFAULT_MIN_RATIO = 1.7;

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

function parseArgs(argv) {
  const positional = [];
  let minRatio = DEFAULT_MIN_RATIO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-ratio') {
      minRatio = Number.parseFloat(argv[++i] ?? '');
      if (!Number.isFinite(minRatio) || minRatio <= 0) {
        throw new Error('--min-ratio requires a positive number');
      }
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) {
    throw new Error('usage: verify-deb-compression.mjs <path-to.deb> [--min-ratio N]');
  }
  return { debPath: positional[0], minRatio };
}

export function inspectDeb(buf) {
  const members = readArMembers(buf);
  const data = members.find((m) => m.name.startsWith('data.tar'));
  if (!data) throw new Error('no data.tar member found');
  const control = members.find((m) => m.name.startsWith('control.tar'));
  if (!control) throw new Error('no control.tar member found');

  let controlTar = buf.subarray(control.start, control.start + control.size);
  if (control.name.endsWith('.zst')) controlTar = zstdDecompressSync(controlTar);
  else if (control.name !== 'control.tar') {
    // xz/gz control members only appear if the compression option regressed,
    // and the data-member assertion below reports that far more clearly than
    // a decompression failure here would.
    return { dataMember: data.name, installedBytes: null };
  }
  const controlText = readFileFromTar(controlTar, 'control');
  const installedKiB = Number.parseInt(
    /^Installed-Size:\s*(\d+)/m.exec(controlText ?? '')?.[1] ?? '',
    10,
  );
  return {
    dataMember: data.name,
    installedBytes: Number.isSafeInteger(installedKiB) ? installedKiB * 1024 : null,
  };
}

function main() {
  const { debPath, minRatio } = parseArgs(process.argv.slice(2));
  const buf = readFileSync(debPath);
  const { dataMember, installedBytes } = inspectDeb(buf);
  const label = basename(debPath);

  if (dataMember !== EXPECTED_DATA_MEMBER) {
    console.error(
      `::error::${label} carries ${dataMember}, expected ${EXPECTED_DATA_MEMBER}. The deb \`compression: zst\` setting in packages/app/electron-builder.yml did not take effect — check that the installed fpm still supports it.`,
    );
    process.exit(1);
  }

  if (installedBytes === null) {
    console.error(
      `::error::${label} has no readable Installed-Size in its control record, so the compression ratio cannot be checked.`,
    );
    process.exit(1);
  }

  const ratio = installedBytes / buf.length;
  const mib = (n) => `${Math.round(n / 1024 / 1024)} MiB`;
  if (ratio < minRatio) {
    console.error(
      `::error::${label} compresses at only ${ratio.toFixed(2)}:1 (${mib(buf.length)} from ${mib(installedBytes)}), below the ${minRatio.toFixed(2)}:1 floor. The most likely cause is fpm passing ZSTD_CLEVEL with a leading dash, which selects zstd fast mode: confirm \`--deb-compression-level 0\` is still first in deb.fpm in packages/app/electron-builder.yml, and that nobody raised it above 0.`,
    );
    process.exit(1);
  }

  console.log(
    `${label}: ${dataMember}, ${mib(buf.length)} from ${mib(installedBytes)} ` +
      `(${ratio.toFixed(2)}:1, floor ${minRatio.toFixed(2)}:1)`,
  );
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith(basename(import.meta.url))
) {
  main();
}
