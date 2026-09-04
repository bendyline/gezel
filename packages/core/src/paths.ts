import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { assertSafeEntityId } from './entity-id.js';
import { KnowledgeIdSchema, KnowledgeVersionSchema } from './schemas/knowledge.js';

/**
 * Marker written by the privileged installer after a legacy machine-home
 * migration has completed. Merely finding a writable-looking directory is
 * not enough to mount it: the marker is the installer's assertion that the
 * root has the intended cross-account ACL and contains migrated product data.
 */
export const MACHINE_SHARED_MARKER = '.gezel-machine-shared-v1.json';

/**
 * Canonical root for explicit machine-shared product data. This is separate
 * from the machine engine broker's private home: user daemons perform every
 * project/gezel filesystem operation with the logged-in user's permissions.
 *
 * GEZEL_MACHINE_SHARED_HOME is primarily an operator/test override. A root is
 * mounted only when {@link MACHINE_SHARED_MARKER} exists beneath it.
 */
export function machineSharedHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.GEZEL_MACHINE_SHARED_HOME;
  if (override?.trim()) return override;
  if (platform === 'win32') {
    const base = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    return win32.join(base, 'Gezel', 'shared');
  }
  if (platform === 'darwin') return '/Users/Shared/Gezel';
  if (platform === 'linux') return '/var/lib/gezel/shared';
  return null;
}

export function machineSharedMarkerFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = machineSharedHome(platform, env);
  if (!root) return null;
  return platform === 'win32'
    ? win32.join(root, MACHINE_SHARED_MARKER)
    : posix.join(root, MACHINE_SHARED_MARKER);
}

/** A shared root is trusted only after the installer publishes its marker. */
export function activeMachineSharedHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = machineSharedHome(process.platform, env);
  const marker = machineSharedMarkerFile(process.platform, env);
  if (!root || !marker || !existsSync(marker)) return null;
  // An explicit operator/test override is itself the trust decision.
  if (env.GEZEL_MACHINE_SHARED_HOME?.trim()) return root;

  // Default discovery is coupled to a live split-role installation. A marker
  // planted in a broadly writable conventional directory must not be enough
  // to inject gezel prompts/projects into another account's daemon.
  const systemHome =
    process.platform === 'win32'
      ? win32.dirname(root)
      : process.platform === 'darwin'
        ? '/Library/Application Support/Gezel'
        : process.platform === 'linux'
          ? '/var/lib/gezel'
          : null;
  if (!systemHome) return null;
  const roleFile = join(systemHome, 'runtime', 'service-role');
  try {
    if (readFileSync(roleFile, 'utf8').trim() !== 'machine-engine') return null;
    if (process.platform !== 'win32') {
      const markerStat = lstatSync(marker);
      const roleStat = lstatSync(roleFile);
      if (
        !markerStat.isFile() ||
        !roleStat.isFile() ||
        markerStat.uid !== 0 ||
        (markerStat.mode & 0o022) !== 0 ||
        (roleStat.mode & 0o022) !== 0
      ) {
        return null;
      }
    }
    return root;
  } catch {
    return null;
  }
}

export type MachineStorageScope = 'user' | 'machine-shared';

/** Explicit user-home entity locations, bypassing shared-root resolution. */
export function userGezelDir(root: string, gezelId: string, external?: ExternalFolders): string {
  assertSafeEntityId(gezelId, 'gezel id');
  return join(external?.gezels ?? join(root, 'gezels'), gezelId);
}

export function userProjectDir(root: string, projectId: string): string {
  assertSafeEntityId(projectId, 'project id');
  return join(root, 'projects', projectId);
}

/**
 * Per-account sidecar for project runtime state.
 *
 * Unlike {@link projectStorageDir}, this NEVER follows a machine-shared project
 * into the installer-managed shared root. It is the only appropriate home for
 * approvals, questions, histories, terminals, executable installs, and
 * derived databases that belong to the logged-in user's daemon.
 *
 * A sidecar deliberately has no `project.json`; projectStorageScope therefore
 * continues to resolve the canonical definition from the machine-shared root.
 */
export function projectPrivateDir(root: string, projectId: string): string {
  return userProjectDir(root, projectId);
}

/**
 * Daemon-owned record of the seed files the applied project type deployed
 * into the workspace (the "overlay manifest"). Per-machine by design — it
 * lives in the private sidecar, never in the possibly-synced workspace.
 */
export function projectTypeOverlayFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'project-type-overlay.json');
}

export function machineSharedGezelDir(gezelId: string): string | null {
  assertSafeEntityId(gezelId, 'gezel id');
  const shared = activeMachineSharedHome();
  return shared ? join(shared, 'gezels', gezelId) : null;
}

export function machineSharedProjectDir(projectId: string): string | null {
  assertSafeEntityId(projectId, 'project id');
  const shared = activeMachineSharedHome();
  return shared ? join(shared, 'projects', projectId) : null;
}

/**
 * Local definition wins on id collision. Sidecar-only user directories (for
 * private sessions/memories belonging to a shared gezel) deliberately do not:
 * `gezel.md` is the definition/ownership signal.
 */
export function gezelStorageScope(
  root: string,
  gezelId: string,
  external?: ExternalFolders,
): MachineStorageScope {
  const local = userGezelDir(root, gezelId, external);
  if (existsSync(join(local, 'gezel.md'))) return 'user';
  const shared = machineSharedGezelDir(gezelId);
  if (shared && shared !== local && existsSync(join(shared, 'gezel.md'))) return 'machine-shared';
  return 'user';
}

/** `project.json` is the project definition/ownership signal. */
export function projectStorageScope(root: string, projectId: string): MachineStorageScope {
  const local = userProjectDir(root, projectId);
  if (existsSync(join(local, 'project.json'))) return 'user';
  const shared = machineSharedProjectDir(projectId);
  if (shared && shared !== local && existsSync(join(shared, 'project.json'))) {
    return 'machine-shared';
  }
  return 'user';
}

/**
 * Resolve the root of the Gezel user directory. Defaults to `~/.gezel`
 * but can be overridden with the `GEZEL_HOME` environment variable (used
 * heavily by the integration tests).
 */
export function gezelHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GEZEL_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), '.gezel');
}

