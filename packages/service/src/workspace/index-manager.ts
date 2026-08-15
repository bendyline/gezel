import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CommandShape,
  type DiscoveredCommand,
  type DiscoveredInstruction,
  type DiscoveredSkill,
  type WorkspaceCommandIndex,
  type WorkspaceIndexMeta,
  type WorkspaceIndexStatus,
  type WorkspaceInstructionIndex,
  type WorkspaceSkillIndex,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { projectIndexDir } from '@bendyline/gezel/paths';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import { resolveProjectBoekwachter } from '../gezels/autonomous-roles.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { detectAndPersistProjectType } from '../project-type/detect.js';
import {
  type EnsureProjectLeadResult,
  type ImportSyncDeps,
  ensureProjectVoorman,
  syncProjectImports,
} from './import-sync.js';
import {
  type TokenIndex,
  type WorkspaceFile,
  buildTokenIndex,
  discoverBinCommands,
  discoverFiles,
  discoverNpmScripts,
  discoverVscodeLaunchConfigs,
  discoverWorkspaceScripts,
  workspaceLooksReal,
} from './indexer.js';
import { discoverInstructionFiles } from './instruction-scanner.js';
import { discoverWorkspaceSkills } from './skill-scanner.js';

/**
 * Per-project workspace indexer. Runs the discovery scanners against a
 * project's resolved workspace dir, persists three JSON files under
 * `~/.gezel/projects/{id}/_index/`, and exposes a status surface the
 * UI polls.
 *
 * Mounted alongside MemoryHealthMonitor in `service.ts` — same shape:
 * startup-deferred first pass + periodic timer + `.unref()` so it
 * never holds the process open.
 *
 * Cadence + MRU prioritization: each tick (every 60s by default) picks
 * the highest-priority stale project from `config.recentTabs` and
 * indexes exactly one. Active project is stale at 60s; positions 2–5
 * at 5min; the rest at 30min. Skips projects with an in-flight gezel
 * turn so the indexer never competes for cycles with chat.
 */

const log = createLogger('index');

// Bumped whenever command discovery semantics change. Version 4 refreshes
// package-script commands so pnpm workspaces no longer keep stale
// `npm run …` launch rows from older indexes.
const INDEX_VERSION = 4;

const STARTUP_DELAY_MS = 8_000;
const TICK_INTERVAL_MS = 60_000;

const STALE_ACTIVE_MS = 60_000;
const STALE_RECENT_MS = 5 * 60_000;
const STALE_COLD_MS = 30 * 60_000;

const COMMANDS_FILE = 'commands.json';
const FILES_FILE = 'files.json';
const TOKENS_FILE = 'tokens.json';
const SHAPES_FILE = 'shapes.json';
const SKILLS_FILE = 'skills.json';
const INSTRUCTIONS_FILE = 'instructions.json';
const META_FILE = 'index.meta.json';

interface ProjectIndexState {
  meta?: WorkspaceIndexMeta;
  indexing: boolean;
  /** Set when this scan was kicked off; cleared on completion. */
  inflight?: Promise<void>;
}

export interface WorkspaceIndexManagerOptions {
  home: string;
  store: Store;
  chat: ChatManager;
  /** Used to recruit a real voorman from the `voorman` template. */
  catalog: CatalogService;
  /** Content index (code/doc intelligence); refreshed each scan. Optional so
   *  tests can construct the manager without it. */
  contentIndex?: ContentIndex;
  /** Chat event bus for `index_progress` heartbeats (optional in tests). */
  events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  /** Override the tick cadence (tests). */
  intervalMs?: number;
  /** Override the startup delay (tests). */
  startupDelayMs?: number;
}

