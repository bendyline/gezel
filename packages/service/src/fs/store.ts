import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type ChatModelTuning,
  type ChatSession,
  ChatSessionSchema,
  type ChatSessionSummary,
  type Craftbook,
  CraftbookSchema,
  CraftbookStepSchema,
  type CraftbookSummary,
  type GezelConfig,
  GezelConfigSchema,
  type GezelDetail,
  type GezelFrontmatter,
  type GezelGender,
  type GezelGrowthState,
  GezelGrowthStateSchema,
  type GezelSummary,
  type GezelTrait,
  type ImportProvenance,
  ImportProvenanceSchema,
  type InstalledPackage,
  type InstalledToolset,
  type MeesterStatusReport,
  MeesterStatusReportSchema,
  type MeesterStatusState,
  MeesterStatusStateSchema,
  PROJECT_GEZEL_LOCAL_ID,
  type PendingImports,
  PendingImportsSchema,
  type Project,
  type ProjectActivity,
  ProjectActivitySchema,
  type ProjectCraftbookProvenance,
  ProjectCraftbookProvenanceSchema,
  type ProjectDetail,
  type ProjectFileEntry,
  type ProjectGitHub,
  type ProjectLocalConfig,
  ProjectLocalConfigSchema,
  type ProjectMail,
  type ProjectNudgeConfig,
  ProjectSchema,
  type ProjectTabVisibility,
  type ProviderName,
  type Question,
  type Task,
  type TaskNote,
  TaskNoteSchema,
  type TerminalMessage,
  type TerminalThread,
  TerminalThreadSchema,
  type TerminalThreadSummary,
  type TerminalTimelineEntry,
  type TimelineMessage,
  type ToolsetConfig,
  type ToolsetsScope,
  createLogger,
  decodeProjectGezelId,
  encodeProjectGezelId,
  inferGenderForName,
  isValidKokoroVoice,
  nowIso,
  parseGezelMarkdown,
  pickKokoroVoiceForGender,
  pronounFormsForGender,
  serializeGezelMarkdown,
} from '@bendyline/gezel';
import {
  type ExternalFolders,
  activeMachineSharedHome,
  craftbookTemplateDir,
  craftbookTemplateManifestFile,
  craftbookTemplateVersionDir,
  craftbookTemplateVersionManifestFile,
  craftbookTemplatesRoot,
  gezelDir,
  gezelGrowthPath,
  gezelLocalDir,
  gezelMemoriesDir,
  gezelPaths,
  gezelSessionFile,
  gezelSessionsDir,
  gezelStorageScope,
  gezelToolsetsFile,
  gezelToolsetsInstallDir,
  machineSharedGezelDir,
  meesterStatusDir,
  meesterStatusFile,
  meesterStatusStateFile,
  projectActivityFile,
  projectArtifactsDir,
  projectDir,
  projectDocsDir,
  projectFindingLifecycleFile,
  projectInternalGithubDir,
  projectLocalConfigFile,
  projectLocalCraftbookDir,
  projectLocalCraftbooksRoot,
  projectLocalDir,
  projectLocalGezelDir,
  projectLocalGezelsRoot,
  projectLocalImportsFile,
  projectLocalPendingImportsFile,
  projectLocalRoot,
  projectMemoriesDir,
  projectMetaFile,
  projectQuestionsFile,
  projectStorageScope,
  projectTaskAboutFile,
  projectTaskFile,
  projectTaskNextIdFile,
  projectTaskNotesFile,
  projectTasksDir,
  projectTerminalFile,
  projectTerminalsDir,
  projectToolsetsFile,
  projectToolsetsInstallDir,
  sharedToolsetsFile,
  sharedToolsetsInstallDir,
  systemInstalledToolsetsFile,
  systemToolsetsFile,
  systemToolsetsInstallDir,
  toolsetConfigFile,
  userGezelDir,
} from '@bendyline/gezel/paths';
import { applyPatch, parsePatch } from 'diff';
import { matchReferencedArtifactsInContent } from '../chat/artifact-references.js';
import { matchReferencedTasksInContent } from '../chat/task-references.js';
import { inspectGitWorkdir } from '../git/inspect.js';
import { parseGitHubUrl, sameGitHubRepo } from '../github/url.js';
import {
  DEFAULT_MEMORY_KIND,
  type MemoryKind,
  formatMemoryBlock,
} from '../memory/daily-markdown.js';
import { PoppetjeManager } from '../poppetje/manager.js';
import {
  type WorkspaceEditResult,
  buildWorkspaceEditResult,
  findAllOccurrences,
  findFlexibleMatch,
  readFileForEditOrThrow,
} from '../workspace/edit.js';
import { WorkspaceEditError, WorkspaceWriteDeniedError } from '../workspace/errors.js';
import { type JournalContext, appendJournalEntry } from '../workspace/journal.js';
import { bootstrapWorkspace } from '../workspace/template.js';
import { writeFileAtomic } from './atomic.js';
import { DocumentsStore } from './documents-store.js';
import { extForMimeType, mimeTypeForFilename, safeBasename } from './media-types.js';
import {
  type ProjectArtifactGrepResult,
  type ProjectArtifactResolveResult,
  type ProjectArtifactSliceResult,
  ProjectArtifactsStore,
} from './project-artifacts-store.js';
import { intoWorkspaceRelative, resolveInside, safeJoin } from './safe-paths.js';
import {
  type WalkDirResult,
  findHtmlPages,
  listDirEntries,
  safeReadBinaryFile,
  safeReadTextFile,
  safeResolveRead,
  walkDirDetailed,
} from './tree.js';

const log = createLogger('store');

export type ProjectFindingStatus = 'open' | 'in_progress' | 'resolved';
export interface ProjectFindingLifecycleEntry {
  status: ProjectFindingStatus;
  taskRef?: string;
  resolvedAt?: string;
}
export type ProjectFindingLifecycle = Record<string, ProjectFindingLifecycleEntry>;

interface ProjectFindingLifecycleFile {
  version: 1;
  findings: ProjectFindingLifecycle;
}

/**
 * Tasks written before the `phases` → `craftbook` rename carry a
 * top-level `phases` array and `activePhaseId` instead of an embedded
 * `craftbook` / `activeStepId`. Map the legacy shape onto the current
 * one at the read boundary so every consumer (UI and service) sees a
 * valid craftbook — without this the UI crashes on `task.craftbook.steps`.
 *
 * Idempotent: a task that already has `craftbook` passes straight
 * through. The legacy `phases`/`activePhaseId` keys are dropped from the
 * returned object so they don't linger if the task is later written back.
 */
function normalizeLegacyTaskShape(raw: unknown): Task {
  const t = raw as Record<string, unknown>;
  if (t.craftbook || !Array.isArray(t.phases)) return t as unknown as Task;

  const { phases, activePhaseId, ...rest } = t;
  const legacyPhases = phases as Array<Record<string, unknown>>;
  const createdAt = typeof t.createdAt === 'string' ? t.createdAt : '1970-01-01T00:00:00.000Z';
  const updatedAt = typeof t.updatedAt === 'string' ? t.updatedAt : createdAt;

  const ids = legacyPhases.map((p, i) => (typeof p.id === 'string' ? p.id : `step-${i + 1}`));
  const steps = legacyPhases.map((p, i) => {
    const step: Record<string, unknown> = {
      id: ids[i],
      name: typeof p.name === 'string' ? p.name : `Step ${i + 1}`,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : createdAt,
    };
    if (typeof p.description === 'string') step.description = p.description;
    if (typeof p.suggestedGezelId === 'string') step.suggestedGezelId = p.suggestedGezelId;
    if (typeof p.suggestedRole === 'string') step.suggestedRole = p.suggestedRole;
    if (typeof p.completedAt === 'string') step.completedAt = p.completedAt;
    // Legacy phases were a flat ordered list — reconstruct the linear
    // walk so advancement keeps working: each step points to the next,
    // the last is terminal.
    if (i < legacyPhases.length - 1) step.next = ids[i + 1];
    else step.terminal = true;
    return step;
  });
  // `craftbook.steps` is `.min(1)` — synthesize a single placeholder for
  // the (rare) legacy task that recorded zero phases.
  if (steps.length === 0) {
    const id = 'main';
    ids.push(id);
    steps.push({
      id,
      name: typeof t.title === 'string' ? t.title : 'Task',
      createdAt,
      terminal: true,
    });
  }

  const craftbook = {
    id: 'legacy',
    name: typeof t.title === 'string' ? t.title : 'Task',
    steps,
    entryStepId: ids[0],
    createdAt,
    updatedAt,
  };

  return {
    ...rest,
    craftbook,
    ...(typeof activePhaseId === 'string' ? { activeStepId: activePhaseId } : {}),
  } as unknown as Task;
}

export interface StoreOptions {
  home: string;
  /**
   * Optional history recorder. When set, the Store emits audit events after
   * successful writes (create/rename/update/delete for gezels + projects +
   * documents + icons). Kept optional so unit tests that don't care about
   * history can construct a bare Store.
   */
  history?: import('../history/manager.js').HistoryManager;
  /**
   * Per-scope external roots, captured at boot from
   * `config.json#externalFolders`. When set, the Store routes reads/
   * writes for the externalized scopes (documents, gezels, projects)
   * to the configured paths. Subdirectories that stay local even when
   * their parent scope is externalized (gezel `toolsets/`, project
   * `workspace/`, `gh/`, `scripts/`, history.jsonl, etc.) use the
   * `*LocalDir` helpers that ignore this field. Live mutation isn't
   * supported — changing externalization requires a service restart
   * (the move worker enforces this).
   */
  external?: ExternalFolders;
}

export interface SessionChangeEvent {
  type: 'write' | 'delete';
  gezelId: string;
  sessionId: string;
}

export interface DocumentChangeEvent {
  type: 'write' | 'delete';
  path: string;
}

export interface GezelChangeEvent {
  type: 'create';
  gezelId: string;
  name: string;
}

/**
 * The store owns all reads and writes to `~/.gezel/`. It's the only place
 * in the service that touches disk for agent/env/task data — HTTP routes call
 * into it rather than constructing paths themselves.
 */
export class ConfigCorruptionError extends Error {
  readonly code = 'CONFIG_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCorruptionError';
  }
}

/** Thrown by {@link Store.deleteProject} for refusable cases. */
export class ProjectDeleteError extends Error {
  constructor(
    message: string,
    readonly reason: 'default_project' | 'machine_shared' | 'not_found',
  ) {
    super(message);
    this.name = 'ProjectDeleteError';
  }
}

export class Store {
  private readonly home: string;
  private readonly history?: import('../history/manager.js').HistoryManager;
  private readonly external?: ExternalFolders;
  private readonly poppetjes: PoppetjeManager;
  private readonly documents: DocumentsStore;
  private readonly artifacts: ProjectArtifactsStore;
  private projectCreationTail: Promise<void> = Promise.resolve();
  private readonly findingLifecycleLocks = new Map<string, Promise<unknown>>();

  /**
   * Notified after every session persist/delete — the single choke point all
   * ChatManager write paths funnel through, so a subscriber sees every
   * transcript mutation. Synchronous + best-effort: listeners must be
   * enqueue-only and never throw work back into the write path.
   */
  private readonly sessionListeners = new Set<(ev: SessionChangeEvent) => void>();

  /** Notified on every document write/delete, including overwrites (which
   *  emit no history event). Same enqueue-only contract as session listeners. */
  private readonly documentListeners = new Set<(ev: DocumentChangeEvent) => void>();

  /** Notified after a shared gezel has been fully created and is listable.
   *  Project-local gezels use a separate Store path and intentionally do not
   *  enter this stream. */
  private readonly gezelListeners = new Set<(ev: GezelChangeEvent) => void>();

  constructor(opts: StoreOptions) {
    this.home = opts.home;
    this.history = opts.history;
    this.external = opts.external;
    this.poppetjes = new PoppetjeManager({
      home: this.home,
      external: this.external,
      history: this.history,
    });
    this.documents = new DocumentsStore({
      home: this.home,
      external: this.external,
      history: this.history,
      onChange: (ev) => {
        for (const listener of this.documentListeners) {
          try {
            listener(ev);
          } catch (err) {
            log.warn('[store] document listener failed:', err instanceof Error ? err.message : err);
          }
        }
      },
    });
    this.artifacts = new ProjectArtifactsStore({
      home: this.home,
      external: this.external,
      touchProject: (id) => this.touchProject(id),
    });
  }

  /** Snapshot of the external-folder config this Store was constructed
   *  with. Useful for the move worker, which needs to compute source
   *  paths against the *current* external config (possibly different
   *  from the destination it's moving to). */
  get externalFolders(): ExternalFolders | undefined {
    return this.external;
  }

  /** Absolute path of the gezel home directory that owns this store. */
  get homePath(): string {
    return this.home;
  }

  /** Directory holding the daemon + engine logs (`<home>/logs`). */
  get logsDirPath(): string {
    return gezelPaths(this.home).logs;
  }

  /** Absolute path of a session's on-disk transcript JSON — the full
   *  turn-by-turn record surfaced in the debug bundle for deep digs. */
  sessionRecordPath(gezelId: string, sessionId: string): string {
    return gezelSessionFile(this.home, gezelId, sessionId, this.external);
  }

  /** Expose the history recorder for callers that want to emit events directly. */
  get historyManager(): import('../history/manager.js').HistoryManager | undefined {
    return this.history;
  }

  /**
   * Serialize project publication inside the single daemon. Directory rename
   * can replace an empty target on POSIX, so collision checks alone do not
   * protect a typed-project commit racing ordinary `createProject` between
   * mkdir and its first file write.
   */
  async acquireProjectCreationLock(): Promise<() => void> {
    const previous = this.projectCreationTail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.projectCreationTail = previous.then(() => gate);
    await previous;
    return release;
  }