/**
 * Per-scope external roots. When a field is set, that scope's content
 * lives outside `~/.gezel/` (e.g. on a OneDrive folder). Configured via
 * Settings → Folders; persisted on `GezelConfig.externalFolders`. The
 * helpers below take this struct as an optional trailing argument and
 * route to the external location when present, otherwise fall back to
 * the local layout.
 *
 * Some subdirectories deliberately stay local even when their parent
 * scope is externalized (gezel `toolsets/`, project `workspace/`, `gh/`,
 * `scripts/`, `project.json`, `history.jsonl`, `questions.json`). Those
 * paths use the `*LocalDir` helpers, which never consult `external`.
 */
export interface ExternalFolders {
  documents?: string;
  gezels?: string;
  projects?: string;
}

export interface GezelPaths {
  root: string;
  config: string;
  runtime: {
    dir: string;
    pid: string;
    port: string;
    /**
     * Per-launch first-party client credential used for service discovery.
     * It carries the reserved `ui` plus local-facade `openai` scopes; the
     * daemon root credential is process-local and must never be written here.
     */
    token: string;
    /**
     * PEM-encoded loopback TLS cert. Public material; chmod 0644 so
     * external clients (CLI, ad-hoc curl) can read it. Rotated on every
     * daemon start, same as `token`. Only present when the daemon is
     * serving HTTPS — absent under `GEZEL_INSECURE_TRANSPORT=1`.
     */
    cert: string;
    /**
     * Hex SHA-256 of the cert's DER bytes — what the Electron renderer
     * pins via `session.setCertificateVerifyProc`. Stored as a separate
     * file so the supervisor can read the fingerprint without parsing
     * the PEM.
     */
    fingerprint: string;
    /**
     * Per-launch ephemeral token for the browser web-UI mode (`gezel
     * start --web`). Written only when web mode is on; the CLI reads it
     * to compose the one-time `?token=` URL it prints, so the root token
     * never lands in a URL / shell history. Same lifecycle as `token` —
     * rotates every boot, not persisted to `tokens.json`.
     */
    webUiToken: string;
  };
  /**
   * Directory where Electron extracts the `service-bundle/` tree on first
   * launch. This is the stable path users can `cd` into to run local dev
   * commands against the bundled CLI (e.g. `npx @github/copilot login`).
   */
  install: string;
  gezels: string;
  projects: string;
  documents: string;
  logs: string;
}

export function gezelPaths(root: string = gezelHome(), external?: ExternalFolders): GezelPaths {
  const runtimeDir = join(root, 'runtime');
  return {
    root,
    config: join(root, 'config.json'),
    runtime: {
      dir: runtimeDir,
      pid: join(runtimeDir, 'pid'),
      port: join(runtimeDir, 'port'),
      token: join(runtimeDir, 'auth-token'),
      cert: join(runtimeDir, 'cert.pem'),
      fingerprint: join(runtimeDir, 'cert-fingerprint'),
      webUiToken: join(runtimeDir, 'web-ui-token'),
    },
    install: join(root, 'service'),
    gezels: external?.gezels ?? join(root, 'gezels'),
    projects: external?.projects ?? join(root, 'projects'),
    documents: external?.documents ?? join(root, 'documents'),
    logs: join(root, 'logs'),
  };
}

/**
 * Always-local private transaction state. Unlike `runtime/`, this directory
 * contains daemon-internal recovery metadata and must never be exposed as
 * desktop-client discovery material on a machine-wide install.
 */
export function daemonTransactionsRoot(root: string): string {
  return join(root, '.transactions');
}

/** Durable journals + isolated staging homes for atomic typed-project creation. */
export function projectCreateTransactionsRoot(root: string): string {
  return join(daemonTransactionsRoot(root), 'project-create');
}

// ---------- gezel scope ----------

/**
 * Per-gezel directory holding `gezel.md`, `about.md`, `icon.svg`,
 * `icons/`, `sessions/`, `memories/`, `resources/`. Routes to the
 * external location when `external.gezels` is set.
 *
 * Note: `toolsets/` and `toolsets.json` are deliberately NOT under this
 * dir when externalized — they stay local (see {@link gezelLocalDir}).
 */
export function gezelDir(root: string, gezelId: string, external?: ExternalFolders): string {
  if (gezelStorageScope(root, gezelId, external) === 'machine-shared') {
    return machineSharedGezelDir(gezelId)!;
  }
  return userGezelDir(root, gezelId, external);
}

/**
 * Always-local per-gezel directory. Holds installed toolsets (npm
 * package extracts) — kept out of cloud-synced folders because
 * node_modules churn is hostile to OneDrive/Dropbox-style sync.
 */
export function gezelLocalDir(root: string, gezelId: string): string {
  assertSafeEntityId(gezelId, 'gezel id');
  return join(root, 'gezels', gezelId);
}

export function gezelSessionsDir(
  root: string,
  gezelId: string,
  external?: ExternalFolders,
): string {
  // Character identity may be shared, but transcripts are account-private.
  // Migrated legacy transcripts are copied into this sidecar on first mount.
  if (gezelStorageScope(root, gezelId, external) === 'machine-shared') {
    return join(gezelLocalDir(root, gezelId), 'sessions');
  }
  return join(gezelDir(root, gezelId, external), 'sessions');
}

export function gezelSessionFile(
  root: string,
  gezelId: string,
  sessionId: string,
  external?: ExternalFolders,
): string {
  return join(gezelSessionsDir(root, gezelId, external), `${sessionId}.json`);
}

/**
 * Per-gezel memories directory (daily markdown + summary + vectra index).
 * Moves with the gezel when externalized.
 */
export function gezelMemoriesDir(
  root: string,
  gezelId: string,
  external?: ExternalFolders,
): string {
  if (gezelStorageScope(root, gezelId, external) === 'machine-shared') {
    return join(gezelLocalDir(root, gezelId), 'memories');
  }
  return join(gezelDir(root, gezelId, external), 'memories');
}

/**
 * Per-gezel growth.json — level / XP / pending level-up state. Travels
 * with the gezel when externalized, like the memories dir.
 */
export function gezelGrowthPath(root: string, gezelId: string, external?: ExternalFolders): string {
  if (gezelStorageScope(root, gezelId, external) === 'machine-shared') {
    return join(gezelLocalDir(root, gezelId), 'growth.json');
  }
  return join(gezelDir(root, gezelId, external), 'growth.json');
}

