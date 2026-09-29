#!/usr/bin/env node
/**
 * Stamp the release's macOS floor into latest-mac.yml as electron-updater's
 * `minimumSystemVersion`.
 *
 * This is the one lever that reaches Gezel releases already installed on
 * users' Macs. Every shipped release checks for updates with electron-updater
 * 6.8.x, whose default `isUpdateSupported` compares the feed's
 * `minimumSystemVersion` with `os.release()` and reports "no update" when the
 * running OS is older. Without the field, a Mac below a newly raised floor is
 * offered the update, downloads and verifies the PKG, and only then has
 * Installer refuse it (the PKG's allowed-os-versions).
 *
 * electron-builder cannot write the field itself: its ReleaseInfo schema
 * rejects unknown keys, and update-info files are written after
 * afterAllArtifactBuild runs. So the release job stamps the file after
 * packaging, before it is uploaded and before SHA256SUMS covers it.
 *
 * `os.release()` is the Darwin kernel version, not the marketing version, so
 * the floor is translated.
 *
 * Usage:
 *   node scripts/stamp-mac-update-floor.mjs <latest-mac.yml> [macOS floor]
 *
 * The floor defaults to `mac.minimumSystemVersion` in electron-builder.yml.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILDER_CONFIG, declaredMacFloor } from './verify-macos-version-floor.mjs';

/**
 * The `os.release()` value of the first release of `macosVersion`. macOS 14
 * and 15 are Darwin 23 and 24 with matching minor numbers; Apple then renumbered
 * macOS to 26 while Darwin continued at 25. Earlier majors are refused: their
 * minor releases do not line up (macOS 13.5 is Darwin 22.6), and the floor
 * only ever rises.
 */
export function darwinReleaseForMacOS(macosVersion) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(macosVersion);
  if (!match) throw new Error(`not a macOS version: ${macosVersion}`);
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (major === 14 || major === 15) return `${major + 9}.${minor}.0`;
  if (major >= 26) return `${major - 1}.${minor}.0`;
  throw new Error(
    `no verified Darwin release mapping for macOS ${macosVersion}; extend darwinReleaseForMacOS deliberately`,
  );
}

/** latest-mac.yml with a top-level `minimumSystemVersion`, added or replaced. */
export function withMinimumSystemVersion(feed, darwinRelease) {
  const stamped = `minimumSystemVersion: '${darwinRelease}'`;
  const lines = feed.replace(/\r\n/g, '\n').split('\n');
  const versionLines = lines.filter((line) => /^version:\s*\S/.test(line));
  if (versionLines.length !== 1) {
    throw new Error('update feed must have exactly one top-level version: line');
  }
  const existing = lines.findIndex((line) => /^minimumSystemVersion:/.test(line));
  if (existing !== -1) {
    lines[existing] = stamped;
  } else {
    lines.splice(lines.indexOf(versionLines[0]) + 1, 0, stamped);
  }
  return lines.join('\n');
}

/** The stamped Darwin release, or null when the feed has none. */
export function feedMinimumSystemVersion(feed) {
  return feed.match(/^minimumSystemVersion:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m)?.[1] ?? null;
}

export async function stampMacUpdateFloor(feedPath, macosFloor) {
  const darwinRelease = darwinReleaseForMacOS(macosFloor);
  const feed = await readFile(feedPath, 'utf8');
  const next = withMinimumSystemVersion(feed, darwinRelease);
  await writeFile(feedPath, next, 'utf8');
  if (feedMinimumSystemVersion(await readFile(feedPath, 'utf8')) !== darwinRelease) {
    throw new Error(`${feedPath} did not keep minimumSystemVersion ${darwinRelease}`);
  }
  return darwinRelease;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const feedPath = process.argv[2];
  if (!feedPath) {
    console.error('usage: node scripts/stamp-mac-update-floor.mjs <latest-mac.yml> [macOS floor]');
    process.exit(2);
  }
  try {
    const floor = process.argv[3] ?? declaredMacFloor(await readFile(BUILDER_CONFIG, 'utf8'));
    const darwinRelease = await stampMacUpdateFloor(feedPath, floor);
    console.log(
      `✓ ${feedPath}: minimumSystemVersion ${darwinRelease} (macOS ${floor}); older Macs will not be offered this update`,
    );
  } catch (error) {
    console.error(`could not stamp the macOS update floor: ${error.message ?? error}`);
    process.exit(1);
  }
}