  /** Subscribe to session persist/delete events. Returns an unsubscribe fn. */
  onSessionChange(listener: (ev: SessionChangeEvent) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** Subscribe to document write/delete events. Returns an unsubscribe fn. */
  onDocumentChange(listener: (ev: DocumentChangeEvent) => void): () => void {
    this.documentListeners.add(listener);
    return () => this.documentListeners.delete(listener);
  }

  /** Subscribe to shared-roster changes. Returns an unsubscribe fn. */
  onGezelChange(listener: (ev: GezelChangeEvent) => void): () => void {
    this.gezelListeners.add(listener);
    return () => this.gezelListeners.delete(listener);
  }

  private notifyGezelChange(ev: GezelChangeEvent): void {
    for (const listener of this.gezelListeners) {
      try {
        listener(ev);
      } catch (err) {
        log.warn('[store] gezel listener failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  private notifySessionChange(ev: SessionChangeEvent): void {
    for (const listener of this.sessionListeners) {
      try {
        listener(ev);
      } catch (err) {
        log.warn('[store] session listener failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Expose the poppetje manager so HTTP routes and other modules can
   * read/persist the per-gezel character data without going through a
   * dedicated wrapper method on Store. Owns its own carve-out under
   * `~/.gezel/gezels/{id}/poppetje.json`.
   */
  get poppetjeManager(): PoppetjeManager {
    return this.poppetjes;
  }

  async ensureLayout(): Promise<void> {
    const local = gezelPaths(this.home);
    const p = gezelPaths(this.home, this.external);
    // One-time rename: the folder used to be called `agents/`. If the old
    // path exists and the new one doesn't, rename it. Safe to remove once
    // all installs have upgraded. Always operates against the local root —
    // legacy installs predate externalization.
    const legacyAgents = join(local.root, 'agents');
    try {
      const [hadLegacy, hasNew] = await Promise.all([
        stat(legacyAgents)
          .then(() => true)
          .catch(() => false),
        stat(local.gezels)
          .then(() => true)
          .catch(() => false),
      ]);
      if (hadLegacy && !hasNew) {
        await rename(legacyAgents, local.gezels);
        log.info('[store] migrated legacy agents/ directory to gezels/');
      }
    } catch {
      /* best-effort */
    }
    await Promise.all([
      mkdir(local.runtime.dir, { recursive: true }),
      mkdir(local.gezels, { recursive: true }),
      mkdir(local.projects, { recursive: true }),
      mkdir(local.logs, { recursive: true }),
      // Externalized roots: when external is unset these resolve to the
      // same local paths above (idempotent mkdir). When set, this is the
      // first time the external location gets initialized.
      mkdir(p.gezels, { recursive: true }),
      mkdir(p.projects, { recursive: true }),
      mkdir(p.documents, { recursive: true }),
    ]);
    await this.adoptMachineSharedGezelPrivateState();
    await this.backfillRoleBasedNames();
    await this.backfillVoices();
    await this.migrateLegacyTemperatureField();
    await this.migrateLegacyGhCheckouts();
    await this.cleanStaleWorkspaceBootstraps();
  }

  /**
   * A pre-split machine daemon stored identity and personal runtime state in
   * the same gezel directory. The installer preserves those bytes under the
   * shared root; the first user-daemon boot copies the legacy transcripts,
   * memories, and growth state into that account's private sidecar. From then
   * on, new activity is private while the shared root owns only identity.
   *
   * Local files win on collision so a retry can never replace newer work.
   * The memory vector index is derived and intentionally rebuilt per user.
   */
  private async adoptMachineSharedGezelPrivateState(): Promise<void> {
    const shared = activeMachineSharedHome();
    if (!shared) return;
    const ids = await safeReaddir(join(shared, 'gezels'));
    let adopted = 0;
    for (const id of ids) {
      const sharedDir = machineSharedGezelDir(id);
      if (!sharedDir || !(await pathExists(join(sharedDir, 'gezel.md')))) continue;
      const localDir = gezelLocalDir(this.home, id);
      // A real private definition shadows the shared entity and owns its own
      // runtime state; do not import unrelated machine history into it.
      if (await pathExists(join(userGezelDir(this.home, id, this.external), 'gezel.md'))) continue;
      const marker = join(localDir, '.machine-shared-import-v1.json');
      if (await pathExists(marker)) continue;
      await mkdir(localDir, { recursive: true });

      const sharedSessions = join(sharedDir, 'sessions');
      if (await pathExists(sharedSessions)) {
        await cp(sharedSessions, join(localDir, 'sessions'), {
          recursive: true,
          force: false,
          errorOnExist: false,
          preserveTimestamps: true,
        });
      }

      const sharedMemories = join(sharedDir, 'memories');
      const sharedMemoryIndex = join(sharedMemories, 'index');
      if (await pathExists(sharedMemories)) {
        await cp(sharedMemories, join(localDir, 'memories'), {
          recursive: true,
          force: false,
          errorOnExist: false,
          preserveTimestamps: true,
          filter: (source) =>
            source !== sharedMemoryIndex && !source.startsWith(`${sharedMemoryIndex}${sep}`),
        });
      }

      const sharedGrowth = join(sharedDir, 'growth.json');
      const localGrowth = join(localDir, 'growth.json');
      if ((await pathExists(sharedGrowth)) && !(await pathExists(localGrowth))) {
        await copyFile(sharedGrowth, localGrowth);
      }
      await writeFileAtomic(
        marker,
        `${JSON.stringify({ version: 1, sharedGezelId: id, importedAt: nowIso() }, null, 2)}\n`,
        { durable: true },
      );
      adopted++;
    }
    if (adopted > 0) {
      log.info(`[store] adopted private runtime state for ${adopted} machine-shared gezel(s)`);
    }
  }

  /**
   * Phase 2 one-shot migration: projects with a legacy `gh/` checkout
   * get their clone moved INTO the workspace dir, so the post-Phase-2
   * principle holds (workspace === root of git repo). Without this
   * migration, projects created before Phase 2 stay split-brained —
   * their reads / writes go to the workspace (after the Phase 1
   * resolver fix) while their actual repo content sits in `gh/` and
   * is invisible to the model.
   *
   * Skipped when:
   *   - project has no github link, or no `gh/` directory present.
   *   - `workspace/` has user-authored content (anything beyond the
   *     three bootstrap files). Preserving user work always wins over
   *     a clean migration — the project keeps its split state and the
   *     user can resolve manually.
   *
   * On a clean migration: bootstrap files in `workspace/` are removed,
   * the (now empty) workspace dir is rmdir'd, and `gh/` is renamed to
   * `workspace/`. The project's `github.checkoutDir` is updated to the
   * new workspace path.
   */
  private async migrateLegacyGhCheckouts(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.listProjects();
    } catch {
      return;
    }
    const BOOTSTRAP_FILES = new Set(['package.json', 'tsconfig.json', '.gitignore']);
    let migrated = 0;
    let skippedWithUserContent = 0;
    for (const p of projects) {
      if (!p.github?.checkoutDir) continue;
      if (p.workingDir) continue;
      const legacyGh = projectInternalGithubDir(this.home, p.id);
      if (p.github.checkoutDir !== legacyGh) continue;
      // Verify the legacy gh/ actually exists as a directory.
      try {
        const s = await stat(legacyGh);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      const workspaceDir = join(projectLocalDir(this.home, p.id), 'workspace');
      // Check workspace state — must be empty OR only bootstrap files.
      let safeToMigrate = true;
      try {
        const entries = await readdir(workspaceDir);
        for (const name of entries) {
          if (!BOOTSTRAP_FILES.has(name)) {
            safeToMigrate = false;
            break;
          }
        }
      } catch {
        // workspace doesn't exist — fine, we'll create it via rename
      }
      if (!safeToMigrate) {
        skippedWithUserContent++;
        log.warn(
          `[store] skipping legacy gh/ migration for project ${p.id}: workspace has user content`,
        );
        continue;
      }
      try {
        // Clear workspace (delete bootstrap files + the dir itself) so
        // rename can land cleanly. rm with recursive+force tolerates
        // missing dir.
        await rm(workspaceDir, { recursive: true, force: true });
        // Atomic move of gh/ → workspace/. Same parent dir, same
        // filesystem, so rename is atomic.
        await rename(legacyGh, workspaceDir);
        // Update metadata so projectWorkspaceDir + the github tab use
        // the new path.
        await this.updateProjectGitHub(p.id, {
          url: p.github.url,
          ...(p.github.branch ? { branch: p.github.branch } : {}),
          checkoutDir: workspaceDir,
        });
        migrated++;
      } catch (err) {
        log.warn(
          `[store] failed to migrate legacy gh/ for project ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (migrated > 0 || skippedWithUserContent > 0) {
      log.info(
        `[store] legacy gh/ migration: ${migrated} project(s) migrated, ${skippedWithUserContent} skipped (user content in workspace)`,
      );
    }
  }

  /**
   * One-time cleanup for projects that were created from a GitHub URL
   * before the workspace-tab unification: their internal `workspace/`
   * dir got seeded with the three bootstrap files (package.json,
   * tsconfig.json, .gitignore), but the Workspace tab now points at
   * the github checkout instead — leaving the bootstrap files dangling
   * on disk and confusing anyone who `ls`'s the project dir.
   *
   * Only deletes the workspace dir when:
   *   - the project is github-linked AND has a checkoutDir
   *   - workspace/ contains nothing except those three bootstrap files
   * Anything else (real user files, non-github projects) is untouched.
   *
   * Note: as of Phase 2, fresh github-linked projects no longer create
   * the parallel `gh/` checkout — they clone directly into the
   * workspace. This cleanup remains for projects whose `gh/` got
   * migrated by `migrateLegacyGhCheckouts` (whose state should be
   * cleaned already) and for any never-cloned legacy projects whose
   * `workspace/` was bootstrapped but gh/ never landed.
   */
  private async cleanStaleWorkspaceBootstraps(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.listProjects();
    } catch {
      return;
    }
    const BOOTSTRAP_FILES = new Set(['package.json', 'tsconfig.json', '.gitignore']);
    let cleaned = 0;
    for (const p of projects) {
      if (!p.github?.checkoutDir) continue;
      // If workingDir is set, projectWorkspaceDir resolves to it, not
      // to the internal workspace/ — leave that untouched either way.
      if (p.workingDir) continue;
      const workspaceDir = join(projectLocalDir(this.home, p.id), 'workspace');
      try {
        const entries = await readdir(workspaceDir);
        if (entries.length === 0) continue;
        const allBootstrap = entries.every((name) => BOOTSTRAP_FILES.has(name));
        if (!allBootstrap) continue;
        await rm(workspaceDir, { recursive: true, force: true });
        cleaned++;
      } catch {
        /* dir doesn't exist or unreadable — nothing to clean */
      }
    }
    if (cleaned > 0) {
      log.info(`[store] cleaned ${cleaned} stale workspace bootstrap dir(s)`);
    }
  }

  /**
   * Idempotent one-pass migration: every gezel.md gets a `roleBasedName`
   * if it doesn't have one. Deterministic order (by id) so re-running
   * after a partial run produces the same assignments.
   */
  private async backfillRoleBasedNames(): Promise<void> {
    let all: GezelSummary[];
    try {
      all = await this.listGezels();
    } catch {
      return;
    }
    const needsBackfill = all.filter((g) => !g.roleBasedName);
    if (needsBackfill.length === 0) return;
    const taken = new Set<string>(all.map((g) => g.roleBasedName).filter((s): s is string => !!s));
    const ordered = [...needsBackfill].sort((a, b) => a.id.localeCompare(b.id));
    let backfilled = 0;
    for (const g of ordered) {
      const detail = await this.tryGetGezel(g.id);
      if (!detail) continue;
      const name = pickRoleBasedName(detail.role, taken);
      const updated = {
        ...detail.parsed,
        frontmatter: { ...detail.parsed.frontmatter, roleBasedName: name },
      };
      try {
        await writeFileAtomic(
          join(gezelDir(this.home, g.id, this.external), 'gezel.md'),
          serializeGezelMarkdown(updated),
        );
        taken.add(name);
        backfilled++;
      } catch {
        /* best-effort — log line below still fires for partial runs */
      }
    }
    if (backfilled > 0) {
      log.info(`[store] backfilled roleBasedName on ${backfilled} gezels`);
    }
  }

  /**
   * Idempotent one-pass migration: every gezel.md gets a `voice` (Kokoro
   * TTS voice id) if it doesn't have one. Deterministic per-id seed so the
   * same gezel always lands on the same voice across re-installs.
   */
  private async backfillVoices(): Promise<void> {
    let all: GezelSummary[];
    try {
      all = await this.listGezels();
    } catch {
      return;
    }
    const needsBackfill = all.filter((g) => !g.voice);
    if (needsBackfill.length === 0) return;
    let backfilled = 0;
    for (const g of needsBackfill) {
      const detail = await this.tryGetGezel(g.id);
      if (!detail) continue;
      const voice = pickKokoroVoiceForGender(g.gender, { seed: stringSeed(g.id) });
      const updated = {
        ...detail.parsed,
        frontmatter: { ...detail.parsed.frontmatter, voice },
      };
      try {
        await writeFileAtomic(
          join(gezelDir(this.home, g.id, this.external), 'gezel.md'),
          serializeGezelMarkdown(updated),
        );
        backfilled++;
      } catch {
        /* best-effort */
      }
    }
    if (backfilled > 0) {
      log.info(`[store] backfilled voice on ${backfilled} gezels`);
    }
  }

  /**
   * One-time migration from the legacy gezel-frontmatter `temperature`
   * field (now removed from the schema) into the new structured
   * `tuning.sampling.temperature`. We can't go through
   * `parseGezelMarkdown` here because Zod strips the unknown key
   * before we'd see it. Instead, regex on the raw YAML block: find a
   * top-level `temperature: <number>` line and:
   *   - rewrite the file with that line removed
   *   - inject `tuning:\n  sampling:\n    temperature: <number>` if no
   *     existing tuning block sets a temperature
   *
   * Idempotent — subsequent runs see the field already gone. Best-
   * effort: read / write failures log and skip rather than abort
   * layout init.
   */
  private async migrateLegacyTemperatureField(): Promise<void> {
    let all: GezelSummary[];
    try {
      all = await this.listGezels();
    } catch {
      return;
    }
    const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
    // Top-level `temperature: <number>` only — won't match a nested
    // `  temperature:` inside `tuning.sampling`. The `^` matches start
    // of line under the `m` flag.
    const TEMP_LINE = /^temperature:\s*([0-9]+(?:\.[0-9]+)?)\s*$/m;
    // Detect a pre-existing `tuning.sampling.temperature` so we don't
    // clobber. Looks for `tuning:`, then any depth of YAML, then a
    // `temperature:` inside the `sampling:` block. Conservative: any
    // `temperature:` not at top-level counts as "user already has one
    // somewhere under tuning."
    const NESTED_TEMP = /^\s+temperature:\s*[0-9]/m;
    let migrated = 0;
    for (const g of all) {
      const path = join(gezelDir(this.home, g.id, this.external), 'gezel.md');
      let source: string;
      try {
        source = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      const fmMatch = FRONTMATTER_BLOCK.exec(source);
      if (!fmMatch) continue;
      const yaml = fmMatch[1]!;
      const tempMatch = TEMP_LINE.exec(yaml);
      if (!tempMatch) continue;
      const raw = Number(tempMatch[1]);
      const valid = Number.isFinite(raw) && raw >= 0 && raw <= 2;
      let newYaml = yaml
        .replace(TEMP_LINE, '')
        .replace(/\r?\n\r?\n+/g, '\n')
        .trimEnd();
      // Fold into tuning.sampling.temperature only when valid AND no
      // pre-existing nested temperature would be clobbered.
      if (valid && !NESTED_TEMP.test(newYaml)) {
        if (/^tuning:\s*$/m.test(newYaml)) {
          // Existing `tuning:` block — append/extend rather than
          // duplicate. This branch is rare; we fall through to a safe
          // no-op fold (just drop the legacy field, don't risk
          // corrupting an existing block).
        } else {
          newYaml += `\ntuning:\n  sampling:\n    temperature: ${raw}`;
        }
      }
      const newSource = `---\n${newYaml}\n---\n${source.slice(fmMatch[0].length)}`;
      try {
        await writeFileAtomic(path, newSource);
        migrated++;
      } catch {
        /* best-effort */
      }
    }
    if (migrated > 0) {
      log.info(`[store] migrated legacy temperature field on ${migrated} gezels`);
    }
  }

  async ensureDefaultProject(): Promise<void> {
    const existing = await this.tryGetProjectMeta('default');
    if (existing) return;
    await this.createProject({
      name: 'Default',
      description: 'The default project for general-purpose chats.',
    });
  }

  /**
   * Ensure `config.meesterGezelId` points at a valid gezel. Order of preference:
   *   1. Existing pointer → a live gezel: no-op.
   *   2. Any other gezels exist: auto-pick the first alphabetically.
   *   3. No gezels at all: create a fresh Meester with a random name and the
   *      curated about.md from packages/service/src/meester/prompt.ts.
   */
  async ensureDefaultMeester(): Promise<void> {
    const config = await this.readConfig();
    if (config.meesterGezelId) {
      const stillExists = await this.tryGetGezel(config.meesterGezelId);
      if (stillExists) {
        await this.refreshStaleMeesterAbout(config.meesterGezelId);
        return;
      }
    }

    const existing = await this.listGezels();
    if (existing.length > 0) {
      const first = existing[0]!;
      await this.writeConfig({ meesterGezelId: first.id });
      log.info(`[meester] auto-designated ${first.id} as meester`);
      await this.refreshStaleMeesterAbout(first.id);
      return;
    }

    await this.createFreshMeester();
  }

  /**
   * One-shot migration: if the active Meester's about.md carries
   * markers from any prior version of `MEESTER_ABOUT_MD`, overwrite
   * with the current curated text. Two staleness detectors run, each
   * gated on TWO markers so a user-customized about (e.g. kept old
   * sections intentionally) doesn't get clobbered:
   *
   *   1. **Pre-tools-block era** — `## Your tools` heading + the
   *      "browser automation available as a system toolset" prose.
   *      Both removed when the auto-injected `## Tools available
   *      this turn` block shipped (~1.5K tokens/turn savings).
   *   2. **Pre-`start_project`/`start_job` macros era** — `## The
   *      three-step project setup` heading + the `mode: 'solo'`
   *      reference in the old "Solo projects ('jobs')" section.
   *      Both removed when the two-macro split landed; without this
   *      refresh the existing Meester reads contradictory
   *      instructions (about.md says "create_project then update,
   *      then ..." while the cookbook says "use start_project") and
   *      the small model produces malformed tool calls trying to
   *      reconcile them.
   *
   * Idempotent: once refreshed, neither marker matches and the
   * function no-ops on subsequent boots.
   */
  private async refreshStaleMeesterAbout(gezelId: string): Promise<void> {
    const detail = await this.tryGetGezel(gezelId);
    if (!detail) return;
    const about = detail.about ?? '';
    // Each marker is a literal section header from a past version of
    // `MEESTER_ABOUT_MD`. The current text contains neither, so a
    // hit is a definitive stale signal — a user customizing their
    // Meester would not coincidentally write our exact prior
    // section headers verbatim.
    const hasPreToolsBlockMarker = /^## Your tools$/m.test(about);
    const hasPreMacroSplitMarker = about.includes('## The three-step project setup');
    // Post-macro-split content that *also* lacks ask_specialist
    // guidance — i.e. it has "Starting work — two macros, one
    // decision" but no mention of `ask_specialist` (the role-shaped
    // consultation macro). This catches gezels that already got the
    // pre-macro-split refresh and are now stale on the consultation
    // macro.
    const hasPostMacroPreSpecialistMarker =
      about.includes('## Starting work — two macros, one decision') &&
      !about.includes('ask_specialist');
    if (!hasPreToolsBlockMarker && !hasPreMacroSplitMarker && !hasPostMacroPreSpecialistMarker)
      return;
    const { MEESTER_ABOUT_MD } = await import('../meester/prompt.js');
    await this.updateGezelAbout(gezelId, MEESTER_ABOUT_MD);
    const reason = hasPreToolsBlockMarker
      ? 'pre-tools-block era'
      : hasPreMacroSplitMarker
        ? 'pre-macro-split era'
        : 'pre-ask-specialist era';
    log.info(`[meester] refreshed stale about.md for ${gezelId} (${reason})`);
  }

  /**
   * Forcibly create a brand-new gezel wearing the Meester role, with the
   * curated Meester about.md, and set it as the active meester. Used by the
   * "Change meester to: <New Meester Gezel>" option in the UI. An optional
   * `name` overrides the random pick from the curated list.
   */
  async createFreshMeester(name?: string): Promise<GezelDetail> {
    const { MEESTER_ABOUT_MD, randomMeesterName } = await import('../meester/prompt.js');
    const chosen = name?.trim() || randomMeesterName();
    const created = await this.createGezel({
      name: chosen,
      role: 'Meester',
      about: MEESTER_ABOUT_MD,
      // Match the Meester gilde template's frontmatter so the
      // fast-path here doesn't diverge from gilde-created Meesters.
      // The Meester is a concierge / delegator — a SUGGESTION (not a
      // hard pick) of low-temp `thinking-precise`, so it stays overridable
      // by an install preset or per-gezel choice. Coordinators drift /
      // mangle tool args at the old `thinking-general` temp 0.9 (eval
      // matrix).
      frontmatter: { suggestedTuningProfile: 'thinking-precise' },
    });
    await this.writeConfig({ meesterGezelId: created.id });
    log.info(`[meester] created fresh meester "${created.name}" (${created.id})`);
    return created;
  }

  /**
   * Ensure `config.klerkGezelId` points at a valid gezel. The Klerk owns
   * one-shot text utility work (about.md drafts, rewrites, summaries,
   * memory consolidation) so users can route grunt work to a different
   * model than their conversational gezels. Order of preference matches
   * {@link ensureDefaultMeester}: respect a live pointer; otherwise
   * create a fresh Klerk with the curated about.md from
   * packages/service/src/klerk/prompt.ts.
   *
   * Unlike the meester fallback, we do NOT auto-pick the first existing
   * gezel — the Klerk's about.md is purpose-built for utility writing,
   * and silently inheriting a "Reviewer" or "Designer" gezel's prompt
   * would tilt summary/rewrite output in the wrong direction. A fresh
   * Klerk on first miss keeps the role's voice intact.
   */
  async ensureDefaultKlerk(): Promise<void> {
    const config = await this.readConfig();
    if (config.klerkGezelId) {
      const stillExists = await this.tryGetGezel(config.klerkGezelId);
      if (stillExists) return;
    }
    await this.createFreshKlerk();
  }

  /**
   * Forcibly create a brand-new gezel wearing the Klerk role, with the
   * curated Klerk about.md, and set it as the active klerk. Used by the
   * "New Klerk gezel…" option in Settings.
   */
  async createFreshKlerk(name?: string): Promise<GezelDetail> {
    const { KLERK_ABOUT_MD, randomKlerkName } = await import('../klerk/prompt.js');
    const chosen = name?.trim() || randomKlerkName();
    const created = await this.createGezel({
      name: chosen,
      role: 'Klerk',
      about: KLERK_ABOUT_MD,
      // Klerk owns one-shot rewrites + summaries — short, decisive,
      // no chain-of-thought needed. `instruct` profile (no thinking,
      // moderate temp) is the right shape for utility work — a
      // SUGGESTION so an install preset / per-gezel pick still wins.
      frontmatter: { suggestedTuningProfile: 'instruct' },
    });
    await this.writeConfig({ klerkGezelId: created.id });
    log.info(`[klerk] created fresh klerk "${created.name}" (${created.id})`);
    return created;
  }

  /**
   * Forcibly create a brand-new gezel wearing the Keurmeester role, with
   * the curated inspector about.md, and set it as the active keurmeester.
   * Used by the "New Keurmeester gezel…" option in Settings and minted
   * lazily by KeurmeesterManager on the first consult when supervision is
   * enabled with no pointer. Deliberately NO boot-time ensure — the
   * feature is off by default, and disabled installs should never grow a
   * Keurmeester they didn't ask for.
   */
  async createFreshKeurmeester(
    name?: string,
    opts: { provider?: import('@bendyline/gezel').ProviderName; model?: string } = {},
  ): Promise<GezelDetail> {
    const { KEURMEESTER_ABOUT_MD, randomKeurmeesterName } = await import(
      '../keurmeester/prompt.js'
    );
    const chosen = name?.trim() || randomKeurmeesterName();
    const created = await this.createGezel({
      name: chosen,
      role: 'Keurmeester',
      about: KEURMEESTER_ABOUT_MD,
      // No suggestedTuningProfile: the Keurmeester runs on a frontier
      // provider (config.keurmeester.providerName/model), not a local
      // engine, so local tuning presets don't apply. When the consult
      // target is known at mint time it's pinned as frontmatter so the
      // Keurmeester's OWN sessions (takeover turns) run on the frontier
      // provider too — without the pin they'd land on config.provider,
      // typically the struggling local engine.
      frontmatter: {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      },
    });
    await this.writeConfig({ keurmeesterGezelId: created.id });
    log.info(`[keurmeester] created fresh keurmeester "${created.name}" (${created.id})`);
    return created;
  }

  // ---------- index rubrics ----------

  /**
   * User rubric overrides for the boekwachter review pass: one markdown file
   * per classify.ts file kind at `~/.gezel/rubrics/<kind>.md`. A file for a
   * kind with a built-in default replaces it; a file for an uncovered kind
   * (e.g. `text.md`) ADDS review eligibility for that kind. The directory is
   * optional — no dir means built-ins only.
   */
  async listIndexRubrics(): Promise<Record<string, string>> {
    const dir = join(this.home, 'rubrics');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const kind = name.slice(0, -'.md'.length);
      if (!kind) continue;
      const text = await readFile(join(dir, name), 'utf8').catch(() => null);
      if (text !== null) out[kind] = text;
    }
    return out;
  }

  // ---------- config ----------

  async readConfig(): Promise<GezelConfig> {
    const p = gezelPaths(this.home);
    let raw: string;
    try {
      raw = await readFile(p.config, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new ConfigCorruptionError(
        `Unable to read ${p.config}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigCorruptionError(
        `config.json is not valid JSON. Gezel left it untouched: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const result = GezelConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigCorruptionError(
        `config.json failed schema validation. Gezel left it untouched: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async writeConfig(config: Partial<Record<keyof GezelConfig, unknown>>): Promise<GezelConfig> {
    const p = gezelPaths(this.home);
    const existing = await this.readConfig();
    // Explicit `null` on any patched field means "reset to default" —
    // drop it from the merged shape instead of persisting the null.
    // `undefined` values never reach here (JSON.stringify strips them
    // at the client), so this is the only way the UI can express
    // "clear this optional field."
    const merged: Record<string, unknown> = { ...existing, ...config };
    for (const [k, v] of Object.entries(config)) {
      if (v === null) delete merged[k];
    }
    // externalFolders is a nested object; per-scope `null` clears that
    // scope's external path. If all three scopes end up absent the
    // parent object goes away entirely so the on-disk config stays
    // narrow.
    if ('externalFolders' in config && config.externalFolders !== null) {
      const incoming = config.externalFolders as Record<string, unknown> | undefined;
      if (incoming) {
        const existingExternal =
          (existing as { externalFolders?: Record<string, unknown> }).externalFolders ?? {};
        const mergedExternal: Record<string, unknown> = { ...existingExternal, ...incoming };
        for (const [k, v] of Object.entries(incoming)) {
          if (v === null) delete mergedExternal[k];
        }
        if (Object.keys(mergedExternal).length === 0) {
          delete merged.externalFolders;
        } else {
          merged.externalFolders = mergedExternal;
        }
      }
    }
    await writeFileAtomic(p.config, `${JSON.stringify(merged, null, 2)}\n`);
    await tryChmod600(p.config);
    return merged as GezelConfig;
  }

  // ---------- agents ----------

  async listGezels(): Promise<GezelSummary[]> {
    const p = gezelPaths(this.home, this.external);
    const shared = activeMachineSharedHome();
    const [userDirs, sharedDirs] = await Promise.all([
      safeReaddir(p.gezels),
      shared ? safeReaddir(join(shared, 'gezels')) : Promise.resolve([]),
    ]);
    // Local definition wins on collision. A local sidecar containing only
    // sessions/memories does not count as a definition and must not hide the
    // shared identity it belongs to.
    const localDefinitions = new Set<string>();
    for (const id of userDirs) {
      try {
        await stat(join(p.gezels, id, 'gezel.md'));
        localDefinitions.add(id);
      } catch {
        // Sidecar-only shared state.
      }
    }
    const dirs = Array.from(
      new Set([...localDefinitions, ...sharedDirs.filter((id) => !localDefinitions.has(id))]),
    );
    // Skip encoded project-local ids that happen to have an app-data
    // sidecar dir (poppetje/sessions live there keyed by the encoded id) —
    // they are NOT global gezels and must not leak into the global roster.
    const globalDirs = dirs.filter((id) => !decodeProjectGezelId(id));
    const details = await Promise.all(globalDirs.map((id) => this.tryGetGezel(id)));
    const out: GezelSummary[] = details
      .filter((d): d is GezelDetail => d !== null)
      .map((d) => this.toGezelSummary(d));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Map a hydrated detail to the list-summary shape. `scope` badges project-local gezels. */
  private toGezelSummary(d: GezelDetail, scope?: 'global' | 'project'): GezelSummary {
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      role: d.role,
      roleBasedName: d.roleBasedName,
      gender: d.parsed.frontmatter.gender,
      model: d.model,
      provider: d.provider,
      reasoningEffort: d.reasoningEffort,
      font: d.font,
      voice: d.parsed.frontmatter.voice,
      templateId: d.templateId,
      templateVersion: d.parsed.frontmatter.templateVersion,
      sandboxCopilot: d.parsed.frontmatter.sandboxCopilot,
      claudePermissionMode: d.parsed.frontmatter.claudePermissionMode,
      fixedFunction: d.parsed.frontmatter.fixedFunction,
      icon: d.icon,
      poppetje: d.poppetje,
      iconOverride: d.iconOverride,
      recognition: d.parsed.frontmatter.recognition,
      ...(scope ? { scope } : {}),
      ...(d.storageScope ? { storageScope: d.storageScope } : {}),
      updatedAt: d.updatedAt,
    };
  }

  /**
   * List the project-local gezels defined in a project's workspace
   * `.gezel/gezels/` folder. These never appear in the global
   * {@link listGezels} roster; the project roster merges them in. The
   * canonical `@project` gezel (localId `project`) is included once it
   * has been minted on disk.
   */
  async listProjectGezels(projectId: string): Promise<GezelSummary[]> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return [];
    }
    let localIds: string[] = [];
    try {
      const entries = await readdir(projectLocalGezelsRoot(ws), { withFileTypes: true });
      localIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const details = await Promise.all(
      localIds.map((localId) => this.tryGetProjectGezel(projectId, localId)),
    );
    const out = details
      .filter((d): d is GezelDetail => d !== null)
      .map((d) => this.toGezelSummary(d, 'project'));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async createGezel(input: {
    name: string;
    description?: string;
    role?: string;
    /**
     * Optional explicit gender. When omitted, derived from the name via
     * {@link inferGenderForName} — which checks the gendered name pools
     * and applies a small NB conversion rate so even pool names sometimes
     * land non-binary. Callers that already chose a gender alongside the
     * name (UI form, `pickRandomNameWithGender`) should pass it through
     * so the NB rule isn't re-rolled.
     */
    gender?: GezelGender;
    model?: string;
    /** Optional curated about.md. When omitted, uses the generic placeholder.
     *  Ignored when `frontmatter.fixedFunction` is set — those gezels have no
     *  system prompt and no about.md is written. */
    about?: string;
    /**
     * Gilde catalog template id this gezel was created from, if any.
     * Persisted in frontmatter so the about editor can offer "reset to
     * original template" later.
     */
    templateId?: string;
    /**
     * Semver of the template version installed at create time. Paired
     * with `templateId`; absent on bespoke gezels and on legacy gezels
     * created before this field existed.
     */
    templateVersion?: string;
    /**
     * Extra frontmatter the template wants merged onto the new gezel.
     * Today only `fixedFunction` flows through here — when present, the
     * gezel skips the LLM and forwards messages to the named MCP tool,
     * and no `about.md` is written. Future templates can use the same
     * channel for any non-scalar field that doesn't fit the flat
     * arguments above.
     */
    frontmatter?: Partial<import('@bendyline/gezel').GezelFrontmatter>;
  }): Promise<GezelDetail> {
    const id = await this.uniqueGezelId(slugify(input.name) || randomUUID().slice(0, 8));
    // Creation is always private. In particular, never let the shared-path
    // resolver turn a same-name create into an overwrite of a migrated gezel.
    const dir = userGezelDir(this.home, id, this.external);
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'memories'), { recursive: true });
    await mkdir(join(dir, 'resources'), { recursive: true });

    // Compute roleBasedName before write so the gezel lands on disk with
    // its boring-mode identifier already set. New gezel isn't in the
    // taken set yet (its dir was created above but `listGezels` reads
    // `gezel.md`, which we haven't written).
    const roleBasedName = await this.computeRoleBasedName(input.role);
    // Gender: caller-supplied wins (UI picker, paired name+gender draw).
    // Otherwise infer from the name — pool lookup with a flat NB share.
    const gender = input.gender ?? inferGenderForName(input.name);
    // Kokoro TTS voice. Caller-supplied wins (template frontmatter, UI
    // override). Otherwise pick deterministically from the gender-matched
    // pool, seeded by the gezel id so the same gezel always gets the
    // same voice across re-installs / migrations.
    const callerVoice = input.frontmatter?.voice;
    const voice =
      callerVoice && isValidKokoroVoice(callerVoice)
        ? callerVoice
        : pickKokoroVoiceForGender(gender, { seed: stringSeed(id) });
    const source = defaultAgentMarkdown({
      id,
      name: input.name,
      description: input.description,
      role: input.role,
      roleBasedName,
      gender,
      voice,
      model: input.model,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      extraFrontmatter: input.frontmatter,
    });
    await writeFileAtomic(join(dir, 'gezel.md'), source);
    // Fixed-function gezels skip the LLM entirely, so an about.md
    // (which becomes the system prompt for normal gezels) would be
    // misleading. The about pane / editor route refuses to write into
    // these gezels too — see the http routes and the UI gating.
    if (!input.frontmatter?.fixedFunction) {
      await writeFileAtomic(
        join(dir, 'about.md'),
        input.about ?? defaultAboutMarkdown(input.name, gender),
      );
    }
    // Generate-and-persist the poppetje before reading the detail, so
    // the create response carries the figure for the UI to render
    // immediately (no second round-trip). Deterministic from the id,
    // so the same name → same gezel → same initial appearance.
    // `gender` (resolved above) gates beard/mustache for female gezels.
    await this.poppetjes.get(id, input.name, gender);
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`failed to create agent ${id}`);
    await this.history?.log({
      kind: 'gezel.created',
      gezelId: detail.id,
      summary: `Created "${detail.name}"${detail.role ? ` (${detail.role})` : ''}`,
      details: {
        name: detail.name,
        role: detail.role,
        model: detail.model,
        provider: detail.provider,
      },
    });
    this.notifyGezelChange({ type: 'create', gezelId: detail.id, name: detail.name });
    return detail;
  }

  /**
   * Permanently remove a shared gezel and all service-owned files beneath
   * their gezel directories. Project rosters and voorman pointers are
   * cleared first so no active project keeps pointing at a missing gezel.
   * Historical task/audit records keep their original ids as provenance.
   */
  async deleteGezel(id: string): Promise<{ id: string; name: string }> {
    const existing = await this.tryGetGezel(id);
    if (!existing) throw new Error(`agent ${id} not found`);
    if (existing.storageScope === 'machine-shared') {
      throw new Error(
        'Machine-shared gezels cannot be removed from an individual account. Shared removal is not available yet.',
      );
    }

    const projects = await this.listProjects();
    for (const project of projects) {
      const wasVoorman = project.voormanGezelId === id;
      const wasMember = project.gezelIds?.includes(id) ?? false;
      if (!wasVoorman && !wasMember) continue;
      const updated: Project = {
        ...project,
        ...(wasVoorman ? { voormanGezelId: undefined, voormanAutoAssignedAt: undefined } : {}),
        ...(wasMember ? { gezelIds: project.gezelIds!.filter((gezelId) => gezelId !== id) } : {}),
        updatedAt: nowIso(),
      };
      await writeFileAtomic(
        projectMetaFile(this.home, project.id),
        `${JSON.stringify(updated, null, 2)}\n`,
      );
    }

    const config = await this.readConfig();
    const configPatch: Partial<Record<keyof GezelConfig, unknown>> = {};
    if (config.meesterGezelId === id) configPatch.meesterGezelId = null;
    if (config.klerkGezelId === id) configPatch.klerkGezelId = null;
    if (config.boekwachterGezelId === id) configPatch.boekwachterGezelId = null;
    if (config.keurmeesterGezelId === id) configPatch.keurmeesterGezelId = null;
    if (Object.keys(configPatch).length > 0) await this.writeConfig(configPatch);

    const contentDir = gezelDir(this.home, id, this.external);
    const localDir = gezelLocalDir(this.home, id);
    await rm(contentDir, { recursive: true, force: true });
    if (localDir !== contentDir) await rm(localDir, { recursive: true, force: true });

    await this.history?.log({
      kind: 'gezel.deleted',
      gezelId: id,
      summary: `Deleted gezel "${existing.name}"`,
      details: { id, name: existing.name },
    });

    // The Meester is a product invariant. If the removed gezel wore that
    // role, immediately designate another existing gezel or mint a fresh one.
    if (config.meesterGezelId === id) {
      await this.ensureDefaultMeester().catch((err) => {
        log.warn('[meester] failed to replace deleted meester:', err);
      });
    }

    return { id, name: existing.name };
  }

  async updateGezelAbout(id: string, source: string): Promise<GezelDetail> {
    const existing = await this.tryGetGezel(id);
    if (!existing) throw new Error(`agent ${id} not found`);
    if (existing.parsed.frontmatter.fixedFunction) {
      throw new Error(
        `agent ${id} is a fixed-function gezel and has no about.md (no LLM is invoked)`,
      );
    }
    const dir = gezelDir(this.home, id, this.external);
    await writeFileAtomic(join(dir, 'about.md'), source);
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after about update`);
    return detail;
  }

  async renameGezel(oldId: string, newName: string): Promise<GezelDetail> {
    const existing = await this.tryGetGezel(oldId);
    if (!existing) throw new Error(`agent ${oldId} not found`);
    // A shared gezel's id anchors every account's private transcript/memory
    // sidecar. Keep that id stable across a display-name edit so one user's
    // rename cannot orphan every other user's private state.
    if (existing.storageScope === 'machine-shared') {
      const updated = {
        ...existing.parsed,
        frontmatter: { ...existing.parsed.frontmatter, id: oldId, name: newName },
      };
      await writeFileAtomic(
        join(gezelDir(this.home, oldId, this.external), 'gezel.md'),
        serializeGezelMarkdown(updated),
      );
      const detail = await this.getGezel(oldId);
      if (!detail) throw new Error(`agent ${oldId} not found after rename`);
      await this.history?.log({
        kind: 'gezel.renamed',
        gezelId: oldId,
        summary: `Renamed ${existing.name} → ${detail.name}`,
        details: { oldName: existing.name, newName: detail.name, storageScope: 'machine-shared' },
      });
      return detail;
    }
    const newId = slugify(newName) || randomUUID().slice(0, 8);
    if (newId === oldId) {
      // Slug didn't change — just update the name in frontmatter.
      const updated = {
        ...existing.parsed,
        frontmatter: { ...existing.parsed.frontmatter, id: newId, name: newName },
      };
      const source = serializeGezelMarkdown(updated);
      await writeFileAtomic(join(gezelDir(this.home, oldId, this.external), 'gezel.md'), source);
      const detail = await this.getGezel(oldId);
      if (!detail) throw new Error(`agent ${oldId} not found after rename`);
      await this.history?.log({
        kind: 'gezel.renamed',
        gezelId: detail.id,
        summary: `Renamed ${existing.name} → ${detail.name}`,
        details: { oldName: existing.name, newName: detail.name },
      });
      return detail;
    }
    const oldDir = gezelDir(this.home, oldId, this.external);
    const newDir = gezelDir(this.home, newId, this.external);
    await rename(oldDir, newDir);
    // Repin the poppetje's `key` field to the new id so the wood-grain
    // seed stays anchored to the gezel's current identity. The file
    // physically moved with the directory rename above; this pass just
    // rewrites the JSON contents.
    try {
      const existing = await this.poppetjes.tryRead(newId);
      if (existing) {
        await this.poppetjes.set(newId, newName, { ...existing, key: newId, name: newName });
      }
    } catch {
      /* non-fatal — the next get() will regenerate */
    }
    // The local toolsets dir is a sibling under `~/.gezel/gezels/{id}/`
    // even when the gezel content is externalized — keep it in sync so
    // installed toolsets follow the rename.
    if (this.external?.gezels) {
      const oldLocal = gezelLocalDir(this.home, oldId);
      const newLocal = gezelLocalDir(this.home, newId);
      try {
        await rename(oldLocal, newLocal);
      } catch {
        /* no local dir yet (no toolsets installed) — fine */
      }
    }
    const updated = {
      ...existing.parsed,
      frontmatter: { ...existing.parsed.frontmatter, id: newId, name: newName },
    };
    const source = serializeGezelMarkdown(updated);
    await writeFileAtomic(join(newDir, 'gezel.md'), source);
    const detail = await this.getGezel(newId);
    if (!detail) throw new Error(`agent ${newId} not found after rename`);
    await this.history?.log({
      kind: 'gezel.renamed',
      gezelId: detail.id,
      summary: `Renamed ${existing.name} → ${detail.name}`,
      details: { oldId, newId, oldName: existing.name, newName: detail.name },
    });
    return detail;
  }

  async getGezel(id: string): Promise<GezelDetail | null> {
    return this.tryGetGezel(id);
  }

  async updateGezelMarkdown(id: string, source: string): Promise<GezelDetail> {
    const dir = gezelDir(this.home, id, this.external);
    const path = join(dir, 'gezel.md');
    const before = await this.tryGetGezel(id);
    const oldRole = before?.role;
    const oldRoleBasedName = before?.roleBasedName;
    await writeFileAtomic(path, source);
    let detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after update`);
    // If the user changed `role` in the raw markdown, re-derive
    // roleBasedName so it stays consistent. Also catches the case
    // where roleBasedName was deleted from the frontmatter entirely.
    const roleChanged = detail.role !== oldRole;
    const roleBasedNameMissing = !detail.roleBasedName;
    if (roleChanged || roleBasedNameMissing) {
      const recomputed = await this.computeRoleBasedName(detail.role, id);
      if (recomputed !== detail.roleBasedName) {
        const updated = {
          ...detail.parsed,
          frontmatter: { ...detail.parsed.frontmatter, roleBasedName: recomputed },
        };
        await writeFileAtomic(path, serializeGezelMarkdown(updated));
        detail = await this.getGezel(id);
        if (!detail) throw new Error(`agent ${id} not found after roleBasedName recompute`);
      }
    }
    void oldRoleBasedName;
    return detail;
  }

  /**
   * Class-level wrapper around `pickRoleBasedName` that reads the
   * current set of in-use names from disk. Pass `excludeGezelId` when
   * recomputing for an existing gezel — its current name is removed
   * from the taken set so it can keep the same slug if nothing changed.
   */
  private async computeRoleBasedName(
    role: string | undefined,
    excludeGezelId?: string,
  ): Promise<string> {
    const all = await this.listGezels();
    const taken = new Set<string>();
    for (const g of all) {
      if (g.id === excludeGezelId) continue;
      if (g.roleBasedName) taken.add(g.roleBasedName);
    }
    return pickRoleBasedName(role, taken);
  }

  private async uniqueGezelId(base: string): Promise<string> {
    const ids = new Set((await this.listGezels()).map((gezel) => gezel.id));
    if (!ids.has(base)) return base;
    for (let i = 2; i < 10000; i++) {
      const candidate = `${base}-${i}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`gezel id collision overflow for "${base}"`);
  }

  /**
   * Patch a subset of frontmatter fields without rewriting prose sections.
   * Used for inline provider/model toggles. Pass `undefined` to leave a field
   * unchanged; pass `null` to clear it.
   */
  async updateGezelSettings(
    id: string,
    patch: {
      provider?: ProviderName | null;
      model?: string | null;
      reasoningEffort?: string | null;
      numCtx?: number | null;
      autoRecall?: boolean | null;
      font?: string | null;
      sandboxCopilot?: boolean | null;
      claudePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | null;
      /**
       * Sparse `Partial<ChatModelTuning>` override on top of the
       * catalog manifest's recommended defaults. Pass `null` to clear
       * the override entirely (return to pure catalog defaults).
       * Anything else replaces the frontmatter `tuning` field
       * wholesale — callers are expected to send the merged set they
       * want persisted.
       */
      tuning?: ChatModelTuning | null;
      /**
       * Canonical tuning-profile id this gezel uses (e.g.
       * `thinking-coding`). Pass `null` to clear (revert to template
       * default or "automatic"). Sits between `installDefault` and
       * `catalog` in the resolution stack — see {@link resolveTuning}.
       */
      tuningProfile?: string | null;
      /**
       * When true, the UI renders the gezel's custom `icon.svg` instead
       * of their parametric poppetje. Toggled from Gezel Detail. Set to
       * `null` to clear (default: render poppetje).
       */
      iconOverride?: boolean | null;
      /**
       * Overrides `config.recognition.mode` for this gezel. `null` clears the
       * override so the install default applies again.
       */
      recognition?: 'auto' | 'always' | 'off' | null;
    },
  ): Promise<GezelDetail> {
    const existing = await this.tryGetGezel(id);
    if (!existing) throw new Error(`agent ${id} not found`);
    const frontmatter = { ...existing.parsed.frontmatter };
    if (patch.provider === null) delete frontmatter.provider;
    else if (patch.provider !== undefined) frontmatter.provider = patch.provider;
    if (patch.model === null) delete frontmatter.model;
    else if (patch.model !== undefined) frontmatter.model = patch.model;
    if (patch.reasoningEffort === null) delete frontmatter.reasoningEffort;
    else if (patch.reasoningEffort !== undefined)
      frontmatter.reasoningEffort = patch.reasoningEffort;
    if (patch.numCtx === null) delete frontmatter.numCtx;
    else if (patch.numCtx !== undefined) frontmatter.numCtx = patch.numCtx;
    if (patch.autoRecall === null) delete frontmatter.autoRecall;
    else if (patch.autoRecall !== undefined) frontmatter.autoRecall = patch.autoRecall;
    if (patch.font === null) delete frontmatter.font;
    else if (patch.font !== undefined) frontmatter.font = patch.font;
    if (patch.sandboxCopilot === null) delete frontmatter.sandboxCopilot;
    else if (patch.sandboxCopilot !== undefined) frontmatter.sandboxCopilot = patch.sandboxCopilot;
    if (patch.claudePermissionMode === null) delete frontmatter.claudePermissionMode;
    else if (patch.claudePermissionMode !== undefined)
      frontmatter.claudePermissionMode = patch.claudePermissionMode;
    if (patch.tuning === null) delete frontmatter.tuning;
    else if (patch.tuning !== undefined) frontmatter.tuning = patch.tuning;
    if (patch.tuningProfile === null) delete frontmatter.tuningProfile;
    else if (patch.tuningProfile !== undefined) frontmatter.tuningProfile = patch.tuningProfile;
    if (patch.iconOverride === null) delete frontmatter.iconOverride;
    else if (patch.iconOverride !== undefined) frontmatter.iconOverride = patch.iconOverride;
    if (patch.recognition === null) delete frontmatter.recognition;
    else if (patch.recognition !== undefined) frontmatter.recognition = patch.recognition;
    const updated = { ...existing.parsed, frontmatter };
    const source = serializeGezelMarkdown(updated);
    await writeFileAtomic(join(gezelDir(this.home, id, this.external), 'gezel.md'), source);
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after settings update`);
    const changed: string[] = [];
    if (patch.provider !== undefined) changed.push('provider');
    if (patch.model !== undefined) changed.push('model');
    if (patch.reasoningEffort !== undefined) changed.push('reasoningEffort');
    if (patch.numCtx !== undefined) changed.push('numCtx');
    if (patch.autoRecall !== undefined) changed.push('autoRecall');
    if (patch.font !== undefined) changed.push('font');
    if (patch.sandboxCopilot !== undefined) changed.push('sandboxCopilot');
    if (patch.claudePermissionMode !== undefined) changed.push('claudePermissionMode');
    if (patch.tuning !== undefined) changed.push('tuning');
    if (patch.tuningProfile !== undefined) changed.push('tuningProfile');
    if (patch.iconOverride !== undefined) changed.push('iconOverride');
    if (patch.recognition !== undefined) changed.push('recognition');
    if (changed.length > 0) {
      await this.history?.log({
        kind: 'gezel.settings.updated',
        gezelId: detail.id,
        summary: `Updated ${detail.name} settings (${changed.join(', ')})`,
        details: { changed, patch },
      });
    }
    return detail;
  }

  /**
   * Replace the `defaults` map on a fixed-function gezel's frontmatter.
   * Pass `null` to clear it. Throws when the gezel isn't fixed-function
   * — `tool` and `promptKey` are template-owned and not editable from
   * this surface.
   */
  async updateGezelFixedFunctionDefaults(
    id: string,
    defaults: Record<string, unknown> | null,
  ): Promise<GezelDetail> {
    const existing = await this.tryGetGezel(id);
    if (!existing) throw new Error(`agent ${id} not found`);
    const ff = existing.parsed.frontmatter.fixedFunction;
    if (!ff) {
      throw new Error(`agent ${id} is not a fixed-function gezel`);
    }
    const next = {
      ...existing.parsed.frontmatter,
      fixedFunction: {
        ...ff,
        ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : { defaults: undefined }),
      },
    };
    if (next.fixedFunction && next.fixedFunction.defaults === undefined) {
      delete next.fixedFunction.defaults;
    }
    const updated = { ...existing.parsed, frontmatter: next };
    const source = serializeGezelMarkdown(updated);
    await writeFileAtomic(join(gezelDir(this.home, id, this.external), 'gezel.md'), source);
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after defaults update`);
    await this.history?.log({
      kind: 'gezel.settings.updated',
      gezelId: detail.id,
      summary: `Updated ${detail.name} fixed-function defaults`,
      details: { changed: ['fixedFunction.defaults'], defaults: defaults ?? null },
    });
    return detail;
  }

  /**
   * Append a trait to the gezel's frontmatter (the authoritative list of
   * active traits — rendered as the `### Traits` prompt block). Fresh
   * read-modify-write like `updateGezelSettings`. Throws on the visible
   * slot cap (8) and on duplicate normalized text.
   */
  async addGezelTrait(id: string, trait: GezelTrait): Promise<GezelDetail> {
    const existing = await this.tryGetGezel(id);
    if (!existing) throw new Error(`agent ${id} not found`);
    const traits = [...(existing.parsed.frontmatter.traits ?? [])];
    if (traits.length >= 8) {
      throw new Error(`agent ${id} already has 8 traits — retire one first`);
    }
    const normalized = trait.text.trim().toLowerCase();
    if (traits.some((t) => t.text.trim().toLowerCase() === normalized)) {
      throw new Error(`agent ${id} already has an equivalent trait`);
    }
    traits.push(trait);
    const updated = {
      ...existing.parsed,
      frontmatter: { ...existing.parsed.frontmatter, traits },
    };
    await writeFileAtomic(
      join(gezelDir(this.home, id, this.external), 'gezel.md'),
      serializeGezelMarkdown(updated),
    );
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after trait update`);
    await this.history?.log({
      kind: 'gezel.trait.adopted',
      gezelId: detail.id,
      summary: `${detail.name} adopted a trait: ${trait.text}`,
      details: { traitId: trait.id, text: trait.text, source: trait.source ?? 'manual' },
    });
    return detail;
  }

  async removeGezelTrait(id: string, traitId: string): Promise<GezelDetail> {
    const existing = await this.tryGetGezel(id);
    if (!existing) throw new Error(`agent ${id} not found`);
    const traits = existing.parsed.frontmatter.traits ?? [];
    const removed = traits.find((t) => t.id === traitId);
    if (!removed) throw new Error(`agent ${id} has no trait ${traitId}`);
    const next = traits.filter((t) => t.id !== traitId);
    const frontmatter = { ...existing.parsed.frontmatter };
    if (next.length > 0) frontmatter.traits = next;
    else delete frontmatter.traits;
    const updated = { ...existing.parsed, frontmatter };
    await writeFileAtomic(
      join(gezelDir(this.home, id, this.external), 'gezel.md'),
      serializeGezelMarkdown(updated),
    );
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after trait removal`);
    await this.history?.log({
      kind: 'gezel.trait.removed',
      gezelId: detail.id,
      summary: `${detail.name} retired a trait: ${removed.text}`,
      details: { traitId, text: removed.text },
    });
    return detail;
  }

  private async tryGetGezel(id: string): Promise<GezelDetail | null> {
    // Project-local gezels are addressed by an encoded id (`proj__…__…`).
    // Route those to the workspace `.gezel/` store; everything else is a
    // normal global gezel under `~/.gezel/gezels/<id>/`.
    const dec = decodeProjectGezelId(id);
    if (dec) return this.tryGetProjectGezel(dec.projectId, dec.localId);
    const dir = gezelDir(this.home, id, this.external);
    const storageScope = gezelStorageScope(this.home, id, this.external);
    return this.hydrateGezelDetail(id, dir, {
      ...(storageScope === 'machine-shared' ? { storageScope } : {}),
    });
  }

  /**
   * Read a gezel definition from a directory into a `GezelDetail`. Shared
   * by the global path and the project-local path; the only differences
   * are the directory and (for the canonical `@project` gezel) an
   * `aboutOverride` sourced from the workspace instruction file. The
   * poppetje is keyed by `id` — for project-local gezels that's the
   * encoded id, so the face lands in app-data under
   * `~/.gezel/gezels/<encoded-id>/poppetje.json`, never in the repo.
   */
  private async hydrateGezelDetail(
    id: string,
    dir: string,
    opts: {
      aboutOverride?: string;
      scope?: 'project';
      storageScope?: 'machine-shared';
    },
  ): Promise<GezelDetail | null> {
    const mdPath = join(dir, 'gezel.md');
    const aboutPath = join(dir, 'about.md');
    const iconPath = join(dir, 'icon.svg');
    const toolsPath = join(dir, 'tools.md');
    try {
      const [source, s] = await Promise.all([readFile(mdPath, 'utf8'), stat(mdPath)]);
      const parsed = parseGezelMarkdown(source);
      // about.md is read lazily; if it's missing (older agent) we fall back
      // to an empty string so older agents don't break. The canonical
      // `@project` gezel passes its prompt in via `aboutOverride` (read
      // live from AGENTS.md/CLAUDE.md) and never writes an about.md.
      let about = opts.aboutOverride ?? '';
      if (opts.aboutOverride === undefined) {
        try {
          about = await readFile(aboutPath, 'utf8');
        } catch {
          /* older agent without about.md */
        }
      }
      let icon: string | undefined;
      try {
        icon = await readFile(iconPath, 'utf8');
      } catch {
        /* agent has no icon yet */
      }
      // Optional power-user override file. Absent for the default
      // case (auto-injected `## Tools available this turn` block
      // takes over). Present when the user wants to fully replace
      // the auto listing — see `gezelToolsPath` in core/paths.
      let toolsMd: string | null = null;
      try {
        toolsMd = await readFile(toolsPath, 'utf8');
      } catch {
        /* default — no override file */
      }
      const name = parsed.frontmatter.name;
      // Resolve the poppetje for this gezel — self-heals on first read
      // (generates deterministically from the id, persists, returns).
      // Pass `gender` so the first generation can gate beard/mustache
      // for female gezels. Errors here are non-fatal: the UI falls back
      // to the letter avatar so the gezel still lists.
      let poppetje: import('@bendyline/gezel').Poppetje | undefined;
      try {
        poppetje = await this.poppetjes.get(id, name, parsed.frontmatter.gender);
      } catch (err) {
        log.warn(
          `[store] poppetje resolution failed for ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      // Inline the lightweight growth summary (level + pending flag) so
      // roster badges render without N+1 follow-up requests. growth.json
      // is keyed by the (possibly encoded) gezel id under app data, like
      // the poppetje.
      const growth = await this.readGrowthSummary(id);
      return {
        id,
        name,
        description: parsed.frontmatter.description,
        role: parsed.frontmatter.role,
        roleBasedName: parsed.frontmatter.roleBasedName,
        gender: parsed.frontmatter.gender,
        model: parsed.frontmatter.model,
        provider: parsed.frontmatter.provider,
        reasoningEffort: parsed.frontmatter.reasoningEffort,
        numCtx: parsed.frontmatter.numCtx,
        autoRecall: parsed.frontmatter.autoRecall,
        font: parsed.frontmatter.font,
        voice: parsed.frontmatter.voice,
        templateId: parsed.frontmatter.templateId,
        templateVersion: parsed.frontmatter.templateVersion,
        sandboxCopilot: parsed.frontmatter.sandboxCopilot,
        claudePermissionMode: parsed.frontmatter.claudePermissionMode,
        fixedFunction: parsed.frontmatter.fixedFunction,
        icon,
        poppetje,
        iconOverride: parsed.frontmatter.iconOverride,
        recognition: parsed.frontmatter.recognition,
        traits: parsed.frontmatter.traits,
        ...(growth ? { growth } : {}),
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.storageScope ? { storageScope: opts.storageScope } : {}),
        updatedAt: s.mtime.toISOString(),
        parsed,
        about,
        toolsMd,
      };
    } catch {
      return null;
    }
  }

  /* ─── Project-local gezels (workspace `.gezel/`) ────────────────────── */

  /**
   * Resolve a project-local gezel from its project's workspace `.gezel/`
   * folder. The canonical `@project` gezel (localId `project`) gets its
   * `about` from the live workspace instruction file; other project-local
   * gezels use their own `about.md`.
   */
  private async tryGetProjectGezel(
    projectId: string,
    localId: string,
  ): Promise<GezelDetail | null> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    const encodedId = encodeProjectGezelId(projectId, localId);
    const dir = projectLocalGezelDir(ws, localId);
    if (localId === PROJECT_GEZEL_LOCAL_ID) {
      const about = await this.readProjectInstructionAbout(ws);
      return this.hydrateGezelDetail(encodedId, dir, {
        aboutOverride: about ?? '',
        scope: 'project',
      });
    }
    return this.hydrateGezelDetail(encodedId, dir, { scope: 'project' });
  }

  /** Read the `.gezel/project.json` about-source mapping, if present. */
  private async readProjectLocalConfig(ws: string): Promise<ProjectLocalConfig | null> {
    try {
      const raw = await readFile(projectLocalConfigFile(ws), 'utf8');
      return ProjectLocalConfigSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Resolve the live `@project` prompt from the workspace-root instruction
   * files, honoring the `.gezel/project.json` merge mode. Precedence:
   * AGENTS.md > CLAUDE.md > .github/copilot-instructions.md. Returns null
   * when none are present.
   */
  private async readProjectInstructionAbout(ws: string): Promise<string | null> {
    const order = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'] as const;
    const present: Array<{ file: string; content: string }> = [];
    for (const file of order) {
      try {
        const content = await readFile(join(ws, file), 'utf8');
        present.push({ file, content });
      } catch {
        /* absent */
      }
    }
    if (present.length === 0) return null;
    const config = await this.readProjectLocalConfig(ws);
    if ((config?.mergeMode ?? 'primary') === 'concat') {
      return present.map((p) => `## Source: ${p.file}\n\n${p.content.trim()}`).join('\n\n---\n\n');
    }
    const chosen = config?.sourceFile
      ? (present.find((p) => p.file === config.sourceFile) ?? present[0]!)
      : present[0]!;
    return chosen.content;
  }

  /** Persist the `.gezel/project.json` about-source mapping. Gated like any workspace write. */
  async writeProjectLocalConfig(projectId: string, config: ProjectLocalConfig): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    await mkdir(projectLocalRoot(gate.workspaceDir), { recursive: true });
    await writeFileAtomic(
      projectLocalConfigFile(gate.workspaceDir),
      `${JSON.stringify(ProjectLocalConfigSchema.parse(config), null, 2)}\n`,
    );
  }

  /** Read `.gezel/imports.json` provenance; returns an empty ledger when absent. */
  async readImportProvenance(projectId: string): Promise<ImportProvenance> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return { version: 1, craftbooks: {} };
    }
    try {
      const raw = await readFile(projectLocalImportsFile(ws), 'utf8');
      return ImportProvenanceSchema.parse(JSON.parse(raw));
    } catch {
      return { version: 1, craftbooks: {} };
    }
  }

  /** Persist `.gezel/imports.json` provenance. Gated. */
  async writeImportProvenance(projectId: string, prov: ImportProvenance): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    await mkdir(projectLocalRoot(gate.workspaceDir), { recursive: true });
    await writeFileAtomic(
      projectLocalImportsFile(gate.workspaceDir),
      `${JSON.stringify(ImportProvenanceSchema.parse(prov), null, 2)}\n`,
    );
  }

  /** Read `.gezel/pending-imports.json` review queue; empty when absent. */
  async readPendingImports(projectId: string): Promise<PendingImports> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return { version: 1, items: [] };
    }
    try {
      const raw = await readFile(projectLocalPendingImportsFile(ws), 'utf8');
      return PendingImportsSchema.parse(JSON.parse(raw));
    } catch {
      return { version: 1, items: [] };
    }
  }

  /** Persist `.gezel/pending-imports.json` review queue. Gated. */
  async writePendingImports(projectId: string, pending: PendingImports): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    await mkdir(projectLocalRoot(gate.workspaceDir), { recursive: true });
    await writeFileAtomic(
      projectLocalPendingImportsFile(gate.workspaceDir),
      `${JSON.stringify(PendingImportsSchema.parse(pending), null, 2)}\n`,
    );
  }

  /**
   * Create a project-local gezel in the workspace `.gezel/gezels/` folder.
   * Mirrors {@link createGezel} (same identity helpers + poppetje
   * generation) but targets the repo-travelling store. For the canonical
   * `@project` gezel (`canonical: true`) the localId is fixed to `project`
   * and no `about.md` is written — the prompt is read live from the
   * workspace instruction file.
   */
  async createProjectGezel(
    projectId: string,
    input: {
      name: string;
      localId?: string;
      canonical?: boolean;
      description?: string;
      role?: string;
      gender?: GezelGender;
      model?: string;
      provider?: ProviderName;
      about?: string;
      frontmatter?: Partial<GezelFrontmatter>;
    },
  ): Promise<GezelDetail> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const ws = gate.workspaceDir;
    const localId = input.canonical
      ? PROJECT_GEZEL_LOCAL_ID
      : input.localId || slugify(input.name) || randomUUID().slice(0, 8);
    const encodedId = encodeProjectGezelId(projectId, localId);
    const dir = projectLocalGezelDir(ws, localId);
    await mkdir(dir, { recursive: true });
    const roleBasedName = await this.computeRoleBasedName(input.role);
    const gender = input.gender ?? inferGenderForName(input.name);
    const callerVoice = input.frontmatter?.voice;
    const voice =
      callerVoice && isValidKokoroVoice(callerVoice)
        ? callerVoice
        : pickKokoroVoiceForGender(gender, { seed: stringSeed(encodedId) });
    const source = defaultAgentMarkdown({
      id: encodedId,
      name: input.name,
      description: input.description,
      role: input.role,
      roleBasedName,
      gender,
      voice,
      model: input.model,
      extraFrontmatter: {
        ...(input.provider ? { provider: input.provider } : {}),
        ...input.frontmatter,
      },
    });
    await writeFileAtomic(join(dir, 'gezel.md'), source);
    if (!input.canonical) {
      await writeFileAtomic(
        join(dir, 'about.md'),
        input.about ?? defaultAboutMarkdown(input.name, gender),
      );
    }
    // Poppetje lands in app-data keyed by the encoded id (not the repo).
    await this.poppetjes.get(encodedId, input.name, gender);
    const detail = await this.tryGetProjectGezel(projectId, localId);
    if (!detail) throw new Error(`failed to create project gezel ${encodedId}`);
    await this.history?.log({
      kind: 'gezel.created',
      gezelId: encodedId,
      summary: `Created project gezel "${detail.name}"${detail.role ? ` (${detail.role})` : ''}`,
      details: { projectId, localId, canonical: input.canonical === true },
    });
    return detail;
  }

  /** Overwrite a project-local gezel's raw `gezel.md` (identity edits). */
  async updateProjectGezelMarkdown(
    projectId: string,
    localId: string,
    source: string,
  ): Promise<GezelDetail> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalGezelDir(gate.workspaceDir, localId);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, 'gezel.md'), source);
    const detail = await this.tryGetProjectGezel(projectId, localId);
    if (!detail) throw new Error(`project gezel ${projectId}/${localId} not found after update`);
    return detail;
  }

  /** Overwrite a (non-canonical) project-local gezel's `about.md`. */
  async updateProjectGezelAbout(
    projectId: string,
    localId: string,
    about: string,
  ): Promise<GezelDetail> {
    if (localId === PROJECT_GEZEL_LOCAL_ID) {
      throw new Error(
        'the @project gezel prompt is the workspace instruction file (AGENTS.md/CLAUDE.md); edit that file instead',
      );
    }
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalGezelDir(gate.workspaceDir, localId);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, 'about.md'), about);
    const detail = await this.tryGetProjectGezel(projectId, localId);
    if (!detail)
      throw new Error(`project gezel ${projectId}/${localId} not found after about update`);
    return detail;
  }

  /** Remove a project-local gezel's workspace definition. App-data (poppetje/sessions) is left as-is. */
  async deleteProjectGezel(projectId: string, localId: string): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalGezelDir(gate.workspaceDir, localId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* already absent */
    }
  }