/** JSON file of installed toolsets for a gezel. Always local. */
export function gezelToolsetsFile(root: string, gezelId: string): string {
  return join(gezelLocalDir(root, gezelId), 'toolsets.json');
}

/**
 * Optional per-gezel `tools.md` — power-user override that fully
 * replaces the auto-injected `## Tools available this turn` block in
 * the system prompt. When present, the gezel's owner takes
 * responsibility for keeping the listing accurate as the install's
 * registered tools evolve. When absent (the default), the runtime
 * computes the listing from the live MCP bridge's
 * `getOpenAITools()` post-allowlist set.
 *
 * Lives in the externalizable per-gezel directory alongside `gezel.md`
 * and `icon.svg` (NOT in the always-local `gezelLocalDir`) — it
 * describes how the gezel uses tools, which is character-shaped, so
 * it should travel with the gezel when externalized.
 */
export function gezelToolsPath(root: string, gezelId: string, external?: ExternalFolders): string {
  return join(gezelDir(root, gezelId, external), 'tools.md');
}

/** Root for on-disk toolset installs, e.g. npm-package extracts. Always local. */
export function gezelToolsetsInstallDir(root: string, gezelId: string): string {
  return join(gezelLocalDir(root, gezelId), 'toolsets');
}

/**
 * Per-gezel `poppetje.json` — the resolved Poppetje struct (body shape,
 * skin, hair, hat, etc.) that drives the parametric SVG renderer in the
 * UI. Persisted explicitly so adding new catalog entries or tuning slot
 * odds later never drifts existing characters. Travels with the gezel
 * when externalized.
 */
export function gezelPoppetjePath(
  root: string,
  gezelId: string,
  external?: ExternalFolders,
): string {
  return join(gezelDir(root, gezelId, external), 'poppetje.json');
}

// ---------- project scope ----------

/**
 * Per-project directory holding the project's content. Routes to the
 * external location when `external.projects` is set.
 *
 * The canonical `project.json` plus an internal `workspace/` / legacy `gh/`
 * checkout follow this directory. Account-private runtime state does not: it
 * stays under {@link projectPrivateDir}, even when this project is
 * machine-shared.
 */
export function projectDir(root: string, projectId: string, external?: ExternalFolders): string {
  assertSafeEntityId(projectId, 'project id');
  if (projectStorageScope(root, projectId) === 'machine-shared') {
    return machineSharedProjectDir(projectId)!;
  }
  return join(gezelPaths(root, external).projects, projectId);
}

/**
 * Canonical on-machine project directory. For a machine-shared project this
 * follows the project into the installer-managed shared root; otherwise it is
 * the user's project directory.
 *
 * This helper is for the project definition and intentionally shared project
 * content such as its internal workspace. Per-account runtime state must use
 * {@link projectPrivateDir} instead.
 */
export function projectStorageDir(root: string, projectId: string): string {
  if (projectStorageScope(root, projectId) === 'machine-shared') {
    return machineSharedProjectDir(projectId)!;
  }
  return userProjectDir(root, projectId);
}

/**
 * @deprecated The old name blurred canonical project storage with private
 * daemon state. Use {@link projectStorageDir} for shared project content or
 * {@link projectPrivateDir} for per-account state.
 */
export function projectLocalDir(root: string, projectId: string): string {
  return projectStorageDir(root, projectId);
}

/** Per-project `project.json` metadata file. Always local. */
export function projectMetaFile(root: string, projectId: string): string {
  return join(projectStorageDir(root, projectId), 'project.json');
}

/** Durable user/worker lifecycle for indexed code findings. Account-private. */
export function projectFindingLifecycleFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'finding-lifecycle.json');
}

/** Durable Boekwachter issue identity + lifecycle. Account-private. */
export function projectBoekwachterIssuesFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'boekwachter-issues.json');
}

/** Durable per-project code-review records for this account. */
export function projectCodeReviewsFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'code-reviews.json');
}

/** Durable per-project diffpack records for this account. */
export function projectDiffpacksFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'diffpacks.json');
}

/** Durable per-account report-action lifecycle records. */
export function projectReportActionsFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'report-actions.json');
}

/** Per-project documents folder — holds about.md, missionObjectives.md, etc. */
export function projectDocsDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectDir(root, projectId, external), 'documents');
}

/** Per-project artifacts folder — agent-generated outputs. */
export function projectArtifactsDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectDir(root, projectId, external), 'artifacts');
}

/**
 * Reserved artifacts subtree holding gezel-generated shadow files: markdown
 * representations of workspace content (converted office documents, image
 * descriptions, audio transcripts). Lives under artifacts — never the
 * workspace, which may be read-only — and is a regenerable cache: write-denied
 * to gezels/users, safe to delete, rebuilt by indexing.
 */
export const PROJECT_SHADOW_DIR_NAME = 'shadow';

/** Per-project `artifacts/shadow/` root. */
export function projectShadowDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectArtifactsDir(root, projectId, external), PROJECT_SHADOW_DIR_NAME);
}

/**
 * Reserved artifacts subtree holding tables derived from tabular files that
 * live in the project *workspace* — a CSV too large to read, a spreadsheet a
 * gezel cannot open at all. Sibling to `shadow/`, and derived the same way:
 * regenerable from the source file, write-denied to gezels and users, safe to
 * delete.
 *
 * Distinct from a connector corpus under `data/`, because the two have
 * different lifecycles. A connector corpus is an append-only stream that grows
 * forever and needs sealing, compaction and retention; a workspace table is a
 * *snapshot of one file*, rebuilt wholesale when the file's content hash moves
 * and swept when the file goes.
 *
 * Companion directories keep the source's full basename (`sales.xlsx_tables`),
 * so `X_tables` → source `X` is a lossless reverse map for orphan collection
 * and `a.csv` cannot collide with `a.xlsx` — the same reasoning as the shadow
 * tree's `_files` convention.
 */
export const PROJECT_TABULAR_DIR_NAME = 'tabular';

/** Suffix marking one source file's companion directory under `tabular/`. */
export const TABULAR_COMPANION_SUFFIX = '_tables';

/** Per-project `artifacts/tabular/` root. */
export function projectTabularDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectArtifactsDir(root, projectId, external), PROJECT_TABULAR_DIR_NAME);
}

