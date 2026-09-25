import { type FSWatcher, watch } from 'node:fs';
import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { WorkspaceIndexManager } from './index-manager.js';

/**
 * Filesystem watcher for the hottest workspaces. The polling tick keeps every
 * project eventually-fresh (60s for the active project, up to 30min for cold
 * ones); this closes the gap for the MRU-top few by turning an on-disk change
 * into a near-immediate `WorkspaceIndexManager.refresh` — which is lock-safe,
 * idempotent, and hash-gated, so over-triggering costs almost nothing.
 *
 * Where `fs.watch({recursive})` is unsupported, the first failed watch flips
 * a `supported` latch and the platform silently stays on polling. No
 * chokidar — one less native-adjacent dependency.
 */

const log = createLogger('workspace-watch');

const RECONCILE_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 2_000;
const MAX_WATCHED = 3;

// Mirrors the indexer's SKIP_DIRS: churn inside these never re-triggers a
// scan. `.gezel` matters most — the index itself writes there.
const IGNORE =
  /(^|[/\\])(\.git|node_modules|\.gezel|dist|build|out|coverage|\.next|\.cache|\.turbo|__pycache__|\.venv|venv)([/\\]|$)/;

export interface WorkspaceWatchManagerOptions {
  store: Store;
  indexManager: Pick<WorkspaceIndexManager, 'refresh'>;
  /** Rebuild project MCP bridges when an approved project config changes. */
  onProjectMcpConfigChanged?: (projectId: string) => void | Promise<void>;
  maxWatched?: number;
  debounceMs?: number;
  reconcileIntervalMs?: number;
  /**
   * Projects watched regardless of recency, ahead of the MRU slots. The
   * shared document library is pinned here: it is edited from outside the
   * app more than any workspace — a sync client writing a file another
   * device changed — and it has no tab activity to earn an MRU slot.
   */
  pinnedProjects?: () => string[];
  watchImpl?: typeof watch;
}

/**
 * True when the host has no inotify watch left to give. Node's recursive
 * watcher on Linux swallows ENOSPC — no throw, no 'error' event, just a
 * watcher that never fires — while a plain watch of the root reports it.
 * One app holding the whole per-user budget (fs.inotify.max_user_watches)
 * is enough, and a terminal or editor watching a large tree does.
 */
export function watchLimitReached(dir: string, watchImpl: typeof watch = watch): boolean {
  try {
    watchImpl(dir, { persistent: false }).close();
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOSPC';
  }
}

export class WorkspaceWatchManager {
  private readonly store: Store;
  private readonly indexManager: Pick<WorkspaceIndexManager, 'refresh'>;
  private readonly onProjectMcpConfigChanged?: (projectId: string) => void | Promise<void>;
  private readonly maxWatched: number;
  private readonly debounceMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly pinnedProjects: () => string[];
  private readonly watchImpl: typeof watch;

  private readonly watchers = new Map<string, { dir: string; watcher: FSWatcher }>();
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly mcpDebounces = new Map<string, ReturnType<typeof setTimeout>>();
  /** Projects already warned about a spent watch budget; reconcile retries every tick. */
  private readonly starved = new Set<string>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private supported = true;
  private stopped = false;

