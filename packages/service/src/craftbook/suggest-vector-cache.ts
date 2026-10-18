import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';

const log = createLogger('craftbook');

/**
 * The suggester's candidate vectors, kept on disk so a restarted daemon ranks
 * by meaning without re-embedding the catalog: ~300 craftbook and project-type
 * texts took ~5 s of CPU on the first suggest after every start (2026-10-17).
 *
 * Keyed by a hash of the embedded text, so a new book version or a live gilde
 * update simply misses, and stamped with the embedder profile, so a model swap
 * discards the file. A rebuildable cache under `index/`, safe to delete.
 */

const FILE_VERSION = 1;
const SAVE_DELAY_MS = 2_000;
/** Past this, only the texts this process ranked are written back. */
const MAX_ENTRIES = 4_000;

interface CacheFile {
  version: number;
  profile: string;
  /** Text hash → base64 of the vector's float32 bytes. */
  vectors: Record<string, string>;
}

export interface SuggestVectorCacheOptions {
  /** Absent: in memory only. */
  file?: string;
  /** The embedder identity the vectors belong to (`embedProfileId`). */
  profile: () => string;
  saveDelayMs?: number;
}

export class SuggestVectorCache {
  private readonly entries = new Map<string, number[]>();
  private readonly touched = new Set<string>();
  private loading: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SuggestVectorCacheOptions) {}

  /** Read the file once; later calls resolve immediately. */
  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  get(text: string): number[] | undefined {
    const key = textKey(text);
    const vector = this.entries.get(key);
    if (vector) this.touched.add(key);
    return vector;
  }

  set(text: string, vector: number[]): void {
    const key = textKey(text);
    this.entries.set(key, vector);
    this.touched.add(key);
    this.scheduleSave();
  }

  clear(): void {
    this.entries.clear();
    this.touched.clear();
  }

  /** Write any pending change now. For tests and shutdown. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.save());
    }
    await this.saving;
  }

  private async load(): Promise<void> {
    const file = this.opts.file;
    if (!file) return;
    let parsed: CacheFile;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8')) as CacheFile;
    } catch {
      return;
    }
    if (parsed?.version !== FILE_VERSION || parsed.profile !== this.opts.profile()) return;
    for (const [key, encoded] of Object.entries(parsed.vectors ?? {})) {
      if (this.entries.has(key) || typeof encoded !== 'string') continue;
      const vector = decodeVector(encoded);
      if (vector.length > 0) this.entries.set(key, vector);
    }
  }

  private scheduleSave(): void {
    if (!this.opts.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.save());
    }, this.opts.saveDelayMs ?? SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    const file = this.opts.file;
    if (!file) return;
    const keys = this.entries.size > MAX_ENTRIES ? [...this.touched] : [...this.entries.keys()];
    const vectors: Record<string, string> = {};
    for (const key of keys) {
      const vector = this.entries.get(key);
      if (vector) vectors[key] = encodeVector(vector);
    }
    const body: CacheFile = { version: FILE_VERSION, profile: this.opts.profile(), vectors };
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, JSON.stringify(body));
    } catch (err) {
      log.debug(
        '[craftbook] could not save suggest vectors:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function textKey(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function encodeVector(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength % 4 !== 0) return [];
  // A pooled Buffer may sit at an offset Float32Array cannot view; copy it out.
  return Array.from(new Float32Array(new Uint8Array(bytes).buffer));
}
