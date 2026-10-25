#!/usr/bin/env node
/**
 * Merge the per-arch Windows update feeds into the one `latest.yml` every
 * Windows install reads.
 *
 * electron-updater's NSIS updater always fetches `latest.yml` (Windows gets no
 * arch suffix, unlike `latest-linux-arm64.yml`), and the x64 and arm64
 * installers are packaged on separate runners, so each job writes its own
 * `latest.yml` listing only its installer. Publishing both would collide on
 * the name; publishing one would hand every machine that arch.
 *
 * One feed listing both works because electron-updater picks, among the
 * feed's `.exe` entries, the one whose URL contains `process.arch`
 * (`findFile` in electron-updater's providers/Provider.js). The x64 feed is
 * the base, so its top-level `path`/`sha512` — the fields older updaters
 * read — keep pointing at the x64 installer.
 *
 * Line-based like stamp-mac-update-floor.mjs: the release job installs no
 * dependencies, and electron-builder writes this file in a fixed shape.
 *
 * Usage:
 *   node scripts/merge-windows-update-feed.mjs <x64 latest.yml> <arm64 latest.yml> --out <file>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function feedLines(feed) {
  return feed.replace(/\r\n/g, '\n').split('\n');
}

function feedVersion(lines, label) {
  const versions = lines.filter((line) => /^version:\s*\S/.test(line));
  if (versions.length !== 1) {
    throw new Error(`${label} update feed must have exactly one top-level version: line`);
  }
  return versions[0].replace(/^version:\s*/, '').trim();
}

/** The `files:` list: its index and the indented lines that belong to it. */
function filesBlock(lines, label) {
  const start = lines.findIndex((line) => /^files:\s*$/.test(line));
  if (start === -1) throw new Error(`${label} update feed has no top-level files: list`);
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  const entries = lines.slice(start + 1, end);
  if (!entries.some((line) => /^\s+-\s+url:/.test(line))) {
    throw new Error(`${label} update feed lists no files`);
  }
  return { start, end, entries };
}

function installerUrls(entries) {
  return entries
    .map((line) => /^\s+-\s+url:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((url) => url?.toLowerCase().endsWith('.exe'));
}

/** One feed listing both installers, with the x64 feed's top-level fields. */
export function mergeWindowsUpdateFeeds(x64Feed, arm64Feed) {
  const x64 = feedLines(x64Feed);
  const arm64 = feedLines(arm64Feed);
  const version = feedVersion(x64, 'x64');
  const arm64Version = feedVersion(arm64, 'arm64');
  if (version !== arm64Version) {
    throw new Error(`x64 feed is ${version} but arm64 feed is ${arm64Version}`);
  }

  const x64Files = filesBlock(x64, 'x64');
  const arm64Files = filesBlock(arm64, 'arm64');
  // The arch in each installer's name is what electron-updater matches on;
  // a feed whose names lost it would hand both arches the first entry.
  for (const [arch, block] of [
    ['x64', x64Files],
    ['arm64', arm64Files],
  ]) {
    const urls = installerUrls(block.entries);
    if (urls.length === 0 || !urls.every((url) => url.includes(arch))) {
      throw new Error(`${arch} feed's installers must name their arch: ${urls.join(', ')}`);
    }
  }

  return [...x64.slice(0, x64Files.end), ...arm64Files.entries, ...x64.slice(x64Files.end)].join(
    '\n',
  );
}

async function main(argv) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? null : argv[outIndex + 1];
  const inputs = argv.filter((arg, index) => arg !== '--out' && index !== outIndex + 1);
  if (inputs.length !== 2 || !out) {
    console.error(
      'usage: merge-windows-update-feed.mjs <x64 latest.yml> <arm64 latest.yml> --out <file>',
    );
    process.exit(2);
  }
  const [x64Path, arm64Path] = inputs;
  const merged = mergeWindowsUpdateFeeds(
    await readFile(x64Path, 'utf8'),
    await readFile(arm64Path, 'utf8'),
  );
  await writeFile(out, merged, 'utf8');
  console.log(`[update-feed] merged ${x64Path} + ${arm64Path} -> ${out}`);
  console.log(merged);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[update-feed] ${error.message}`);
    process.exit(1);
  });
}
