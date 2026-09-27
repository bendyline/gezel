import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A content pack is one file standing in for a directory tree of small
 * catalog files.
 *
 * It exists because of file count, not bytes. The community MCP-registry tier
 * of `@bendyline/gilde` is ~30k tiny manifests, and every file is a separate
 * tar extraction — plus, on Windows, a Defender scan — wherever the service
 * bundle is unpacked per account: the v1.26270.76 first launch spent 4m47s on
 * 52,311 files, 29,710 of them this tier. Packed, the tier is one file.
 *
 * Layout (version 1):
 *
 *   line 1   JSON header {"format":"gezel-content-pack","version":1,"files":[[path,size],…]}
 *   the rest every file's bytes, concatenated in header order
 *
 * Paths are `/`-separated, relative to the packed directory, and sorted by
 * UTF-16 code unit, so packing a tree is byte-for-byte deterministic. Content
 * is carried verbatim — a reader sees exactly the bytes the directory held,
 * which is what lets `BundledSource` read either form interchangeably.
 */

export const CONTENT_PACK_FILENAME = 'content.pack';

const FORMAT = 'gezel-content-pack';
const FORMAT_VERSION = 1;
const HEADER_CHUNK_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const WRITE_BATCH_BYTES = 4 * 1024 * 1024;
/** Source files read concurrently: per-file latency, not bandwidth, dominates. */
const READ_CONCURRENCY = 64;
const PACK_CHANGED = 'EGEZELPACKCHANGED';

export interface ContentPackStats {
  files: number;
  bytes: number;
}

type HeaderEntry = [path: string, size: number];

function fsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function corrupt(path: string, reason: string): Error {
  return new Error(`[content-pack] ${path} is not a valid content pack: ${reason}`);
}

/** True when a pack read failed because the file was replaced after indexing. */
export function isContentPackChanged(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === PACK_CHANGED;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isValidPackPath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Every regular file under `dir`, as sorted `/`-joined relative paths. A
 * symlink or other special entry has no representation in a pack, so it
 * refuses the whole pack rather than silently dropping content.
 */
async function listTreeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        if (!isValidPackPath(childRel)) {
          throw new Error(`[content-pack] cannot pack ${childRel}: unrepresentable path`);
        }
        out.push(childRel);
      } else {
        throw new Error(`[content-pack] cannot pack ${childRel}: not a regular file`);
      }
    }
  }
  await walk(dir, '');
  return out.sort(compareCodeUnits);
}

function sourcePath(dir: string, rel: string): string {
  return join(dir, ...rel.split('/'));
}

/** `map` in bounded concurrent chunks, results in input order. */
async function mapInChunks<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + READ_CONCURRENCY).map(map))));
  }
  return out;
}

async function writeFully(handle: FileHandle, chunks: Buffer[]): Promise<void> {
  if (chunks.length === 0) return;
  const data = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    offset += bytesWritten;
  }
}

/**
 * Pack every file under `sourceDir` into a new file at `packPath` (which must
 * not exist and must not sit inside `sourceDir`). Deterministic: the same tree
 * always produces the same bytes.
 */
