#!/usr/bin/env node
/**
 * Build dist/gezel.oxt from src/.
 *
 * Deterministic on purpose: entries sorted, one fixed timestamp, no
 * directory entries. The daemon decides "a newer extension is ready to
 * install" by hashing this file, so an unchanged source must produce the
 * same bytes on every build.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yazl from 'yazl';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');
const SKIP = [/(^|\/)__pycache__\//, /\.pyc$/, /(^|\/)\.DS_Store$/];

async function listFiles(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  await walk(root);
  return out.filter((p) => !SKIP.some((re) => re.test(p))).sort();
}

/** The product version core carries (stamped at release; 0.0.0 in development). */
export async function productVersion(repoRoot = join(packageDir, '..', '..')) {
  const source = await readFile(join(repoRoot, 'packages', 'core', 'src', 'browser.ts'), 'utf8');
  const m = /export const GEZEL_VERSION = '([^']+)'/.exec(source);
  if (!m) throw new Error('GEZEL_VERSION not found in packages/core/src/browser.ts');
  return m[1].split(/[-+]/)[0];
}

/** Every file META-INF/manifest.xml names. */
export function manifestEntries(manifestXml) {
  return [...manifestXml.matchAll(/manifest:full-path="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * @param {{ srcDir?: string; outFile?: string; version?: string }} [options]
 * @returns {Promise<{ outFile: string; files: string[]; version: string }>}
 */
export async function buildOxt({
  srcDir = join(packageDir, 'src'),
  outFile = join(packageDir, 'dist', 'gezel.oxt'),
  version,
} = {}) {
  const resolvedVersion = version ?? (await productVersion());
  const files = await listFiles(srcDir);
  const manifest = await readFile(join(srcDir, 'META-INF', 'manifest.xml'), 'utf8');
  for (const entry of manifestEntries(manifest)) {
    if (!files.includes(entry))
      throw new Error(`manifest.xml names ${entry}, which is not in src/`);
  }
  await mkdir(dirname(outFile), { recursive: true });
  const zip = new yazl.ZipFile();
  for (const file of files) {
    let content = await readFile(join(srcDir, ...file.split('/')));
    if (file === 'description.xml') {
      content = Buffer.from(content.toString('utf8').replace('__VERSION__', resolvedVersion));
    }
    zip.addBuffer(content, file, { mtime: FIXED_MTIME, mode: 0o100644 });
  }
  zip.end();
  await new Promise((resolve, reject) => {
    const out = createWriteStream(outFile);
    zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
  });
  return { outFile, files, version: resolvedVersion };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { outFile, files, version } = await buildOxt();
  console.log(
    `[libreoffice-extension] ${relative(process.cwd(), outFile)} (${files.length} files, version ${version})`,
  );
}
