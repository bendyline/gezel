import { PortableTransactionSchema } from '../schemas/portable-store.js';
import {
  type PortableFileSystem,
  boundedText,
  parentPath,
  readText,
  validatePortablePath,
} from './files.js';

const PENDING = '.transactions/pending.json';
function destination(path: string): void {
  validatePortablePath(path);
  if (path === '.transactions' || path.startsWith('.transactions/'))
    throw new Error('Invalid transaction destination');
}

/** A published journal is the durable commit point; reads wait for idempotent replay. */
export class PortableTransactions {
  constructor(
    private readonly files: PortableFileSystem,
    private readonly createId: () => string,
  ) {}

  async recover(): Promise<void> {
    const raw = await readText(this.files, PENDING);
    if (raw === null) return;
    const journal = PortableTransactionSchema.parse(JSON.parse(raw));
    const staging = `.transactions/${journal.id}`;
    for (const path of [
      ...journal.removes,
      ...journal.clears,
      ...journal.directories,
      ...journal.writes.map((item) => item.path),
    ])
      destination(path);
    for (const [index, item] of journal.writes.entries()) {
      if (item.staged !== `${staging}/${index}`) throw new Error('Invalid staged transaction path');
      if ((await this.files.read(item.staged)) === null)
        throw new Error('A committed transaction is missing staged data');
    }
    for (const path of journal.clears) await this.files.remove(path);
    for (const path of journal.directories) await this.files.mkdir(path);
    for (const item of journal.writes) {
      await this.files.mkdir(parentPath(item.path));
      await this.files.write(item.path, (await this.files.read(item.staged))!);
    }
    for (const path of journal.removes) await this.files.remove(path);
    await this.files.remove(PENDING);
    await this.files.remove(staging).catch(() => {});
  }

  async commit(
    writes: ReadonlyMap<string, Uint8Array>,
    removes: string[] = [],
    directories: string[] = [],
    clears: string[] = [],
  ): Promise<void> {
    const id = this.createId();
    const staging = `.transactions/${id}`;
    if (staging === PENDING) throw new Error('Invalid transaction identifier');
    const journal = PortableTransactionSchema.parse({
      version: 1,
      id,
      writes: [...writes.keys()].map((path, index) => ({
        path: validatePortablePath(path),
        staged: `${staging}/${index}`,
      })),
      removes: removes.map((path) => validatePortablePath(path)),
      clears: clears.map((path) => validatePortablePath(path)),
      directories: directories.map((path) => validatePortablePath(path)),
    });
    for (const path of [...removes, ...clears, ...directories, ...writes.keys()]) destination(path);
    // Reject deterministic file/directory conflicts before publishing. Otherwise
    // an invalid write would leave a committed journal that could never replay.
    for (const [path, directory] of [
      ...directories.map((path) => [path, true] as const),
      ...[...writes.keys()].map((path) => [path, false] as const),
    ]) {
      const parts = path.split('/');
      let parent = '';
      for (let i = 0; i < parts.length; i++) {
        const candidate = parent ? `${parent}/${parts[i]}` : parts[i]!;
        if (clears.some((root) => candidate === root || candidate.startsWith(`${root}/`))) break;
        const entry = (await this.files.list(parent)).find((item) => item.name === parts[i]);
        if (!entry) break;
        const expectedDirectory = i < parts.length - 1 || directory;
        if (entry.isDirectory !== expectedDirectory)
          throw new Error('A file or folder blocks this destination');
        parent = parent ? `${parent}/${parts[i]}` : parts[i]!;
      }
    }
    const journalBytes = boundedText(JSON.stringify(journal));
    await this.files.mkdir(staging);
    let published = false;
    try {
      for (const item of journal.writes)
        await this.files.write(item.staged, writes.get(item.path)!);
      await this.files.write(PENDING, journalBytes);
      published = true;
      await this.recover();
    } finally {
      if (!published) await this.files.remove(staging).catch(() => {});
    }
  }
}
