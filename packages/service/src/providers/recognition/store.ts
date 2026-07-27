import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ImageRecognition, ImageRecognitionSchema, createLogger } from '@bendyline/gezel';

const log = createLogger('recognition');

/**
 * Content-addressed cache for recognition results, at
 * `~/.gezel/recognition/<aa>/<sha256>.json`.
 *
 * Follows the handboek narration precedent: hash-keyed derived files owned by
 * the feature that writes them, rebuildable, safe to delete. Registered as a
 * carve-out in CLAUDE.md rather than routed through `Store`, which is for
 * user-facing state.
 *
 * Home-scoped rather than project-scoped so the same screenshot pasted into
 * two projects is described once — and deliberately not the index-store, whose
 * `summaries` table only exists if the project happens to have been indexed.
 * Making a synchronous chat turn depend on that is a latent flake.
 *
 * **Invalidation is total and implicit.** The key mixes the image bytes, the
 * mode, the model id, and a prompt version, so different bytes, a different
 * mode, an upgraded model, or a tuned prompt all land on a different key.
 * There is nothing to invalidate imperatively.
 */

/** Bump when a mode's prompt changes enough to invalidate stored output. */
const PROMPT_VERSION = 1;

export interface RecognitionCacheOptions {
  home: string;
}

export class RecognitionCache {
  private readonly root: string;

  constructor(opts: RecognitionCacheOptions) {
    this.root = join(opts.home, 'recognition');
  }

  keyFor(input: { bytes: Buffer; mode: string; modelId: string }): string {
    const imageHash = createHash('sha256').update(input.bytes).digest('hex');
    return createHash('sha256')
      .update(`${imageHash}\0${input.mode}\0${input.modelId}\0v${PROMPT_VERSION}`)
      .digest('hex');
  }

  private pathFor(key: string): string {
    return join(this.root, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<ImageRecognition | null> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      return ImageRecognitionSchema.parse(JSON.parse(raw));
    } catch (err) {
      // A miss is the common case; a malformed entry is a stale schema and
      // should be treated as a miss rather than failing the turn.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.debug(`cache read failed for ${key.slice(0, 8)}: ${String(err)}`);
      }
      return null;
    }
  }

  async put(key: string, value: ImageRecognition): Promise<void> {
    const dest = this.pathFor(key);
    try {
      await mkdir(join(this.root, key.slice(0, 2)), { recursive: true });
      const tmp = `${dest}.partial`;
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rm(dest, { force: true });
      await rename(tmp, dest);
    } catch (err) {
      // The cache is an optimization. A full disk must not fail the turn.
      log.warn(`cache write failed for ${key.slice(0, 8)}: ${String(err)}`);
    }
  }

  /** Drop everything. Exposed for Settings ("clear cached descriptions"). */
  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
