import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CONTENT_PACK_FILENAME, ContentPack, isContentPackChanged } from './content-pack.js';

/**
 * How `BundledSource` reads a content root: straight from the directory, or —
 * when the root holds a `content.pack` — from that one file. Both honor the
 * `fs` error contract the source relies on (`ENOENT`/`ENOTDIR` mean absent;
 * anything else is a real failure).
 *
 * A packed root is read exclusively through its pack and loose files beside
 * it are ignored. That is what makes collapsing a directory in place safe: the
 * pack is renamed in before the loose tree is removed.
 */
export interface ContentTree {
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  /** Every file under `dir`, `/`-separated and relative to it, unsorted. */
  listFiles(dir: string): Promise<string[]>;
}

const DISK_TREE: ContentTree = {
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path),
  async listFiles(dir) {
    const entries = (await readdir(dir, { recursive: true, withFileTypes: true })) as Array<{
      parentPath?: string;
      path?: string;
      name: string;
      isFile(): boolean;
    }>;
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      // Node's Dirent under `recursive` carries the containing dir in
      // `parentPath` (Node 20.12+) or the older `path`; join + relativize.
      const parent = e.parentPath ?? e.path ?? dir;
      const abs = join(parent, e.name);
      const rel = abs.startsWith(dir) ? abs.slice(dir.length).replace(/^[/\\]+/, '') : e.name;
      out.push(rel.split('\\').join('/'));
    }
    return out;
  },
};

function absent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

class PackedContentTree implements ContentTree {
  private pack: Promise<ContentPack> | null = null;

  constructor(
    private readonly root: string,
    private readonly packPath: string,
  ) {}

  readFile(path: string): Promise<Buffer> {
    return this.withPack((pack) => pack.readFile(this.toPackPath(path)));
  }

  readdir(path: string): Promise<string[]> {
    return this.withPack(async (pack) => pack.readdir(this.toPackPath(path)));
  }

  listFiles(dir: string): Promise<string[]> {
    return this.withPack(async (pack) => pack.listFiles(this.toPackPath(dir)));
  }

  private toPackPath(path: string): string {
    const rel = relative(this.root, path);
    if (rel === '') return '';
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw absent(path);
    return rel.split(sep).join('/');
  }

  private async withPack<T>(read: (pack: ContentPack) => Promise<T>): Promise<T> {
    try {
      return await read(await this.load());
    } catch (err) {
      if (!isContentPackChanged(err)) throw err;
      this.pack = null;
      return read(await this.load());
    }
  }

  private load(): Promise<ContentPack> {
    if (!this.pack) {
      const opening = ContentPack.open(this.packPath);
      this.pack = opening;
      // A failed open (transient fd exhaustion, a pack mid-replacement) must
      // not poison the tree: the next read tries again.
      opening.catch(() => {
        if (this.pack === opening) this.pack = null;
      });
    }
    return this.pack;
  }
}

/** The reader for `root`. Never rejects: a root without a pack reads from disk. */
export async function openContentTree(root: string): Promise<ContentTree> {
  const packPath = join(root, CONTENT_PACK_FILENAME);
  const packed = await stat(packPath).then(
    (st) => st.isFile(),
    () => false,
  );
  return packed ? new PackedContentTree(root, packPath) : DISK_TREE;
}