export class WorkspaceIndexManager {
  private readonly home: string;
  private readonly store: Store;
  private readonly chat: ChatManager;
  private readonly catalog: CatalogService;
  private readonly contentIndex: ContentIndex | undefined;
  private readonly events: Pick<ChatEventBus, 'publishGlobalEvent'> | undefined;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly state = new Map<string, ProjectIndexState>();
  /** Per-project promise chain so two concurrent scans on the same
   *  project serialize rather than racing on the disk. */
  private readonly locks = new Map<string, Promise<unknown>>();

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WorkspaceIndexManagerOptions) {
    this.home = opts.home;
    this.store = opts.store;
    this.chat = opts.chat;
    this.catalog = opts.catalog;
    this.contentIndex = opts.contentIndex;
    this.events = opts.events;
    this.intervalMs = opts.intervalMs ?? TICK_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick().catch((err) => {
        log.warn(`[index] startup tick failed: ${describe(err)}`);
      });
    }, this.startupDelayMs);
    unref(this.startupTimer);

    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => {
        log.warn(`[index] tick failed: ${describe(err)}`);
      });
    }, this.intervalMs);
    unref(this.tickTimer);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Return the current status for a project. Reads in-memory state
   * first (cheap), falls through to `index.meta.json` on disk if
   * we haven't seen the project yet this process. Never throws.
   */
  async status(projectId: string): Promise<WorkspaceIndexStatus> {
    if (!(await this.isIndexingEnabled(projectId))) {
      return { state: 'disabled' };
    }
    const inMem = this.state.get(projectId);
    if (inMem?.indexing) {
      return {
        state: 'indexing',
        ...(inMem.meta ? { meta: inMem.meta } : {}),
      };
    }
    const meta = inMem?.meta ?? (await this.readMetaFromDisk(projectId));
    if (!meta) return { state: 'never' };
    if (!inMem) this.state.set(projectId, { meta, indexing: false });
    const stale = await this.isStale(projectId, meta);
    return { state: stale ? 'stale' : 'fresh', meta };
  }

  /**
   * Status for the UI pill: {@link status} plus the AI-scan (content
   * enrichment) flag. Kept separate from `status()` — which the hot tick
   * loop calls for every candidate project — because resolving
   * `aiScanPending` opens the per-project content sqlite, a cost only the
   * foreground poll should pay. Never throws.
   */
  async statusForUi(projectId: string): Promise<WorkspaceIndexStatus> {
    const base = await this.status(projectId);
    // The AI-scan flag only colours the pill once the structural index is
    // fresh: a missing/stale index already reads as "out of date" and
    // `indexing` has its own state, so skip the sqlite open in those cases.
    if (base.state !== 'fresh' || !this.contentIndex) return base;
    const enrichment = await this.contentIndex.enrichmentCounts(projectId).catch(() => null);
    if (!enrichment) return base;
    // Review coverage rides along but deliberately does NOT colour
    // aiScanPending — the amber pill means "search not ready", and the review
    // tier lags summaries by design.
    const reviews = await this.contentIndex.reviewCounts(projectId).catch(() => null);
    return {
      ...base,
      aiScanPending: enrichment.pending > 0,
      enrichment: { ...enrichment, ...(reviews ? { reviews } : {}) },
    };
  }

  /**
   * Read the persisted `commands.json` + `index.meta.json`. Returns
   * null when no index exists on disk for this project. The UI gates
   * a 404 on null.
   */
  async readCommandIndex(projectId: string): Promise<WorkspaceCommandIndex | null> {
    if (!(await this.isIndexingEnabled(projectId))) return null;
    const dir = projectIndexDir(this.home, projectId);
    try {
      const [metaRaw, commandsRaw] = await Promise.all([
        readFile(join(dir, META_FILE), 'utf8'),
        readFile(join(dir, COMMANDS_FILE), 'utf8'),
      ]);
      const meta = JSON.parse(metaRaw) as WorkspaceIndexMeta;
      const commands = JSON.parse(commandsRaw) as DiscoveredCommand[];
      // Shapes are stored in a sibling file so consumers that only
      // want the command list can skip the larger payload. Absent on
      // projects with no shape-bearing commands.
      let shapes: Record<string, CommandShape> | undefined;
      try {
        const raw = await readFile(join(dir, SHAPES_FILE), 'utf8');
        const parsed = JSON.parse(raw) as { shapes?: Record<string, CommandShape> };
        if (parsed?.shapes && typeof parsed.shapes === 'object') {
          shapes = parsed.shapes;
        }
      } catch {
        /* no shapes file — common case for non-Node workspaces */
      }
      return shapes ? { meta, commands, shapes } : { meta, commands };
    } catch {
      return null;
    }
  }

  /**
   * Read the persisted `files.json` — the workspace file listing the indexer
   * already wrote. Returns an empty list when no index exists yet (the project
   * hasn't been scanned). Used by the cross-project search catalog to match
   * file paths without re-walking the tree.
   */
  async readFiles(projectId: string): Promise<WorkspaceFile[]> {
    if (!(await this.isIndexingEnabled(projectId))) return [];
    const dir = projectIndexDir(this.home, projectId);
    try {
      const raw = await readFile(join(dir, FILES_FILE), 'utf8');
      const parsed = JSON.parse(raw) as WorkspaceFile[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Workspace paths matching a typed prefix, for the terminal's path
   * autocomplete. The index stores files only, so directories are derived:
   * each match collapses to its next path segment after the prefix — a
   * directory (trailing `/`, so the user can descend) or the full file path.
   * Reads the cached file list (capped at 20,000 files by the indexer).
   * Case-insensitive prefix; deduped; capped.
   */
  async searchWorkspaceFiles(projectId: string, prefix: string, limit = 50): Promise<string[]> {
    const files = await this.readFiles(projectId);
    const lower = prefix.toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of files) {
      if (lower !== '' && !f.path.toLowerCase().startsWith(lower)) continue;
      const nextSlash = f.path.indexOf('/', prefix.length);
      const candidate = nextSlash >= 0 ? f.path.slice(0, nextSlash + 1) : f.path;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Force a re-scan for one project. Returns immediately if a scan is
   * already in flight (callers see `indexing` in subsequent status
   * polls). Used by:
   *   - the manual "Refresh" button in the status bar
   *   - on-mount of the Commands panel when status is `never`
   */
  async refresh(projectId: string): Promise<WorkspaceIndexStatus> {
    const current = await this.status(projectId);
    if (current.state === 'disabled') return current;
    void this.indexOne(projectId).catch((err) => {
      log.warn(`[index] forced refresh failed for ${projectId}: ${describe(err)}`);
    });
    // Don't wait for the index to finish — the caller polls status.
    return this.status(projectId);
  }

  /**
   * Like {@link refresh}, but awaits the whole scan (structural pass + the
   * content-index refresh it drives). For callers that sequence work on a
   * CURRENT index — the on-demand enrichment drive and the night-shift
   * catch-up must not summarize/review against yesterday's file list.
   */
  async refreshAndWait(projectId: string): Promise<WorkspaceIndexStatus> {
    const current = await this.status(projectId);
    if (current.state === 'disabled') return current;
    await this.indexOne(projectId).catch((err) => {
      log.warn(`[index] awaited refresh failed for ${projectId}: ${describe(err)}`);
    });
    return this.status(projectId);
  }

  /**
   * Periodic tick: pick the highest-priority stale project and index
   * exactly one. One project per tick keeps the loop bounded; with a
   * 60s cadence we cover an MRU of 5 in 5 minutes.
   */
  private async tick(): Promise<void> {
    const config = await this.store.readConfig().catch(() => null);
    const projects = await this.store.listProjects().catch(() => []);
    if (projects.length === 0) return;

    // Build an MRU-ordered list of project ids: anything in
    // recentTabs first (in stored order), then any remaining
    // projects appended at the end.
    const recent: string[] = [];
    const recentSet = new Set<string>();
    for (const entry of config?.recentTabs ?? []) {
      if (entry.kind !== 'project') continue;
      if (recentSet.has(entry.id)) continue;
      recentSet.add(entry.id);
      recent.push(entry.id);
    }
    const ordered: string[] = [...recent];
    for (const p of projects) {
      if (!recentSet.has(p.id)) ordered.push(p.id);
    }

    for (let i = 0; i < ordered.length; i++) {
      const projectId = ordered[i]!;
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project?.indexingEnabled === false) continue;
      if (this.chat.isProjectActive(projectId)) continue;
      const status = await this.status(projectId);
      if (status.state === 'fresh' || status.state === 'indexing') continue;
      const threshold = thresholdFor(i);
      if (status.state === 'stale' && status.meta) {
        const ageMs = Date.now() - Date.parse(status.meta.scannedAt);
        if (Number.isFinite(ageMs) && ageMs < threshold) continue;
      }
      await this.indexOne(projectId).catch((err) => {
        log.warn(`[index] index failed for ${projectId}: ${describe(err)}`);
      });
      return; // One project per tick.
    }
  }

  /**
   * Run the discoverers + file walk + token build for one project and
   * persist atomically. Serializes against concurrent calls for the
   * same project via the per-project lock.
   */
  private indexOne(projectId: string): Promise<void> {
    return this.withLock(projectId, async () => {
      if (!(await this.isIndexingEnabled(projectId))) return;
      const state = this.getState(projectId);
      if (state.indexing) {
        // Another in-flight; wait for it instead of double-scanning.
        if (state.inflight) await state.inflight.catch(() => {});
        return;
      }
      state.indexing = true;
      const promise = this.runScan(projectId)
        .catch((err) => {
          log.warn(`[index] scan crashed for ${projectId}: ${describe(err)}`);
        })
        .finally(() => {
          state.indexing = false;
          state.inflight = undefined;
        });
      state.inflight = promise;
      await promise;
    });
  }

  private async runScan(projectId: string): Promise<void> {
    // Re-check at the work boundary so a project disabled while waiting on
    // the per-project lock does not begin a scan.
    if (!(await this.isIndexingEnabled(projectId))) return;
    const workspaceDir = await this.store.projectWorkspaceDir(projectId);
    if (!(await workspaceLooksReal(workspaceDir))) return;
    const boekwachter = await resolveProjectBoekwachter(this.store, projectId).catch(() => null);
    this.events?.publishGlobalEvent({
      type: 'index_progress',
      phase: 'scan',
      state: 'started',
      projectId,
      ...(boekwachter ? { gezelId: boekwachter.id, gezelName: boekwachter.name } : {}),
    });
    const started = Date.now();
    const [npmScripts, workspaceScripts, vscodeConfigs, binResult, files, skills, instructions] =
      await Promise.all([
        discoverNpmScripts(workspaceDir),
        discoverWorkspaceScripts(workspaceDir),
        discoverVscodeLaunchConfigs(workspaceDir),
        discoverBinCommands(workspaceDir),
        discoverFiles(workspaceDir),
        discoverWorkspaceSkills(workspaceDir),
        discoverInstructionFiles(workspaceDir),
      ]);
    const commands: DiscoveredCommand[] = [
      ...npmScripts,
      ...workspaceScripts,
      ...vscodeConfigs,
      ...binResult.commands,
    ];
    const shapes: Record<string, CommandShape> = { ...binResult.shapes };
    const tokens = buildTokenIndex(files);
    const durationMs = Date.now() - started;
    const shapeCount = Object.keys(shapes).length;
    const meta: WorkspaceIndexMeta = {
      version: INDEX_VERSION,
      scannedAt: nowIso(),
      root: workspaceDir,
      durationMs,
      fileCount: files.length,
      commandCount: commands.length,
      ...(shapeCount > 0 ? { shapeCount } : {}),
    };
    await this.writeAtomic(projectId, meta, commands, files, tokens, shapes, skills, instructions);
    this.getState(projectId).meta = meta;
    const shapesPart = shapeCount > 0 ? ` (${shapeCount} shapes)` : '';
    const skillsPart = skills.length > 0 ? `, ${skills.length} skills` : '';
    log.info(
      `[index] scanned ${projectId}: ${commands.length} commands${shapesPart}${skillsPart}, ${files.length} files in ${durationMs}ms`,
    );
    this.events?.publishGlobalEvent({
      type: 'index_progress',
      phase: 'scan',
      state: 'ended',
      projectId,
      detail: `${files.length} files in ${Math.round(durationMs / 100) / 10}s`,
      ...(boekwachter ? { gezelId: boekwachter.id, gezelName: boekwachter.name } : {}),
    });

    const importDeps: ImportSyncDeps = {
      store: this.store,
      chat: this.chat,
      home: this.home,
      catalog: this.catalog,
    };

    // Mirror AGENTS.md/CLAUDE.md into the project About + import skill
    // craftbooks. Internally hash-gated + provenance-tracked, so this is
    // cheap on unchanged scans and only translates changed skills. Runs
    // AFTER the parallel discovery (it may make an LLM call) and never
    // breaks the scan.
    if (instructions.length > 0 || skills.length > 0) {
      try {
        await syncProjectImports(importDeps, projectId, instructions, skills);
      } catch (err) {
        log.warn(`[index] import-sync failed for ${projectId}: ${describe(err)}`);
      }
    }

    // Refresh the content index (code/doc intelligence — symbols + outlines).
    // Best-effort and self-contained: it opens its own sqlite store, gates on
    // content hashes (cheap on unchanged scans), and never breaks the scan.
    if (this.contentIndex) {
      try {
        const stats = await this.contentIndex.refresh(projectId);
        if (stats && (stats.changed > 0 || stats.removed > 0)) {
          log.info(
            `[index] content: ${stats.changed} changed, ${stats.symbols} symbols, ${stats.removed} removed (${projectId})`,
          );
        }
      } catch (err) {
        log.warn(`[index] content-index refresh failed for ${projectId}: ${describe(err)}`);
      }
    }

    // Classify the project's output type from its file mix + about/mission
    // text, and persist the top result. Drives the curated craftbook shortlist
    // in the rail and the gezel-role affinity lists. Never overwrites the
    // user's explicit `projectTypeId` override; best-effort, never breaks the
    // scan. Runs outside the `contentIndex` gate above because detection falls
    // back to a bounded folder scan when no index profile exists.
    await detectAndPersistProjectType(
      { store: this.store, contentIndex: this.contentIndex },
      projectId,
    );

    // Make sure the project has a voorman — promote a project-member gezel,
    // reuse an existing voorman, or recruit a real one from the `voorman`
    // template. Runs unconditionally and store-side only, so it's independent
    // of the instruction/skills gate above and of workspace writability.
    // One-time per project (guarded by `voormanAutoAssignedAt`), so this is a
    // cheap no-op once one is set.
    const ensured = await ensureProjectVoorman(importDeps, projectId).catch((err) => {
      log.warn(`[index] ensure-voorman failed for ${projectId}: ${describe(err)}`);
      return {} as EnsureProjectLeadResult;
    });
    if (ensured.createdGezel) {
      this.events?.publishGlobalEvent({
        type: 'gezel_created',
        gezelId: ensured.createdGezel.id,
        name: ensured.createdGezel.name,
      });
    }
  }

  /**
   * Read the discovered-skill index for a project. Returns an empty
   * list when no skills were found or the index file is missing.
   */
  async readSkills(projectId: string): Promise<WorkspaceSkillIndex> {
    if (!(await this.isIndexingEnabled(projectId))) return { skills: [] };
    const dir = projectIndexDir(this.home, projectId);
    try {
      const raw = await readFile(join(dir, SKILLS_FILE), 'utf8');
      const parsed = JSON.parse(raw) as DiscoveredSkill[];
      return { skills: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { skills: [] };
    }
  }

  /**
   * Read the discovered workspace-root instruction files (AGENTS.md etc.).
   * Returns an empty list when none were found or the index is missing.
   */
  async readInstructions(projectId: string): Promise<WorkspaceInstructionIndex> {
    if (!(await this.isIndexingEnabled(projectId))) return { instructions: [] };
    const dir = projectIndexDir(this.home, projectId);
    try {
      const raw = await readFile(join(dir, INSTRUCTIONS_FILE), 'utf8');
      const parsed = JSON.parse(raw) as DiscoveredInstruction[];
      return { instructions: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { instructions: [] };
    }
  }

  private async writeAtomic(
    projectId: string,
    meta: WorkspaceIndexMeta,
    commands: DiscoveredCommand[],
    files: WorkspaceFile[],
    tokens: TokenIndex,
    shapes: Record<string, CommandShape>,
    skills: DiscoveredSkill[],
    instructions: DiscoveredInstruction[],
  ): Promise<void> {
    const dir = projectIndexDir(this.home, projectId);
    await mkdir(dir, { recursive: true });
    const writes: Array<Promise<void>> = [
      writeJsonAtomic(join(dir, COMMANDS_FILE), commands),
      writeJsonAtomic(join(dir, FILES_FILE), files),
      writeJsonAtomic(join(dir, TOKENS_FILE), tokens),
      writeJsonAtomic(join(dir, META_FILE), meta),
    ];
    // Skip the shapes file entirely on projects where no command
    // yielded a shape — avoids littering empty `{}` files across
    // every non-Node project on disk.
    if (Object.keys(shapes).length > 0) {
      writes.push(writeJsonAtomic(join(dir, SHAPES_FILE), { shapes }));
    }
    if (skills.length > 0) {
      writes.push(writeJsonAtomic(join(dir, SKILLS_FILE), skills));
    }
    if (instructions.length > 0) {
      writes.push(writeJsonAtomic(join(dir, INSTRUCTIONS_FILE), instructions));
    }
    await Promise.all(writes);
  }

  private async readMetaFromDisk(projectId: string): Promise<WorkspaceIndexMeta | undefined> {
    const dir = projectIndexDir(this.home, projectId);
    try {
      const raw = await readFile(join(dir, META_FILE), 'utf8');
      const parsed = JSON.parse(raw) as WorkspaceIndexMeta;
      if (parsed.version !== INDEX_VERSION) return undefined; // schema bumped
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async isStale(projectId: string, meta: WorkspaceIndexMeta): Promise<boolean> {
    const ageMs = Date.now() - Date.parse(meta.scannedAt);
    if (!Number.isFinite(ageMs)) return true;
    // Apply the same MRU threshold the tick loop uses. Treat unknown
    // positions as cold (30-min threshold).
    const idx = await this.mruIndex(projectId);
    return ageMs >= thresholdFor(idx);
  }

  private async mruIndex(projectId: string): Promise<number> {
    const cfg = await this.store.readConfig().catch(() => null);
    if (!cfg?.recentTabs) return Number.POSITIVE_INFINITY;
    const projectTabs = cfg.recentTabs.filter((t) => t.kind === 'project');
    const i = projectTabs.findIndex((t) => t.id === projectId);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  }

  /**
   * Missing preserves the historical indexed-by-default behavior. Reads the
   * live project each time so toggling the setting takes effect without a
   * service restart and hides any stale derived index immediately.
   */
  private async isIndexingEnabled(projectId: string): Promise<boolean> {
    return this.store.projectIndexingEnabled(projectId).catch(() => true);
  }

  private getState(projectId: string): ProjectIndexState {
    let s = this.state.get(projectId);
    if (!s) {
      s = { indexing: false };
      this.state.set(projectId, s);
    }
    return s;
  }

  private async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId);
    const next = (prev ?? Promise.resolve()).then(fn, fn);
    this.locks.set(
      projectId,
      next.finally(() => {
        if (this.locks.get(projectId) === next) this.locks.delete(projectId);
      }),
    );
    return next;
  }
}

function thresholdFor(mruIndex: number): number {
  if (mruIndex === 0) return STALE_ACTIVE_MS;
  if (mruIndex < 5) return STALE_RECENT_MS;
  return STALE_COLD_MS;
}

async function writeJsonAtomic(absPath: string, value: unknown): Promise<void> {
  // Delegates to the shared `writeFileAtomic`. Was a local copy with
  // `pid + Date.now()` for the tmp suffix; the shared version uses
  // `pid + UUID` which is collision-safe across rapid concurrent writes
  // (Date.now() can repeat within the same millisecond and was the
  // source of intermittent rename-target-exists errors here).
  await writeFileAtomic(absPath, JSON.stringify(value));
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