  // ---------- gezel icons ----------

  async readGezelIcon(id: string): Promise<string | null> {
    const iconPath = join(gezelDir(this.home, id, this.external), 'icon.svg');
    try {
      return await readFile(iconPath, 'utf8');
    } catch {
      return null;
    }
  }

  async writeGezelIcon(id: string, svg: string): Promise<GezelDetail> {
    const dir = gezelDir(this.home, id, this.external);
    const iconPath = join(dir, 'icon.svg');
    const historyDir = join(dir, 'icons');
    await mkdir(historyDir, { recursive: true });
    // Archive the existing icon (if any) into history.
    try {
      const existing = await readFile(iconPath, 'utf8');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFileAtomic(join(historyDir, `${stamp}.svg`), existing);
    } catch {
      /* no existing icon */
    }
    // Prune history to last 5.
    const entries = await safeReaddir(historyDir);
    const svgs = entries.filter((e) => e.endsWith('.svg')).sort();
    const excess = svgs.length - 5;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        const name = svgs[i];
        if (name) {
          try {
            await writeFile(join(historyDir, name), ''); // clear first for safety
          } catch {
            /* ignore */
          }
          try {
            const { unlink } = await import('node:fs/promises');
            await unlink(join(historyDir, name));
          } catch {
            /* ignore */
          }
        }
      }
    }
    await writeFileAtomic(iconPath, svg);
    const detail = await this.getGezel(id);
    if (!detail) throw new Error(`agent ${id} not found after icon update`);
    await this.history?.log({
      kind: 'icon.generated',
      gezelId: detail.id,
      summary: `Updated ${detail.name}'s icon`,
      details: { bytes: svg.length },
    });
    return detail;
  }

  async listGezelIconHistory(
    id: string,
  ): Promise<{ current: string | null; history: Array<{ timestamp: string; svg: string }> }> {
    const dir = gezelDir(this.home, id, this.external);
    const historyDir = join(dir, 'icons');
    const current = await this.readGezelIcon(id);
    const entries = await safeReaddir(historyDir);
    const history: Array<{ timestamp: string; svg: string }> = [];
    for (const name of entries) {
      if (!name.endsWith('.svg')) continue;
      const timestamp = name.slice(0, -4);
      try {
        const svg = await readFile(join(historyDir, name), 'utf8');
        history.push({ timestamp, svg });
      } catch {
        /* skip unreadable */
      }
    }
    // Newest-first.
    history.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return { current, history };
  }

  async revertGezelIcon(id: string, timestamp: string): Promise<GezelDetail> {
    const dir = gezelDir(this.home, id, this.external);
    const historyDir = join(dir, 'icons');
    // Basic path safety: strip any separators.
    const safeStamp = timestamp.replace(/[/\\]/g, '');
    const historicalPath = join(historyDir, `${safeStamp}.svg`);
    let svg: string;
    try {
      svg = await readFile(historicalPath, 'utf8');
    } catch {
      throw new Error(`icon variant ${timestamp} not found for agent ${id}`);
    }
    const detail = await this.writeGezelIcon(id, svg);
    await this.history?.log({
      kind: 'icon.reverted',
      gezelId: detail.id,
      summary: `Reverted ${detail.name}'s icon to ${timestamp}`,
      details: { timestamp },
    });
    return detail;
  }

  // ---------- projects ----------

  async listProjects(): Promise<Project[]> {
    const p = gezelPaths(this.home);
    const shared = activeMachineSharedHome();
    const [userDirs, sharedDirs] = await Promise.all([
      safeReaddir(p.projects),
      shared ? safeReaddir(join(shared, 'projects')) : Promise.resolve([]),
    ]);
    const localDefinitions = new Set<string>();
    for (const id of userDirs) {
      try {
        await stat(join(p.projects, id, 'project.json'));
        localDefinitions.add(id);
      } catch {
        // A definition-less leftover must not hide a migrated project.
      }
    }
    const dirs = Array.from(
      new Set([...localDefinitions, ...sharedDirs.filter((id) => !localDefinitions.has(id))]),
    );
    const metas = await Promise.all(dirs.map((id) => this.tryGetProjectMeta(id)));
    const projects = metas.filter((m): m is Project => m !== null);
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  }

  async createProject(
    input: {
      name: string;
      description?: string;
      /** Written to documents/about.md at creation. */
      about?: string;
      /** Written to documents/missionObjectives.md at creation. */
      missionObjectives?: string;
      workingDir?: string;
      /** `crew` (default) or `solo`. Persisted to `project.json`. */
      mode?: 'crew' | 'solo';
      /** Missing/true indexes the workspace; false opts the project out. */
      indexingEnabled?: boolean;
      /** Optional GitHub link. Just `{ url }` at creation; `branch` /
       *  `checkoutDir` / `lastSyncedAt` are populated later by the
       *  GitHub manager once a clone runs. */
      github?: { url: string };
    },
    opts?: {
      /** Internal transaction hook: preselect an already-collision-checked id. */
      id?: string;
    },
  ): Promise<ProjectDetail> {
    const release = await this.acquireProjectCreationLock();
    try {
      const id =
        opts?.id ?? (await this.uniqueProjectId(slugify(input.name) || randomUUID().slice(0, 8)));
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        throw new Error(`invalid project id "${id}"`);
      }
      const localDir = projectLocalDir(this.home, id);
      const externalDir = projectDir(this.home, id, this.external);
      await mkdir(localDir, { recursive: true });
      await mkdir(externalDir, { recursive: true });
      await mkdir(projectArtifactsDir(this.home, id, this.external), { recursive: true });
      await mkdir(join(localDir, 'workspace'), { recursive: true });
      await mkdir(join(localDir, 'workdir'), { recursive: true });
      await writeFileAtomic(
        join(localDir, 'package.json'),
        `${JSON.stringify({ name: `gezel-project-${id}`, private: true, version: '0.0.0' }, null, 2)}\n`,
      );
      // Seed the internal workspace with a Node + TypeScript baseline so
      // gezels can immediately `writeFile('src/…')` + `run_nodejs_script`
      // without first having to reinvent package.json / tsconfig.json.
      // External working dirs are left alone — that's the user's repo.
      // GitHub-linked projects: the clone will populate the real files,
      // so seeding a template here would only confuse the Workspace tab.
      if (!input.workingDir && !input.github?.url) {
        await bootstrapWorkspace({
          workspaceDir: join(localDir, 'workspace'),
          projectId: id,
          projectName: input.name,
        });
      }
      const project: Project = {
        id,
        name: input.name,
        description: input.description,
        ...(input.workingDir ? { workingDir: input.workingDir } : {}),
        ...(input.mode && input.mode !== 'crew' ? { mode: input.mode } : {}),
        ...(input.indexingEnabled !== undefined ? { indexingEnabled: input.indexingEnabled } : {}),
        ...(input.github?.url ? { github: { url: input.github.url } } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await writeFileAtomic(
        projectMetaFile(this.home, id),
        `${JSON.stringify(project, null, 2)}\n`,
      );
      // Required metadata per the new schema — any caller going through
      // `CreateProjectRequestSchema` supplies both. Keep them as *optional*
      // at the Store boundary so internal callers (e.g. `ensureDefaultProject`)
      // that don't need a full about can still create a blank project.
      if (input.about) {
        await this.writeProjectDoc(id, 'about.md', input.about);
      }
      if (input.missionObjectives) {
        await this.writeProjectDoc(id, 'missionObjectives.md', input.missionObjectives);
      }
      await this.history?.log({
        kind: 'project.created',
        projectId: id,
        summary: `Created project "${project.name}"`,
        details: {
          name: project.name,
          description: project.description,
          workingDir: project.workingDir,
          ...(project.indexingEnabled !== undefined
            ? { indexingEnabled: project.indexingEnabled }
            : {}),
          ...(project.github?.url ? { githubUrl: project.github.url } : {}),
        },
      });
      return {
        ...project,
        packages: [],
        ...(input.about ? { about: input.about } : {}),
        ...(input.missionObjectives ? { missionObjectives: input.missionObjectives } : {}),
      };
    } finally {
      release();
    }
  }

  private async uniqueProjectId(base: string): Promise<string> {
    // Guard on the project *directory*, not just `project.json`: a safe-deleted
    // project leaves its workspace/artifacts behind under the old id, so a
    // later same-named project must claim a fresh id rather than mkdir over
    // (and re-adopt) those orphaned files. See {@link deleteProject}.
    if (!(await pathExists(projectLocalDir(this.home, base)))) return base;
    for (let i = 2; i < 10000; i++) {
      const candidate = `${base}-${i}`;
      if (!(await pathExists(projectLocalDir(this.home, candidate)))) return candidate;
    }
    throw new Error(`project id collision overflow for "${base}"`);
  }

  async getProject(id: string): Promise<ProjectDetail | null> {
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) return null;
    const packages = await this.readInstalledPackages(id);
    const [about, missionObjectives] = await Promise.all([
      this.readProjectDoc(id, 'about.md'),
      this.readProjectDoc(id, 'missionObjectives.md'),
    ]);
    return {
      ...meta,
      packages,
      ...(about !== null ? { about } : {}),
      ...(missionObjectives !== null ? { missionObjectives } : {}),
    };
  }

  /**
   * Cheap metadata-only read for workspace-index admission gates. Avoids the
   * package/about/mission reads performed by `getProject` on hot status and
   * background-refresh paths.
   */
  async projectIndexingEnabled(id: string): Promise<boolean> {
    const meta = await this.tryGetProjectMeta(id);
    return meta?.indexingEnabled !== false;
  }

  /** Read durable lifecycle state for indexed findings in one project. */
  async readProjectFindingLifecycle(id: string): Promise<ProjectFindingLifecycle> {
    const file = projectFindingLifecycleFile(this.home, id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return {};
    }
    const raw = (parsed as { findings?: unknown } | null)?.findings;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const findings: ProjectFindingLifecycle = {};
    for (const [fingerprint, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (row.status !== 'open' && row.status !== 'in_progress' && row.status !== 'resolved') {
        continue;
      }
      findings[fingerprint] = {
        status: row.status,
        ...(typeof row.taskRef === 'string' ? { taskRef: row.taskRef } : {}),
        ...(typeof row.resolvedAt === 'string' ? { resolvedAt: row.resolvedAt } : {}),
      };
    }
    return findings;
  }

  private async writeProjectFindingLifecycle(
    id: string,
    findings: ProjectFindingLifecycle,
  ): Promise<void> {
    const body: ProjectFindingLifecycleFile = { version: 1, findings };
    await writeFileAtomic(
      projectFindingLifecycleFile(this.home, id),
      `${JSON.stringify(body, null, 2)}\n`,
    );
  }

  async setProjectFindingStatus(
    id: string,
    fingerprint: string,
    status: ProjectFindingStatus,
    taskRef?: string,
  ): Promise<void> {
    await this.withFindingLifecycleLock(id, async () => {
      const findings = await this.readProjectFindingLifecycle(id);
      findings[fingerprint] = {
        status,
        ...(taskRef ? { taskRef } : {}),
        ...(status === 'resolved' ? { resolvedAt: nowIso() } : {}),
      };
      await this.writeProjectFindingLifecycle(id, findings);
    });
  }

  async settleProjectFindingsForTask(
    id: string,
    taskRef: string,
    outcome: 'complete' | 'canceled',
  ): Promise<number> {
    return this.withFindingLifecycleLock(id, async () => {
      const findings = await this.readProjectFindingLifecycle(id);
      let changed = 0;
      for (const [fingerprint, row] of Object.entries(findings)) {
        if (row.taskRef !== taskRef || row.status !== 'in_progress') continue;
        findings[fingerprint] =
          outcome === 'complete'
            ? { status: 'resolved', taskRef, resolvedAt: nowIso() }
            : { status: 'open' };
        changed++;
      }
      if (changed > 0) await this.writeProjectFindingLifecycle(id, findings);
      return changed;
    });
  }

  /** Remove lifecycle rows after a completed scan proves a finding is gone. */
  async reconcileProjectFindingLifecycle(id: string, liveFingerprints: Set<string>): Promise<void> {
    await this.withFindingLifecycleLock(id, async () => {
      const findings = await this.readProjectFindingLifecycle(id);
      let changed = false;
      for (const fingerprint of Object.keys(findings)) {
        if (liveFingerprints.has(fingerprint)) continue;
        delete findings[fingerprint];
        changed = true;
      }
      if (changed) await this.writeProjectFindingLifecycle(id, findings);
    });
  }

  private async withFindingLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.findingLifecycleLocks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tracked: Promise<unknown> = run.finally(() => {
      if (this.findingLifecycleLocks.get(id) === tracked) {
        this.findingLifecycleLocks.delete(id);
      }
    });
    this.findingLifecycleLocks.set(id, tracked);
    return run;
  }

  async touchProject(id: string): Promise<void> {
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) return;
    const updated: Project = { ...meta, updatedAt: nowIso() };
    await writeFileAtomic(projectMetaFile(this.home, id), `${JSON.stringify(updated, null, 2)}\n`);
  }

  /**
   * A project `workingDir` is settable by the model (via `update_project`)
   * and flows into spawn cwds, git operations, and the OS "reveal in file
   * manager" launcher. Reject values that are never a legitimate path:
   * control characters (NUL / newline / CR are classic argument- and
   * log-injection vectors) and non-absolute paths. The reveal launcher
   * also uses execFile + argv, so this is defense-in-depth, not the sole
   * guard against the original `exec("open \"${dir}\"")` injection.
   */
  private assertSafeWorkingDir(workingDir: string): void {
    if (workingDir === '') return;
    for (let i = 0; i < workingDir.length; i++) {
      if (workingDir.charCodeAt(i) < 0x20) {
        throw new Error('workingDir must not contain control characters');
      }
    }
    if (!isAbsolute(workingDir)) {
      throw new Error('workingDir must be an absolute path');
    }
  }

  async updateProjectWorkingDir(id: string, workingDir?: string): Promise<ProjectDetail> {
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) throw new Error(`project ${id} not found`);
    if (typeof workingDir === 'string') this.assertSafeWorkingDir(workingDir);
    // Same auto-link as updateProject — pointing workingDir at an
    // existing github clone wires up the github link without an extra
    // round-trip from the UI.
    let nextGitHub = meta.github;
    if (workingDir && workingDir.length > 0) {
      const detected = await autoDetectGitHubLink(workingDir, nextGitHub);
      if (detected) nextGitHub = detected;
    }
    const updated: Project = {
      ...meta,
      workingDir: workingDir || undefined,
      ...(nextGitHub !== meta.github ? { github: nextGitHub } : {}),
      updatedAt: nowIso(),
    };
    await writeFileAtomic(projectMetaFile(this.home, id), `${JSON.stringify(updated, null, 2)}\n`);
    const detail = await this.getProject(id);
    if (!detail) throw new Error(`project ${id} not found after update`);
    return detail;
  }

  /**
   * Patch any subset of project metadata. `workingDir: null` clears the
   * external path (falls back to internal); omit the key to leave it alone.
   * `github: null` unlinks the repo entirely; passing `{ url, branch? }`
   * links/relinks (the link is a user-supplied claim — actual cloning is
   * driven separately by the GitManager).
   */
  async updateProject(
    id: string,
    patch: {
      name?: string;
      description?: string;
      workingDir?: string | null;
      voormanGezelId?: string | null;
      voormanAutoAssignedAt?: string;
      about?: string;
      missionObjectives?: string;
      github?: { url?: string; branch?: string } | null;
      /** Email association — `null` clears it. */
      mail?: ProjectMail | null;
      /** External-data connector bindings — `null` clears them. */
      connectors?: import('@bendyline/gezel').ProjectConnectorBinding[] | null;
      allowGezelWrites?: boolean;
      /** Replaces the stored per-project ambient nudge override. */
      nudgeConfig?: ProjectNudgeConfig;
      /** Replaces the optional project-tab visibility overrides. */
      tabVisibility?: ProjectTabVisibility;
      /** Project shape — `solo` (a single-gezel job/game) vs `crew`. */
      mode?: 'crew' | 'solo';
      /** Custom project-lead label (e.g. checkers → "Opponent"); `null` clears it. */
      leadLabel?: string | null;
      /** Lean-agent profile — minimal tools + prompt for focused single-purpose gezels. */
      leanProfile?: boolean;
      /** Missing/true indexes the workspace; false opts the project out. */
      indexingEnabled?: boolean;
      workspaceScriptTimeoutMs?: number;
      status?: 'active' | 'readonly' | 'inactive' | 'stable';
      grantedCredentials?: string[];
      credentialAllowedOrigins?: Record<string, string[]>;
      /** `null` clears the user override (back to auto-detection). */
      projectTypeId?: string | null;
      detectedProjectType?: { id: string; score: number; scannedAt: string };
      /** Custom project-type provenance stamped on adoption; `null` clears it. */
      projectType?: import('@bendyline/gezel').ProjectTypeProvenance | null;
      /**
       * Merge into the project's shared configuration bag (see core
       * `project-properties.ts`). Empty-string values delete the key;
       * unmentioned keys are untouched.
       */
      properties?: Record<string, string>;
    },
  ): Promise<ProjectDetail> {
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) throw new Error(`project ${id} not found`);
    if (typeof patch.workingDir === 'string') this.assertSafeWorkingDir(patch.workingDir);
    let nextGitHub = mergeGitHubPatch(meta.github, patch.github);
    // Auto-link: if the user is pointing workingDir at an existing
    // github clone, populate the github link silently (origin URL +
    // checkoutDir). Skip if the user explicitly passed a different
    // github URL in the same patch.
    if (
      typeof patch.workingDir === 'string' &&
      patch.workingDir.length > 0 &&
      patch.github !== null
    ) {
      const detected = await autoDetectGitHubLink(patch.workingDir, nextGitHub);
      if (detected) nextGitHub = detected;
    }
    const updated: Project = {
      ...meta,
      updatedAt: nowIso(),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.workingDir === null
        ? { workingDir: undefined }
        : patch.workingDir !== undefined
          ? { workingDir: patch.workingDir }
          : {}),
      ...(patch.voormanGezelId === null
        ? { voormanGezelId: undefined }
        : patch.voormanGezelId !== undefined
          ? { voormanGezelId: patch.voormanGezelId }
          : {}),
      ...(patch.voormanAutoAssignedAt !== undefined
        ? { voormanAutoAssignedAt: patch.voormanAutoAssignedAt }
        : {}),
      ...(patch.github !== undefined ? { github: nextGitHub } : {}),
      ...(patch.mail === null
        ? { mail: undefined }
        : patch.mail !== undefined
          ? { mail: patch.mail }
          : {}),
      ...(patch.connectors === null
        ? { connectors: undefined }
        : patch.connectors !== undefined
          ? { connectors: patch.connectors }
          : {}),
      ...(patch.allowGezelWrites !== undefined ? { allowGezelWrites: patch.allowGezelWrites } : {}),
      ...(patch.nudgeConfig !== undefined ? { nudgeConfig: patch.nudgeConfig } : {}),
      ...(patch.tabVisibility !== undefined ? { tabVisibility: patch.tabVisibility } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.leadLabel === null
        ? { leadLabel: undefined }
        : patch.leadLabel !== undefined
          ? { leadLabel: patch.leadLabel }
          : {}),
      ...(patch.leanProfile !== undefined ? { leanProfile: patch.leanProfile } : {}),
      ...(patch.indexingEnabled !== undefined ? { indexingEnabled: patch.indexingEnabled } : {}),
      ...(patch.workspaceScriptTimeoutMs !== undefined
        ? { workspaceScriptTimeoutMs: patch.workspaceScriptTimeoutMs }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.grantedCredentials !== undefined
        ? { grantedCredentials: patch.grantedCredentials }
        : {}),
      ...(patch.credentialAllowedOrigins !== undefined
        ? { credentialAllowedOrigins: patch.credentialAllowedOrigins }
        : {}),
      ...(patch.projectTypeId === null
        ? { projectTypeId: undefined }
        : patch.projectTypeId !== undefined
          ? { projectTypeId: patch.projectTypeId }
          : {}),
      ...(patch.detectedProjectType !== undefined
        ? { detectedProjectType: patch.detectedProjectType }
        : {}),
      ...(patch.projectType === null
        ? { projectType: undefined }
        : patch.projectType !== undefined
          ? { projectType: patch.projectType }
          : {}),
      ...(patch.properties !== undefined
        ? { properties: mergeProjectProperties(meta.properties, patch.properties) }
        : {}),
    };
    if (updated.properties && Object.keys(updated.properties).length === 0) {
      delete (updated as Partial<Project>).properties;
    }
    await writeFileAtomic(projectMetaFile(this.home, id), `${JSON.stringify(updated, null, 2)}\n`);
    if (patch.properties !== undefined) {
      await this.history?.log({
        kind: 'project.properties.updated',
        projectId: id,
        summary: `Project properties updated on "${meta.name}" (${Object.keys(patch.properties).join(', ')})`,
        details: { values: patch.properties },
      });
    }
    if (patch.about !== undefined) {
      await this.writeProjectDoc(id, 'about.md', patch.about);
    }
    if (patch.missionObjectives !== undefined) {
      await this.writeProjectDoc(id, 'missionObjectives.md', patch.missionObjectives);
    }
    const detail = await this.getProject(id);
    if (!detail) throw new Error(`project ${id} not found after update`);
    // Fan out into specific events so the UI and MCP filters can target them.
    const metaChanged: string[] = [];
    if (patch.name !== undefined && patch.name !== meta.name) metaChanged.push('name');
    if (patch.description !== undefined && patch.description !== meta.description)
      metaChanged.push('description');
    if (patch.workingDir !== undefined) metaChanged.push('workingDir');
    if (
      patch.nudgeConfig !== undefined &&
      !isDeepStrictEqual(patch.nudgeConfig, meta.nudgeConfig)
    ) {
      metaChanged.push('nudgeConfig');
    }
    if (
      patch.tabVisibility !== undefined &&
      !isDeepStrictEqual(patch.tabVisibility, meta.tabVisibility)
    ) {
      metaChanged.push('tabVisibility');
    }
    if (
      patch.indexingEnabled !== undefined &&
      patch.indexingEnabled !== (meta.indexingEnabled !== false)
    ) {
      metaChanged.push('indexingEnabled');
    }
    if (metaChanged.length > 0) {
      await this.history?.log({
        kind: 'project.updated',
        projectId: id,
        summary: `Updated project "${detail.name}" (${metaChanged.join(', ')})`,
        details: { changed: metaChanged, patch },
      });
    }
    if (patch.status !== undefined && patch.status !== (meta.status ?? 'active')) {
      const previous = meta.status ?? 'active';
      await this.history?.log({
        kind: 'project.status.changed',
        projectId: id,
        summary: `Project "${detail.name}" status: ${previous} → ${patch.status}`,
        details: { previousStatus: previous, status: patch.status },
      });
    }
    if (patch.voormanGezelId !== undefined) {
      // The summary names the gezel — their id is a slug that reads as
      // plumbing in the History view; ids stay in `details`.
      const voormanName = patch.voormanGezelId
        ? ((await this.getGezel(patch.voormanGezelId).catch(() => null))?.name ??
          patch.voormanGezelId)
        : null;
      await this.history?.log({
        kind: 'project.voorman.changed',
        projectId: id,
        summary: voormanName
          ? `Set voorman of "${detail.name}" to ${voormanName}`
          : `Cleared voorman of "${detail.name}"`,
        details: {
          previousVoormanGezelId: meta.voormanGezelId,
          voormanGezelId: patch.voormanGezelId,
        },
      });
      // Promoting a gezel to voorman implies project membership. The
      // roster is advisory, so we do this even for solo projects (the
      // ambachtsman is the only member). Idempotent — no-op when the
      // gezel was already on the roster from a prior interaction.
      if (patch.voormanGezelId) {
        await this.addGezelToProject(id, patch.voormanGezelId, {
          source: 'voorman',
        }).catch((err) => {
          log.warn(
            `[store] roster auto-add (voorman) failed for ${id}/${patch.voormanGezelId}:`,
            err,
          );
        });
      }
    }
    if (patch.about !== undefined) {
      await this.history?.log({
        kind: 'project.about.updated',
        projectId: id,
        summary: `Updated about for project "${detail.name}"`,
        details: { bytes: patch.about.length },
      });
    }
    if (patch.missionObjectives !== undefined) {
      await this.history?.log({
        kind: 'project.mission.updated',
        projectId: id,
        summary: `Updated mission objectives for project "${detail.name}"`,
        details: { bytes: patch.missionObjectives.length },
      });
    }
    if (patch.github !== undefined) {
      const previousUrl = meta.github?.url;
      const nextUrl = nextGitHub?.url;
      if (patch.github === null || !nextUrl) {
        if (previousUrl) {
          await this.history?.log({
            kind: 'project.github.unlinked',
            projectId: id,
            summary: `Unlinked GitHub repo from "${detail.name}"`,
            details: { previousUrl },
          });
        }
      } else if (previousUrl !== nextUrl) {
        await this.history?.log({
          kind: 'project.github.linked',
          projectId: id,
          summary: `Linked "${detail.name}" to ${nextUrl}`,
          details: { previousUrl, url: nextUrl, branch: nextGitHub?.branch },
        });
      }
    }
    if (patch.allowGezelWrites !== undefined && patch.allowGezelWrites !== meta.allowGezelWrites) {
      await this.history?.log({
        kind: 'workspace.allow-writes.changed',
        projectId: id,
        summary: patch.allowGezelWrites
          ? `Enabled gezel workspace writes on "${detail.name}"`
          : `Disabled gezel workspace writes on "${detail.name}"`,
        details: {
          previousValue: meta.allowGezelWrites ?? false,
          value: patch.allowGezelWrites,
          workingDir: detail.workingDir,
        },
      });
    }
    return detail;
  }

  /**
   * Delete a project. Two tiers, because the user's own files must never be
   * destroyed silently:
   *
   *   - **Always:** the project record disappears from every listing. When
   *     `removeWorkspace` is falsy we only drop `project.json` — the internal
   *     workspace + artifacts survive on disk (recoverable), and an external
   *     `workingDir` is of course never touched.
   *   - **Opt-in (`removeWorkspace: true`):** the internal workspace +
   *     artifacts + all gezel bookkeeping are permanently removed. This is
   *     honored ONLY when the workspace is gezel-internal. A project pointing
   *     at an external `workingDir` (or a github checkout) never has that
   *     directory removed regardless of the flag — the server is the backstop
   *     for the UI's guess.
   *
   * The surviving directory (safe-delete case) keeps its slot occupied so
   * {@link uniqueProjectId} never re-adopts orphaned files under a later
   * same-named project. The `default` project can't be deleted — the app
   * always needs one.
   */
  async deleteProject(
    id: string,
    opts?: { removeWorkspace?: boolean },
  ): Promise<{
    name: string;
    removedWorkspace: boolean;
    workspaceSource: 'workingDir' | 'githubCheckout' | 'internal';
  }> {
    if (id === 'default') {
      throw new ProjectDeleteError('The default project cannot be deleted.', 'default_project');
    }
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) {
      throw new ProjectDeleteError(`project ${id} not found`, 'not_found');
    }
    if (meta.storageScope === 'machine-shared') {
      throw new ProjectDeleteError(
        'Machine-shared projects cannot be removed from an individual account. Shared removal is not available yet.',
        'machine_shared',
      );
    }
    const { source } = this.resolveWorkspaceDir(id, meta);
    const removeWorkspace = !!opts?.removeWorkspace && source === 'internal';

    const localDir = projectLocalDir(this.home, id);
    const externalDir = projectDir(this.home, id, this.external);

    if (removeWorkspace) {
      await rm(externalDir, { recursive: true, force: true });
      if (externalDir !== localDir) {
        await rm(localDir, { recursive: true, force: true });
      }
    } else {
      // Drop only the metadata so the project vanishes from listings while
      // the workspace + artifacts stay on disk for the user to recover.
      await rm(projectMetaFile(this.home, id), { force: true });
    }

    await this.history?.log({
      kind: 'project.deleted',
      projectId: id,
      summary: `Deleted project "${meta.name}"${removeWorkspace ? ' and its workspace' : ''}`,
      details: { name: meta.name, removedWorkspace: removeWorkspace, workspaceSource: source },
    });

    return { name: meta.name, removedWorkspace: removeWorkspace, workspaceSource: source };
  }

  /**
   * Update the service-managed fields of `project.github`. When `patch.url`
   * is supplied, this may also create the link after an explicit clone path
   * such as `fetch_repo`, which intentionally creates the project before
   * linking it to avoid the background auto-clone race.
   */
  /**
   * Add a gezel to a project's `gezelIds` roster. Idempotent — calling
   * twice for the same (project, gezel) pair is a no-op on the second
   * call and returns `{ added: false }`. Logs a `project.gezel.joined`
   * history event on the first add only, with `details.source`
   * carrying the trigger (`'voorman' | 'session' | 'message' | 'task'
   * | 'manual'`) so the audit trail captures *why* the gezel showed
   * up in the roster.
   *
   * Permissive: missing project → no-op (matches `writeProjectNudgeState`);
   * missing gezel → still adds the id and logs with the id as the
   * display name. Existence checks belong at the MCP/HTTP boundary so
   * a "Reassigned to a now-deleted gezel" auto-add path doesn't throw
   * across the chat hot path. Does NOT touch `updatedAt` — roster
   * joins are bookkeeping, not "project had activity" in the sense the
   * nudge scheduler cares about.
   */
  async addGezelToProject(
    projectId: string,
    gezelId: string,
    opts?: {
      source?: 'voorman' | 'session' | 'message' | 'task' | 'manual';
    },
  ): Promise<{ added: boolean }> {
    const meta = await this.tryGetProjectMeta(projectId);
    if (!meta) return { added: false };
    const current = meta.gezelIds ?? [];
    if (current.includes(gezelId)) return { added: false };
    const updated: Project = {
      ...meta,
      gezelIds: [...current, gezelId],
    };
    await writeFileAtomic(
      projectMetaFile(this.home, projectId),
      `${JSON.stringify(updated, null, 2)}\n`,
    );
    const gezel = await this.getGezel(gezelId).catch(() => null);
    await this.history?.log({
      kind: 'project.gezel.joined',
      projectId,
      gezelId,
      summary: `${gezel?.name ?? gezelId} joined "${meta.name}"`,
      details: { source: opts?.source ?? 'manual' },
    });
    return { added: true };
  }

  /**
   * Remove a gezel from a project's `gezelIds` roster. Idempotent —
   * returns `{ removed: false }` when the gezel wasn't a member. Does
   * NOT cascade: existing chat sessions, task assignments, or the
   * `voormanGezelId` pointer are left intact. The roster is advisory;
   * dropping someone from it just stops surfacing them as part of the
   * project's "team" — it doesn't revoke any access.
   */
  async removeGezelFromProject(
    projectId: string,
    gezelId: string,
    opts?: {
      source?: 'manual';
    },
  ): Promise<{ removed: boolean }> {
    const meta = await this.tryGetProjectMeta(projectId);
    if (!meta) return { removed: false };
    const current = meta.gezelIds ?? [];
    if (!current.includes(gezelId)) return { removed: false };
    const updated: Project = {
      ...meta,
      gezelIds: current.filter((id) => id !== gezelId),
    };
    await writeFileAtomic(
      projectMetaFile(this.home, projectId),
      `${JSON.stringify(updated, null, 2)}\n`,
    );
    const gezel = await this.getGezel(gezelId).catch(() => null);
    await this.history?.log({
      kind: 'project.gezel.left',
      projectId,
      gezelId,
      summary: `${gezel?.name ?? gezelId} left "${meta.name}"`,
      details: { source: opts?.source ?? 'manual' },
    });
    return { removed: true };
  }

  /**
   * Add or remove a suggested-work key on the project's dismissal list
   * ("don't offer this again here"). Advisory UI state, same spirit as
   * the roster: idempotent, missing project → no-op, does NOT touch
   * `updatedAt`.
   */
  async setSuggestedWorkDismissed(
    projectId: string,
    key: string,
    dismissed: boolean,
  ): Promise<{ changed: boolean }> {
    const meta = await this.tryGetProjectMeta(projectId);
    if (!meta) return { changed: false };
    const current = meta.suggestedWorkDismissed ?? [];
    if (dismissed === current.includes(key)) return { changed: false };
    const next = dismissed ? [...current, key] : current.filter((k) => k !== key);
    const updated: Project = {
      ...meta,
      ...(next.length > 0 ? { suggestedWorkDismissed: next } : {}),
    };
    if (next.length === 0) delete (updated as Partial<Project>).suggestedWorkDismissed;
    await writeFileAtomic(
      projectMetaFile(this.home, projectId),
      `${JSON.stringify(updated, null, 2)}\n`,
    );
    return { changed: true };
  }

  /**
   * Patch the project's `nudgeState` without touching `updatedAt`. The
   * ambient-nudge scheduler uses this after every nudge decision —
   * bumping `updatedAt` here would be a false positive for "project had
   * activity", fooling its own rapid-vs-slow logic on the next sweep.
   */
  async writeProjectNudgeState(
    id: string,
    nudgeState: NonNullable<Project['nudgeState']>,
  ): Promise<void> {
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) return;
    const updated: Project = { ...meta, nudgeState };
    await writeFileAtomic(projectMetaFile(this.home, id), `${JSON.stringify(updated, null, 2)}\n`);
  }

  /**
   * Per-project last-activity stamp (`activity.json`), maintained by the
   * ActivityTracker. Same discipline as `writeProjectNudgeState`: an
   * ambient write that must never bump `project.updatedAt`.
   */
  async readProjectActivity(id: string): Promise<ProjectActivity | null> {
    try {
      const raw = JSON.parse(await readFile(projectActivityFile(this.home, id), 'utf8'));
      const parsed = ProjectActivitySchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async writeProjectActivity(id: string, activity: ProjectActivity): Promise<void> {
    await writeFileAtomic(
      projectActivityFile(this.home, id),
      `${JSON.stringify(activity, null, 2)}\n`,
    );
  }

  // ---------- meester status report ----------

  async readMeesterStatus(): Promise<MeesterStatusReport | null> {
    try {
      const raw = JSON.parse(await readFile(meesterStatusFile(this.home), 'utf8'));
      const parsed = MeesterStatusReportSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async writeMeesterStatus(report: MeesterStatusReport): Promise<void> {
    await mkdir(meesterStatusDir(this.home), { recursive: true });
    await writeFileAtomic(meesterStatusFile(this.home), `${JSON.stringify(report, null, 2)}\n`);
  }

  async readMeesterStatusState(): Promise<MeesterStatusState> {
    try {
      const raw = JSON.parse(await readFile(meesterStatusStateFile(this.home), 'utf8'));
      const parsed = MeesterStatusStateSchema.safeParse(raw);
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async writeMeesterStatusState(state: MeesterStatusState): Promise<void> {
    await mkdir(meesterStatusDir(this.home), { recursive: true });
    await writeFileAtomic(meesterStatusStateFile(this.home), `${JSON.stringify(state, null, 2)}\n`);
  }

  async updateProjectGitHub(id: string, patch: Partial<ProjectGitHub>): Promise<void> {
    const meta = await this.tryGetProjectMeta(id);
    if (!meta) return;
    const url = patch.url ?? meta.github?.url;
    if (!url) return;
    const nextGitHub: ProjectGitHub = { ...(meta.github ?? { url }), ...patch, url };
    const updated: Project = {
      ...meta,
      updatedAt: nowIso(),
      github: nextGitHub,
    };
    await writeFileAtomic(projectMetaFile(this.home, id), `${JSON.stringify(updated, null, 2)}\n`);
    if (patch.lastSyncedAt) {
      await this.history?.log({
        kind: 'project.github.synced',
        projectId: id,
        summary: `Synced GitHub repo for "${meta.name}"`,
        details: {
          url: nextGitHub.url,
          branch: nextGitHub.branch,
          checkoutDir: nextGitHub.checkoutDir,
        },
      });
    }
  }

  // ---------- project documents (per-project prose) ----------

  /**
   * Per-project document folder — used for well-known docs like about.md and
   * missionObjectives.md. Distinct from the global ~/.gezel/documents library.
   */
  projectDocsDir(id: string): string {
    return projectDocsDir(this.home, id, this.external);
  }

  async readProjectDoc(id: string, name: string): Promise<string | null> {
    const dir = this.projectDocsDir(id);
    const full = safeJoin(dir, name);
    if (!full) return null;
    try {
      return await readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  async writeProjectDoc(id: string, name: string, content: string): Promise<void> {
    const dir = this.projectDocsDir(id);
    const full = safeJoin(dir, name);
    if (!full) throw new Error('path traversal blocked');
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
  }

  private async tryGetProjectMeta(id: string): Promise<Project | null> {
    let raw: string;
    try {
      raw = await readFile(projectMetaFile(this.home, id), 'utf8');
    } catch (err) {
      // ENOENT is the normal "no such project" path — this is a `try` getter
      // and callers rely on null for not-found, so stay quiet. Any OTHER fs
      // error (EMFILE / EIO / EACCES under load) is a TRANSIENT failure that
      // silently degrades a real project to null — the class of blip that
      // used to strip a live session's project-type script tools on rebuild.
      // Log those so the next regression leaves a breadcrumb.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        log.warn(
          `[store] project.json read for ${id} failed (${code ?? 'unknown'}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(
        `[store] project.json for ${id} is not valid JSON:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    const result = ProjectSchema.safeParse(parsed);
    if (!result.success) {
      log.warn(`[store] project.json for ${id} failed schema validation:`, result.error.message);
      return null;
    }
    return projectStorageScope(this.home, id) === 'machine-shared'
      ? { ...result.data, storageScope: 'machine-shared' }
      : result.data;
  }

  // ---------- project artifacts ----------

  projectArtifactsDir(id: string): string {
    return this.artifacts.projectArtifactsDir(id);
  }

  async listProjectArtifacts(id: string, subpath = ''): Promise<ProjectFileEntry[]> {
    return this.artifacts.listProjectArtifacts(id, subpath);
  }

  async listProjectArtifactsRecursive(
    id: string,
    opts?: { withStats?: boolean },
  ): Promise<ProjectFileEntry[]> {
    return this.artifacts.listProjectArtifactsRecursive(id, opts);
  }

  async listProjectArtifactsRecursiveDetailed(
    id: string,
    opts?: { withStats?: boolean },
  ): Promise<WalkDirResult> {
    return this.artifacts.listProjectArtifactsRecursiveDetailed(id, opts);
  }

  async readProjectArtifact(id: string, filePath: string): Promise<string | null> {
    return this.artifacts.readProjectArtifact(id, filePath);
  }

  /**
   * Read an artifact as raw bytes plus a MIME type guess (from the file
   * extension). Used by binary consumers — e.g. the image-layer resolver
   * in the render pipeline — that need to embed an artifact as a data
   * URL without UTF-8 round-tripping.
   */
  async readProjectArtifactBinary(
    id: string,
    filePath: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    return this.artifacts.readProjectArtifactBinary(id, filePath);
  }

  /**
   * Flexible artifact lookup for agent tools. Exact path first; if that
   * misses, walk the tree and match by basename case-insensitively. One
   * match returns content + the canonical path (so the caller knows where
   * it came from). Multiple matches surface as `ambiguous` with the
   * candidates so the agent can disambiguate on the next call.
   *
   * Rescues pathological states like `artifacts/artifacts/foo.md` left
   * behind by older code paths — the agent can still read the file by
   * basename without needing a migration.
   */
  async resolveProjectArtifact(
    id: string,
    filePath: string,
  ): Promise<ProjectArtifactResolveResult> {
    return this.artifacts.resolveProjectArtifact(id, filePath);
  }

  /**
   * Read an artifact with optional line-based slicing. Used by the
   * `read_artifact` MCP tool to support partial reads on large
   * outboard-storage artifacts (the model gets a summary + path from
   * a wrapper, then drills into specific ranges instead of pulling the
   * whole file back into context).
   *
   * Slice options are mutually exclusive: at most one of `lines` /
   * `head` / `tail`. Omitting all returns the full content (the
   * existing v1 behavior).
   *
   * Path resolution mirrors `resolveProjectArtifact` — exact match
   * first, then fuzzy basename. The `fuzzy` flag in the result tells
   * the caller which path matched.
   *
   * Result fields:
   *   - `content`: the requested slice (or full content)
   *   - `linesReturned`: lines in `content`
   *   - `totalLines`: total lines in the file
   *   - `bytesReturned`: byte length of `content`
   *   - `totalBytes`: byte length of the full file
   *   - `hasMore`: true when the slice covers less than the full file
   *     (the model should call again to see the rest)
   */
  async readProjectArtifactSlice(
    id: string,
    filePath: string,
    opts?: {
      lines?: { start: number; count: number };
      head?: number;
      tail?: number;
    },
  ): Promise<ProjectArtifactSliceResult> {
    return this.artifacts.readProjectArtifactSlice(id, filePath, opts);
  }

  /**
   * Regex-grep a single artifact, returning matched lines (1-indexed)
   * with optional surrounding context. Caps at `maxMatches` so a
   * pathological `.*` pattern can't dump the whole file back through
   * the MCP boundary. Used by the `grep_artifact` MCP tool.
   *
   * Pattern is JS RegExp source (the caller passes a string; we
   * compile here so we can return a structured "invalid pattern"
   * error rather than throwing). Default flags: `i` (case-insensitive)
   * unless caller passes `caseInsensitive: false`.
   *
   * Result includes `totalMatches` even when capped, so the model
   * knows whether the result is the full picture.
   */
  async grepProjectArtifact(
    id: string,
    filePath: string,
    opts: {
      pattern: string;
      caseInsensitive?: boolean;
      contextLines?: number;
      maxMatches?: number;
    },
  ): Promise<ProjectArtifactGrepResult> {
    return this.artifacts.grepProjectArtifact(id, filePath, opts);
  }

  async writeProjectArtifact(id: string, filePath: string, content: string): Promise<void> {
    await this.artifacts.writeProjectArtifact(id, filePath, content);
  }

  /**
   * Write a binary artifact (image, PDF, etc.) under
   * `projects/{id}/artifacts/{relPath}`. Mirrors `writeProjectArtifact`
   * but takes a Buffer instead of a string. The caller supplies the full
   * relative path including extension.
   */
  async writeProjectArtifactBinary(id: string, filePath: string, data: Buffer): Promise<string> {
    return this.artifacts.writeProjectArtifactBinary(id, filePath, data);
  }

  async deleteProjectArtifact(id: string, filePath: string): Promise<void> {
    await this.artifacts.deleteProjectArtifact(id, filePath);
  }

  // ---------- session images (pasted / uploaded in a chat) ----------
  //
  // Images attached to a chat message live under the project's artifacts
  // tree so the existing MCP artifact tools can read them back —
  // `projects/{id}/artifacts/sessions/{sid}/images/{uuid}.{ext}`. This
  // mirrors the "artifacts are project-level" invariant without adding a
  // new storage area.

  private sessionImagesDir(projectId: string, sessionId: string): string {
    return join(this.projectArtifactsDir(projectId), 'sessions', sessionId, 'images');
  }

  /** Relative path used inside chat-message markdown, e.g. "images/abc.png". */
  private sessionImageRelPath(filename: string): string {
    return `images/${filename}`;
  }

  async writeSessionImage(
    projectId: string,
    sessionId: string,
    data: Buffer,
    mimeType: string,
  ): Promise<{ relativePath: string; filename: string }> {
    const ext = extForMimeType(mimeType);
    const filename = `${randomUUID()}${ext}`;
    const dir = this.sessionImagesDir(projectId, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, filename), data);
    await this.touchProject(projectId);
    return { relativePath: this.sessionImageRelPath(filename), filename };
  }

  async readSessionImage(
    projectId: string,
    sessionId: string,
    filename: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const safe = safeBasename(filename);
    if (!safe) return null;
    const full = join(this.sessionImagesDir(projectId, sessionId), safe);
    try {
      const data = await readFile(full);
      return { data, mimeType: mimeTypeForFilename(safe) };
    } catch {
      return null;
    }
  }

  async listSessionImages(
    projectId: string,
    sessionId: string,
  ): Promise<Array<{ filename: string; size: number; mimeType: string }>> {
    const dir = this.sessionImagesDir(projectId, sessionId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Array<{ filename: string; size: number; mimeType: string }> = [];
    for (const name of names) {
      try {
        const s = await stat(join(dir, name));
        if (s.isFile()) {
          out.push({ filename: name, size: s.size, mimeType: mimeTypeForFilename(name) });
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async removeSessionImage(projectId: string, sessionId: string, filename: string): Promise<void> {
    const safe = safeBasename(filename);
    if (!safe) return;
    const full = join(this.sessionImagesDir(projectId, sessionId), safe);
    const { rm } = await import('node:fs/promises');
    await rm(full, { force: true });
    await this.touchProject(projectId);
  }

  // ---------- project attachments (project-scoped files pasted in chat) ----------
  //
  // Unlike session-scoped images (legacy; see above), attachments live
  // once per project under `artifacts/attachments/<filename>`. A user
  // pastes an image in any session and every chat in the same project
  // can reference the same file — it also shows up in the Artifacts
  // tab like any other project file. Markdown refs use the relative
  // form `attachments/<filename>` so the existing image-extraction
  // regex matches and resolves the bytes via `readProjectAttachment`.

  private projectAttachmentsDir(projectId: string): string {
    return join(this.projectArtifactsDir(projectId), 'attachments');
  }

  async writeProjectAttachment(
    projectId: string,
    data: Buffer,
    mimeType: string,
  ): Promise<{ relativePath: string; filename: string }> {
    const ext = extForMimeType(mimeType);
    const filename = `${randomUUID()}${ext}`;
    const dir = this.projectAttachmentsDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, filename), data);
    await this.touchProject(projectId);
    return { relativePath: `attachments/${filename}`, filename };
  }

  async readProjectAttachment(
    projectId: string,
    filename: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const safe = safeBasename(filename);
    if (!safe) return null;
    const full = join(this.projectAttachmentsDir(projectId), safe);
    try {
      const data = await readFile(full);
      return { data, mimeType: mimeTypeForFilename(safe) };
    } catch {
      return null;
    }
  }

  async listProjectAttachments(
    projectId: string,
  ): Promise<Array<{ filename: string; size: number; mimeType: string }>> {
    const dir = this.projectAttachmentsDir(projectId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Array<{ filename: string; size: number; mimeType: string }> = [];
    for (const name of names) {
      try {
        const s = await stat(join(dir, name));
        if (s.isFile()) {
          out.push({ filename: name, size: s.size, mimeType: mimeTypeForFilename(name) });
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async removeProjectAttachment(projectId: string, filename: string): Promise<void> {
    const safe = safeBasename(filename);
    if (!safe) return;
    const full = join(this.projectAttachmentsDir(projectId), safe);
    const { rm } = await import('node:fs/promises');
    await rm(full, { force: true });
    await this.touchProject(projectId);
  }

  // ---------- project workspace (external or internal, gated writes) ----------

  /**
   * Single source of truth for "where does this project's workspace live
   * on disk?" Both the read path (`projectWorkspaceDir` + every list /
   * read / stat helper) and the write path (`assertWorkspaceWritable` +
   * every mutation helper) consume this resolver, so reads and writes
   * always land in the same directory. Earlier the two paths diverged
   * when `github.checkoutDir` was set but `workingDir` wasn't — reads
   * went to the clone, writes to an empty internal directory, and the
   * model saw `write_file` succeed while `stat`/`list_dir` reported the
   * file missing. Wild-caught squisq-review.
   *
   * Priority hierarchy (highest first):
   *   1. `workingDir` — user explicitly pointed at an external folder.
   *      This is the workspace whether or not it's also a git repo.
   *   2. `github.checkoutDir` — github-linked project, no external
   *      workingDir. The clone IS the workspace.
   *   3. Internal fallback — neither set; use the per-project scratch
   *      dir at `~/.gezel/projects/{id}/workspace/`.
   *
   * The returned `source` tag tells `assertWorkspaceWritable` which
   * writability rule to apply without it having to re-derive the
   * priority. No I/O — pure metadata resolution; callers pass in the
   * already-fetched `meta` to avoid double-reads.
   */
  private resolveWorkspaceDir(
    id: string,
    meta: Project | null,
  ): { dir: string; source: 'workingDir' | 'githubCheckout' | 'internal' } {
    if (meta?.workingDir) return { dir: meta.workingDir, source: 'workingDir' };
    if (meta?.github?.checkoutDir) {
      return { dir: meta.github.checkoutDir, source: 'githubCheckout' };
    }
    return { dir: join(projectLocalDir(this.home, id), 'workspace'), source: 'internal' };
  }

  async projectWorkspaceDir(id: string): Promise<string> {
    const meta = await this.tryGetProjectMeta(id);
    return this.resolveWorkspaceDir(id, meta).dir;
  }

  async listProjectWorkspace(id: string, subpath = ''): Promise<ProjectFileEntry[]> {
    const base = await this.projectWorkspaceDir(id);
    return listDirEntries(base, intoWorkspaceRelative(base, subpath));
  }

  async listProjectWorkspaceRecursive(id: string): Promise<ProjectFileEntry[]> {
    return (await this.listProjectWorkspaceRecursiveDetailed(id)).entries;
  }

  /** Recursive listing plus the truncation flag, for surfaces that must
   *  tell the user/model when the walker's entry cap dropped files. */
  async listProjectWorkspaceRecursiveDetailed(id: string): Promise<WalkDirResult> {
    const base = await this.projectWorkspaceDir(id);
    return walkDirDetailed(base);
  }

  async listProjectWorkspaceHtmlPages(id: string): Promise<ProjectFileEntry[]> {
    const base = await this.projectWorkspaceDir(id);
    return findHtmlPages(base);
  }

  async readProjectWorkspaceFile(id: string, filePath: string): Promise<string | null> {
    const base = await this.projectWorkspaceDir(id);
    return safeReadTextFile(base, intoWorkspaceRelative(base, filePath));
  }

  /**
   * Byte-exact workspace read, same containment fence as the text path.
   * Needed by image-signature gate checks (`fileCount.verifyImageBytes`):
   * decoding a PNG through UTF-8 destroys the magic bytes it must inspect.
   */
  async readProjectWorkspaceBinary(id: string, filePath: string): Promise<Uint8Array | null> {
    const base = await this.projectWorkspaceDir(id);
    return safeReadBinaryFile(base, intoWorkspaceRelative(base, filePath));
  }

  /**
   * Gate mutations. Uses the same {@link resolveWorkspaceDir} as the
   * read path, then applies the per-project writability contract
   * (`projectWorkspaceWritable` in core):
   *
   *   - `internal` / `githubCheckout`: writable unless the project
   *     explicitly set `allowGezelWrites: false` (the per-project
   *     "edits off" switch — gezel-initiated writes only; app-internal
   *     `.gezel` bookkeeping and user-initiated writes stay exempt).
   *   - `workingDir`: writable iff `allowGezelWrites === true`. The
   *     user has to explicitly opt gezels into mutating their own folder.
   *
   * The global security policy deliberately does not factor in — the
   * per-project contract is the single write gate (super-lockdown keeps
   * internal projects functional; external dirs are deny-by-default at
   * every level).
   *
   * Returns `ok: true` with the workspace dir on success, or an
   * actionable denial that callers translate to HTTP 403 + MCP tool
   * errors. `external: boolean` is kept on the success shape so callers
   * can distinguish "this is the user's own folder" from "this is a
   * managed dir" (e.g. for UX messaging).
   */
  async assertWorkspaceWritable(
    id: string,
    opts?: { initiatedByGezel?: boolean },
  ): Promise<
    | { ok: true; workspaceDir: string; external: boolean }
    | { ok: false; reason: 'missing-flag-external' | 'disabled-by-project'; workingDir: string }
  > {
    const meta = await this.tryGetProjectMeta(id);
    const resolved = this.resolveWorkspaceDir(id, meta);
    if (resolved.source === 'workingDir' && meta?.allowGezelWrites !== true) {
      return { ok: false, reason: 'missing-flag-external', workingDir: resolved.dir };
    }
    if (opts?.initiatedByGezel && meta?.allowGezelWrites === false) {
      return { ok: false, reason: 'disabled-by-project', workingDir: resolved.dir };
    }
    return {
      ok: true,
      workspaceDir: resolved.dir,
      external: resolved.source === 'workingDir',
    };
  }

  async statProjectWorkspacePath(
    id: string,
    filePath: string,
  ): Promise<{ kind: 'file' | 'dir' | 'missing'; size?: number; mtime?: string }> {
    const base = await this.projectWorkspaceDir(id);
    const full = await safeResolveRead(base, intoWorkspaceRelative(base, filePath));
    if (!full) return { kind: 'missing' };
    try {
      const s = await stat(full);
      if (s.isDirectory()) return { kind: 'dir', mtime: s.mtime.toISOString() };
      if (s.isFile()) return { kind: 'file', size: s.size, mtime: s.mtime.toISOString() };
      return { kind: 'missing' };
    } catch {
      return { kind: 'missing' };
    }
  }

  async writeProjectWorkspaceFile(
    id: string,
    filePath: string,
    content: string,
    ctx?: JournalContext,
  ): Promise<void> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, filePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
    await appendJournalEntry(this.home, id, 'write', filePath, { content, ctx });
    await this.history?.log({
      kind: 'workspace.write',
      projectId: id,
      ...(ctx?.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary: `Wrote ${filePath}`,
      details: { path: filePath, bytes: Buffer.byteLength(content) },
    });
    await this.touchProject(id);
  }

  /**
   * Surgical edit: replace a literal substring in an existing
   * workspace file. The find/replace pair is matched verbatim — no
   * regex — to keep the surface predictable for tiny-tier models.
   *
   * `occurrence` defaults to "exactly one match required"; multi-match
   * paths require an explicit numeric (1-based) index or `'all'`. This
   * is deliberately strict — silently editing a different match than
   * the model intended is the failure mode we're avoiding.
   */
  async replaceInProjectWorkspaceFile(
    id: string,
    args: {
      path: string;
      find: string;
      replace: string;
      occurrence?: number | 'all';
    },
    ctx?: JournalContext,
  ): Promise<WorkspaceEditResult> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, args.path);
    const oldContent = await readFileForEditOrThrow(full, args.path);

    const matches = findAllOccurrences(oldContent, args.find);
    const notFound = () =>
      new WorkspaceEditError(
        `pattern not found in ${args.path}. The file's content may have changed since you last read it — re-read and try again.`,
        'pattern-not-found',
      );

    let newContent: string;
    if (args.occurrence === 'all') {
      if (matches.length === 0) throw notFound();
      newContent = oldContent.split(args.find).join(args.replace);
    } else if (typeof args.occurrence === 'number') {
      const pos = matches[args.occurrence - 1];
      if (pos === undefined) {
        if (matches.length === 0) throw notFound();
        throw new WorkspaceEditError(
          `occurrence ${args.occurrence} out of range — found ${matches.length} match(es) in ${args.path}`,
          'occurrence-out-of-range',
        );
      }
      newContent =
        oldContent.slice(0, pos) + args.replace + oldContent.slice(pos + args.find.length);
    } else if (matches.length === 1) {
      const pos = matches[0]!;
      newContent =
        oldContent.slice(0, pos) + args.replace + oldContent.slice(pos + args.find.length);
    } else if (matches.length > 1) {
      throw new WorkspaceEditError(
        `pattern matches ${matches.length} places in ${args.path}; specify occurrence=<1-based index> or 'all'.`,
        'ambiguous-match',
      );
    } else {
      // No exact match. Fall back to a whitespace-flexible, line-based
      // match so a botched-indentation or gutter-pasted `find` still
      // lands instead of bouncing the model into a full-file rewrite.
      const flexible = findFlexibleMatch(oldContent, args.find);
      if (flexible.kind === 'ambiguous') {
        throw new WorkspaceEditError(
          `pattern matches ${flexible.count} places in ${args.path} (ignoring whitespace); add more surrounding lines to \`find\` so it is unique, or use \`replaceLines\`.`,
          'ambiguous-match',
        );
      }
      if (flexible.kind === 'none') throw notFound();
      newContent =
        oldContent.slice(0, flexible.start) + args.replace + oldContent.slice(flexible.end);
    }

    if (newContent === oldContent) {
      throw new WorkspaceEditError(
        `replaceInFile is a no-op on ${args.path} — \`find\` and \`replace\` produced identical content.`,
        'identity-edit',
      );
    }

    await writeFileAtomic(full, newContent);
    await appendJournalEntry(this.home, id, 'write', args.path, { content: newContent, ctx });
    const result = buildWorkspaceEditResult(args.path, oldContent, newContent);
    await this.logWorkspaceEditHistory(id, 'replace_in_file', result, ctx);
    await this.touchProject(id);
    return result;
  }

  /**
   * Surgical edit: replace an inclusive 1-based line range with new
   * content. The model copies the line numbers straight out of a
   * numbered `read_file` (or a located parse error) — no exact-substring
   * reproduction, no diff-coordinate arithmetic. The friendliest edit
   * shape for tiny-tier models; pairs with the `N→` readFile gutter.
   * `endLine` is clamped to the file's length; `content` may be empty
   * (deletes the range) or multi-line.
   */
  async replaceLinesInProjectWorkspaceFile(
    id: string,
    args: {
      path: string;
      startLine: number;
      endLine: number;
      content: string;
    },
    ctx?: JournalContext,
  ): Promise<WorkspaceEditResult> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, args.path);
    const oldContent = await readFileForEditOrThrow(full, args.path);

    if (args.endLine < args.startLine) {
      throw new WorkspaceEditError(
        `endLine (${args.endLine}) is before startLine (${args.startLine}) in ${args.path}.`,
        'invalid-range',
      );
    }

    const newlineStyle = oldContent.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingNewline = oldContent.endsWith('\n');
    const body = hadTrailingNewline ? oldContent.slice(0, -newlineStyle.length) : oldContent;
    const lines = body === '' ? [] : body.split(/\r?\n/);
    const total = lines.length;

    if (args.startLine > total) {
      throw new WorkspaceEditError(
        `startLine ${args.startLine} is past the end of ${args.path} (${total} line(s)). Re-read the file for current line numbers, or use \`appendToFile\` to add to the end.`,
        'line-out-of-range',
      );
    }
    const endLine = Math.min(args.endLine, total);

    const inserted = args.content === '' ? [] : args.content.replace(/\r?\n$/, '').split(/\r?\n/);
    const next = [...lines.slice(0, args.startLine - 1), ...inserted, ...lines.slice(endLine)];
    let newContent = next.join(newlineStyle);
    if (hadTrailingNewline && newContent !== '') newContent += newlineStyle;

    if (newContent === oldContent) {
      throw new WorkspaceEditError(
        `replaceLines is a no-op on ${args.path} — the new content matches lines ${args.startLine}-${endLine}.`,
        'identity-edit',
      );
    }

    await writeFileAtomic(full, newContent);
    await appendJournalEntry(this.home, id, 'write', args.path, { content: newContent, ctx });
    const result = buildWorkspaceEditResult(args.path, oldContent, newContent);
    await this.logWorkspaceEditHistory(id, 'replace_lines', result, ctx);
    await this.touchProject(id);
    return result;
  }

  /**
   * Surgical edit: apply a unified diff to an existing workspace file.
   * Single-file only — multi-file patches reject with a guidance error
   * so models learn the one-call-per-file shape. Fuzz factor 1
   * tolerates ±1 line of whitespace drift in surrounding context; if
   * the model's context is more stale than that, the patch rejects
   * and the model gets a clear "re-read the file" prompt back.
   */
  async applyPatchToProjectWorkspaceFile(
    id: string,
    args: { path: string; diff: string },
    ctx?: JournalContext,
  ): Promise<WorkspaceEditResult> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, args.path);
    const oldContent = await readFileForEditOrThrow(full, args.path);

    let parsed: ReturnType<typeof parsePatch>;
    try {
      parsed = parsePatch(args.diff);
    } catch (err) {
      throw new WorkspaceEditError(
        `unified diff did not parse: ${err instanceof Error ? err.message : String(err)} — make sure each hunk has @@ -L,N +L,N @@ headers and -/+/space line prefixes.`,
        'patch-parse-failed',
      );
    }
    if (parsed.length === 0) {
      throw new WorkspaceEditError(
        'unified diff contained no hunks — at least one @@ -L,N +L,N @@ block is required.',
        'patch-parse-failed',
      );
    }
    if (parsed.length > 1) {
      throw new WorkspaceEditError(
        `applyPatch is one-file-per-call but the diff describes ${parsed.length} files; split into ${parsed.length} separate calls.`,
        'patch-multi-file',
      );
    }
    const onlyPatch = parsed[0]!;
    const applied = applyPatch(oldContent, onlyPatch, { fuzzFactor: 1 });
    if (applied === false) {
      const failing = onlyPatch.hunks
        .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
        .join(', ');
      throw new WorkspaceEditError(
        `hunk(s) did not apply cleanly to ${args.path} (${failing}). The surrounding context may have shifted — re-read the file and emit a fresh diff.`,
        'patch-rejected',
      );
    }
    if (applied === oldContent) {
      throw new WorkspaceEditError(
        `applyPatch is a no-op on ${args.path} — the diff would not change file content.`,
        'identity-edit',
      );
    }
    await writeFileAtomic(full, applied);
    await appendJournalEntry(this.home, id, 'write', args.path, { content: applied, ctx });
    const result = buildWorkspaceEditResult(args.path, oldContent, applied);
    await this.logWorkspaceEditHistory(id, 'apply_patch', result, ctx);
    await this.touchProject(id);
    return result;
  }

  /**
   * Apply a PACK of single-file unified diffs with validate-all-first
   * semantics: phase A dry-runs every patch in memory (`applyPatch`
   * returns `false` on rejection — no new machinery) and, on ANY failure,
   * returns per-file errors having written NOTHING. Phase B then writes
   * each file atomically with the same journaling/history as
   * `applyPatchToProjectWorkspaceFile`.
   *
   * Identity no-op diffs pass as `{ ok: true, error: 'no-op' }` rather
   * than failing the pack — a recommendation already applied by hand
   * shouldn't block its siblings.
   *
   * v1 limitation, deliberate: phase B is not transactional across a
   * crash mid-pack. Each write is individually journaled and
   * recoverable; validate-first keeps the window small. No rollback.
   */
  async applyEditPackToProjectWorkspace(
    id: string,
    edits: Array<{ path: string; diff: string }>,
    ctx?: JournalContext,
  ): Promise<{ ok: boolean; results: Array<{ path: string; ok: boolean; error?: string }> }> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);

    interface PlannedWrite {
      path: string;
      full: string;
      oldContent: string;
      newContent: string | null;
    }
    const planned: PlannedWrite[] = [];
    const results: Array<{ path: string; ok: boolean; error?: string }> = [];
    let failed = false;

    for (const edit of edits) {
      try {
        const full = await resolveInside(gate.workspaceDir, edit.path);
        const oldContent = await readFileForEditOrThrow(full, edit.path);
        let parsed: ReturnType<typeof parsePatch>;
        try {
          parsed = parsePatch(edit.diff);
        } catch (err) {
          throw new WorkspaceEditError(
            `unified diff did not parse: ${err instanceof Error ? err.message : String(err)}`,
            'patch-parse-failed',
          );
        }
        if (parsed.length === 0) {
          throw new WorkspaceEditError('unified diff contained no hunks', 'patch-parse-failed');
        }
        if (parsed.length > 1) {
          throw new WorkspaceEditError(
            `diff describes ${parsed.length} files; each pack entry must be a single-file diff`,
            'patch-multi-file',
          );
        }
        const applied = applyPatch(oldContent, parsed[0]!, { fuzzFactor: 1 });
        if (applied === false) {
          throw new WorkspaceEditError(
            `hunk(s) did not apply cleanly to ${edit.path} — the file may have changed since the diff was written`,
            'patch-rejected',
          );
        }
        if (applied === oldContent) {
          planned.push({ path: edit.path, full, oldContent, newContent: null });
          results.push({ path: edit.path, ok: true, error: 'no-op' });
          continue;
        }
        planned.push({ path: edit.path, full, oldContent, newContent: applied });
        results.push({ path: edit.path, ok: true });
      } catch (err) {
        failed = true;
        results.push({
          path: edit.path,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failed) return { ok: false, results };

    for (const write of planned) {
      if (write.newContent === null) continue;
      await writeFileAtomic(write.full, write.newContent);
      await appendJournalEntry(this.home, id, 'write', write.path, {
        content: write.newContent,
        ctx,
      });
      const result = buildWorkspaceEditResult(write.path, write.oldContent, write.newContent);
      await this.logWorkspaceEditHistory(id, 'apply_patch', result, ctx);
    }
    await this.touchProject(id);
    return { ok: true, results };
  }

  /**
   * Surgical edit sugar: insert content before/after a unique marker
   * substring. Implemented as a single replace under the hood; the
   * model gets a tool specifically shaped for the "add a new export
   * inside the // EXPORTS block" use case where finding the right
   * `find` string for `replace_in_file` (and rewriting it correctly)
   * isn't worth the cognitive overhead.
   */
  async insertAtMarkerInProjectWorkspaceFile(
    id: string,
    args: {
      path: string;
      marker: string;
      content: string;
      where?: 'before' | 'after';
    },
    ctx?: JournalContext,
  ): Promise<WorkspaceEditResult> {
    const where = args.where ?? 'after';
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, args.path);
    const oldContent = await readFileForEditOrThrow(full, args.path);
    const matches = findAllOccurrences(oldContent, args.marker);
    if (matches.length === 0) {
      throw new WorkspaceEditError(
        `marker not found in ${args.path}. Re-read the file and pass a literal substring that appears exactly once.`,
        'marker-not-found',
      );
    }
    if (matches.length > 1) {
      throw new WorkspaceEditError(
        `marker matches ${matches.length} places in ${args.path}; pick a longer literal substring that's unique.`,
        'marker-ambiguous',
      );
    }
    const pos = matches[0]!;
    const newContent =
      where === 'after'
        ? oldContent.slice(0, pos + args.marker.length) +
          args.content +
          oldContent.slice(pos + args.marker.length)
        : oldContent.slice(0, pos) + args.content + oldContent.slice(pos);
    await writeFileAtomic(full, newContent);
    await appendJournalEntry(this.home, id, 'write', args.path, { content: newContent, ctx });
    const result = buildWorkspaceEditResult(args.path, oldContent, newContent);
    await this.logWorkspaceEditHistory(id, 'insert_at_marker', result, ctx);
    await this.touchProject(id);
    return result;
  }

  private async logWorkspaceEditHistory(
    id: string,
    tool: 'replace_in_file' | 'apply_patch' | 'insert_at_marker' | 'replace_lines',
    result: WorkspaceEditResult,
    ctx?: JournalContext,
  ): Promise<void> {
    await this.history?.log({
      kind: 'workspace.write',
      projectId: id,
      ...(ctx?.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary: `${tool} ${result.path} (+${result.addedLines} −${result.removedLines})`,
      details: {
        path: result.path,
        tool,
        addedLines: result.addedLines,
        removedLines: result.removedLines,
        diff: result.diff,
        ...(result.diffTruncated ? { diffTruncated: true } : {}),
      },
    });
  }

  /**
   * Binary variant of `writeProjectWorkspaceFile`. Used by image
   * generation and any other tool that needs to drop a non-text asset
   * directly into the workspace where the developer's HTML/CSS can
   * reference it via a normal relative path. Skips the workspace
   * journal (which is text-shaped) but still emits a history event so
   * postmortems can see what was written and when.
   */
  async writeProjectWorkspaceBinary(
    id: string,
    filePath: string,
    data: Buffer,
    ctx?: JournalContext,
  ): Promise<void> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, filePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, data);
    await this.history?.log({
      kind: 'workspace.write',
      projectId: id,
      ...(ctx?.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary: `Wrote ${filePath} (${data.length} bytes binary)`,
      details: { path: filePath, bytes: data.length, binary: true },
    });
    await this.touchProject(id);
  }

  /**
   * Copy a file from the project's artifacts drawer to its workspace,
   * preserving bytes exactly (no UTF-8 round-trip). This is the path
   * the model uses to relocate binaries that `generate_image` or any
   * other artifact-writing tool produced — the naive `read_artifact +
   * writeFile` flow corrupts non-text content because the read returns
   * a JSON string. Composed of the existing binary read + binary write
   * primitives so workspace-gate, history, and project-touch all fire
   * the same way they would for any other workspace mutation.
   */
  async copyProjectArtifactToWorkspace(
    id: string,
    source: string,
    dest: string,
    ctx?: JournalContext,
  ): Promise<{ source: string; dest: string; bytes: number }> {
    const binary = await this.readProjectArtifactBinary(id, source);
    if (!binary) {
      throw new Error(`artifact not found at "${source}"`);
    }
    await this.writeProjectWorkspaceBinary(id, dest, binary.data, ctx);
    return { source, dest, bytes: binary.data.length };
  }

  async rmProjectWorkspacePath(
    id: string,
    filePath: string,
    opts: { recursive?: boolean } = {},
    ctx?: JournalContext,
  ): Promise<void> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, filePath);
    // `force: true` so removing a missing path is a no-op (matches the
    // model's mental model of "make sure this is gone"). `recursive` is
    // caller-opt-in — models can't accidentally wipe a directory tree.
    await rm(full, { force: true, recursive: opts.recursive === true });
    await appendJournalEntry(this.home, id, 'delete', filePath, { ctx });
    await this.history?.log({
      kind: 'workspace.delete',
      projectId: id,
      ...(ctx?.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary: `Deleted ${filePath}`,
      details: { path: filePath, recursive: opts.recursive === true },
    });
    await this.touchProject(id);
  }

  async mkdirProjectWorkspace(id: string, dirPath: string, ctx?: JournalContext): Promise<void> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const full = await resolveInside(gate.workspaceDir, dirPath);
    await mkdir(full, { recursive: true });
    await appendJournalEntry(this.home, id, 'mkdir', dirPath, { ctx });
    await this.history?.log({
      kind: 'workspace.mkdir',
      projectId: id,
      ...(ctx?.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary: `Created directory ${dirPath}`,
      details: { path: dirPath },
    });
    await this.touchProject(id);
  }

  async renameProjectWorkspacePath(
    id: string,
    fromPath: string,
    toPath: string,
    ctx?: JournalContext,
  ): Promise<void> {
    const gate = await this.assertWorkspaceWritable(id, { initiatedByGezel: !!ctx?.gezelId });
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const fromFull = await resolveInside(gate.workspaceDir, fromPath);
    const toFull = await resolveInside(gate.workspaceDir, toPath);
    await mkdir(dirname(toFull), { recursive: true });
    await rename(fromFull, toFull);
    await appendJournalEntry(this.home, id, 'rename', toPath, { fromPath, ctx });
    await this.history?.log({
      kind: 'workspace.move',
      projectId: id,
      ...(ctx?.gezelId ? { gezelId: ctx.gezelId } : {}),
      summary: `Renamed ${fromPath} → ${toPath}`,
      details: { fromPath, toPath },
    });
    await this.touchProject(id);
  }

  // ---------- shared documents library ----------

  documentsDir(): string {
    return this.documents.documentsDir();
  }

  async listDocuments(subpath = ''): Promise<ProjectFileEntry[]> {
    return this.documents.listDocuments(subpath);
  }

  async listDocumentsRecursive(): Promise<ProjectFileEntry[]> {
    return this.documents.listDocumentsRecursive();
  }

  async readDocument(filePath: string): Promise<string | null> {
    return this.documents.readDocument(filePath);
  }

  /**
   * Read a shared-library document sidecar as raw bytes. Native document
   * media export uses this for images, narration, and embedded clips while
   * keeping all user-state access behind Store.
   */
  async readDocumentBinary(filePath: string): Promise<{ data: Buffer; mimeType: string } | null> {
    return this.documents.readDocumentBinary(filePath);
  }

  async writeDocument(filePath: string, content: string): Promise<void> {
    await this.documents.writeDocument(filePath, content);
  }

  /**
   * Binary sibling of `writeDocument` — same dir, same path-traversal
   * guard, but writes raw bytes. Powers the squisq editor's Files panel
   * (image uploads + media-sidecar writes) that lives next to a markdown
   * document.
   */
  async writeDocumentBinary(filePath: string, data: Uint8Array): Promise<void> {
    await this.documents.writeDocumentBinary(filePath, data);
  }

  async deleteDocument(filePath: string): Promise<void> {
    await this.documents.deleteDocument(filePath);
  }

  async createDocumentFolder(folderPath: string): Promise<void> {
    await this.documents.createDocumentFolder(folderPath);
  }

  async renameDocument(fromPath: string, toPath: string): Promise<void> {
    await this.documents.renameDocument(fromPath, toPath);
  }

  // ---------- chat sessions ----------

  async writeSession(session: ChatSession): Promise<void> {
    const dir = gezelSessionsDir(this.home, session.gezelId, this.external);
    await mkdir(dir, { recursive: true });
    const path = gezelSessionFile(this.home, session.gezelId, session.id, this.external);
    // Atomic write via tmp + rename. A plain `writeFile` truncates the
    // target to zero, extends it to the new length, then writes the
    // bytes — three independent steps the OS commits separately. A
    // crash / force-kill / power loss between the size extension and
    // the data flush leaves NTFS (and ext4) with a file whose metadata
    // claims N bytes but whose contents are all-NUL, which then fails
    // `JSON.parse` with `Unexpected token '' is not valid JSON` on
    // next read. Writing to a sibling tmp and renaming is atomic from
    // the application's perspective: either the old session or the
    // new one is at the target path, never an in-between zeroed file.
    await writeFileAtomic(path, `${JSON.stringify(session, null, 2)}\n`);
    this.notifySessionChange({ type: 'write', gezelId: session.gezelId, sessionId: session.id });
  }

  /**
   * Read + JSON-parse + Zod-validate a session file. Returns null if the
   * file is missing (silent), and logs a warn before returning null when
   * the JSON or schema is malformed — corrupt sessions stay invisible to
   * the chat layer instead of cascading type errors deeper.
   *
   * A genuinely-unparseable file is *quarantined* (renamed to
   * `<name>.json.corrupt-<ts>`), not just skipped: `listSessions`,
   * `listTimeline`, and the task scheduler's re-drive all rescan these
   * directories continuously, so a file left in place re-logs the same
   * warning on every pass forever. The classic culprit is an all-NUL file
   * left by a pre-`writeFileAtomic` crash — its bytes are already
   * unrecoverable, so we move it aside (preserving it for inspection)
   * rather than delete, and scans skip it because it no longer ends in
   * `.json`. Same quarantine convention as `readGezelGrowth`. Valid JSON
   * that merely fails schema validation is NOT quarantined below — that
   * can be benign version skew worth keeping.
   */
  private async readSessionFile(path: string, label: string): Promise<ChatSession | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(
        `[store] session ${label} is not valid JSON — quarantining:`,
        err instanceof Error ? err.message : err,
      );
      await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
      return null;
    }
    const result = ChatSessionSchema.safeParse(parsed);
    if (!result.success) {
      log.warn(
        `[store] session ${label} failed schema validation; skipping:`,
        result.error.message,
      );
      return null;
    }
    return result.data;
  }

  async getSession(gezelId: string, sessionId: string): Promise<ChatSession | null> {
    const session = await this.readSessionFile(
      gezelSessionFile(this.home, gezelId, sessionId, this.external),
      `${gezelId}/${sessionId}`,
    );
    if (!session) return null;
    // Legacy-intent migration: earlier Copilot turns shipped phase
    // announcements as inline italic markdown (`\n_...label..._\n\n`)
    // baked into `content`. Upgrade those to structured `intents[]`
    // in place so the UI renders them as HR dividers the same way
    // live turns do now. Idempotent — once a message has `intents`,
    // we skip it on future reads.
    if (migrateLegacyIntents(session)) {
      try {
        await this.writeSession(session);
      } catch (err) {
        log.warn(
          `[store] legacy-intent migration write-back failed for ${gezelId}/${sessionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return session;
  }

  /**
   * Locate a session by id without knowing which gezel owns it. Scans every
   * gezel's `sessions/` directory. Acceptable for a local app.
   */
  async findSessionById(sessionId: string): Promise<ChatSession | null> {
    const gezelIds = await safeReaddir(gezelPaths(this.home, this.external).gezels);
    for (const gezelId of gezelIds) {
      const hit = await this.getSession(gezelId, sessionId);
      if (hit) return hit;
    }
    return null;
  }

  async deleteSession(gezelId: string, sessionId: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(gezelSessionFile(this.home, gezelId, sessionId, this.external));
    } catch {
      /* already gone */
    }
    this.notifySessionChange({ type: 'delete', gezelId, sessionId });
  }

  async listSessions(opts?: {
    gezelId?: string;
    projectId?: string;
  }): Promise<ChatSessionSummary[]> {
    const gezelIds = opts?.gezelId
      ? [opts.gezelId]
      : await safeReaddir(gezelPaths(this.home, this.external).gezels);
    const summaries: ChatSessionSummary[] = [];
    for (const gezelId of gezelIds) {
      const dir = gezelSessionsDir(this.home, gezelId, this.external);
      const files = await safeReaddir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const session = await this.readSessionFile(join(dir, file), `${gezelId}/${file}`);
        if (!session) continue;
        if (opts?.projectId && session.projectId !== opts.projectId) continue;
        // Latest human message — `role: 'user'` without `from` (gezel-
        // injected messages like meester nudges carry `from`). The nudge
        // scheduler keys its backoff reset off this; see the field's doc
        // on ChatSessionSummarySchema.
        let lastHumanActivityAt: string | undefined;
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const m = session.messages[i];
          if (m && m.role === 'user' && !m.from) {
            lastHumanActivityAt = m.at;
            break;
          }
        }
        summaries.push({
          id: session.id,
          gezelId: session.gezelId,
          projectId: session.projectId,
          providerName: session.providerName,
          model: session.model,
          title: session.title,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt,
          archived: session.archived,
          ...(session.lastTurnError ? { lastTurnError: session.lastTurnError } : {}),
          ...(session.taskRef ? { taskRef: session.taskRef } : {}),
          ...(session.stepId ? { stepId: session.stepId } : {}),
          ...(lastHumanActivityAt ? { lastHumanActivityAt } : {}),
        });
      }
    }
    summaries.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );
    return summaries;
  }

  /**
   * Build an interleaved, chronologically-sorted slice of messages across
   * every session in scope. Used by the project + global timeline UI.
   *
   * Each row carries its parent session's identity (gezelId, sessionId,
   * title, taskRef, ...) so the UI can group rows by session and label
   * each bubble with its author.
   *
   * `before` is exclusive (return messages strictly older than the cursor).
   * Result is the trailing `limit` messages — i.e. the most-recent slice
   * before the cursor — sorted ascending by `at`. `hasMore` is true when
   * older messages remain that weren't returned.
   *
   * `handoffFrom` is set on rows whose parent session was created from a
   * `startHandoffSession` call: the previous session in the same project
   * sharing the same `taskRef` but with a different `gezelId`.
   *
   * `taskRef` narrows the scope to one task's sessions — what the Task
   * detail's Chat tab uses so its history matches the task in its header
   * instead of showing every conversation in the project.
   */
  async listTimeline(opts: {
    projectId?: string;
    gezelId?: string;
    taskRef?: string;
    limit: number;
    before?: string;
    includeArchived?: boolean;
  }): Promise<{
    messages: TimelineMessage[];
    hasMore: boolean;
    terminalEntries?: TerminalTimelineEntry[];
  }> {
    const limit = Math.max(1, Math.min(500, opts.limit));
    const includeArchived = opts.includeArchived === true;
    const before = opts.before;

    const gezelIds = opts.gezelId
      ? [opts.gezelId]
      : await safeReaddir(gezelPaths(this.home, this.external).gezels);

    // Collect every in-scope session up front so we can both flatten
    // messages and resolve handoff lineage from the same data.
    const sessions: ChatSession[] = [];
    for (const gezelId of gezelIds) {
      const dir = gezelSessionsDir(this.home, gezelId, this.external);
      const files = await safeReaddir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const session = await this.readSessionFile(join(dir, file), `${gezelId}/${file}`);
        if (!session) continue;
        if (opts.projectId && session.projectId !== opts.projectId) continue;
        // Task scoping is exact-match on the session's pinned `taskRef`,
        // which keeps handoff sessions (spawned by `advance_task_step`
        // under the same ref but a different gezel) in view while
        // dropping every unrelated conversation in the project.
        if (opts.taskRef && session.taskRef !== opts.taskRef) continue;
        if (!includeArchived && session.archived) continue;
        sessions.push(session);
      }
    }

    // Resolve handoff lineage per session: for each session with a taskRef,
    // find the most recent prior session in the same project that shares
    // the same taskRef but has a different gezelId.
    const handoffOf = new Map<string, { gezelId: string; sessionId: string }>();
    for (const s of sessions) {
      if (!s.taskRef) continue;
      let best: ChatSession | null = null;
      for (const other of sessions) {
        if (other.id === s.id) continue;
        if (other.taskRef !== s.taskRef) continue;
        if (other.projectId !== s.projectId) continue;
        if (other.gezelId === s.gezelId) continue;
        if (other.createdAt >= s.createdAt) continue;
        if (!best || other.createdAt > best.createdAt) best = other;
      }
      if (best) handoffOf.set(s.id, { gezelId: best.gezelId, sessionId: best.id });
    }

    // Gather one artifact listing per in-scope project so we can
    // backfill `referencedArtifacts` on assistant messages that predate
    // the server-side parser. Cheap: one recursive walk per project,
    // reused across every message in that project's sessions.
    const projectArtifacts = new Map<string, string[]>();
    const uniqueProjects = new Set(sessions.map((s) => s.projectId));
    for (const pid of uniqueProjects) {
      const hasLegacyAssistant = sessions.some(
        (s) =>
          s.projectId === pid &&
          s.messages.some((m) => m.role === 'assistant' && !m.referencedArtifacts),
      );
      if (!hasLegacyAssistant) continue;
      try {
        const files = await this.listProjectArtifactsRecursive(pid);
        projectArtifacts.set(
          pid,
          files.filter((f) => !f.isDirectory).map((f) => f.path),
        );
      } catch {
        projectArtifacts.set(pid, []);
      }
    }

    // Backfill task-refs on assistant messages that predate the
    // task-ref parser. Only walk the task index when a legacy message
    // exists; the global list is cheap (one readdir per project) and
    // reused across every backfilled message.
    let taskRefs: string[] | null = null;
    const hasLegacyTaskRefAssistant = sessions.some((s) =>
      s.messages.some((m) => m.role === 'assistant' && !m.referencedTasks),
    );
    if (hasLegacyTaskRefAssistant) {
      try {
        const all = await this.listAllTasks();
        taskRefs = all.map((t) => t.ref);
      } catch {
        taskRefs = [];
      }
    }

    // Flatten into rows tagged with parent session metadata.
    const rows: TimelineMessage[] = [];
    for (const s of sessions) {
      const handoff = handoffOf.get(s.id);
      for (const m of s.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        // Hidden facilitation seeds (e.g. a project-type page reaction with
        // `hideSeed`) stay in the session file for the model but never
        // surface a transcript bubble.
        if (m.hidden) continue;
        if (before && m.at >= before) continue;
        // Assistant-only: either forward the persisted list or compute
        // one on the fly from the project's current artifact inventory.
        let refs = m.referencedArtifacts;
        if (m.role === 'assistant' && !refs) {
          const artifactPaths = projectArtifacts.get(s.projectId);
          if (artifactPaths && artifactPaths.length > 0) {
            const computed = matchReferencedArtifactsInContent(m.content, artifactPaths);
            if (computed.length > 0) refs = computed;
          }
        }
        let tRefs = m.referencedTasks;
        if (m.role === 'assistant' && !tRefs && taskRefs && taskRefs.length > 0) {
          const computed = matchReferencedTasksInContent(m.content, taskRefs);
          if (computed.length > 0) tRefs = computed;
        }
        rows.push({
          sessionId: s.id,
          gezelId: s.gezelId,
          projectId: s.projectId,
          sessionTitle: s.title,
          sessionCreatedAt: s.createdAt,
          sessionLastActivityAt: s.lastActivityAt,
          sessionProviderName: s.providerName,
          ...(s.model ? { sessionModel: s.model } : {}),
          ...(s.archived ? { sessionArchived: true } : {}),
          ...(s.lastTurnError ? { sessionLastTurnError: s.lastTurnError } : {}),
          ...(s.taskRef ? { taskRef: s.taskRef } : {}),
          ...(s.stepId ? { stepId: s.stepId } : {}),
          ...(handoff ? { handoffFrom: handoff } : {}),
          role: m.role,
          content: m.content,
          at: m.at,
          ...(m.from ? { from: m.from } : {}),
          ...(m.nudge ? { nudge: true } : {}),
          ...(refs && refs.length > 0 ? { referencedArtifacts: refs } : {}),
          ...(tRefs && tRefs.length > 0 ? { referencedTasks: tRefs } : {}),
          ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
          ...(m.intents && m.intents.length > 0 ? { intents: m.intents } : {}),
          ...(m.pendingQuestionId ? { pendingQuestionId: m.pendingQuestionId } : {}),
          ...(m.warnings && m.warnings.length > 0 ? { warnings: m.warnings } : {}),
          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          ...(m.reasoningDurationMs !== undefined
            ? { reasoningDurationMs: m.reasoningDurationMs }
            : {}),
          ...(m.attemptedToolCalls && m.attemptedToolCalls.length > 0
            ? { attemptedToolCalls: m.attemptedToolCalls }
            : {}),
        });
      }
    }

    rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(rows.length - limit) : rows;

    // Per-project queries also pull terminal entries from the project's
    // terminal threads. Returned as a sibling array; the UI interleaves
    // by `at`. Global + gezel-scoped queries leave this undefined so
    // their existing chat-only shape is preserved.
    let terminalEntries: TerminalTimelineEntry[] | undefined;
    if (opts.projectId) {
      const collected = await this.collectProjectTerminalEntries(
        opts.projectId,
        includeArchived,
        before,
      );
      if (collected.length > 0) {
        collected.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        terminalEntries = collected;
      }
    }

    return { messages: trimmed, hasMore, ...(terminalEntries ? { terminalEntries } : {}) };
  }

  // ---------- terminal threads (per-project) ----------

  /**
   * Slug a workingDir (relative to project root) into a stable threadId.
   * Empty string → `_root`. Path separators and unsafe chars collapse to
   * underscores; the result is filesystem-safe and unique across siblings
   * because the FULL relative path is encoded (not just the leaf).
   *
   * Slug ambiguity for non-ASCII paths is not reversible — callers store
   * the raw workingDir on the thread to reconstruct it.
   */
  terminalThreadId(workingDir: string): string {
    const trimmed = workingDir.replace(/^\/+|\/+$/g, '');
    if (trimmed === '') return '_root';
    const sanitized = trimmed
      .replace(/[^A-Za-z0-9._\-/]/g, '_')
      .replace(/\//g, '__')
      .replace(/_+/g, '_');
    return sanitized || '_root';
  }

  async writeTerminalThread(thread: TerminalThread): Promise<void> {
    const dir = projectTerminalsDir(this.home, thread.projectId);
    await mkdir(dir, { recursive: true });
    const path = projectTerminalFile(this.home, thread.projectId, thread.id);
    await writeFileAtomic(path, `${JSON.stringify(thread, null, 2)}\n`);
  }

  private async readTerminalThreadFile(
    path: string,
    label: string,
  ): Promise<TerminalThread | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(
        `[store] terminal thread ${label} is not valid JSON:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    const result = TerminalThreadSchema.safeParse(parsed);
    if (!result.success) {
      log.warn(
        `[store] terminal thread ${label} failed schema validation; skipping:`,
        result.error.message,
      );
      return null;
    }
    return result.data;
  }

  async getTerminalThread(projectId: string, threadId: string): Promise<TerminalThread | null> {
    return this.readTerminalThreadFile(
      projectTerminalFile(this.home, projectId, threadId),
      `${projectId}/${threadId}`,
    );
  }

  async listTerminalThreads(projectId: string): Promise<TerminalThreadSummary[]> {
    const dir = projectTerminalsDir(this.home, projectId);
    const files = await safeReaddir(dir);
    const out: TerminalThreadSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const thread = await this.readTerminalThreadFile(join(dir, file), `${projectId}/${file}`);
      if (!thread) continue;
      out.push({
        id: thread.id,
        projectId: thread.projectId,
        workingDir: thread.workingDir,
        createdAt: thread.createdAt,
        lastActivityAt: thread.lastActivityAt,
        ...(thread.archived ? { archived: true } : {}),
      });
    }
    out.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );
    return out;
  }

  async deleteTerminalThread(projectId: string, threadId: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(projectTerminalFile(this.home, projectId, threadId));
    } catch {
      /* already gone */
    }
  }

  /**
   * Append a TerminalMessage to a thread, updating `lastActivityAt`.
   * Creates the thread if it doesn't exist. Returns the persisted thread.
   * Concurrent callers must serialize externally — the TerminalManager
   * runs a per-thread queue for that.
   */
  async appendTerminalMessage(
    projectId: string,
    threadId: string,
    workingDir: string,
    message: TerminalMessage,
  ): Promise<TerminalThread> {
    const existing = await this.getTerminalThread(projectId, threadId);
    const now = nowIso();
    const thread: TerminalThread = existing
      ? { ...existing, messages: [...existing.messages, message], lastActivityAt: now }
      : {
          version: 1,
          id: threadId,
          projectId,
          workingDir,
          createdAt: now,
          lastActivityAt: now,
          messages: [message],
        };
    await this.writeTerminalThread(thread);
    return thread;
  }

  /** Flatten every terminal thread for `projectId` into timeline entries. */
  private async collectProjectTerminalEntries(
    projectId: string,
    includeArchived: boolean,
    before: string | undefined,
  ): Promise<TerminalTimelineEntry[]> {
    const dir = projectTerminalsDir(this.home, projectId);
    const files = await safeReaddir(dir);
    const entries: TerminalTimelineEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const thread = await this.readTerminalThreadFile(join(dir, file), `${projectId}/${file}`);
      if (!thread) continue;
      if (!includeArchived && thread.archived) continue;
      for (const m of thread.messages) {
        if (before && m.at >= before) continue;
        entries.push({
          threadId: thread.id,
          projectId: thread.projectId,
          workingDir: thread.workingDir,
          threadCreatedAt: thread.createdAt,
          threadLastActivityAt: thread.lastActivityAt,
          ...(thread.archived ? { threadArchived: true } : {}),
          messageId: m.id,
          msgKind: m.kind,
          content: m.content,
          at: m.at,
          ...(m.resolvedFrom ? { resolvedFrom: m.resolvedFrom } : {}),
          ...(m.stdout !== undefined ? { stdout: m.stdout } : {}),
          ...(m.stderr !== undefined ? { stderr: m.stderr } : {}),
          ...(m.exitCode !== undefined ? { exitCode: m.exitCode } : {}),
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
          ...(m.truncated ? { truncated: true } : {}),
          ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
          ...(m.fileReferences ? { fileReferences: m.fileReferences } : {}),
          ...(m.cwd !== undefined ? { cwd: m.cwd } : {}),
        });
      }
    }
    return entries;
  }

  private async readInstalledPackages(id: string): Promise<InstalledPackage[]> {
    const pkgPath = join(projectLocalDir(this.home, id), 'package.json');
    try {
      const raw = await readFile(pkgPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
      };
      const deps = parsed.dependencies ?? {};
      return Object.entries(deps).map(([name, version]) => ({ name, version }));
    } catch {
      return [];
    }
  }

  /**
   * Read `package.json#scripts` from the project's workspace directory
   * — the actual cwd that `pnpm run`, `npx`, and user edits operate on.
   * Returns an empty map (never throws) when there's no package.json or
   * the file is malformed.
   */
  async readPackageJsonScripts(
    id: string,
  ): Promise<{ scripts: Record<string, string>; packageManager?: string }> {
    const workspaceDir = await this.projectWorkspaceDir(id);
    const pkgPath = join(workspaceDir, 'package.json');
    try {
      const raw = await readFile(pkgPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      const scripts: Record<string, string> = {};
      for (const [name, body] of Object.entries(parsed.scripts ?? {})) {
        if (typeof name === 'string' && typeof body === 'string') scripts[name] = body;
      }
      return {
        scripts,
        ...(typeof parsed.packageManager === 'string'
          ? { packageManager: parsed.packageManager }
          : {}),
      };
    } catch {
      return { scripts: {} };
    }
  }

  // ---------- memories (agent + project) ----------

  private memoryBaseDir(scope: 'gezel' | 'project', id: string): string {
    return scope === 'gezel'
      ? gezelMemoriesDir(this.home, id, this.external)
      : projectMemoriesDir(this.home, id, this.external);
  }

  private memoryDir(scope: 'gezel' | 'project', id: string): string {
    return join(this.memoryBaseDir(scope, id), 'daily');
  }

  private todayFile(scope: 'gezel' | 'project', id: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.memoryDir(scope, id), `${date}.md`);
  }

  async appendMemory(
    scope: 'gezel' | 'project',
    id: string,
    text: string,
    kind: MemoryKind = DEFAULT_MEMORY_KIND,
  ): Promise<void> {
    const dir = this.memoryDir(scope, id);
    await mkdir(dir, { recursive: true });
    const file = this.todayFile(scope, id);
    const time = new Date().toISOString().slice(11, 16);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, formatMemoryBlock(time, text, kind), 'utf8');
  }

  async listMemoryDays(scope: 'gezel' | 'project', id: string): Promise<string[]> {
    const dir = this.memoryDir(scope, id);
    try {
      const entries = await readdir(dir);
      return entries
        .filter((e) => e.endsWith('.md'))
        .map((e) => e.replace('.md', ''))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  async readMemoryDay(scope: 'gezel' | 'project', id: string, day: string): Promise<string> {
    const file = join(this.memoryDir(scope, id), `${day}.md`);
    try {
      return await readFile(file, 'utf8');
    } catch {
      return '';
    }
  }

  async readRecentMemories(scope: 'gezel' | 'project', id: string, days = 7): Promise<string> {
    const allDays = await this.listMemoryDays(scope, id);
    const recent = allDays.slice(0, days);
    const parts: string[] = [];
    for (const day of recent) {
      const content = await this.readMemoryDay(scope, id, day);
      if (content.trim()) parts.push(`# ${day}\n${content}`);
    }
    return parts.join('\n\n');
  }

  /** Replace one daily memory file wholesale (compaction output). */
  async writeMemoryDay(
    scope: 'gezel' | 'project',
    id: string,
    day: string,
    content: string,
  ): Promise<void> {
    const dir = this.memoryDir(scope, id);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, `${day}.md`), content);
  }

  async deleteMemoryDay(scope: 'gezel' | 'project', id: string, day: string): Promise<void> {
    await rm(join(this.memoryDir(scope, id), `${day}.md`), { force: true });
  }

  /**
   * Copy daily memory files into `memories/archive/<runId>/` before a
   * compaction rewrites them. Pure copy — originals untouched. The
   * archive dir is invisible to `listMemoryDays` (which reads `daily/`
   * only). Returns the archive directory path.
   */
  async archiveMemoryDays(
    scope: 'gezel' | 'project',
    id: string,
    days: string[],
    runId: string,
  ): Promise<string> {
    const archiveDir = join(this.memoryBaseDir(scope, id), 'archive', runId);
    await mkdir(archiveDir, { recursive: true });
    for (const day of days) {
      await copyFile(join(this.memoryDir(scope, id), `${day}.md`), join(archiveDir, `${day}.md`));
    }
    return archiveDir;
  }

  memorySummaryPath(scope: 'gezel' | 'project', id: string): string {
    return join(this.memoryBaseDir(scope, id), 'summary.md');
  }

  /**
   * Curated "lessons from past work" document — gezel scope only by
   * design: lessons are the transferable knowledge layer, distilled
   * periodically from gezel-scope memories and injected into the stable
   * system-prompt prefix. Project scope keeps similarity recall only.
   */
  memoryLessonsPath(gezelId: string): string {
    return join(this.memoryBaseDir('gezel', gezelId), 'lessons.md');
  }

  async readMemoryLessons(gezelId: string): Promise<string> {
    try {
      return await readFile(this.memoryLessonsPath(gezelId), 'utf8');
    } catch {
      return '';
    }
  }

  async writeMemoryLessons(gezelId: string, content: string): Promise<void> {
    await mkdir(this.memoryBaseDir('gezel', gezelId), { recursive: true });
    await writeFileAtomic(this.memoryLessonsPath(gezelId), content);
  }

  /* ─── Growth (per-gezel leveling state) ─────────────────────────────── */

  /**
   * Read a gezel's growth.json. Missing file → level-1 defaults. A
   * corrupt file (bad JSON or schema) is quarantined to
   * `growth.json.corrupt-<ts>` and the state recovered: level from the
   * highest resolved level-up in history, active traits survive in the
   * frontmatter (which is authoritative), and the XP ratchet recomputes
   * on the next refresh.
   */
  async readGezelGrowth(gezelId: string): Promise<GezelGrowthState> {
    const path = gezelGrowthPath(this.home, gezelId, this.external);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return GezelGrowthStateSchema.parse({});
    }
    try {
      return GezelGrowthStateSchema.parse(JSON.parse(raw));
    } catch (err) {
      log.warn(
        `[growth] corrupt growth.json for ${gezelId} — quarantining:`,
        err instanceof Error ? err.message : err,
      );
      await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
      return GezelGrowthStateSchema.parse({ level: await this.recoverGrowthLevel(gezelId) });
    }
  }

  /** Highest level recorded by resolution history events, else 1. */
  private async recoverGrowthLevel(gezelId: string): Promise<number> {
    try {
      const events = await this.history?.listEvents({
        gezelId,
        kinds: ['gezel.trait.adopted', 'gezel.tuning.adjusted', 'gezel.level.up'],
      });
      let level = 1;
      for (const e of events ?? []) {
        const toLevel = (e.details as { toLevel?: number; level?: number } | undefined) ?? {};
        const n = toLevel.toLevel ?? toLevel.level;
        if (typeof n === 'number' && n > level) level = n;
      }
      return level;
    } catch {
      return 1;
    }
  }

  async writeGezelGrowth(gezelId: string, state: GezelGrowthState): Promise<void> {
    const path = gezelGrowthPath(this.home, gezelId, this.external);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** Lightweight `{level, pending}` for inlining on summaries; undefined when no growth.json. */
  private async readGrowthSummary(
    gezelId: string,
  ): Promise<{ level: number; pending?: boolean } | undefined> {
    const path = gezelGrowthPath(this.home, gezelId, this.external);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        level?: number;
        pendingLevelUp?: unknown;
      };
      const level = typeof raw.level === 'number' && raw.level >= 1 ? raw.level : 1;
      return { level, ...(raw.pendingLevelUp ? { pending: true } : {}) };
    } catch {
      return undefined;
    }
  }

  /**
   * @deprecated Legacy summary.md viewer — nothing writes summary.md
   * anymore (compaction rewrites the daily corpus in place instead).
   * Kept so existing files on disk remain viewable.
   */
  async readMemorySummary(scope: 'gezel' | 'project', id: string): Promise<string> {
    try {
      return await readFile(this.memorySummaryPath(scope, id), 'utf8');
    } catch {
      return '';
    }
  }

  memoryIndexDir(scope: 'gezel' | 'project', id: string): string {
    return join(this.memoryBaseDir(scope, id), 'index');
  }

  // ---------- tasks (per-project, stable numeric IDs) ----------

  private readonly taskNumLocks = new Map<string, Promise<number>>();

  /**
   * Allocate the next monotonic task number for a project. Uses a plain-text
   * `.next-id` file under `tasks/` and an in-memory per-project mutex so
   * concurrent creates don't collide.
   */
  async nextProjectTaskNum(projectId: string): Promise<number> {
    const prior = this.taskNumLocks.get(projectId) ?? Promise.resolve(0);
    const next = prior.then(async () => {
      const file = projectTaskNextIdFile(this.home, projectId, this.external);
      let current = 0;
      try {
        const raw = await readFile(file, 'utf8');
        current = Number.parseInt(raw.trim(), 10);
        if (!Number.isFinite(current) || current < 0) current = 0;
      } catch {
        /* first allocation */
      }
      const num = current + 1;
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, `${num}\n`);
      return num;
    });
    this.taskNumLocks.set(projectId, next);
    return next;
  }

  async writeTask(task: Task): Promise<void> {
    const file = projectTaskFile(this.home, task.projectId, task.num, this.external);
    await mkdir(dirname(file), { recursive: true });
    // `description` is persisted as `about.md` next to `task.json` —
    // the long-form prose stays editable as a real markdown file and
    // the JSON stays compact. We strip it from the JSON shape before
    // serializing so the two never drift. Empty/whitespace-only
    // descriptions are treated as "delete the about file" so a clear
    // round-trips correctly.
    const { description, ...rest } = task;
    await writeFileAtomic(file, `${JSON.stringify(rest, null, 2)}\n`);
    // `task` is a complete aggregate snapshot, not a patch. Reconcile the
    // sidecar on every write so deleting the optional property in
    // TaskManager still clears the previously-persisted prose. Gating this on
    // `description !== undefined` loses the clear intent after the manager
    // normalizes an empty string by deleting `next.description`.
    if (description !== undefined && description.trim().length > 0) {
      await this.writeTaskAbout(task.projectId, task.num, description);
    } else {
      await this.deleteTaskAbout(task.projectId, task.num);
    }
  }

  async readTask(projectId: string, num: number): Promise<Task | null> {
    try {
      const raw = await readFile(projectTaskFile(this.home, projectId, num, this.external), 'utf8');
      const parsed = normalizeLegacyTaskShape(JSON.parse(raw));
      // Hydrate description from the sidecar `about.md`. Missing file
      // is normal — older tasks without a description body simply
      // come back without the field. ENOENT is the fast path.
      const about = await this.readTaskAbout(projectId, num);
      if (about.length > 0) parsed.description = about;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Read just the `about.md` body for a task. Returns `''` when the
   * file is absent — callers that want to distinguish "no body" from
   * "empty body" should treat any empty result as "no body".
   */
  async readTaskAbout(projectId: string, num: number): Promise<string> {
    try {
      return await readFile(projectTaskAboutFile(this.home, projectId, num, this.external), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Write the `about.md` body for a task. Mkdir's the task folder if
   * the task itself hasn't been written yet (rare but cheap to support
   * — keeps callers from having to interleave `writeTask` first).
   */
  async writeTaskAbout(projectId: string, num: number, body: string): Promise<void> {
    const file = projectTaskAboutFile(this.home, projectId, num, this.external);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, body);
  }

  async deleteTaskAbout(projectId: string, num: number): Promise<void> {
    const file = projectTaskAboutFile(this.home, projectId, num, this.external);
    try {
      await rm(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async listProjectTasks(projectId: string): Promise<Task[]> {
    const dir = projectTasksDir(this.home, projectId, this.external);
    const names = await safeReaddir(dir);
    const tasks: Task[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const num = Number.parseInt(name, 10);
      const t = await this.readTask(projectId, num);
      if (t) tasks.push(t);
    }
    tasks.sort((a, b) => b.num - a.num);
    return tasks;
  }

  async listAllTasks(): Promise<Task[]> {
    const p = gezelPaths(this.home);
    let projectIds: string[] = [];
    try {
      projectIds = await readdir(p.projects);
    } catch {
      /* none */
    }
    const all: Task[] = [];
    for (const id of projectIds) {
      all.push(...(await this.listProjectTasks(id)));
    }
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return all;
  }

  // ---------- structured questions (per-project, single-file) ----------

  /**
   * Upsert a `Question` record. Read-merge-write keyed by `id`. Single
   * file per project (`questions.json`) — questions are low-volume and
   * the panels always want the full list, so the per-id task layout
   * would be needless overhead here.
   */
  async writeQuestion(question: Question): Promise<void> {
    const file = projectQuestionsFile(this.home, question.projectId);
    const existing = await this.listProjectQuestions(question.projectId);
    const idx = existing.findIndex((q) => q.id === question.id);
    if (idx >= 0) existing[idx] = question;
    else existing.push(question);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(existing, null, 2)}\n`);
  }

  async getQuestion(projectId: string, id: string): Promise<Question | null> {
    const all = await this.listProjectQuestions(projectId);
    return all.find((q) => q.id === id) ?? null;
  }

  /**
   * Newest-first list of every question in the project. Returns `[]`
   * when the file is missing or unreadable — callers can render empty
   * panels without try/catch boilerplate.
   */
  async listProjectQuestions(projectId: string): Promise<Question[]> {
    const file = projectQuestionsFile(this.home, projectId);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Question[];
      if (!Array.isArray(parsed)) return [];
      return parsed.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  /**
   * Every pending (unanswered, not declined) question across every
   * project. Drives the Home "Needs your input" panel + the Home tab
   * badge.
   */
  async listAllPendingQuestions(): Promise<Question[]> {
    const p = gezelPaths(this.home);
    let projectIds: string[] = [];
    try {
      projectIds = await readdir(p.projects);
    } catch {
      return [];
    }
    const all: Question[] = [];
    for (const id of projectIds) {
      const qs = await this.listProjectQuestions(id);
      for (const q of qs) {
        if (q.answer) continue;
        all.push(q);
      }
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all;
  }

  /**
   * Look up an existing session and stamp `pendingQuestionId` onto its
   * most recent assistant message. Called from the questions route
   * after a question is created so the chat UI can correlate the card
   * with the bubble that asked it. No-ops if the session or assistant
   * message can't be found — the panel + badge surfaces still work
   * without the in-chat correlation.
   */
  async stampPendingQuestionOnLastAssistant(
    gezelId: string,
    sessionId: string,
    questionId: string,
  ): Promise<void> {
    const session = await this.getSession(gezelId, sessionId);
    if (!session) return;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (!m || m.role !== 'assistant') continue;
      m.pendingQuestionId = questionId;
      await this.writeSession(session);
      return;
    }
  }

  async listTaskNotes(projectId: string, num: number, stepId?: string): Promise<TaskNote[]> {
    const file = projectTaskNotesFile(this.home, projectId, num, this.external);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    const notes: TaskNote[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = TaskNoteSchema.parse(JSON.parse(trimmed));
        if (stepId !== undefined && parsed.stepId !== stepId) continue;
        notes.push(parsed);
      } catch {
        // Drop malformed lines silently — readers should not crash on
        // a single bad entry; the rest of the feed remains usable.
      }
    }
    notes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return notes;
  }

  async appendTaskNote(projectId: string, num: number, note: TaskNote): Promise<void> {
    const file = projectTaskNotesFile(this.home, projectId, num, this.external);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(note)}\n`, 'utf8');
  }

  async deleteTaskNote(projectId: string, num: number, noteId: string): Promise<TaskNote | null> {
    const file = projectTaskNotesFile(this.home, projectId, num, this.external);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    let removed: TaskNote | null = null;
    const kept: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = TaskNoteSchema.parse(JSON.parse(trimmed));
        if (parsed.id === noteId && !removed) {
          removed = parsed;
          continue;
        }
        kept.push(JSON.stringify(parsed));
      } catch {
        kept.push(trimmed);
      }
    }
    if (!removed) return null;
    await writeFileAtomic(file, kept.length ? `${kept.join('\n')}\n` : '');
    return removed;
  }

  /**
   * Update an existing note's text in place, preserving id, author,
   * `at`, and `stepId`. Returns the updated note, or null when no
   * matching id exists. Rewrites the JSONL file atomically — same
   * pattern as `deleteTaskNote`.
   */
  async updateTaskNote(
    projectId: string,
    num: number,
    noteId: string,
    text: string,
  ): Promise<TaskNote | null> {
    const file = projectTaskNotesFile(this.home, projectId, num, this.external);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    let updated: TaskNote | null = null;
    const lines: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = TaskNoteSchema.parse(JSON.parse(trimmed));
        if (parsed.id === noteId && !updated) {
          updated = { ...parsed, text };
          lines.push(JSON.stringify(updated));
          continue;
        }
        lines.push(JSON.stringify(parsed));
      } catch {
        lines.push(trimmed);
      }
    }
    if (!updated) return null;
    await writeFileAtomic(file, lines.length ? `${lines.join('\n')}\n` : '');
    return updated;
  }

  // ── Installed toolsets ──

  async listInstalledToolsets(scope: ToolsetsScope): Promise<InstalledToolset[]> {
    const primary = this.toolsetsFile(scope);
    try {
      const raw = await readFile(primary, 'utf8');
      const parsed = JSON.parse(raw) as InstalledToolset[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to the legacy-path check below */
    }
    // One-time migration for system-scope only. The legacy path is
    // `system-toolsets.json`, which was shared with the bootstrap's
    // tracking record. When both subsystems wrote to it the file
    // contents oscillated — last write wins. If the legacy file
    // happens to currently be a valid `InstalledToolset[]` array,
    // recover the data rather than telling the user "not installed"
    // on everything. `writeInstalledToolsets` always lands at the
    // new path from here on out.
    if (scope.kind === 'system') {
      try {
        const legacyRaw = await readFile(systemToolsetsFile(this.home), 'utf8');
        const legacyParsed = JSON.parse(legacyRaw);
        if (Array.isArray(legacyParsed)) return legacyParsed as InstalledToolset[];
      } catch {
        /* legacy file missing or not a JSON array — give up */
      }
    }
    return [];
  }

  async writeInstalledToolsets(scope: ToolsetsScope, toolsets: InstalledToolset[]): Promise<void> {
    const file = this.toolsetsFile(scope);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(toolsets, null, 2)}\n`);
  }

  /** Directory a toolset install pipeline can extract into for this scope. */
  toolsetInstallRoot(scope: ToolsetsScope): string {
    if (scope.kind === 'gezel') return gezelToolsetsInstallDir(this.home, scope.gezelId);
    if (scope.kind === 'project') return projectToolsetsInstallDir(this.home, scope.projectId);
    if (scope.kind === 'system') return systemToolsetsInstallDir(this.home);
    return sharedToolsetsInstallDir(this.home);
  }

  // ── Global toolset config ──
  //
  // One config per toolsetId, globally. Non-secret values only; secret
  // fields live in the SecretStore. Callers merge the two at spawn time.

  async readToolsetConfig(toolsetId: string): Promise<ToolsetConfig | null> {
    try {
      const raw = await readFile(toolsetConfigFile(this.home, toolsetId), 'utf8');
      return JSON.parse(raw) as ToolsetConfig;
    } catch {
      return null;
    }
  }

  async writeToolsetConfigValues(toolsetId: string, values: Record<string, string>): Promise<void> {
    const file = toolsetConfigFile(this.home, toolsetId);
    await mkdir(dirname(file), { recursive: true });
    const config: ToolsetConfig = {
      toolsetId,
      values,
      updatedAt: nowIso(),
    };
    await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
    await tryChmod600(file);
  }

  private toolsetsFile(scope: ToolsetsScope): string {
    if (scope.kind === 'gezel') return gezelToolsetsFile(this.home, scope.gezelId);
    if (scope.kind === 'project') return projectToolsetsFile(this.home, scope.projectId);
    // Previously this returned systemToolsetsFile(home), which
    // collided with the bootstrap's SystemTrackingRecord at the same
    // path — each subsystem silently overwrote the other. Now on its
    // own file. On first read of the new path, if it's missing but
    // the legacy path happens to still hold a valid `InstalledToolset[]`
    // array, we migrate — see `listInstalledToolsets`.
    if (scope.kind === 'system') return systemInstalledToolsetsFile(this.home);
    return sharedToolsetsFile(this.home);
  }

  /* ─── Local craftbook templates ─────────────────────────────────────── */

  /**
   * List user-authored craftbook templates from the local catalog source
   * under `~/.gezel/craftbook-templates/`. Returns lightweight summaries
   * — full hydration goes through `getLocalCraftbookTemplate`.
   */
  async listLocalCraftbookTemplates(): Promise<CraftbookSummary[]> {
    const root = craftbookTemplatesRoot(this.home);
    let shards: string[];
    try {
      shards = await readdir(root);
    } catch {
      return [];
    }
    const out: CraftbookSummary[] = [];
    for (const shard of shards) {
      let ids: string[] = [];
      try {
        ids = await readdir(join(root, shard));
      } catch {
        continue;
      }
      for (const id of ids) {
        const book = await this.getLocalCraftbookTemplate(id);
        if (!book) continue;
        out.push({
          id: book.id,
          name: book.name,
          ...(book.description ? { description: book.description } : {}),
          ...(book.version ? { version: book.version } : {}),
          ...(book.basedOn ? { basedOn: book.basedOn } : {}),
          source: 'local',
          stepCount: book.steps.length,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Read every `scripts/*.ts` file in a craftbook version dir into the
   * runtime `scripts` map (name → source). Absent/empty dir → undefined.
   * The hydration half of the inline-scripts contract: sources stay
   * ordinary files on disk; the resolved runtime object carries them.
   */
  private async readCraftbookScriptsDir(dir: string): Promise<Record<string, string> | undefined> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return undefined;
    }
    const scripts: Record<string, string> = {};
    for (const f of files.filter((f) => f.endsWith('.ts')).sort()) {
      try {
        scripts[f.slice(0, -3)] = await readFile(join(dir, f), 'utf8');
      } catch {
        /* unreadable entry — skip */
      }
    }
    return Object.keys(scripts).length > 0 ? scripts : undefined;
  }

  /**
   * Persist a `scripts` map into a version's `scripts/` dir. The map is
   * the truth: entries are written, on-disk `.ts` files whose names left
   * the map are deleted. `undefined` leaves the dir untouched (legacy
   * callers that never carried scripts must not clear what the script
   * editor wrote); pass `{}` to clear.
   */
  private async writeCraftbookScriptsDir(
    dir: string,
    scripts: Record<string, string> | undefined,
  ): Promise<void> {
    if (scripts === undefined) return;
    let existing: string[] = [];
    try {
      existing = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    } catch {
      /* no dir yet */
    }
    const keep = new Set(Object.keys(scripts).map((n) => `${n}.ts`));
    if (Object.keys(scripts).length > 0) await mkdir(dir, { recursive: true });
    for (const [name, source] of Object.entries(scripts)) {
      await writeFileAtomic(join(dir, `${name}.ts`), source);
    }
    for (const f of existing) {
      if (!keep.has(f)) await rm(join(dir, f), { force: true }).catch(() => undefined);
    }
  }

  /**
   * Resolve a local craftbook template into the runtime `Craftbook`
   * shape — identity + version manifest + about.md merged. When
   * `version` is omitted, picks the only present version (v1: local
   * templates have a single `1.0.0` version edited in place).
   */
  async getLocalCraftbookTemplate(id: string, version?: string): Promise<Craftbook | null> {
    const prefix = craftbookShardPrefix(id);
    const identityFile = craftbookTemplateManifestFile(this.home, prefix, id);
    let identity: { id?: string; name?: string; description?: string } = {};
    try {
      identity = JSON.parse(await readFile(identityFile, 'utf8'));
    } catch {
      return null;
    }
    if (identity.id !== id) return null;
    // Discover versions; default to single 1.0.0 for local source.
    const versionsDir = join(craftbookTemplateDir(this.home, prefix, id), 'versions');
    let versions: string[];
    try {
      versions = await readdir(versionsDir);
    } catch {
      return null;
    }
    versions = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v));
    if (versions.length === 0) return null;
    const chosen = version ?? versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]!;
    if (!versions.includes(chosen)) return null;
    const versionFile = craftbookTemplateVersionManifestFile(this.home, prefix, id, chosen);
    let raw: string;
    try {
      raw = await readFile(versionFile, 'utf8');
    } catch {
      return null;
    }
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      return null;
    }
    const v = parsedRaw as {
      steps?: unknown;
      entryStepId?: unknown;
      plan?: unknown;
      defaultAssignee?: unknown;
      basedOn?: unknown;
      runModes?: unknown;
      releasedAt?: unknown;
    };
    let steps: Craftbook['steps'] | null;
    try {
      steps = z_array_parse(v.steps);
    } catch {
      return null;
    }
    if (!steps || typeof v.entryStepId !== 'string') return null;
    const scripts = await this.readCraftbookScriptsDir(
      join(craftbookTemplateVersionDir(this.home, prefix, id, chosen), 'scripts'),
    );
    const now = nowIso();
    const candidate: Craftbook = {
      id,
      name: identity.name ?? id,
      ...(identity.description ? { description: identity.description } : {}),
      version: chosen,
      ...(v.basedOn && typeof v.basedOn === 'object'
        ? { basedOn: v.basedOn as Craftbook['basedOn'] }
        : {}),
      ...(typeof v.plan === 'string' ? { plan: v.plan } : {}),
      ...(v.defaultAssignee
        ? { defaultAssignee: v.defaultAssignee as Craftbook['defaultAssignee'] }
        : {}),
      ...(v.runModes && typeof v.runModes === 'object'
        ? { runModes: v.runModes as Craftbook['runModes'] }
        : {}),
      steps,
      entryStepId: v.entryStepId,
      ...(scripts ? { scripts } : {}),
      createdAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
      updatedAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
    };
    try {
      return CraftbookSchema.parse(candidate);
    } catch {
      return null;
    }
  }

  /**
   * Persist a local craftbook template. Writes the identity manifest
   * once (if absent), then writes the version manifest in place. v1
   * uses a single `1.0.0` version per local craftbook — re-saves
   * overwrite that version rather than minting a new one.
   */
  async writeLocalCraftbookTemplate(book: Craftbook): Promise<void> {
    const prefix = craftbookShardPrefix(book.id);
    const version = book.version ?? '1.0.0';
    const identityFile = craftbookTemplateManifestFile(this.home, prefix, book.id);
    const versionDir = craftbookTemplateVersionDir(this.home, prefix, book.id, version);
    const versionFile = craftbookTemplateVersionManifestFile(this.home, prefix, book.id, version);
    await mkdir(versionDir, { recursive: true });
    let writeIdentity = true;
    try {
      await readFile(identityFile, 'utf8');
      writeIdentity = false;
    } catch {
      /* missing — write fresh */
    }
    if (writeIdentity) {
      const identity = {
        schemaVersion: 1,
        kind: 'craftbook-template',
        id: book.id,
        name: book.name,
        description: book.description ?? '',
        tags: [],
        maintainer: { name: 'local' },
        license: undefined,
        yankedVersions: [],
      };
      await writeFileAtomic(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    }
    const versionManifest = {
      schemaVersion: 1,
      version,
      releasedAt: book.updatedAt,
      about: 'about.md',
      entryStepId: book.entryStepId,
      steps: book.steps,
      ...(book.basedOn ? { basedOn: book.basedOn } : {}),
      ...(book.plan !== undefined ? { plan: book.plan } : {}),
      ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
      ...(book.runModes ? { runModes: book.runModes } : {}),
      ...(book.scripts ? { bundledScripts: Object.keys(book.scripts).map((n) => `${n}.ts`) } : {}),
    };
    await writeFileAtomic(versionFile, `${JSON.stringify(versionManifest, null, 2)}\n`);
    if (book.description) {
      await writeFileAtomic(join(versionDir, 'about.md'), book.description);
    }
    await this.writeCraftbookScriptsDir(join(versionDir, 'scripts'), book.scripts);
  }

  /**
   * Remove a local craftbook template entirely. Caller is responsible
   * for refusing the delete when any task's `sourceCraftbookIds`
   * references it — the Store doesn't cross-check that itself.
   */
  async deleteLocalCraftbookTemplate(id: string): Promise<void> {
    const prefix = craftbookShardPrefix(id);
    const dir = craftbookTemplateDir(this.home, prefix, id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* already absent */
    }
  }

  /* ─── Project-local craftbooks (workspace `.gezel/craftbooks/`) ──────── */

  /**
   * List the project-local craftbooks defined in a project's workspace
   * `.gezel/craftbooks/` folder. These travel with the repo and only
   * surface inside their own project. Flat layout (no shard prefix);
   * otherwise mirrors {@link listLocalCraftbookTemplates}.
   */
  async listProjectCraftbooks(projectId: string): Promise<CraftbookSummary[]> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return [];
    }
    let ids: string[] = [];
    try {
      const entries = await readdir(projectLocalCraftbooksRoot(ws), { withFileTypes: true });
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const out: CraftbookSummary[] = [];
    for (const id of ids) {
      const book = await this.getProjectCraftbook(projectId, id);
      if (!book) continue;
      out.push({
        id: book.id,
        name: book.name,
        ...(book.description ? { description: book.description } : {}),
        ...(book.version ? { version: book.version } : {}),
        ...(book.basedOn ? { basedOn: book.basedOn } : {}),
        source: 'project',
        stepCount: book.steps.length,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Resolve a project-local craftbook into the runtime `Craftbook` shape. */
  async getProjectCraftbook(
    projectId: string,
    id: string,
    version?: string,
  ): Promise<Craftbook | null> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    const dir = projectLocalCraftbookDir(ws, id);
    let identity: { id?: string; name?: string; description?: string } = {};
    try {
      identity = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
    if (identity.id !== id) return null;
    const versionsDir = join(dir, 'versions');
    let versions: string[];
    try {
      versions = await readdir(versionsDir);
    } catch {
      return null;
    }
    versions = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v));
    if (versions.length === 0) return null;
    const chosen = version ?? versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]!;
    if (!versions.includes(chosen)) return null;
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(await readFile(join(versionsDir, chosen, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
    const v = parsedRaw as {
      steps?: unknown;
      entryStepId?: unknown;
      plan?: unknown;
      defaultAssignee?: unknown;
      basedOn?: unknown;
      triggers?: unknown;
      toolsets?: unknown;
      hooks?: unknown;
      paramSchema?: unknown;
      command?: unknown;
      requirements?: unknown;
      runModes?: unknown;
      releasedAt?: unknown;
    };
    let steps: Craftbook['steps'] | null;
    try {
      steps = z_array_parse(v.steps);
    } catch {
      return null;
    }
    if (!steps || typeof v.entryStepId !== 'string') return null;
    const scripts = await this.readCraftbookScriptsDir(join(versionsDir, chosen, 'scripts'));
    const now = nowIso();
    const candidate: Craftbook = {
      id,
      name: identity.name ?? id,
      ...(identity.description ? { description: identity.description } : {}),
      version: chosen,
      ...(v.basedOn && typeof v.basedOn === 'object'
        ? { basedOn: v.basedOn as Craftbook['basedOn'] }
        : {}),
      ...(typeof v.plan === 'string' ? { plan: v.plan } : {}),
      ...(v.defaultAssignee
        ? { defaultAssignee: v.defaultAssignee as Craftbook['defaultAssignee'] }
        : {}),
      steps,
      entryStepId: v.entryStepId,
      ...(Array.isArray(v.triggers) ? { triggers: v.triggers as string[] } : {}),
      ...(Array.isArray(v.toolsets) ? { toolsets: v.toolsets as Craftbook['toolsets'] } : {}),
      ...(Array.isArray(v.hooks) ? { hooks: v.hooks as Craftbook['hooks'] } : {}),
      ...(v.paramSchema && typeof v.paramSchema === 'object'
        ? { paramSchema: v.paramSchema as Craftbook['paramSchema'] }
        : {}),
      ...(typeof v.command === 'string' ? { command: v.command } : {}),
      ...(Array.isArray(v.requirements)
        ? { requirements: v.requirements as Craftbook['requirements'] }
        : {}),
      ...(v.runModes && typeof v.runModes === 'object'
        ? { runModes: v.runModes as Craftbook['runModes'] }
        : {}),
      ...(scripts ? { scripts } : {}),
      createdAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
      updatedAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
    };
    try {
      return CraftbookSchema.parse(candidate);
    } catch {
      return null;
    }
  }

  /** Persist a project-local craftbook (flat `.gezel/craftbooks/<id>/` layout). */
  async writeProjectCraftbook(projectId: string, book: Craftbook): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalCraftbookDir(gate.workspaceDir, book.id);
    const version = book.version ?? '1.0.0';
    const versionDir = join(dir, 'versions', version);
    await mkdir(versionDir, { recursive: true });
    const identityFile = join(dir, 'manifest.json');
    let writeIdentity = true;
    try {
      await readFile(identityFile, 'utf8');
      writeIdentity = false;
    } catch {
      /* missing — write fresh */
    }
    if (writeIdentity) {
      const identity = {
        schemaVersion: 1,
        kind: 'craftbook-template',
        id: book.id,
        name: book.name,
        description: book.description ?? '',
        tags: [],
        maintainer: { name: 'project' },
        yankedVersions: [],
      };
      await writeFileAtomic(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    }
    const versionManifest = {
      schemaVersion: 1,
      version,
      releasedAt: book.updatedAt,
      about: 'about.md',
      entryStepId: book.entryStepId,
      steps: book.steps,
      ...(book.basedOn ? { basedOn: book.basedOn } : {}),
      ...(book.plan !== undefined ? { plan: book.plan } : {}),
      ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
      ...(book.triggers ? { triggers: book.triggers } : {}),
      ...(book.toolsets ? { toolsets: book.toolsets } : {}),
      ...(book.hooks ? { hooks: book.hooks } : {}),
      ...(book.paramSchema ? { paramSchema: book.paramSchema } : {}),
      ...(book.command ? { command: book.command } : {}),
      ...(book.requirements ? { requirements: book.requirements } : {}),
      ...(book.runModes ? { runModes: book.runModes } : {}),
      ...(book.scripts ? { bundledScripts: Object.keys(book.scripts).map((n) => `${n}.ts`) } : {}),
    };
    await writeFileAtomic(
      join(versionDir, 'manifest.json'),
      `${JSON.stringify(versionManifest, null, 2)}\n`,
    );
    if (book.description) {
      await writeFileAtomic(join(versionDir, 'about.md'), book.description);
    }
    await this.writeCraftbookScriptsDir(join(versionDir, 'scripts'), book.scripts);
  }

  /** Remove a project-local craftbook from the workspace. */
  async deleteProjectCraftbook(projectId: string, id: string): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalCraftbookDir(gate.workspaceDir, id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* already absent */
    }
  }

  /**
   * Read the project-type install sidecar for a project-local craftbook
   * (`.gezel/craftbooks/<id>/provenance.json`). Null when the book was
   * user-authored, imported from a SKILL.md, or the sidecar is invalid.
   */
  async readProjectCraftbookProvenance(
    projectId: string,
    id: string,
  ): Promise<ProjectCraftbookProvenance | null> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    try {
      const raw = await readFile(join(projectLocalCraftbookDir(ws, id), 'provenance.json'), 'utf8');
      return ProjectCraftbookProvenanceSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Stamp the project-type install sidecar next to the book's identity manifest. */
  async writeProjectCraftbookProvenance(
    projectId: string,
    id: string,
    prov: ProjectCraftbookProvenance,
  ): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalCraftbookDir(gate.workspaceDir, id);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, 'provenance.json'), `${JSON.stringify(prov, null, 2)}\n`);
  }
}