/**
 * Directory level inside a connector corpus that holds observation tables:
 * `artifacts/data/<corpus>/tables/<table>/`. Deliberately NOT underscore-
 * prefixed. Inside a corpus the underscore prefix marks the *mutable* surface
 * (`_meta.json`, `_actions/`), and `isProtectedConnectorCorpusPath` denies
 * gezel writes to everything else under `data/`. Keeping `tables` bare
 * therefore inherits the existing read-only guard rather than needing a
 * second one.
 */
export const CONNECTOR_TABLES_DIR_NAME = 'tables';

/**
 * Where a table's materialized rollups live, under its own directory. Kept
 * separate from the raw partitions because retention deletes raw data and
 * never deletes rollups.
 */
export const CONNECTOR_ROLLUPS_DIR_NAME = 'rollups';

/** Filename of a table's semantic layer, beside its data. */
export const OBSERVATION_TABLE_MANIFEST_FILE = 'manifest.json';

/** Filename of a table's writer/compaction/rollup bookkeeping. */
export const OBSERVATION_TABLE_STATE_FILE = 'state.json';

/**
 * Reserved artifacts subtree holding diffpacks: proposed change sets a gezel
 * drafted but never applied. Each pack owns `after/` (the copy-on-write draft
 * tree), `files/` (the sealed single-file unified diffs), `notes.md` and
 * `manifest.json`. Lives under artifacts — never the workspace, which is the
 * whole point: the gezel proposes, the user applies.
 */
export const PROJECT_DIFFPACKS_DIR_NAME = 'diffpacks';

/** Per-project `artifacts/diffpacks/` root. */
export function projectDiffpacksDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectArtifactsDir(root, projectId, external), PROJECT_DIFFPACKS_DIR_NAME);
}

/** One pack's folder: `artifacts/diffpacks/<packId>/`. */
export function projectDiffpackDir(
  root: string,
  projectId: string,
  packId: string,
  external?: ExternalFolders,
): string {
  return join(projectDiffpacksDir(root, projectId, external), packId);
}

/**
 * Reserved artifacts subtree holding the user's chat prompt drafts. Each draft
 * owns `message.md` (the prompt markdown), `message_files/` (its uploads,
 * referenced document-relatively while editing) and `draft.json` (thread
 * association, status, sent stamps). Lives under artifacts so a draft is an
 * ordinary inspectable file the user can open, back up, and grep.
 */
export const PROJECT_PROMPTS_DIR_NAME = 'prompts';

/** Per-project `artifacts/prompts/` root. */
export function projectPromptsDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectArtifactsDir(root, projectId, external), PROJECT_PROMPTS_DIR_NAME);
}

/** One draft's folder: `artifacts/prompts/<draftId>/`. */
export function projectPromptDraftDir(
  root: string,
  projectId: string,
  draftId: string,
  external?: ExternalFolders,
): string {
  return join(projectPromptsDir(root, projectId, external), draftId);
}

/** Per-project memories folder (daily markdown + summary + vectra index). */
export function projectMemoriesDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectDir(root, projectId, external), 'memories');
}

/**
 * Per-account derived vector index for project memories. The canonical memory
 * markdown follows the project via {@link projectMemoriesDir}; mutable SQLite
 * never does.
 */
export function projectMemoryIndexDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'memories', 'index');
}

/**
 * Default location for the cloned GitHub repo when neither (a) the project
 * has a workingDir nor (b) the existing workingDir already holds the repo.
 * Internal-only checkout: lives under the project folder. Always local.
 *
 * Pre-Phase-2: this was where every github-linked project's clone landed.
 * Post-Phase-2: new projects clone into the workspace directly; this path
 * is kept around to (a) adopt legacy clones in `GitManager.resolveCheckout`
 * and (b) feed the one-shot `Store.migrateLegacyGhCheckouts` migration that
 * moves legacy `gh/` clones into `workspace/`. New code should not assume
 * a clone lives here.
 */
export function projectInternalGithubDir(root: string, projectId: string): string {
  return join(projectStorageDir(root, projectId), 'gh');
}

/**
 * Root for shared bare clones (Phase 3). Multiple projects pointing at
 * the same github URL share a single bare clone here; each project's
 * workspace is created via `git worktree add` off the bare clone. Saves
 * disk space (no duplicate `.git/objects` per project) and unlocks the
 * "PR review + main branch in parallel" workflow without re-fetching.
 *
 * Lives at `<root>/git-clones/`. Always local — the bare clones are
 * host-specific (worktree paths, packed refs, hooks) and shouldn't
 * cloud-sync.
 */
export function sharedClonesRoot(root: string): string {
  return join(root, 'git-clones');
}

/**
 * Path to the bare clone for a specific github URL. The `key` is the
 * caller-derived stable identifier (typically `<owner>-<repo>-<hash>`)
 * so two URL strings that normalize to the same repo share one clone.
 */
export function sharedCloneDir(root: string, key: string): string {
  return join(sharedClonesRoot(root), key);
}

/**
 * Per-project background-index folder. Holds `commands.json`,
 * `files.json`, `tokens.json`, `index.meta.json` — produced by the
 * workspace indexer. Always local: the index is host-machine-specific
 * (paths, mtimes, installed CLIs) and shouldn't sync across machines.
 */
export function projectIndexDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), '_index');
}

/**
 * Per-project terminal-threads folder. Holds `{threadId}.json` files,
 * one per (project, workingDir) pair. Always local: terminal output
 * is host-machine-specific and not interesting to sync across
 * machines.
 */
export function projectTerminalsDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'terminals');
}

export function projectTerminalFile(root: string, projectId: string, threadId: string): string {
  return join(projectTerminalsDir(root, projectId), `${threadId}.json`);
}

/** JSONL file holding events that aren't scoped to any project. */
export function globalHistoryFile(root: string): string {
  return join(root, 'history.jsonl');
}

/**
 * Gezel-to-gezel messages that were accepted but not yet dispatched — a
 * handoff parks while the sender is mid-turn, and that park is a closure in
 * one process's memory. Written when the park happens, dropped when the
 * dispatch fires, replayed at boot.
 */
export function pendingHandoffsFile(root: string): string {
  return join(root, 'pending-handoffs.json');
}

