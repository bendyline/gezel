import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { extractNpmPackageFiles, verifyTarballSha256 } from '@bendyline/gezel-catalog';
import {
  PAGE_LIBRARY_MARKER,
  type PageLibraryInstall,
  PageLibraryInstallSchema,
  type PageLibraryLine,
  commonJsModuleSource,
  commonJsModuleSpec,
  globalModuleSource,
} from '@bendyline/gezel/pages';
import { pageLibrariesDir } from '@bendyline/gezel/paths';
import { realpathContained, safeJoin } from '../fs/safe-paths.js';

const log = createLogger('page-libraries');

/**
 * Folders of page libraries that ship with the app, separated like `PATH`.
 * A store build may not download code, so its starter set arrives this way;
 * a phone build and an embedding app use the same layout.
 */
export const PAGE_LIBRARIES_SEED_ENV = 'GEZEL_PAGE_LIBRARIES_DIR';

/** How long a listing of the shelf is reused before the folders are read again. */
const LISTING_TTL_MS = 2_000;
const MAX_LINE_FILES = 5_000;

export interface InstalledPageLibrary {
  line: PageLibraryLine;
  files: PageLibraryInstall['files'];
  /** The folder holding the line's files, laid out as in its package. */
  dir: string;
  /** Downloaded into this home, so it can be removed; false when it shipped with the app. */
  removable: boolean;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function folders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/**
 * The shelf of page libraries on this computer (docs/page-libraries.md): the
 * lines downloaded into the home, then the ones that shipped with the app.
 * A line is `<library>/<version>-<sha12>/` holding the package's own files,
 * byte for byte, beside a marker that records the line and every file's
 * hash. Files are never rewritten, so what a page loads is what the pin names.
 */
export class PageLibraryStore {
  private readonly roots: string[];
  private listing: { at: number; lines: Promise<InstalledPageLibrary[]> } | undefined;
  private readonly verified = new Set<string>();

  constructor(opts: {
    home: string;
    seedRoots?: readonly string[];
    env?: NodeJS.ProcessEnv;
    /** Install somewhere other than the home, as staging a store build's set does. */
    writableRoot?: string;
  }) {
    const seeds =
      opts.seedRoots ??
      ((opts.env ?? process.env)[PAGE_LIBRARIES_SEED_ENV] ?? '').split(delimiter).filter(Boolean);
    this.roots = [
      opts.writableRoot ? resolve(opts.writableRoot) : pageLibrariesDir(opts.home),
      ...seeds.map((root) => resolve(root)),
    ];
  }

  /** Every installed line. A line present in two roots is listed once, from the first. */
  installed(): Promise<InstalledPageLibrary[]> {
    const now = Date.now();
    if (!this.listing || now - this.listing.at > LISTING_TTL_MS) {
      this.listing = { at: now, lines: this.read() };
    }
    return this.listing.lines;
  }

  async lines(): Promise<PageLibraryLine[]> {
    return (await this.installed()).map((entry) => entry.line);
  }

  /** Forget the listing, after an install or a removal. */
  invalidate(): void {
    this.listing = undefined;
  }

  private async read(): Promise<InstalledPageLibrary[]> {
    const found = new Map<string, InstalledPageLibrary>();
    for (const [index, root] of this.roots.entries()) {
      for (const library of await folders(root)) {
        for (const release of await folders(join(root, library))) {
          const dir = join(root, library, release);
          const install = await readFile(join(dir, PAGE_LIBRARY_MARKER), 'utf8')
            .then((text) => PageLibraryInstallSchema.safeParse(JSON.parse(text)))
            .catch(() => null);
          if (!install?.success) continue;
          const { line, files } = install.data;
          // The folder names are part of the address a page asks for.
          if (line.library !== library || !release.startsWith(`${line.version}-`)) continue;
          const key = `${line.library}@${line.version}`;
          if (!found.has(key)) found.set(key, { line, files, dir, removable: index === 0 });
        }
      }
    }
    return [...found.values()];
  }