export async function writeContentPack(
  sourceDir: string,
  packPath: string,
): Promise<ContentPackStats> {
  const paths = await listTreeFiles(sourceDir);
  const sizes = await mapInChunks(
    paths,
    async (path) => (await stat(sourcePath(sourceDir, path))).size,
  );
  const files: HeaderEntry[] = paths.map((path, i) => [path, sizes[i]!]);
  const header = `${JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, files })}\n`;
  const handle = await open(packPath, 'wx');
  let bytes = 0;
  try {
    let batch: Buffer[] = [Buffer.from(header, 'utf8')];
    let batchBytes = batch[0]!.length;
    for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
      const chunk = files.slice(i, i + READ_CONCURRENCY);
      const contents = await Promise.all(
        chunk.map(([path]) => readFile(sourcePath(sourceDir, path))),
      );
      for (let j = 0; j < chunk.length; j++) {
        const [path, size] = chunk[j]!;
        const data = contents[j]!;
        if (data.length !== size) {
          throw new Error(`[content-pack] ${path} changed while it was being packed`);
        }
        batch.push(data);
        batchBytes += data.length;
        bytes += data.length;
      }
      if (batchBytes >= WRITE_BATCH_BYTES) {
        await writeFully(handle, batch);
        batch = [];
        batchBytes = 0;
      }
    }
    await writeFully(handle, batch);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(packPath, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();
  return { files: files.length, bytes };
}

async function readHeaderLine(
  handle: FileHandle,
  path: string,
  fileSize: number,
): Promise<{ header: string; dataStart: number }> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < fileSize && position < MAX_HEADER_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(HEADER_CHUNK_BYTES, fileSize - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (newline !== -1) {
      chunks.push(chunk.subarray(0, newline));
      const dataStart = position + newline + 1;
      return { header: Buffer.concat(chunks).toString('utf8'), dataStart };
    }
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  throw corrupt(path, 'no header line');
}

function parseHeader(raw: string, path: string): HeaderEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(path, 'header is not JSON');
  }
  const header = parsed as { format?: unknown; version?: unknown; files?: unknown };
  if (header.format !== FORMAT) throw corrupt(path, 'unknown format');
  if (header.version !== FORMAT_VERSION) {
    throw corrupt(path, `unsupported version ${String(header.version)}`);
  }
  if (!Array.isArray(header.files)) throw corrupt(path, 'header has no file list');
  const files: HeaderEntry[] = [];
  let previous: string | null = null;
  for (const entry of header.files as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw corrupt(path, 'malformed file entry');
    const [file, size] = entry as [unknown, unknown];
    if (typeof file !== 'string' || !isValidPackPath(file)) {
      throw corrupt(path, `invalid path ${JSON.stringify(file)}`);
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw corrupt(path, `invalid size for ${file}`);
    }
    // Strict ascending order is the canonical form and rules out duplicates.
    if (previous !== null && compareCodeUnits(previous, file) >= 0) {
      throw corrupt(path, `file list is not sorted at ${file}`);
    }
    previous = file;
    files.push([file, size]);
  }
  return files;
}

interface PackEntry {
  offset: number;
  size: number;
}

/**
 * Read-only view of a content pack. Opening parses only the header; file
 * reads open the pack, read the one range, and close it again, so a reader
 * never pins the file (live gilde versions are pruned while the daemon runs).
 */
export class ContentPack {
  private readonly entries = new Map<string, PackEntry>();
  private readonly dirs = new Map<string, string[]>();
  private readonly ordered: string[];

  private constructor(
    readonly path: string,
    private readonly identity: { size: number; mtimeMs: number },
    private readonly dataStart: number,
    files: HeaderEntry[],
  ) {
    this.ordered = files.map(([file]) => file);
    let offset = 0;
    for (const [file, size] of files) {
      this.entries.set(file, { offset, size });
      offset += size;
    }
    const children = new Map<string, Set<string>>([['', new Set()]]);
    for (const file of this.ordered) {
      const parts = file.split('/');
      for (let depth = 0; depth < parts.length; depth++) {
        const parent = parts.slice(0, depth).join('/');
        let set = children.get(parent);
        if (!set) {
          set = new Set();
          children.set(parent, set);
        }
        set.add(parts[depth]!);
      }
    }
    for (const [dir, names] of children) {
      if (this.entries.has(dir)) throw corrupt(path, `${dir} is both a file and a folder`);
      this.dirs.set(dir, [...names].sort(compareCodeUnits));
    }
  }

  static async open(path: string): Promise<ContentPack> {
    const handle = await open(path, 'r');
    try {
      const st = await handle.stat();
      const { header, dataStart } = await readHeaderLine(handle, path, st.size);
      const files = parseHeader(header, path);
      const dataBytes = files.reduce((total, [, size]) => total + size, 0);
      if (dataStart + dataBytes !== st.size) {
        throw corrupt(path, `expected ${dataStart + dataBytes} bytes, found ${st.size}`);
      }
      return new ContentPack(path, { size: st.size, mtimeMs: st.mtimeMs }, dataStart, files);
    } finally {
      await handle.close();
    }
  }

  /** Every packed file, sorted. */
  files(): string[] {
    return [...this.ordered];
  }

  /** Names directly inside `dir` (`''` is the root), like `fs.readdir`. */
  readdir(dir: string): string[] {
    const names = this.dirs.get(dir);
    if (names) return [...names];
    throw this.missing(dir, 'ENOTDIR');
  }

