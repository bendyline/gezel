#!/usr/bin/env node
/**
 * The source code Gezel owes for the LGPL libraries its Linux ROCm engine
 * carries, and the step that gathers it.
 *
 * AMD's Linux ROCm runtime links two LGPL libraries that AMD builds into its
 * SDK under new names: numactl's libnuma (librocm_sysdeps_numa) and elfutils'
 * libelf (librocm_sysdeps_elf). Distributing their binaries obliges us to
 * offer their source from where we offer the binaries (LGPL-2.1 section 4;
 * GPL-3.0 section 6 through LGPL-3.0), and AMD's wheels carry neither the
 * source nor an offer to pass along. So the linux-x64 ROCm leg of
 * build-native.yml fetches exactly what AMD built them from, the draft native
 * release attaches it as `gezel-third-party-sources-<version>.tar`, and the
 * license README staged into the archive (stage-native-artifact-licenses.mjs)
 * points there.
 *
 * Bumping ROCm: read third-party/sysdeps/linux/<component>/CMakeLists.txt at
 * the new TheRock tag and update the tag, commit, versions, URLs and hashes
 * here. Every archive is pinned by sha256 and must match from either URL.
 *
 * Usage:
 *   node scripts/rocm-lgpl-sources.mjs --out <dir>      fetch and verify
 *   node scripts/rocm-lgpl-sources.mjs --verify <dir>   check a fetched set
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** AMD's ROCm build system at the release the pinned SDK wheels came from. */
export const THEROCK_SOURCE = Object.freeze({
  repository: 'https://github.com/ROCm/TheRock',
  tag: 'therock-10.0',
  commit: '16adc4d875fd4f65ea23c7c84e1c66706fde3047',
});

export const THEROCK_ARCHIVE = `TheRock-${THEROCK_SOURCE.tag}.tar.gz`;

/** Each LGPL library in the Linux ROCm payload and the release AMD built it from. */
export const ROCM_LGPL_SOURCES = Object.freeze([
  Object.freeze({
    component: 'numactl',
    version: '2.0.19',
    license: 'LGPL-2.1',
    library: 'librocm_sysdeps_numa.so.1',
    file: 'numactl-2.0.19.tar.gz',
    url: 'https://rocm-third-party-deps.s3.us-east-2.amazonaws.com/numactl-2.0.19.tar.gz',
    upstream: 'https://github.com/numactl/numactl/releases/download/v2.0.19/numactl-2.0.19.tar.gz',
    sha256: 'f2672a0381cb59196e9c246bf8bcc43d5568bc457700a697f1a1df762b9af884',
  }),
  Object.freeze({
    component: 'elfutils',
    version: '0.195',
    license: 'LGPL-3.0-or-later OR GPL-2.0-or-later',
    library: 'librocm_sysdeps_elf.so.1',
    file: 'elfutils-0.195.tar.bz2',
    url: 'https://rocm-third-party-deps.s3.us-east-2.amazonaws.com/elfutils-0.195.tar.bz2',
    upstream: 'https://sourceware.org/elfutils/ftp/0.195/elfutils-0.195.tar.bz2',
    sha256: '37629fdf7f1f3dc2818e138fca2b8094177d6c2d0f701d3bb650a561218dc026',
  }),
]);

export const README = 'README.txt';

export function thirdPartySourcesAssetName(version) {
  return `gezel-third-party-sources-${version}.tar`;
}