  /**
   * The file one shelf address names, or null. Only a file the marker lists
   * is served, and its bytes are checked against the marker the first time
   * this process serves it: the home folder is the person's to edit, and a
   * changed library must not run on every page that uses it.
   */
  async file(library: string, version: string, path: string): Promise<string | null> {
    const entry = (await this.installed()).find(
      (candidate) => candidate.line.library === library && candidate.line.version === version,
    );
    const expected = entry?.files[path];
    if (!entry || !expected) return null;
    const full = safeJoin(entry.dir, path);
    if (!full || !(await realpathContained(entry.dir, full))) return null;
    const key = `${entry.dir}\0${path}`;
    if (!this.verified.has(key)) {
      const actual = await sha256File(full).catch(() => null);
      if (actual !== expected.sha256) {
        log.error(
          `[page-libraries] ${library}@${version} ${path} does not match its recorded hash; not serving it`,
        );
        return null;
      }
      this.verified.add(key);
    }
    return full;
  }

  /**
   * The module the shelf writes at `path`, or null: over a plain-script
   * global (`_gezel/index.js` for React 18's `react`, whose build `file`
   * serves), or around a CommonJS file (React 19), which is read through
   * `file` and so hash-checked like any other.
   */
  async globalModule(library: string, version: string, path: string): Promise<string | null> {
    const entry = (await this.installed()).find(
      (candidate) => candidate.line.library === library && candidate.line.version === version,
    );
    if (!entry) return null;
    const written = globalModuleSource(entry.line, path);
    if (written !== null) return written;
    const commonjs = commonJsModuleSpec(entry.line, path);
    if (!commonjs) return null;
    const full = await this.file(library, version, commonjs.spec.file);
    if (!full) return null;
    return commonJsModuleSource(entry.line, path, await readFile(full, 'utf8'));
  }

  /** Remove a line downloaded into this home. Lines that shipped with the app stay. */
  async remove(library: string, version: string): Promise<boolean> {
    const entry = (await this.read()).find(
      (candidate) =>
        candidate.removable &&
        candidate.line.library === library &&
        candidate.line.version === version,
    );
    if (!entry) return false;
    await rm(entry.dir, { recursive: true, force: true });
    for (const key of [...this.verified])
      if (key.startsWith(`${entry.dir}\0`)) this.verified.delete(key);
    this.invalidate();
    return true;
  }

  /**
   * Install one line from its package tarball, already on disk. The tarball
   * must hash to the line's pin, and every file the line maps a request to
   * must be in it.
   */
  async install(opts: {
    line: PageLibraryLine;
    tarballPath: string;
  }): Promise<InstalledPageLibrary> {
    const { line } = opts;
    const sha = await verifyTarballSha256(opts.tarballPath);
    if (sha !== line.source.sha256) {
      throw new Error(
        `[page-libraries] ${line.source.package}@${line.source.version} does not match its pinned hash`,
      );
    }
    const root = this.roots[0]!;
    const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
    const dir = join(root, line.library, `${line.version}-${sha.slice(0, 12)}`);
    await mkdir(staging, { recursive: true });
    try {
      const written = await extractNpmPackageFiles({
        tarballPath: opts.tarballPath,
        destination: staging,
        include: [...line.include, ...(line.notice ? [line.notice] : [])],
        expectedName: line.source.package,
        expectedVersion: line.source.version,
      });
      if (written.length > MAX_LINE_FILES) {
        throw new Error(`[page-libraries] ${line.library} lists more than ${MAX_LINE_FILES} files`);
      }
      const listed = new Set(written);
      for (const entry of written) {
        for (let cut = entry.indexOf('/'); cut !== -1; cut = entry.indexOf('/', cut + 1)) {
          listed.add(entry.slice(0, cut + 1));
        }
      }
      const mapped = [line.module, line.classic, line.style]
        .flatMap((form) => Object.values(form?.entries ?? {}))
        .concat(
          Object.values(line.paths ?? {}),
          Object.values(line.globals ?? {}).map((spec) => spec.file),
          Object.values(line.commonjs ?? {}).map((spec) => spec.file),
          line.include,
        );
      const missing = mapped.find((path) => !listed.has(path));
      if (missing) {
        throw new Error(
          `[page-libraries] ${line.source.package}@${line.source.version} has no ${missing}`,
        );
      }
      const files: PageLibraryInstall['files'] = {};
      for (const path of written) {
        const full = join(staging, path);
        files[path] = { sha256: await sha256File(full), bytes: (await stat(full)).size };
      }
      const install: PageLibraryInstall = {
        format: 'gezel-page-library@1',
        line,
        files,
        installedAt: new Date().toISOString(),
      };
      await writeFile(join(staging, PAGE_LIBRARY_MARKER), `${JSON.stringify(install, null, 2)}\n`);
      await mkdir(join(root, line.library), { recursive: true });
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      this.invalidate();
      return { line, files, dir, removable: true };
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
}