/** First two chars of a craftbook id, lowercased — the catalog shard prefix. */
function craftbookShardPrefix(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

/** Parse a steps array against `CraftbookStepSchema`; throws on invalid rows. */
function z_array_parse(raw: unknown): Craftbook['steps'] | null {
  if (!Array.isArray(raw)) return null;
  const out: Craftbook['steps'] = [];
  for (const item of raw) {
    out.push(CraftbookStepSchema.parse(item));
  }
  return out;
}

async function tryChmod600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await chmod(path, 0o600);
  } catch {
    // best-effort; some filesystems don't support chmod
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() || e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * One-shot upgrade for assistant messages whose content still carries
 * the legacy inline italic phase-announcement format
 * (`\n_...label..._\n\n`). Extracts each match into a structured
 * `{ label, afterChars }` entry on `intents[]` and strips the marker
 * from `content` so the UI renders it as an HR divider instead of
 * italicized prose. Returns true if the session was mutated. Pure —
 * callers decide whether to write back.
 *
 * Safety gate: any assistant message that already has `intents` is
 * skipped (idempotent). Only matches the exact emission shape
 * (single-line label wrapped in leading + trailing newlines), which
 * keeps collateral damage on legitimate italic text low.
 */
function migrateLegacyIntents(session: ChatSession): boolean {
  let mutated = false;
  for (const msg of session.messages) {
    if (msg.role !== 'assistant') continue;
    if (msg.intents && msg.intents.length > 0) continue;
    if (!msg.content || !msg.content.includes('_')) continue;
    // Non-greedy `[^\n]+?` so labels containing underscores survive
    // (e.g. "Running test_foo.ts"). The `_\n\n` terminator is
    // distinctive enough that false positives on legitimate inline
    // italics (`Use _foo_ here.`) don't fire — those lack the two
    // trailing newlines.
    const pattern = /\n_([^\n]+?)_\n\n/g;
    const extracted: Array<{ label: string; afterChars: number }> = [];
    let rebuilt = '';
    let cursor = 0;
    pattern.lastIndex = 0;
    let match = pattern.exec(msg.content);
    while (match !== null) {
      const label = match[1]?.trim();
      if (label) {
        rebuilt += msg.content.slice(cursor, match.index);
        extracted.push({ label, afterChars: rebuilt.length });
        cursor = match.index + match[0].length;
      }
      match = pattern.exec(msg.content);
    }
    if (extracted.length === 0) continue;
    rebuilt += msg.content.slice(cursor);
    msg.content = rebuilt;
    msg.intents = extracted;
    mutated = true;
  }
  return mutated;
}

/**
 * If `workingDir` is itself an existing git checkout of a github.com
 * repo, return a `ProjectGitHub` that populates `url` (from origin) and
 * `checkoutDir = workingDir` so the GitHub features (status bar,
 * branch picker, etc.) light up without the user having to type the
 * URL. Returns `undefined` when the dir isn't a git repo, the origin
 * isn't github.com, or the existing link already points at a
 * different URL (we don't silently clobber a user-supplied link).
 */
async function autoDetectGitHubLink(
  workingDir: string,
  existing: ProjectGitHub | undefined,
): Promise<ProjectGitHub | undefined> {
  const inspected = await inspectGitWorkdir(workingDir);
  if (!inspected.isRepo || !inspected.originUrl) return undefined;
  const parsed = parseGitHubUrl(inspected.originUrl);
  if (!parsed) return undefined;
  // Honor an existing link only if it points at the same repo; refuse
  // to overwrite a different one (the user explicitly set it).
  if (existing?.url && !sameGitHubRepo(existing.url, parsed.canonical)) return undefined;
  return {
    ...(existing ?? {}),
    url: parsed.canonical,
    checkoutDir: workingDir,
    lastSyncedAt: new Date().toISOString(),
  };
}

/** Merge a properties patch onto the stored bag; empty string deletes. */
function mergeProjectProperties(
  existing: Record<string, string> | undefined,
  patch: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = { ...(existing ?? {}) };
  for (const [id, value] of Object.entries(patch)) {
    if (value === '') delete next[id];
    else next[id] = value;
  }
  return next;
}

function mergeGitHubPatch(
  existing: ProjectGitHub | undefined,
  patch: { url?: string; branch?: string } | null | undefined,
): ProjectGitHub | undefined {
  if (patch === undefined) return existing;
  if (patch === null) return undefined;
  // url is required to keep a link alive — clearing it via "" also unlinks.
  if (patch.url === '') return undefined;
  const url = patch.url ?? existing?.url;
  if (!url) return undefined;
  // Switching url drops service-managed fields so a re-clone happens fresh.
  if (existing && existing.url !== url) {
    return {
      url,
      ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
    };
  }
  return {
    ...(existing ?? { url }),
    url,
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Choose a `roleBasedName` for a gezel given its role and the set of
 * names already in use on this install. Exported for tests; the
 * stateful wrapper lives on `Store.computeRoleBasedName`.
 *
 *   - With role: base = `slugify(role)`. If unused, return it. Else
 *     append `-2`, `-3`, … until free.
 *   - Without role (or role slugifies to empty): return the first
 *     unused `gezel-N` starting from `gezel-1`.
 */
export function pickRoleBasedName(role: string | undefined, taken: ReadonlySet<string>): string {
  const base = role ? slugify(role) : '';
  if (base) {
    if (!taken.has(base)) return base;
    for (let i = 2; i < 10000; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`roleBasedName collision overflow for role "${role}"`);
  }
  for (let i = 1; i < 10000; i++) {
    const candidate = `gezel-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('roleBasedName collision overflow for roleless gezel');
}

function defaultAboutMarkdown(name: string, gender?: GezelGender): string {
  const pronouns = pronounFormsForGender(gender);
  return `# ${name}

Write a few paragraphs about this agent: who ${pronouns.subject} ${pronouns.presentBe}, what ${pronouns.subject} ${pronouns.presentBe} good at, how ${pronouns.subject} should behave, and anything a task runner should know to work with ${pronouns.object} well. This content is injected into the system prompt whenever a task uses this agent.
`;
}

function stringSeed(s: string): number {
  // djb2 — same family as the poppetje seed helper, kept local to
  // avoid pulling a stringHash export into core just for this. Returns
  // a 32-bit unsigned int.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function defaultAgentMarkdown(params: {
  id: string;
  name: string;
  description?: string;
  role?: string;
  roleBasedName?: string;
  gender?: GezelGender;
  voice?: string;
  model?: string;
  templateId?: string;
  templateVersion?: string;
  /**
   * Frontmatter the template wants merged in. `fixedFunction` is the
   * legacy non-scalar passthrough; `tuningProfile`, `tuning`,
   * `reasoningEffort`, and `provider` flow from gezel-template
   * manifests (e.g. Builder template declares
   * `frontmatter.tuningProfile: 'thinking-coding'`). Until this
   * function rendered them, the resolver at
   * `manager.ts:resolveTuning` saw `gezel.parsed.frontmatter.tuningProfile`
   * as undefined — the entire profile workstream was a no-op.
   * When `fixedFunction` is set we still skip the LLM-shaped
   * sections — the gezel has no system prompt.
   */
  extraFrontmatter?: Partial<import('@bendyline/gezel').GezelFrontmatter>;
}): string {
  const ff = params.extraFrontmatter?.fixedFunction;
  const tuningProfile = params.extraFrontmatter?.tuningProfile;
  const suggestedTuningProfile = params.extraFrontmatter?.suggestedTuningProfile;
  const tuning = params.extraFrontmatter?.tuning;
  const reasoningEffort = params.extraFrontmatter?.reasoningEffort;
  const provider = params.extraFrontmatter?.provider;
  const frontmatter = [
    '---',
    `id: ${params.id}`,
    `name: ${JSON.stringify(params.name)}`,
    ...(params.description ? [`description: ${JSON.stringify(params.description)}`] : []),
    ...(params.role ? [`role: ${JSON.stringify(params.role)}`] : []),
    ...(params.roleBasedName ? [`roleBasedName: ${JSON.stringify(params.roleBasedName)}`] : []),
    ...(params.gender ? [`gender: ${JSON.stringify(params.gender)}`] : []),
    ...(params.voice ? [`voice: ${JSON.stringify(params.voice)}`] : []),
    ...(params.model ? [`model: ${params.model}`] : []),
    ...(provider ? [`provider: ${JSON.stringify(provider)}`] : []),
    ...(params.templateId ? [`templateId: ${JSON.stringify(params.templateId)}`] : []),
    ...(params.templateVersion
      ? [`templateVersion: ${JSON.stringify(params.templateVersion)}`]
      : []),
    ...(tuningProfile ? [`tuningProfile: ${JSON.stringify(tuningProfile)}`] : []),
    ...(suggestedTuningProfile
      ? [`suggestedTuningProfile: ${JSON.stringify(suggestedTuningProfile)}`]
      : []),
    ...(reasoningEffort ? [`reasoningEffort: ${JSON.stringify(reasoningEffort)}`] : []),
    ...(tuning ? [`tuning: ${JSON.stringify(tuning)}`] : []),
    ...(ff
      ? [
          'fixedFunction:',
          `  tool: ${JSON.stringify(ff.tool)}`,
          `  promptKey: ${JSON.stringify(ff.promptKey ?? 'prompt')}`,
          ...(ff.defaults && Object.keys(ff.defaults).length > 0
            ? [`  defaults: ${JSON.stringify(ff.defaults)}`]
            : []),
        ]
      : []),
    '---',
  ].join('\n');
  if (ff) {
    return `${frontmatter}\n`;
  }
  return `${frontmatter}

## Instructions {[instruction]}

You are a helpful agent. Describe how you should behave here.

## Memory {[memory]}

(Long-term facts the agent should remember go here.)

## Output Format {[output]}

(Describe the expected output format here.)
`;
}
