#!/usr/bin/env node
// Health gate for the vendored Prismatic component library. For every entry in
// vendor/provenance.json it asserts the four things that make a vendored slice
// safe to run off-platform:
//   1. every declared `slice` file is present under vendor/<component>/,
//   2. a `*.conformance.test.ts` exists for it (the runtime shape gate),
//   3. the `<component>/<action>` key is registered in src/vendor/index.ts,
//   4. the slice content matches the pinned `vendoredSha` (silent-edit / drift catch).
//
// Usage:
//   node scripts/vendor-component.mjs            verify (default) — exit 1 on any gap
//   node scripts/vendor-component.mjs --update   (re)stamp `vendoredSha` after an
//                                                intentional vendor change
//
// This is what lets the library scale past Airtable: adding a component means
// adding a provenance entry + slice + conformance test + registration, and this
// gate fails loudly until all four are in place.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const vendorDir = join(pkgRoot, 'vendor');
const provenancePath = join(vendorDir, 'provenance.json');
const registryPath = join(pkgRoot, 'src', 'vendor', 'index.ts');

const update = process.argv.includes('--update');
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
const registry = readFileSync(registryPath, 'utf8');

/** sha256 (first 16 hex) over a slice's files, order-independent. */
function sliceSha(compDir, slice) {
  const hash = createHash('sha256');
  for (const file of [...slice].sort()) {
    const p = join(compDir, file);
    if (existsSync(p)) hash.update(readFileSync(p));
  }
  return hash.digest('hex').slice(0, 16);
}

const rows = [];
let problemCount = 0;
for (const [key, entry] of Object.entries(provenance)) {
  if (key.startsWith('_')) continue; // skip `_note` and other metadata keys
  const [component] = key.split('/');
  const compDir = join(vendorDir, component);
  const slice = Array.isArray(entry.slice) ? entry.slice : [];
  const problems = [];

  for (const file of slice) {
    if (!existsSync(join(compDir, file))) problems.push(`missing slice file: ${file}`);
  }
  const hasConformance =
    existsSync(compDir) && readdirSync(compDir).some((f) => f.endsWith('.conformance.test.ts'));
  if (!hasConformance) problems.push('no *.conformance.test.ts alongside the slice');
  if (!registry.includes(`'${key}'`)) {
    problems.push(`not registered in src/vendor/index.ts (expected key '${key}')`);
  }

  const sha = sliceSha(compDir, slice);
  if (update) {
    entry.vendoredSha = sha;
  } else if (typeof entry.vendoredSha === 'string' && entry.vendoredSha !== sha) {
    problems.push(`content drift: recorded vendoredSha ${entry.vendoredSha}, computed ${sha}`);
  } else if (entry.vendoredSha === undefined) {
    problems.push(`no vendoredSha pinned (run --update); computed ${sha}`);
  }

  rows.push({ key, sha, problems });
  problemCount += problems.length;
}

if (update) {
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Stamped vendoredSha for ${rows.length} vendored action(s) → ${provenancePath}`);
  process.exit(0);
}

for (const r of rows) {
  console.log(`${r.problems.length === 0 ? 'OK  ' : 'FAIL'}  ${r.key}  (sha ${r.sha})`);
  for (const p of r.problems) console.log(`        - ${p}`);
}
console.log(`\n${rows.length} vendored action(s), ${problemCount} problem(s).`);
process.exit(problemCount > 0 ? 1 : 0);
