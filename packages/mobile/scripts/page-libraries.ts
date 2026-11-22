import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { phoneLibraryFiles } from '../../core/src/pages/phone.js';
import type { PageLibraryLine } from '../../core/src/schemas/page-library.js';
import { PageLibraryStore } from '../../inference/src/page-libraries/store.js';
import {
  compilePreviewModule,
  scanPreviewModuleImports,
} from '../../script-runtime/src/preview-module.js';

const ID = 'virtual:gezel-page-libraries';
/** The lines alone, for the prompt: small, and loaded at boot. */
const LINES_ID = 'virtual:gezel-page-library-lines';

/**
 * The page libraries the phone app ships (docs/page-libraries.md). A phone
 * cannot download one, so a build carries the lines marked for phones from a
 * staged shelf: `GEZEL_PAGE_LIBRARIES_DIR`, else packages/mobile/page-libraries,
 * staged with `node scripts/seed-page-libraries.mjs --out packages/mobile/page-libraries`.
 * With no shelf staged the module is empty and pages use no libraries, as
 * before. A lazy chunk: only a preview that names a library loads it.
 */
export function pageLibrariesPlugin(): Plugin {
  let shelf: Promise<PhoneShelf> | undefined;
  return {
    name: 'gezel-page-libraries',
    resolveId(id) {
      return id === ID || id === LINES_ID ? `\0${id}` : null;
    },
    async load(id) {
      if (id !== `\0${ID}` && id !== `\0${LINES_ID}`) return null;
      shelf ??= readPhoneShelf();
      const { lines, files, modules } = await shelf;
      return id === `\0${LINES_ID}`
        ? `export default ${JSON.stringify(lines)};`
        : `export default ${JSON.stringify({ lines, files, modules })};`;
    },
  };
}

interface PhoneShelf {
  lines: PageLibraryLine[];
  /** Files used as written, by `library@version/path`. */
  files: Record<string, string>;
  /** Module files, compiled as the phone's preview worker would compile them. */
  modules: Record<string, { code: string; imports: string[] }>;
}

async function readPhoneShelf(): Promise<PhoneShelf> {
  const folder = resolve(
    process.env.GEZEL_PAGE_LIBRARIES_DIR ??
      fileURLToPath(new URL('../page-libraries', import.meta.url)),
  );
  const store = new PageLibraryStore({ home: tmpdir(), writableRoot: folder, seedRoots: [] });
  const lines: PageLibraryLine[] = [];
  const files: Record<string, string> = {};
  const modules: PhoneShelf['modules'] = {};
  for (const entry of await store.installed()) {
    if (!entry.line.hosts.includes('phone')) continue;
    // The shelf's own check, at build time: a phone never serves from disk.
    const read = async (path: string): Promise<string | null> => {
      const expected = entry.files[path];
      if (!expected) return null;
      const bytes = await readFile(join(entry.dir, path));
      if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
        throw new Error(
          `${entry.line.name} ${entry.line.version}: ${path} does not match its hash`,
        );
      return bytes.toString('utf8');
    };
    const carried = await phoneLibraryFiles(entry.line, read, (code, path) =>
      scanPreviewModuleImports(code, path),
    );
    if (!carried.modules.length && !carried.texts.length) continue;
    lines.push(entry.line);
    const key = (path: string) => `${entry.line.library}@${entry.line.version}/${path}`;
    for (const path of carried.texts) files[key(path)] = (await read(path))!;
    for (const path of carried.modules) {
      const compiled = compilePreviewModule((await read(path))!, path, 'commonjs');
      if (compiled.errors.length)
        throw new Error(
          `${entry.line.name} ${entry.line.version}: ${path} does not compile: ${compiled.errors[0]}`,
        );
      modules[key(path)] = {
        code: compiled.code,
        imports: compiled.imports.map((found) => found.specifier),
      };
    }
  }
  return { lines, files, modules };
}
