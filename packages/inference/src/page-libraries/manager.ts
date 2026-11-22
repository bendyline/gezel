import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { fetchPinnedNpmTarball } from '@bendyline/gezel-catalog';
import type { PageLibraryLine } from '@bendyline/gezel/pages';
import type { InstalledPageLibrary, PageLibraryStore } from './store.js';

const log = createLogger('page-libraries');

/**
 * Why a download may not run now. `build`: a store build ships a fixed set.
 * `network`: the security level turns off app network, which only an
 * automatic download needs. `setting`: the person turned automatic downloads
 * off.
 */
export type PageLibraryDownloadBlock = 'build' | 'network' | 'setting';

export interface PageLibraryEnsureResult {
  /** Lines that were already on the shelf or arrived during the call. */
  ready: string[];
  /** Lines that arrived during the call. */
  installed: string[];
  /** Lines still downloading when the wait ended. */
  pending: string[];
  failed: Array<{ line: string; error: string }>;
  /** Lines that could not be fetched, and why. */
  blocked?: PageLibraryDownloadBlock;
}

export type PageLibraryEvent =
  | { type: 'started'; line: string }
  | { type: 'installed'; line: string }
  | { type: 'failed'; line: string; error: string }
  | { type: 'removed'; line: string };

export interface PageLibraryManagerOptions {
  store: PageLibraryStore;
  /** Every line the catalog offers. */
  catalogLines: () => Promise<PageLibraryLine[]>;
  /** Why downloads are refused now, for a download the person asked for or one a page needs. */
  blockReason: (trigger: 'person' | 'automatic') => Promise<PageLibraryDownloadBlock | null>;
  /** Tests point this at a registry of their own. */
  registry?: string;
}

export function pageLibraryKey(line: Pick<PageLibraryLine, 'library' | 'version'>): string {
  return `${line.library}@${line.version}`;
}

/**
 * Downloads page libraries into the shelf: one at a time per line, joined by
 * anyone who asks while it runs. A download fetches the npm tarball the line
 * pins, refuses it unless it hashes to the pin, and installs only the files
 * the line lists (`PageLibraryStore.install`). Never started by serving a
 * page: only by a person in Settings, or by a request that needs a library
 * (a page check, the preview asking what its page needs).
 */
export class PageLibraryManager {
  readonly store: PageLibraryStore;
  private readonly opts: PageLibraryManagerOptions;
  private readonly inFlight = new Map<string, Promise<InstalledPageLibrary>>();
  private readonly recentFailures = new Map<string, { error: string; at: number }>();
  private readonly listeners = new Set<(event: PageLibraryEvent) => void>();

  constructor(opts: PageLibraryManagerOptions) {
    this.opts = opts;
    this.store = opts.store;
  }

  subscribe(listener: (event: PageLibraryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: PageLibraryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  /** Lines downloading now. */
  downloading(): string[] {
    return [...this.inFlight.keys()];
  }

  /** The last failure for a line, if it failed in the last hour. */
  lastFailure(key: string): string | undefined {
    const failure = this.recentFailures.get(key);
    return failure && Date.now() - failure.at < 60 * 60 * 1000 ? failure.error : undefined;
  }

  /**
   * Every line a page may use here: what is on the shelf, then what the
   * catalog offers that is not, when downloads would be allowed.
   */
  async usableLines(trigger: 'person' | 'automatic' = 'automatic'): Promise<PageLibraryLine[]> {
    const installed = await this.store.lines();
    if (await this.opts.blockReason(trigger)) return installed;
    const have = new Set(installed.map(pageLibraryKey));
    const offered = await this.opts.catalogLines().catch(() => []);
    return [...installed, ...offered.filter((line) => !have.has(pageLibraryKey(line)))];
  }

  /** Download one line. Joins a download of the same line already running. */
  install(line: PageLibraryLine): Promise<InstalledPageLibrary> {
    const key = pageLibraryKey(line);
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.download(line).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async download(line: PageLibraryLine): Promise<InstalledPageLibrary> {
    const key = pageLibraryKey(line);
    this.emit({ type: 'started', line: key });
    const scratch = await mkdtemp(join(tmpdir(), 'gezel-page-library-'));
    try {
      const tarballPath = join(scratch, 'package.tgz');
      await fetchPinnedNpmTarball({
        packageName: line.source.package,
        version: line.source.version,
        dest: tarballPath,
        ...(this.opts.registry ? { registry: this.opts.registry } : {}),
      });
      const installed = await this.store.install({ line, tarballPath });
      this.recentFailures.delete(key);
      log.info(`[page-libraries] installed ${key}`);
      this.emit({ type: 'installed', line: key });
      return installed;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.recentFailures.set(key, { error, at: Date.now() });
      log.warn(`[page-libraries] ${key} did not install: ${error}`);
      this.emit({ type: 'failed', line: key, error });
      throw err;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Make sure the lines a page needs are on the shelf, downloading what is
   * missing when allowed, and wait for them up to `waitMs`. A download that
   * outlives the wait keeps going; the next request finds it in place.
   */
  async ensure(
    lines: readonly PageLibraryLine[],
    opts: { waitMs: number; trigger?: 'person' | 'automatic' },
  ): Promise<PageLibraryEnsureResult> {
    const trigger = opts.trigger ?? 'automatic';
    const have = new Set((await this.store.lines()).map(pageLibraryKey));
    const result: PageLibraryEnsureResult = { ready: [], installed: [], pending: [], failed: [] };
    const missing: PageLibraryLine[] = [];
    for (const line of lines) {
      const key = pageLibraryKey(line);
      if (have.has(key)) result.ready.push(key);
      else missing.push(line);
    }
    if (!missing.length) return result;
    const blocked = await this.opts.blockReason(trigger);
    if (blocked) {
      result.blocked = blocked;
      return result;
    }
    const outcomes = new Map<string, 'installed' | { error: string }>();
    const work = missing.map((line) => {
      const key = pageLibraryKey(line);
      return this.install(line).then(
        () => outcomes.set(key, 'installed'),
        (err: unknown) =>
          outcomes.set(key, { error: err instanceof Error ? err.message : String(err) }),
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(work),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, opts.waitMs));
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const line of missing) {
      const key = pageLibraryKey(line);
      const outcome = outcomes.get(key);
      if (outcome === 'installed') {
        result.installed.push(key);
        result.ready.push(key);
      } else if (outcome) {
        result.failed.push({ line: key, error: outcome.error });
      } else {
        result.pending.push(key);
      }
    }
    return result;
  }

  /** Remove a downloaded line. Lines that shipped with the app cannot be removed. */
  async remove(library: string, version: string): Promise<boolean> {
    const removed = await this.store.remove(library, version);
    if (removed) this.emit({ type: 'removed', line: `${library}@${version}` });
    return removed;
  }
}