  /** Every file under `dir`, relative to it, sorted. */
  listFiles(dir: string): string[] {
    if (!this.dirs.has(dir)) throw this.missing(dir, 'ENOTDIR');
    if (dir === '') return this.files();
    const prefix = `${dir}/`;
    const out: string[] = [];
    // Sorted paths sharing a prefix are contiguous: find the first, then walk.
    let lo = 0;
    let hi = this.ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareCodeUnits(this.ordered[mid]!, prefix) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.ordered.length; i++) {
      const file = this.ordered[i]!;
      if (!file.startsWith(prefix)) break;
      out.push(file.slice(prefix.length));
    }
    return out;
  }

  async readFile(file: string): Promise<Buffer> {
    const entry = this.entries.get(file);
    if (!entry) throw this.missing(file, 'EISDIR');
    const handle = await open(this.path, 'r');
    try {
      await this.assertUnchanged(handle);
      return await this.readRange(handle, file, entry);
    } finally {
      await handle.close();
    }
  }

  /** Visit every file in order through one handle. */
  async forEachFile(visit: (file: string, data: Buffer) => Promise<void> | void): Promise<void> {
    const handle = await open(this.path, 'r');
    try {
      await this.assertUnchanged(handle);
      for (const file of this.ordered) {
        await visit(file, await this.readRange(handle, file, this.entries.get(file)!));
      }
    } finally {
      await handle.close();
    }
  }

  private missing(path: string, codeWhenOtherKind: string): NodeJS.ErrnoException {
    const exists = this.entries.has(path) || this.dirs.has(path);
    return fsError(exists ? codeWhenOtherKind : 'ENOENT', `${this.path}#${path}`);
  }

  private async assertUnchanged(handle: FileHandle): Promise<void> {
    const st = await handle.stat();
    if (st.size !== this.identity.size || st.mtimeMs !== this.identity.mtimeMs) {
      throw fsError(PACK_CHANGED, `${this.path} was replaced after it was indexed`);
    }
  }

  private async readRange(handle: FileHandle, file: string, entry: PackEntry): Promise<Buffer> {
    const out = Buffer.allocUnsafe(entry.size);
    let read = 0;
    while (read < entry.size) {
      const { bytesRead } = await handle.read(
        out,
        read,
        entry.size - read,
        this.dataStart + entry.offset + read,
      );
      if (bytesRead === 0) throw corrupt(this.path, `${file} is truncated`);
      read += bytesRead;
    }
    return out;
  }
}

/**
 * Prove a pack holds exactly the files under `sourceDir`, byte for byte:
 * the same path list and identical content for every path.
 */
export async function verifyContentPack(
  packPath: string,
  sourceDir: string,
): Promise<ContentPackStats> {
  const pack = await ContentPack.open(packPath);
  const expected = await listTreeFiles(sourceDir);
  const actual = pack.files();
  const firstDifference = expected.findIndex((file, i) => file !== actual[i]);
  if (expected.length !== actual.length || firstDifference !== -1) {
    const at = firstDifference === -1 ? Math.min(expected.length, actual.length) : firstDifference;
    throw new Error(
      `[content-pack] ${packPath} lists ${actual.length} files but ${sourceDir} holds ${expected.length} (first difference: ${expected[at] ?? '(none)'} vs ${actual[at] ?? '(none)'})`,
    );
  }
  let bytes = 0;
  let pending: Array<[string, Buffer]> = [];
  const compare = async () => {
    const batch = pending;
    pending = [];
    await Promise.all(
      batch.map(async ([file, data]) => {
        const original = await readFile(sourcePath(sourceDir, file));
        if (!original.equals(data)) {
          throw new Error(`[content-pack] ${file} in ${packPath} differs from its source`);
        }
        bytes += data.length;
      }),
    );
  };
  await pack.forEachFile(async (file, data) => {
    pending.push([file, data]);
    if (pending.length >= READ_CONCURRENCY) await compare();
  });
  await compare();
  return { files: actual.length, bytes };
}

/**
 * Replace the loose tree in `dir` with a single verified `content.pack`.
 *
 * The pack is written beside `dir`, verified against the tree, and renamed
 * in before any loose file is removed. A reader treats a root holding a pack
 * as packed and ignores loose files, so an interruption at any point leaves
 * either the untouched tree or a complete pack — never a partial catalog.
 */
export async function collapseToContentPack(
  dir: string,
): Promise<ContentPackStats & { packPath: string }> {
  const packPath = join(dir, CONTENT_PACK_FILENAME);
  if (
    await stat(packPath).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(`[content-pack] ${dir} is already packed`);
  }
  const originals = await readdir(dir);
  const staging = `${dir}.${CONTENT_PACK_FILENAME}.tmp-${process.pid}-${Date.now()}`;
  try {
    const written = await writeContentPack(dir, staging);
    const verified = await verifyContentPack(staging, dir);
    if (verified.files !== written.files || verified.bytes !== written.bytes) {
      throw new Error(`[content-pack] ${staging} verification disagrees with what was written`);
    }
    await rename(staging, packPath);
    for (const name of originals) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
    return { ...written, packPath };
  } catch (err) {
    await rm(staging, { force: true }).catch(() => {});
    throw err;
  }
}
