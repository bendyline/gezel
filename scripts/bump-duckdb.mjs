#!/usr/bin/env node
/**
 * bump-duckdb.mjs — repin the vendored DuckDB CLI.
 *
 * Downloads every platform archive for the requested tag, computes both the
 * archive and the extracted-binary sha256, resolves the tag's commit, fetches
 * the LICENSE at that commit, and rewrites
 * `packages/core/src/native/duckdb-pin.ts`. The PR diff is the audit trail;
 * never hand-edit a digest.
 *
 *   node scripts/bump-duckdb.mjs 1.5.6
 *   node scripts/bump-duckdb.mjs            # latest release
 *
 * ── This is a security review, not a chore ───────────────────────────────
 *
 * `DuckRunner`'s configuration prelude and `statement-guard`'s reliance on
 * `json_serialize_sql` are behavioural contracts measured against a specific
 * engine build. Before landing a bump, re-run the sandbox matrix documented
 * in docs/observation-corpora.md against the new binary — in particular that
 * `ATTACH` inside an allowed directory still writes a file (which is why the
 * statement guard is load-bearing) and that `json_serialize_sql` still
 * rejects non-SELECT statements. A bump that silently changes either one
 * would weaken the query sandbox without failing a single test.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_PATH = join(repoRoot, 'packages', 'core', 'src', 'native', 'duckdb-pin.ts');

const ASSETS = {
  'darwin-arm64': 'duckdb_cli-osx-arm64.zip',
  'linux-x64': 'duckdb_cli-linux-amd64.zip',
  'linux-arm64': 'duckdb_cli-linux-arm64.zip',
  'win32-x64': 'duckdb_cli-windows-amd64.zip',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function getBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ghJson(url) {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GEZEL_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Extract one named entry from a ZIP using only built-ins (see fetch-duckdb.mjs). */
function readZipEntry(buf, wantName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || entryCount === 0xffff) throw new Error('ZIP64 not supported');
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (name === wantName || name.endsWith(`/${wantName}`)) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      if (method !== 0 && method !== 8) throw new Error(`unsupported method ${method}`);
      const raw = buf.subarray(start, start + compressedSize);
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function replaceTable(src, name, values) {
  const re = new RegExp(`(export const ${name}[^{]*\\{)([\\s\\S]*?)(\\n\\};)`);
  if (!re.test(src)) throw new Error(`cannot locate ${name} in the pin file`);
  const body = Object.entries(values)
    .map(([k, v]) => `\n  '${k}': '${v}',`)
    .join('');
  return src.replace(re, `$1${body}$3`);
}

function replaceConst(src, name, value) {
  const re = new RegExp(`(export const ${name}\\s*=\\s*\\n?\\s*)['"][^'"]*['"]`);
  if (!re.test(src)) throw new Error(`cannot locate ${name} in the pin file`);
  return src.replace(re, `$1'${value}'`);
}

async function main() {
  const requested = process.argv[2]?.replace(/^v/, '');
  const release = requested
    ? await ghJson(`https://api.github.com/repos/duckdb/duckdb/releases/tags/v${requested}`)
    : await ghJson('https://api.github.com/repos/duckdb/duckdb/releases/latest');
  const version = release.tag_name.replace(/^v/, '');
  const ref = await ghJson(
    `https://api.github.com/repos/duckdb/duckdb/git/refs/tags/${release.tag_name}`,
  );
  // Annotated tags point at a tag object; dereference to the commit.
  const commit =
    ref.object.type === 'tag' ? (await ghJson(ref.object.url)).object.sha : ref.object.sha;

  console.log(`[bump-duckdb] v${version} (${commit})`);

  const archiveShas = {};
  const binaryShas = {};
  for (const [key, asset] of Object.entries(ASSETS)) {
    const url = `https://github.com/duckdb/duckdb/releases/download/v${version}/${asset}`;
    process.stdout.write(`  ${key.padEnd(14)} `);
    const archive = await getBuffer(url);
    const binaryName = key.startsWith('win32') ? 'duckdb.exe' : 'duckdb';
    const binary = readZipEntry(archive, binaryName);
    if (!binary) throw new Error(`no '${binaryName}' inside ${asset}`);
    archiveShas[key] = sha256(archive);
    binaryShas[key] = sha256(binary);
    console.log(
      `archive ${archiveShas[key].slice(0, 12)}…  binary ${binaryShas[key].slice(0, 12)}…`,
    );
  }

  const license = await getBuffer(
    `https://raw.githubusercontent.com/duckdb/duckdb/${commit}/LICENSE`,
  );
  const licenseSha = sha256(license);
  console.log(`  LICENSE        ${licenseSha.slice(0, 12)}…`);

  let src = await readFile(PIN_PATH, 'utf8');
  src = replaceConst(src, 'DUCKDB_VERSION', version);
  src = replaceConst(src, 'DUCKDB_COMMIT', commit);
  src = replaceConst(src, 'DUCKDB_LICENSE_SHA256', licenseSha);
  src = replaceTable(src, 'DUCKDB_ARCHIVE_SHA256', archiveShas);
  src = replaceTable(src, 'DUCKDB_BINARY_SHA256', binaryShas);
  await writeFile(PIN_PATH, src, 'utf8');

  console.log(`\n[bump-duckdb] wrote ${PIN_PATH}`);
  console.log('[bump-duckdb] next: update the DuckDB row in NOTICE.md, then RE-RUN THE SANDBOX');
  console.log('               MATRIX in docs/observation-corpora.md against the new binary.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
