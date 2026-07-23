import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CITY_FILE_SCHEMA_VERSION,
  type CityFile,
  CityFileSchema,
  createLogger,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';

/**
 * The impure half of the city file (`.gezel/city.json`): path resolution,
 * schema-validated reads with quarantine-on-corrupt, and a deliberately
 * cautious write policy — this file lands inside the user's repo, so:
 *
 * - it is only ever CREATED by a user-facing build (the user opened the map);
 *   background indexer ticks only update an already-existing file;
 * - writes are skipped when the serialized content is byte-identical to what
 *   was last read/written, so a no-change tick never touches the repo;
 * - serialization is deterministic (sorted anchors/overrides/journal, rounded
 *   journal rects) so git diffs stay minimal and meaningful;
 * - a file written by a NEWER gezel (higher schemaVersion) is honored
 *   read-only and never clobbered.
 *
 * Reads prefer the workspace file and fall back to the home-local path; a
 * write that fails with EACCES/EROFS on the workspace falls back the same way
 * (mirroring the content index's read-only-repo fallback). A per-store
 * promise chain serializes read-modify-write against the refresh-tick /
 * HTTP-build race; writes themselves are atomic.
 */

const log = createLogger('filemap:city');

/** Same ×10 rounding as `streetId`, so street ids survive a journal round-trip. */
const r1 = (n: number): number => Math.round(n * 10) / 10;

export interface CityFileStoreOptions {
  /** The project's workspace dir, or null when there is none. */
  workspaceDir: string | null;
  /** Home-local fallback path (`~/.gezel/projects/{id}/city.json`). */
  fallbackPath: string;
  /** Workspace-relative primary path builder (injected to avoid a paths dep). */
  primaryPath: string | null;
}

/** Canonical ordering + rounding — the deterministic-serialization half. */
export function canonicalizeCityFile(city: CityFile): CityFile {
  const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ...city,
    overrides: [...city.overrides].sort((a, b) => byString(a.path, b.path)),
    domains: Object.fromEntries(
      Object.keys(city.domains)
        .sort(byString)
        .map((domain) => {
          const d = city.domains[domain]!;
          return [
            domain,
            {
              ...d,
              anchors: [...d.anchors].sort((a, b) => byString(a.path, b.path)),
              journal: [...d.journal]
                .map((n) => ({ ...n, r: n.r.map(r1) as [number, number, number, number] }))
                .sort((a, b) => byString(a.k, b.k) || byString(a.id, b.id)),
            },
          ];
        }),
    ),
  };
}

export function serializeCityFile(city: CityFile): string {
  return `${JSON.stringify(canonicalizeCityFile(city), null, 2)}\n`;
}

export class CityFileStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** Raw content of the file as last read or written, per path. */
  private lastRaw = new Map<string, string>();
  /** Where an existing file was found (writes target it). */
  private activePath: string | null = null;
  /** Set when the on-disk file claims a newer schema than we understand. */
  private readOnly = false;

  constructor(private readonly opts: CityFileStoreOptions) {}

  private candidatePaths(): string[] {
    const out: string[] = [];
    if (this.opts.primaryPath) out.push(this.opts.primaryPath);
    out.push(this.opts.fallbackPath);
    return out;
  }

  /** Serialize an async operation onto the store's queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async read(): Promise<CityFile> {
    return this.enqueue(() => this.readUnlocked());
  }

  private async readUnlocked(): Promise<CityFile> {
    for (const path of this.candidatePaths()) {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      try {
        const parsed = CityFileSchema.parse(JSON.parse(raw));
        if (parsed.schemaVersion > CITY_FILE_SCHEMA_VERSION) {
          // A newer gezel owns this file — honor what we can, never write.
          this.readOnly = true;
          log.warn(
            `city file at ${path} has schemaVersion ${parsed.schemaVersion} > ${CITY_FILE_SCHEMA_VERSION}; treating as read-only`,
          );
        }
        this.activePath = path;
        this.lastRaw.set(path, raw);
        return parsed;
      } catch (err) {
        log.warn(
          `corrupt city file at ${path} — quarantining: ${err instanceof Error ? err.message : String(err)}`,
        );
        await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
      }
    }
    this.activePath = null;
    return CityFileSchema.parse({});
  }

  /**
   * Read-modify-write under the store's queue. `mutate` returns the new
   * state; the write is skipped when nothing changed, when no file exists
   * and the build isn't user-facing, or when the file is newer-schema
   * read-only. Returns the resulting state either way.
   */
  async update(
    options: { userFacing: boolean },
    mutate: (city: CityFile) => CityFile,
  ): Promise<CityFile> {
    return this.enqueue(async () => {
      const current = await this.readUnlocked();
      const next = mutate(current);
      if (this.readOnly) return next;

      const target = this.activePath ?? this.opts.primaryPath ?? this.opts.fallbackPath;
      const exists = this.activePath !== null;
      if (!exists && !options.userFacing) return next;

      const serialized = serializeCityFile(next);
      if (this.lastRaw.get(target) === serialized) return next;

      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFileAtomic(target, serialized);
        this.activePath = target;
        this.lastRaw.set(target, serialized);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const canFallBack =
          target !== this.opts.fallbackPath &&
          (code === 'EACCES' || code === 'EROFS' || code === 'EPERM');
        if (!canFallBack) throw err;
        await mkdir(dirname(this.opts.fallbackPath), { recursive: true });
        await writeFileAtomic(this.opts.fallbackPath, serialized);
        this.activePath = this.opts.fallbackPath;
        this.lastRaw.set(this.opts.fallbackPath, serialized);
      }
      return next;
    });
  }
}
