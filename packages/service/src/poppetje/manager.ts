import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type GezelGender,
  type Poppetje,
  PoppetjeSchema,
  createLogger,
  initialPoppetjeForGezel,
  poppetjeFromSeed,
} from '@bendyline/gezel';
import { type ExternalFolders, gezelPoppetjePath } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';

const log = createLogger('poppetje');

export interface PoppetjeManagerOptions {
  home: string;
  external?: ExternalFolders;
  history?: import('../history/manager.js').HistoryManager;
}

/**
 * Owns `~/.gezel/gezels/{id}/poppetje.json`. Pure JSON read/write — the
 * renderer lives in the UI package.
 *
 * `get` self-heals: if the file is missing, generates an initial poppetje
 * deterministically from the gezel id and persists it. Same gezel id will
 * always produce the same first-poppetje, useful for tests and migrations.
 *
 * After that initial state, `reroll` draws a fresh integer seed (or honors
 * an explicit one for tests). The `key` field stays pinned to the gezel id
 * either way — that's what locks the wood-grain noise seed, so the
 * character's grain pattern stays stable even across rerolls.
 *
 * This file is a deliberate carve-out from the Store's atomic-write
 * contract (see CLAUDE.md Store conventions list): it's owned end-to-end
 * by this manager so the schema can evolve independently of gezel.md.
 */
export class PoppetjeManager {
  private readonly home: string;
  private readonly external?: ExternalFolders;
  private readonly history?: import('../history/manager.js').HistoryManager;

  constructor(opts: PoppetjeManagerOptions) {
    this.home = opts.home;
    this.external = opts.external;
    this.history = opts.history;
  }

  /**
   * Read the gezel's poppetje. If the file is missing or unparseable,
   * regenerate it deterministically from the gezel id and persist it.
   * `gender` (when known from the gezel's frontmatter) gates beard /
   * mustache for female gezels during auto-generation.
   * Returns the resolved struct.
   */
  async get(gezelId: string, displayName: string, gender?: GezelGender): Promise<Poppetje> {
    const existing = await this.tryRead(gezelId);
    if (existing) {
      if (existing.name !== displayName) {
        const updated: Poppetje = { ...existing, name: displayName };
        await this.writeFile(gezelId, updated);
        return updated;
      }
      return existing;
    }
    const fresh = initialPoppetjeForGezel(gezelId, displayName, gender);
    await this.writeFile(gezelId, fresh);
    await this.history?.log({
      kind: 'poppetje.generated',
      gezelId,
      summary: `Generated initial poppetje for ${displayName}`,
      details: { source: 'auto' },
    });
    return fresh;
  }

  /** Read without auto-generation. Returns `null` when the file is missing. */
  async tryRead(gezelId: string): Promise<Poppetje | null> {
    const path = gezelPoppetjePath(this.home, gezelId, this.external);
    try {
      const raw = await readFile(path, 'utf8');
      const json = JSON.parse(raw);
      return PoppetjeSchema.parse(json);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        log.warn(
          `[poppetje] read failed for ${gezelId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return null;
    }
  }

  /**
   * Persist an explicit poppetje, validating against the schema. Used by
   * the PUT route and by future per-slot pickers.
   */
  async set(gezelId: string, displayName: string, poppetje: Poppetje): Promise<Poppetje> {
    const validated = PoppetjeSchema.parse({ ...poppetje, key: gezelId });
    await this.writeFile(gezelId, validated);
    await this.history?.log({
      kind: 'poppetje.updated',
      gezelId,
      summary: `Updated ${displayName}'s appearance`,
    });
    return validated;
  }

  /**
   * Draw a fresh integer seed (or honor an explicit one), regenerate the
   * struct, persist, and return. The `key` field stays pinned to the
   * gezel id — that's the wood-grain stability anchor. `gender` (when
   * known) gates beard / mustache for female gezels.
   */
  async reroll(
    gezelId: string,
    displayName: string,
    opts: { seed?: number; gender?: GezelGender } = {},
  ): Promise<Poppetje> {
    const seed = opts.seed ?? this.randomSeed();
    const fresh = poppetjeFromSeed(seed, {
      key: gezelId,
      name: displayName,
      gender: opts.gender,
    });
    await this.writeFile(gezelId, fresh);
    await this.history?.log({
      kind: 'poppetje.rerolled',
      gezelId,
      summary: `Rerolled ${displayName}'s appearance`,
      details: { seed, explicit: opts.seed !== undefined },
    });
    return fresh;
  }

  /** Remove the file (used when a gezel is deleted). Best-effort. */
  async remove(gezelId: string): Promise<void> {
    const path = gezelPoppetjePath(this.home, gezelId, this.external);
    try {
      await unlink(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        log.warn(
          `[poppetje] remove failed for ${gezelId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /** Move the file when a gezel's id changes (rename). Best-effort. */
  async rename(oldId: string, newId: string, displayName: string): Promise<void> {
    const existing = await this.tryRead(oldId);
    if (!existing) return;
    // Repin the wood-grain key to the new id — otherwise the grain
    // pattern would re-anchor on the next get() anyway and the rename
    // would produce a half-stale file.
    const repinned: Poppetje = { ...existing, key: newId, name: displayName };
    await this.writeFile(newId, repinned);
    await this.remove(oldId);
  }

  private async writeFile(gezelId: string, poppetje: Poppetje): Promise<void> {
    const path = gezelPoppetjePath(this.home, gezelId, this.external);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(poppetje, null, 2)}\n`);
  }

  private randomSeed(): number {
    return Math.floor(Math.random() * 0x7fffffff);
  }

  /** Surface a test-only check that the file is present on disk. */
  async exists(gezelId: string): Promise<boolean> {
    const path = gezelPoppetjePath(this.home, gezelId, this.external);
    try {
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  }
}
