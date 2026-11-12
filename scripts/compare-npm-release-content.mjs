#!/usr/bin/env node
/**
 * Say, package by package, whether a set of candidate npm tarballs ships
 * anything the registry does not already serve.
 *
 *   node scripts/compare-npm-release-content.mjs --candidates <dir> --published <dir> [--json]
 *
 * Both directories hold `.tgz` files: the candidates from
 * `node scripts/rehearse-npm-release.mjs --output <dir>`, the published ones from
 * `npm pack <name>@<version> --pack-destination <dir>`. Tarballs are matched by
 * the package name inside them, not by file name, so a candidate may carry a
 * different version from its published counterpart.
 *
 * Each package is reported as one of:
 *   identical  every file is byte-identical, apart from the manifest's version
 *   pins-only  the same, except for exact pins on sibling packages
 *   changed    anything else
 *
 * WHY THE MANIFEST IS COMPARED PARSED: a local `pnpm pack` rewrites each
 * `workspace:*` range through an async map that assigns keys as their
 * promises settle (`pMapValues` in pnpm's exportable-manifest). Plain ranges
 * settle first, so the rewritten sibling pins land at the end of their
 * dependency map. The release does not hit this: multi-semantic-release has
 * already replaced every local range with a version in place, so pnpm keeps
 * the source order. Comparing manifest bytes therefore reported
 * `@bendyline/gezel-knowledge` and `@bendyline/gezel-script-runtime` as
 * changed when only that order differed (2026-11-11 audit). Dependency maps
 * are compared as maps; every other manifest value keeps its order, because
 * the order of conditional `exports` is meaningful.
 *
 * A `pins-only` package is not necessarily one to skip. With exact pins, the
 * pin is how a dependent reaches its sibling's new version: `gezel-cli`'s only
 * content is its pin on `@bendyline/gezel-cli`. See docs/npm-release.md.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Read every regular file of an npm tarball into memory, keyed by its path under `package/`. */
export async function readPackageTarball(file) {
  const files = new Map();
  const reads = [];
  await tar.list({
    file,
    onReadEntry(entry) {
      if (entry.type !== 'File' && entry.type !== 'OldFile') {
        entry.resume();
        return;
      }
      const path = entry.path.replace(/^[^/]+\//, '');
      const chunks = [];
      reads.push(
        new Promise((done, fail) => {
          entry.on('data', (chunk) => chunks.push(chunk));
          entry.on('end', () => {
            files.set(path, Buffer.concat(chunks));
            done();
          });
          entry.on('error', fail);
        }),
      );
    },
  });
  await Promise.all(reads);
  const manifestBytes = files.get('package.json');
  if (!manifestBytes) throw new Error(`${file} has no package/package.json`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  return { file, name: manifest.name, version: manifest.version, manifest, files };
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The differences between two manifests that a consumer could observe,
 * ignoring `version` and the order of dependency maps. Changed ranges on
 * `siblingNames` are reported as pins; everything else as `other`.
 */
export function manifestDifferences(candidate, published, siblingNames) {
  const pins = [];
  const other = [];
  const keys = new Set([...Object.keys(candidate), ...Object.keys(published)]);
  keys.delete('version');
  for (const key of [...keys].sort()) {
    if (!DEPENDENCY_FIELDS.includes(key)) {
      if (!sameValue(candidate[key], published[key])) other.push(key);
      continue;
    }
    const next = candidate[key] ?? {};
    const prev = published[key] ?? {};
    for (const name of [...new Set([...Object.keys(next), ...Object.keys(prev)])].sort()) {
      if (next[name] === prev[name]) continue;
      if (siblingNames.has(name) && name in next && name in prev) {
        pins.push({ field: key, name, from: prev[name], to: next[name] });
      } else {
        other.push(`${key}.${name}`);
      }
    }
  }
  return { pins, other };
}

/** Classify one candidate against the package npm already serves. */
export function compareReleaseContent(candidate, published, siblingNames) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, bytes] of candidate.files) {
    if (path === 'package.json') continue;
    const before = published.files.get(path);
    if (!before) added.push(path);
    else if (!before.equals(bytes)) changed.push(path);
  }
  for (const path of published.files.keys()) {
    if (path !== 'package.json' && !candidate.files.has(path)) removed.push(path);
  }
  const manifest = manifestDifferences(candidate.manifest, published.manifest, siblingNames);
  const contentChanged =
    added.length > 0 || removed.length > 0 || changed.length > 0 || manifest.other.length > 0;
  const kind = contentChanged ? 'changed' : manifest.pins.length > 0 ? 'pins-only' : 'identical';
  return {
    name: candidate.name,
    candidateVersion: candidate.version,
    publishedVersion: published.version,
    kind,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    manifest,
  };
}

async function readTarballDir(dir) {
  const byName = new Map();
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.tgz')) continue;
    const tarball = await readPackageTarball(resolve(dir, entry));
    if (byName.has(tarball.name)) {
      throw new Error(`${dir} holds two tarballs for ${tarball.name}`);
    }
    byName.set(tarball.name, tarball);
  }
  return byName;
}

/** Compare every candidate in one directory with its namesake in another. */
export async function compareTarballDirs({ candidatesDir, publishedDir }) {
  const candidates = await readTarballDir(candidatesDir);
  const published = await readTarballDir(publishedDir);
  const siblingNames = new Set([...candidates.keys(), ...published.keys()]);
  const results = [];
  for (const [name, candidate] of candidates) {
    const before = published.get(name);
    results.push(
      before
        ? compareReleaseContent(candidate, before, siblingNames)
        : {
            name,
            candidateVersion: candidate.version,
            publishedVersion: null,
            kind: 'unpublished',
          },
    );
  }
  return results;
}

export function formatResult(result, limit = 12) {
  const head = `${result.name} ${result.publishedVersion ?? '-'} -> ${result.candidateVersion}: ${result.kind}`;
  if (result.kind === 'identical' || result.kind === 'unpublished') return head;
  const lines = [head];
  for (const pin of result.manifest.pins) {
    lines.push(`    pin ${pin.field}.${pin.name} ${pin.from} -> ${pin.to}`);
  }
  for (const key of result.manifest.other.slice(0, limit)) lines.push(`    ~ package.json ${key}`);
  for (const [mark, paths] of [
    ['+', result.added],
    ['-', result.removed],
    ['~', result.changed],
  ]) {
    for (const path of paths.slice(0, limit)) lines.push(`    ${mark} ${path}`);
    if (paths.length > limit) lines.push(`    ${mark} … ${paths.length - limit} more`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--candidates') options.candidatesDir = argv[++i];
    else if (arg === '--published') options.publishedDir = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.candidatesDir || !options.publishedDir) {
    throw new Error(
      'usage: compare-npm-release-content.mjs --candidates <dir> --published <dir> [--json]',
    );
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const results = await compareTarballDirs(options);
    if (options.json) console.log(JSON.stringify(results, null, 2));
    else for (const result of results) console.log(formatResult(result));
  } catch (err) {
    console.error(`compare-npm-release-content: ${err.message}`);
    process.exit(1);
  }
}