export function sourcesReadme() {
  const width = Math.max(...ROCM_LGPL_SOURCES.map((source) => source.library.length));
  return [
    "Source code for the LGPL libraries in Gezel's Linux ROCm engine",
    '(gezel-native-<version>-linux-x64-rocm.tar.gz), as AMD built them for its',
    `ROCm SDK (TheRock, tag ${THEROCK_SOURCE.tag}):`,
    '',
    ...ROCM_LGPL_SOURCES.flatMap((source) => [
      `  ${source.library.padEnd(width)}  ${source.component} ${source.version}, ${source.license}`,
      `  ${''.padEnd(width)}  ${source.file}`,
    ]),
    '',
    `${THEROCK_ARCHIVE} is TheRock, AMD's ROCm build system, at commit`,
    `${THEROCK_SOURCE.commit}. It compiles each library from the`,
    'release archive above: third-party/sysdeps/linux/<component>/ holds the',
    'build and the patch_source.sh and patch_install.sh scripts that rename',
    'the library to librocm_sysdeps_<name> and prefix its symbol versions',
    'with AMDROCM_SYSDEPS_1.0_; patches/third-party/<component>/ holds any',
    'patch applied to the release before it is built.',
    '',
    'Gezel ships these libraries exactly as AMD built them.',
    '',
    'Upstream:',
    ...ROCM_LGPL_SOURCES.map((source) => `  ${source.upstream}`),
    `  ${THEROCK_SOURCE.repository}/tree/${THEROCK_SOURCE.tag}`,
    '',
  ].join('\n');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(source, out) {
  const failures = [];
  for (const url of [source.url, source.upstream]) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== source.sha256) throw new Error(`sha256 ${actual}, pinned ${source.sha256}`);
      writeFileSync(join(out, source.file), bytes);
      console.log(`[rocm-sources] ${source.file} from ${url}`);
      return;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not fetch ${source.file}:\n  ${failures.join('\n  ')}`);
}

function archiveTheRock(out) {
  const work = mkdtempSync(join(tmpdir(), 'gezel-therock-'));
  const git = (args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    git(['fetch', '-q', '--depth', '1', THEROCK_SOURCE.repository, THEROCK_SOURCE.commit]);
    const fetched = git(['rev-parse', 'FETCH_HEAD']);
    if (fetched !== THEROCK_SOURCE.commit)
      throw new Error(`TheRock fetch returned ${fetched}, pinned ${THEROCK_SOURCE.commit}`);
    git([
      'archive',
      '--format=tar.gz',
      `--prefix=TheRock-${THEROCK_SOURCE.tag}/`,
      '-o',
      join(out, THEROCK_ARCHIVE),
      'FETCH_HEAD',
    ]);
    console.log(`[rocm-sources] ${THEROCK_ARCHIVE} from ${THEROCK_SOURCE.commit}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Fetch every pinned source into `out`, then prove the set is complete. */
export async function fetchRocmLgplSources(out) {
  mkdirSync(out, { recursive: true });
  for (const source of ROCM_LGPL_SOURCES) await download(source, out);
  archiveTheRock(out);
  writeFileSync(join(out, README), sourcesReadme());
  const problems = verifyRocmLgplSources(out);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** Problems with the source set at `dir`, empty when it is complete. */
export function verifyRocmLgplSources(dir) {
  if (!existsSync(dir)) return [`${dir} does not exist`];
  const problems = [];
  const expected = new Set([README, THEROCK_ARCHIVE, ...ROCM_LGPL_SOURCES.map((s) => s.file)]);
  for (const name of readdirSync(dir)) {
    if (!expected.has(name)) problems.push(`unexpected file ${name}`);
  }
  for (const source of ROCM_LGPL_SOURCES) {
    const path = join(dir, source.file);
    if (!existsSync(path)) {
      problems.push(`${source.file} is missing`);
    } else if (sha256(readFileSync(path)) !== source.sha256) {
      problems.push(`${source.file} does not match its pinned sha256`);
    }
  }
  const therock = join(dir, THEROCK_ARCHIVE);
  if (!existsSync(therock) || statSync(therock).size === 0) {
    problems.push(`${THEROCK_ARCHIVE} is missing`);
  }
  if (!existsSync(join(dir, README))) problems.push(`${README} is missing`);
  return problems;
}

async function main(argv) {
  const [flag, dir] = argv;
  if (!dir || (flag !== '--out' && flag !== '--verify')) {
    console.error('usage: rocm-lgpl-sources.mjs --out <dir> | --verify <dir>');
    process.exit(2);
  }
  if (flag === '--out') await fetchRocmLgplSources(resolve(dir));
  const problems = verifyRocmLgplSources(resolve(dir));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`[rocm-sources] complete in ${resolve(dir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