/**
 * Home-scoped index directory for cross-project derived caches (session
 * transcripts, history mirror, documents library). Always local: it's a
 * rebuildable sqlite cache, never user data, so it stays out of
 * `ExternalFolders` on purpose.
 */
export function globalIndexDir(root: string): string {
  return join(root, 'index');
}

export function globalIndexDbFile(root: string): string {
  return join(globalIndexDir(root), 'global.db');
}

/** Per-project JSONL holding events scoped to that project. Always local. */
export function projectHistoryFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'history.jsonl');
}

// ── knowledge catalogs (docs/knowledge-catalogs.md) ─────────────────────────

/** Root of the user-private knowledge tier. Owned by the knowledge manager. */
export function knowledgeDir(root: string): string {
  return join(root, 'knowledge');
}

/** The authoritative per-user registry of installed/enabled catalogs. */
export function knowledgeRegistryFile(root: string): string {
  return join(knowledgeDir(root), 'registry.json');
}

/** User-private extracted catalog versions live under this tree. */
export function knowledgeCatalogsDir(root: string): string {
  return join(knowledgeDir(root), 'catalogs');
}

/**
 * One immutable extracted catalog version:
 * `knowledge/catalogs/<publisherId>/<catalogId>/<version>/<digest16>/`.
 * The digest segment makes re-publishing the same version string with
 * different bytes land in a different directory instead of silently
 * shadowing the installed one.
 */
export function knowledgeCatalogVersionDir(
  root: string,
  publisherId: string,
  catalogId: string,
  version: string,
  contentDigest: string,
): string {
  const publisher = KnowledgeIdSchema.parse(publisherId);
  const catalog = KnowledgeIdSchema.parse(catalogId);
  const catalogVersion = KnowledgeVersionSchema.parse(version);
  if (!/^[0-9a-f]{64}$/i.test(contentDigest)) {
    throw new Error('knowledge catalog content digest must be a sha256');
  }
  return join(
    knowledgeCatalogsDir(root),
    publisher,
    catalog,
    catalogVersion,
    contentDigest.slice(0, 16),
  );
}

/** Resumable download staging for catalog archives. */
export function knowledgeDownloadsDir(root: string): string {
  return join(knowledgeDir(root), 'downloads');
}

/**
 * Single per-project file holding the array of structured Q&A
 * (`Question` records) created by the `ask_user_question` MCP tool.
 * One file rather than per-id because volume is low and the panels
 * always want the full list. Always local.
 */
export function projectQuestionsFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'questions.json');
}

/**
 * Per-project last-activity stamp maintained by the ActivityTracker.
 * Separate from `project.json` so ambient stamping never contends with
 * (or bumps `updatedAt` on) the metadata file. Always local.
 */
export function projectActivityFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'activity.json');
}

/**
 * Home for the meester's status report — the dynamic Home greeting
 * headline + dashboard markdown (`status.json`) and the generator's
 * run budget / idempotency state (`state.json`). Store-managed.
 */
export function meesterStatusDir(root: string): string {
  return join(root, 'meester-status');
}

export function meesterStatusFile(root: string): string {
  return join(meesterStatusDir(root), 'status.json');
}

export function meesterStatusStateFile(root: string): string {
  return join(meesterStatusDir(root), 'state.json');
}

/**
 * Home for the ambient dashboard — meester-generated PNG snapshots of the
 * whole workshop, written for the OS ambient-display integration (wallpaper
 * rotation points here). Holds dated `dashboard-*.png` files, a stable
 * `latest.png` copy, the generator's `state.json`, and the Electron
 * applier's `display-state.json` + `applied-a/b.png` slots. Per-user only —
 * never under machineSharedHome: wallpaper is user-session state.
 */
export function ambientDir(root: string): string {
  return join(root, 'ambient');
}

export function ambientDashboardStateFile(root: string): string {
  return join(ambientDir(root), 'state.json');
}

export function ambientDashboardLatestFile(root: string): string {
  return join(ambientDir(root), 'latest.png');
}

export function ambientDisplayStateFile(root: string): string {
  return join(ambientDir(root), 'display-state.json');
}

export function projectTasksDir(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectDir(root, projectId, external), 'tasks');
}

export function projectTaskNextIdFile(
  root: string,
  projectId: string,
  external?: ExternalFolders,
): string {
  return join(projectTasksDir(root, projectId, external), '.next-id');
}

export function projectTaskDir(
  root: string,
  projectId: string,
  num: number,
  external?: ExternalFolders,
): string {
  return join(projectTasksDir(root, projectId, external), String(num));
}

export function projectTaskFile(
  root: string,
  projectId: string,
  num: number,
  external?: ExternalFolders,
): string {
  return join(projectTaskDir(root, projectId, num, external), 'task.json');
}

export function projectTaskNotesFile(
  root: string,
  projectId: string,
  num: number,
  external?: ExternalFolders,
): string {
  return join(projectTaskDir(root, projectId, num, external), 'notes.jsonl');
}

/**
 * Free-form prose `about.md` at the root of a task folder. Stores the
 * task's `description` body — the long "what we're solving and what
 * success looks like" prose that's injected into task-scoped chat
 * sessions. Kept out of `task.json` so the JSON stays compact and
 * the prose can be edited as a real markdown file.
 */
export function projectTaskAboutFile(
  root: string,
  projectId: string,
  num: number,
  external?: ExternalFolders,
): string {
  return join(projectTaskDir(root, projectId, num, external), 'about.md');
}

/**
 * Account-private project-scoped scripts directory. Holds `.ts` files with a mandatory
 * `export const meta` block; see `schemas/script.ts`. Not recursive —
 * one script per file, resolved by `meta.name`. Always local.
 */
export function projectScriptsDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'scripts');
}

export function projectScriptFile(root: string, projectId: string, name: string): string {
  return join(projectScriptsDir(root, projectId), `${name}.ts`);
}

/**
 * The user's machine-wide script library (`scope: 'user'` refs) —
 * scripts shared across every project on this device. Same file
 * conventions as project scripts. Always local.
 */
export function userScriptsDir(root: string): string {
  return join(root, 'scripts');
}

export function userScriptFile(root: string, name: string): string {
  return join(userScriptsDir(root), `${name}.ts`);
}

