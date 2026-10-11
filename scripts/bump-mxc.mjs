#!/usr/bin/env node
/**
 * bump-mxc.mjs — repin Microsoft's MXC launcher.
 *
 * Downloads the `@microsoft/mxc-sdk` tarball for the requested version,
 * checks it against the registry's own `dist.integrity`, computes the
 * tarball's sha256, every `bin/<arch>/wxc-exec.exe` sha256 and the license
 * sha256, and rewrites `packages/core/src/native/mxc-pin.ts`. The PR diff is
 * the audit trail; never hand-edit a digest.
 *
 *   node scripts/bump-mxc.mjs 1.0.1
 *   node scripts/bump-mxc.mjs            # the registry's `latest`
 *
 * Nothing from the tarball is executed. Before landing a bump, on Windows:
 *
 *   - confirm `Get-AuthenticodeSignature` reports Valid with a
 *     `CN=Microsoft Corporation` subject on both launchers;
 *   - re-run the MXC sandbox integration suite against the new launcher. A
 *     bump moves the containment boundary every sandboxed script runs inside.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x as extractTar } from 'tar';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_PATH = join(repoRoot, 'packages', 'core', 'src', 'native', 'mxc-pin.ts');
const PACKAGE = '@microsoft/mxc-sdk';
const ARCHES = ['x64', 'arm64'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function getBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function replaceConst(src, name, value) {
  const re = new RegExp(`(export const ${name}\\s*=\\s*\\n?\\s*)['"][^'"]*['"]`);
  if (!re.test(src)) throw new Error(`cannot locate ${name} in the pin file`);
  return src.replace(re, `$1'${value}'`);
}

function replaceTable(src, name, values) {
  const re = new RegExp(`(export const ${name}[^{]*\\{)([\\s\\S]*?)(\\n\\};)`);
  if (!re.test(src)) throw new Error(`cannot locate ${name} in the pin file`);
  const body = Object.entries(values)
    .map(([k, v]) => `\n  ${k}: '${v}',`)
    .join('');
  return src.replace(re, `$1${body}$3`);
}

async function main() {
  const requested = process.argv[2]?.replace(/^v/, '') ?? 'latest';
  const meta = await getJson(`https://registry.npmjs.org/${PACKAGE}/${requested}`);
  const version = meta.version;
  const tarballUrl = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (!version || !tarballUrl || !integrity?.startsWith('sha512-')) {
    throw new Error(`registry metadata for ${PACKAGE}@${requested} lacks a tarball or sha512`);
  }
  console.log(`[bump-mxc] ${PACKAGE}@${version}`);

  const tarball = await getBuffer(tarballUrl);
  const actualIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (actualIntegrity !== integrity) {
    throw new Error(
      `tarball integrity ${actualIntegrity} differs from the registry's ${integrity}`,
    );
  }
  const tarballSha = sha256(tarball);

  const scratch = await mkdtemp(join(tmpdir(), 'gezel-bump-mxc-'));
  try {
    const tarballPath = join(scratch, 'package.tgz');
    const extractDir = join(scratch, 'x');
    await writeFile(tarballPath, tarball);
    await mkdir(extractDir, { recursive: true });
    const entries = [
      ...ARCHES.map((arch) => `package/bin/${arch}/wxc-exec.exe`),
      'package/LICENSE.md',
      'package/package.json',
    ];
    await extractTar({ file: tarballPath, cwd: extractDir, strict: true }, entries);

    const pkg = JSON.parse(await readFile(join(extractDir, 'package', 'package.json'), 'utf8'));
    if (pkg.name !== PACKAGE || pkg.version !== version) {
      throw new Error(`tarball identifies as ${pkg.name}@${pkg.version}`);
    }
    if (pkg.license !== 'MIT') {
      throw new Error(`${PACKAGE}@${version} declares license ${pkg.license}; review NOTICE.md`);
    }
    const executorShas = {};
    for (const arch of ARCHES) {
      executorShas[arch] = sha256(
        await readFile(join(extractDir, 'package', 'bin', arch, 'wxc-exec.exe')),
      );
      console.log(`  ${arch.padEnd(6)} wxc-exec.exe ${executorShas[arch]}`);
    }
    const licenseSha = sha256(await readFile(join(extractDir, 'package', 'LICENSE.md')));
    console.log(`  LICENSE.md          ${licenseSha}`);
    console.log(`  tarball             ${tarballSha}`);

    let src = await readFile(PIN_PATH, 'utf8');
    src = replaceConst(src, 'MXC_VERSION', version);
    src = replaceConst(src, 'MXC_TARBALL_URL', tarballUrl);
    src = replaceConst(src, 'MXC_TARBALL_INTEGRITY', integrity);
    src = replaceConst(src, 'MXC_TARBALL_SHA256', tarballSha);
    src = replaceConst(src, 'MXC_LICENSE_SHA256', licenseSha);
    src = replaceTable(src, 'MXC_EXECUTOR_SHA256', executorShas);
    await writeFile(PIN_PATH, src, 'utf8');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  console.log(`\n[bump-mxc] wrote ${PIN_PATH}`);
  console.log('[bump-mxc] next: update the MXC row in NOTICE.md, verify both launchers are');
  console.log('           Microsoft-signed, and re-run the MXC sandbox integration suite.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