  constructor(opts: WorkspaceWatchManagerOptions) {
    this.store = opts.store;
    this.indexManager = opts.indexManager;
    this.onProjectMcpConfigChanged = opts.onProjectMcpConfigChanged;
    this.maxWatched = opts.maxWatched ?? MAX_WATCHED;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    this.pinnedProjects = opts.pinnedProjects ?? (() => []);
    this.watchImpl = opts.watchImpl ?? watch;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.reconcile().catch((err) => log.warn(`reconcile failed: ${describe(err)}`));
    }, 5_000);
    unref(this.startupTimer);
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err) => log.warn(`reconcile failed: ${describe(err)}`));
    }, this.reconcileIntervalMs);
    unref(this.reconcileTimer);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.startupTimer = null;
    this.reconcileTimer = null;
    for (const timer of this.debounces.values()) clearTimeout(timer);
    this.debounces.clear();
    for (const timer of this.mcpDebounces.values()) clearTimeout(timer);
    this.mcpDebounces.clear();
    for (const [projectId] of this.watchers) this.dropWatcher(projectId);
  }

  /** Currently-watched project ids, for tests + status. */
  watched(): string[] {
    return [...this.watchers.keys()];
  }

  /** Exposed for tests: align watchers with the MRU-top projects. */
  async reconcile(): Promise<void> {
    if (this.stopped || !this.supported) return;
    const cfg = await this.store.readConfig().catch(() => null);
    const mru = (cfg?.recentTabs ?? []).filter((t) => t.kind === 'project').map((t) => t.id);
    // Pins take their slots first; the MRU fills what is left, so pinning
    // never silently costs the user a watcher on the project they are in.
    const pinned = this.pinnedProjects();
    const wanted = [...new Set([...pinned, ...mru])].slice(0, this.maxWatched + pinned.length);

    for (const [projectId, entry] of [...this.watchers]) {
      const stillWanted = wanted.includes(projectId);
      const dir = stillWanted
        ? await this.store.projectWorkspaceDir(projectId).catch(() => null)
        : null;
      if (!stillWanted || dir !== entry.dir) this.dropWatcher(projectId);
    }

    for (const projectId of wanted) {
      if (this.watchers.has(projectId)) continue;
      const dir = await this.store.projectWorkspaceDir(projectId).catch(() => null);
      if (!dir) continue;
      if (watchLimitReached(dir, this.watchImpl)) {
        if (!this.starved.has(projectId)) {
          this.starved.add(projectId);
          log.warn(
            `cannot watch ${projectId}: the host's inotify watch limit is spent (fs.inotify.max_user_watches) — outside changes wait for the polling tick`,
          );
        }
        continue;
      }
      this.starved.delete(projectId);
      try {
        const watcher = this.watchImpl(
          dir,
          { recursive: true, persistent: false },
          (_event, filename) => this.onEvent(projectId, filename),
        );
        watcher.on('error', (err) => {
          log.warn(`watcher for ${projectId} errored: ${describe(err)}`);
          this.dropWatcher(projectId);
        });
        this.watchers.set(projectId, { dir, watcher });
        log.info(`watching ${projectId} (${dir})`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
          this.supported = false;
          log.info('recursive fs.watch unsupported on this platform; staying on polling');
          return;
        }
        log.warn(`failed to watch ${projectId}: ${describe(err)}`);
      }
    }
  }

  private onEvent(projectId: string, filename: string | Buffer | null): void {
    if (this.stopped) return;
    const rel = typeof filename === 'string' ? filename : filename?.toString();
    const normalizedRel = rel?.replaceAll('\\', '/');
    const isMcpConfig =
      normalizedRel === '.gezel/mcp.json' ||
      normalizedRel === '.vscode/mcp.json' ||
      normalizedRel === '.mcp.json';
    if (isMcpConfig) {
      const existing = this.mcpDebounces.get(projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.mcpDebounces.delete(projectId);
        void Promise.resolve(this.onProjectMcpConfigChanged?.(projectId)).catch((err) =>
          log.warn(`MCP config refresh for ${projectId} failed: ${describe(err)}`),
        );
      }, this.debounceMs);
      unref(timer);
      this.mcpDebounces.set(projectId, timer);
      return;
    }
    if (rel && IGNORE.test(rel)) return;
    const existing = this.debounces.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounces.delete(projectId);
      void this.indexManager
        .refresh(projectId)
        .catch((err) => log.warn(`refresh for ${projectId} failed: ${describe(err)}`));
    }, this.debounceMs);
    unref(timer);
    this.debounces.set(projectId, timer);
  }

  private dropWatcher(projectId: string): void {
    const entry = this.watchers.get(projectId);
    if (!entry) return;
    this.watchers.delete(projectId);
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
  }
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