/**
 * Per-project directory holding persisted `ScriptRun` records, sharded
 * by UTC date so a long-lived project doesn't accumulate a single
 * giant directory. Always local.
 */
export function projectScriptRunsDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'scripts', 'runs');
}

export function projectScriptRunFile(
  root: string,
  projectId: string,
  isoDate: string,
  runId: string,
): string {
  return join(projectScriptRunsDir(root, projectId), isoDate, `${runId}.json`);
}

// ---------- craftbook templates (local catalog source) ----------

/**
 * Local catalog source for user-authored craftbook templates. Mirrors
 * the bundled catalog layout under
 * `~/.gezel/craftbook-templates/{prefix}/{id}/versions/{version}/`. The
 * `CatalogService` picks this up alongside the bundled source so user
 * craftbooks browse next to shipped ones.
 */
export function craftbookTemplatesRoot(root: string): string {
  return join(root, 'craftbook-templates');
}

export function craftbookTemplateDir(root: string, prefix: string, id: string): string {
  return join(craftbookTemplatesRoot(root), prefix, id);
}

export function craftbookTemplateManifestFile(root: string, prefix: string, id: string): string {
  return join(craftbookTemplateDir(root, prefix, id), 'manifest.json');
}

export function craftbookTemplateVersionDir(
  root: string,
  prefix: string,
  id: string,
  version: string,
): string {
  return join(craftbookTemplateDir(root, prefix, id), 'versions', version);
}

export function craftbookTemplateVersionManifestFile(
  root: string,
  prefix: string,
  id: string,
  version: string,
): string {
  return join(craftbookTemplateVersionDir(root, prefix, id, version), 'manifest.json');
}

/** Directory holding a craftbook version's bundled `*.ts` scripts. */
export function craftbookTemplateScriptsDir(
  root: string,
  prefix: string,
  id: string,
  version: string,
): string {
  return join(craftbookTemplateVersionDir(root, prefix, id, version), 'scripts');
}

/** A single bundled script file inside a craftbook version. */
export function craftbookTemplateScriptFile(
  root: string,
  prefix: string,
  id: string,
  version: string,
  name: string,
): string {
  return join(craftbookTemplateScriptsDir(root, prefix, id, version), `${name}.ts`);
}

/** First two lowercased chars of a craftbook id — the catalog's shard prefix. */
export function craftbookShardPrefix(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

// ---------- installed AI Apps (.gezapp) ----------

/** Installed AI App packages, kept as versioned catalog slices. */
export function aiAppsRoot(root: string): string {
  return join(root, 'ai-apps');
}

/** Active-version registry for installed AI Apps. */
export function aiAppsRegistryFile(root: string): string {
  return join(aiAppsRoot(root), 'registry.json');
}

export function aiAppVersionDir(root: string, appId: string, version: string): string {
  return join(aiAppsRoot(root), appId, version);
}

export function aiAppItemsDir(root: string, appId: string, version: string): string {
  return join(aiAppVersionDir(root, appId, version), 'items');
}

export function aiAppReceiptFile(root: string, appId: string, version: string): string {
  return join(aiAppVersionDir(root, appId, version), 'receipt.json');
}

// ---------- project types (local catalog source) ----------

/**
 * Local catalog source for user-installed / imported project types. Mirrors
 * the bundled catalog layout under
 * `~/.gezel/project-types/{prefix}/{id}/versions/{version}/`. Manually
 * authored local items browse next to bundled and mounted `.gezapp` items.
 */
export function projectTypesRoot(root: string): string {
  return join(root, 'project-types');
}

export function projectTypeDir(root: string, prefix: string, id: string): string {
  return join(projectTypesRoot(root), prefix, id);
}

export function projectTypeManifestFile(root: string, prefix: string, id: string): string {
  return join(projectTypeDir(root, prefix, id), 'manifest.json');
}

export function projectTypeVersionDir(
  root: string,
  prefix: string,
  id: string,
  version: string,
): string {
  return join(projectTypeDir(root, prefix, id), 'versions', version);
}

export function projectTypeVersionManifestFile(
  root: string,
  prefix: string,
  id: string,
  version: string,
): string {
  return join(projectTypeVersionDir(root, prefix, id, version), 'manifest.json');
}

/** First two lowercased chars of a project-type id — the catalog's shard prefix. */
export function projectTypeShardPrefix(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

// ---------- project-local store (workspace `.gezel/`) ----------

/**
 * Per-project authored definitions that travel WITH the repo. They live
 * in a `.gezel/` folder inside the project's resolved WORKSPACE directory
 * (workingDir > github checkout > internal workspace), NOT under
 * `~/.gezel`. Holds the `@project` gezel + any other project-local
 * gezels, project-local craftbooks, and import provenance.
 *
 * IMPORTANT: these helpers take a `workspaceDir` (resolved via
 * `Store.projectWorkspaceDir`), not the gezel `root`. Runtime/derived
 * state for a project-local gezel (poppetje, sessions, memories)
 * deliberately stays in app-data under `~/.gezel/gezels/<encoded-id>/`
 * keyed by the encoded id — the workspace `.gezel/` carries only the
 * authored definition, so chat history never lands in the user's repo.
 */
export function projectLocalRoot(workspaceDir: string): string {
  return join(workspaceDir, '.gezel');
}

/**
 * Workspace content-index store (code/doc intelligence — the boekwachter
 * index). Lives under the project-local `.gezel/index/` so it travels with the
 * repo *folder*, but gezel writes a `.gitignore` inside it so the binary sqlite
 * DB + regenerable artifacts are never committed. Distinct from the host-local
 * `_index/` (commands/files/tokens) under `~/.gezel`: that one is machine-
 * specific (mtimes, installed CLIs); this one is content-derived.
 */
export function projectLocalIndexDir(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'index');
}

export function projectLocalIndexDbFile(workspaceDir: string): string {
  return join(projectLocalIndexDir(workspaceDir), 'index.db');
}

/**
 * Legacy converted-document location under the workspace's own
 * `.gezel/files/<mirror>/<name>_files/`. Workspace conversions now live in
 * the project's `artifacts/shadow/` tree ({@link projectShadowDir}) so a
 * read-only workspace never loses them; this helper remains only so the
 * indexer can clean the old tree up.
 */
export function projectLocalFilesDir(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'files');
}

