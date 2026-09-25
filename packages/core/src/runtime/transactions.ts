import { createLogger } from '../log.js';
import { PortableTransactionSchema } from '../schemas/portable-store.js';
import {
  type PortableFileSystem,
  boundedText,
  parentPath,
  readText,
  validatePortablePath,
} from './files.js';

const PENDING = '.transactions/pending.json';
const log = createLogger('portable-store');
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

  /**
   * Set aside a journal that cannot be completed.
   *
   * Recovery runs before every store operation, so a journal that always
   * throws makes the product permanently unopenable — the one outcome worse
   * than losing the writes it described. Those writes were never durable
   * anyway: the commit point was reached but the staged bytes are not on the
   * device. The journal is kept under a new name as evidence rather than
   * applied in part, because partial application is exactly what it exists to
   * prevent.
   */
  private async quarantine(reason: unknown): Promise<void> {
    log.warn('a pending transaction cannot be recovered; setting it aside', reason);
    await this.files
      .rename(PENDING, `.transactions/unrecoverable-${Date.now()}.json`)
      .catch(async () => {
        // If it cannot be renamed it must still stop blocking every read.
        await this.files.remove(PENDING).catch(() => {});
      });
  }

  async recover(): Promise<void> {
    const raw = await readText(this.files, PENDING);
    if (raw === null) return;
    let journal: ReturnType<typeof PortableTransactionSchema.parse>;
    let staging: string;
    try {
      journal = PortableTransactionSchema.parse(JSON.parse(raw));
      staging = `.transactions/${journal.id}`;
      for (const path of [
        ...journal.removes,
        ...journal.clears,
        ...journal.directories,
        ...journal.writes.map((item) => item.path),
      ])
        destination(path);
      for (const [index, item] of journal.writes.entries()) {
        if (item.staged !== `${staging}/${index}`)
          throw new Error('Invalid staged transaction path');
        if ((await this.files.read(item.staged)) === null)
          throw new Error('A committed transaction is missing staged data');
      }
    } catch (error) {
      await this.quarantine(error);
      return;
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