/**
 * Quarantine for untrusted content the safety scanner refused to index
 * (prompt-injection payloads, attachments that failed parser-safety checks).
 * Lives under `.gezel/quarantine/` — inside the project-local root the content
 * indexer skips, so quarantined material is structurally unreachable by search
 * + embeddings. Operators can inspect the raw artifacts here manually.
 */
export function projectLocalQuarantineDir(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'quarantine');
}

/**
 * Home-local fallback for the content index when the workspace `.gezel/` isn't
 * writable (external read-only repos). Mirrors the `_index` placement but for
 * the content-derived DB.
 */
export function fallbackProjectIndexDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'index');
}

/**
 * Mutable content-index database for a project. Ordinary writable workspaces
 * retain the historical `.gezel/index/` placement; machine-shared workspaces
 * always use the account-private fallback to prevent cross-daemon SQLite use.
 */
export function projectContentIndexDbFile(
  root: string,
  projectId: string,
  workspaceDir: string,
  opts: {
    /**
     * Keep the database out of the workspace even though it is writable.
     * The shared document library's workspace is the user's own documents
     * folder, which may be a cloud-synced directory (OneDrive/Dropbox):
     * mutable SQLite must not ride a sync client, and the user must not find
     * a `.gezel/` directory in a folder they browse in Finder.
     */
    forceHomeSide?: boolean;
  } = {},
): string {
  return opts.forceHomeSide || projectStorageScope(root, projectId) === 'machine-shared'
    ? join(fallbackProjectIndexDir(root, projectId), 'index.db')
    : projectLocalIndexDbFile(workspaceDir);
}

/**
 * Derived FTS index over a project's artifact corpora (connector records under
 * `artifacts/data/**`). Always in the account-private sidecar, never inside
 * the artifacts tree itself — the database must not surface in the corpus
 * browser, and mutable SQLite must not ride an externalized artifacts folder.
 * Rebuildable cache, safe to delete.
 */
export function projectArtifactsIndexDbFile(root: string, projectId: string): string {
  return join(fallbackProjectIndexDir(root, projectId), 'artifacts.db');
}

/**
 * The committable code-map "city file": placement anchors, user overrides, and
 * the layout journal. Deliberately OUTSIDE the self-gitignored `.gezel/index/`
 * subtree — committing it keeps the city stable across machines and index
 * rebuilds.
 */
export function projectLocalVillageFile(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'village.json');
}

/** Home-local village-file fallback (no external workingDir, or read-only repo). */
export function fallbackProjectVillageFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'village.json');
}

/** `@project` about-source mapping (which instruction file feeds the prompt). */
export function projectLocalConfigFile(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'project.json');
}

/** Import provenance — hashes, ids, userEdited flags. */
export function projectLocalImportsFile(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'imports.json');
}

/** Review-before-save proposals for generated JS scripts. */
export function projectLocalPendingImportsFile(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'pending-imports.json');
}

export function projectLocalGezelsRoot(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'gezels');
}

export function projectLocalGezelDir(workspaceDir: string, localId: string): string {
  assertSafeEntityId(localId, 'project-local gezel id');
  return join(projectLocalGezelsRoot(workspaceDir), localId);
}

export function projectLocalCraftbooksRoot(workspaceDir: string): string {
  return join(projectLocalRoot(workspaceDir), 'craftbooks');
}

export function projectLocalCraftbookDir(workspaceDir: string, id: string): string {
  return join(projectLocalCraftbooksRoot(workspaceDir), id);
}

// ---------- shared / system scope ----------

/** JSON file of the shared toolsets — toolsets every gezel inherits. */
export function sharedToolsetsFile(root: string): string {
  return join(root, 'toolsets.json');
}

/** Install root for the shared toolsets' on-disk extracts. */
export function sharedToolsetsInstallDir(root: string): string {
  return join(root, 'toolsets');
}

// ---------- project scope ----------

/**
 * JSON file of this account's project toolsets — installed by a custom project
 * type and seen by this account's sessions scoped to that project. Kept in the
 * private project sidecar so executable selection never crosses accounts.
 * See docs/project-types.md.
 */
export function projectToolsetsFile(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'toolsets.json');
}

/** Install root for a project's toolsets' on-disk extracts. */
export function projectToolsetsInstallDir(root: string, projectId: string): string {
  return join(projectPrivateDir(root, projectId), 'toolsets');
}

/**
 * JSON tracking file for system-scope toolsets — records exactly what's on
 * disk (id, version, integrity, installedAt) plus top-level `pnpmVersion`
 * + `chromiumRevision`. Compared to the shipped `SYSTEM_TOOLSETS` manifest
 * on boot; mismatch triggers a re-install for the affected entries.
 */
export function systemToolsetsFile(root: string): string {
  return join(root, 'system-toolsets.json');
}

/**
 * Store-level `InstalledToolset[]` list for system-scope toolsets. Kept
 * **separate** from {@link systemToolsetsFile}: that file carries the
 * bootstrap's `SystemTrackingRecord` (object schema with `toolsets` map
 * + `chromiumRevision`), while this one carries the Store's runtime list
 * (array schema with `installPath` + full `runtime` snapshot). Previously,
 * they shared the same path and silently overwrote each other
 * — a bootstrap followed by a Store write would leave `systemToolsetsFile`
 * unreadable as a `SystemTrackingRecord`, and the next boot would report
 * "not installed" for everything.
 */
export function systemInstalledToolsetsFile(root: string): string {
  return join(root, 'installed-toolsets-system.json');
}

/** Install root for system-scope toolset extracts (Playwright, etc.). */
export function systemToolsetsInstallDir(root: string): string {
  return join(root, 'system-toolsets');
}

/**
 * Opt-in live gilde content cache — newer `@bendyline/gilde` patch releases
 * fetched at runtime by the GildeUpdateManager. Holds `versions/<v>/` (the
 * extracted npm package) plus `state.json`. Rebuildable: the bundled pin is
 * the permanent fallback, so deleting this tree only reverts content.
 */
export function gildeLiveRoot(root: string): string {
  return join(root, 'gilde');
}

/** Version-named extracted `@bendyline/gilde` packages, `<version>/package/`. */
export function gildeLiveVersionsDir(root: string): string {
  return join(gildeLiveRoot(root), 'versions');
}

/** One extracted live gilde version (contains the npm `package/` dir). */
export function gildeLiveVersionDir(root: string, version: string): string {
  return join(gildeLiveVersionsDir(root), version);
}

/** Active-version + last-check tracking state for live gilde updates. */
export function gildeLiveStateFile(root: string): string {
  return join(gildeLiveRoot(root), 'state.json');
}

/**
 * Directory where Playwright's own CLI drops browser binaries. Exported
 * to both the service (sets `PLAYWRIGHT_BROWSERS_PATH` when spawning
 * Playwright) and the bootstrap (verifies Chromium installed).
 */
export function playwrightBrowsersDir(root: string): string {
  return join(root, 'playwright-browsers');
}

/** Directory holding one subfolder per toolset for its global config. */
export function toolsetConfigsDir(root: string): string {
  return join(root, 'toolset-configs');
}

/** Per-toolset global config file (non-secret values only). */
export function toolsetConfigFile(root: string, toolsetId: string): string {
  return join(toolsetConfigsDir(root), toolsetId, 'config.json');
}

/** AES-GCM encrypted blob file for the fallback FileSecretStore. */
export function secretsFile(root: string): string {
  return join(root, 'secrets.enc');
}

/** Key material file for the fallback FileSecretStore (POSIX 0600). */
export function secretsKeyFile(root: string): string {
  return join(root, 'secrets.key');
}

/**
 * Persisted per-app bearer tokens issued to third-party local apps via the
 * `/v1/apps/register` consent flow. The ephemeral root token (rotated every
 * launch) is **not** persisted here and never leaves process memory.
 * `runtime/auth-token` contains a separate, scoped first-party client
 * credential. POSIX 0600 on this file keeps third-party app bearer secrets
 * private. Always local.
 */
export function tokensFile(root: string): string {
  return join(root, 'tokens.json');
}

/**
 * Persisted `/v1/apps/register` consent requests — both pending grants
 * (waiting for the user to approve/deny in the Connected Apps UI) and
 * decided grants (kept so a polling app can still observe the verdict
 * after a daemon restart). The file is small; no rotation.
 *
 * Headless-Electron fallback: when the daemon runs without a UI attached,
 * pending grants accumulate here. The next time the Electron app starts,
 * it reads this file and surfaces them as notifications. Always local.
 */
export function pendingGrantsFile(root: string): string {
  return join(root, 'pending-grants.json');
}

/**
 * Public half of this device's stable identity keypair (Ed25519) plus its
 * `deviceId` and fingerprint. Used by the remote-model-execution pairing
 * flow: a paired client pins this device's identity fingerprint (TOFU), and
 * the private half (held in the SecretStore) signs the rotating TLS cert so
 * trust survives reboots even though the loopback/LAN cert rotates. Public
 * material; POSIX 0600 anyway so the deviceId isn't world-readable. Always
 * local.
 */
export function deviceIdentityFile(root: string): string {
  return join(root, 'device-identity.json');
}

/**
 * Servers this device has paired with for remote model execution (Device A's
 * view): per-remote `{baseUrl, token, pinnedIdentityKey, ...}`. Holds bearer
 * secrets, so POSIX 0600, same posture as `tokens.json`. Always local.
 */
export function remotesFile(root: string): string {
  return join(root, 'remotes.json');
}

/** Root for all communication-channel per-channel state (future channels). */
export function channelsDir(root: string): string {
  return join(root, 'channels');
}

/**
 * Backups produced by the folder-externalization move worker. Each
 * successful move snapshots the source tree under
 * `~/.gezel/backup/<ISO-timestamp>/<scope>/` before swapping the config.
 * Always local.
 */
export function backupsDir(root: string): string {
  return join(root, 'backup');
}

/**
 * Sentinel + queue directory for the folder-externalization worker.
 * Holds `active-move.json` while a move is in flight so the next boot
 * can detect a crashed mid-move. Always local.
 */
export function foldersStateDir(root: string): string {
  return join(root, 'folders');
}

/**
 * Keurmeester supervision state: append-only case records plus generated
 * digest reports. A deliberate Store carve-out owned by KeurmeesterManager
 * (packages/service/src/keurmeester/) — same posture as `history.jsonl`.
 * Always local.
 */
export function keurmeesterDir(root: string): string {
  return join(root, 'keurmeester');
}

/** Monthly-sharded JSONL case records: `cases/YYYY-MM.jsonl`. */
export function keurmeesterCasesDir(root: string): string {
  return join(keurmeesterDir(root), 'cases');
}

/** Generated digest reports: `digests/YYYY-MM-DD.md`. */
export function keurmeesterDigestsDir(root: string): string {
  return join(keurmeesterDir(root), 'digests');
}

/** Digest idempotency state (last generated date, last case offset). */
export function keurmeesterDigestStatePath(root: string): string {
  return join(keurmeesterDir(root), 'digest-state.json');
}

/**
 * Root of every downloaded engine payload: per-engine model stores, the
 * verified native binary releases, the HuggingFace cache, uv virtualenvs,
 * and per-engine scratch. This is the bulk of a heavy install's disk use —
 * on a working machine it dwarfs everything else in the home directory
 * combined. Owned by the engine/model managers, not the Store.
 */
export function enginesRoot(root: string): string {
  return join(root, 'engines');
}

/**
 * Pinned node + pnpm runtimes the supervisor extracts so packaged installs
 * need no system toolchain. The daemon executes through these, so nothing
 * daemon-side may delete them; the platform uninstaller owns removal and the
 * supervisor re-extracts on a sentinel mismatch.
 */
export function binRuntimeRoot(root: string): string {
  return join(root, 'bin');
}

/**
 * Read the on-disk `config.json` without instantiating a Store. Used at
 * boot to discover `externalFolders` before the Store is constructed
 * (the Store needs `external` to resolve every other path correctly,
 * but the config file itself always lives at `<root>/config.json`).
 *
 * Returns an empty object if the file is missing or unreadable; callers
 * fall back to defaults. Intentionally typed loosely (`unknown`-ish) —
 * no Zod parse here so schema additions don't tie the boot path to
 * regenerating types.
 */
export async function readConfigRaw(root: string): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises');
  try {
    const raw = await readFile(gezelPaths(root).config, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
