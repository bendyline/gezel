import { join, resolve } from 'node:path';
import {
  type StorageCategoryId,
  type StorageClass,
  isSharedLibraryProject,
} from '@bendyline/gezel';
import {
  type ExternalFolders,
  backupsDir,
  binRuntimeRoot,
  channelsDir,
  craftbookTemplatesRoot,
  deviceIdentityFile,
  enginesRoot,
  foldersStateDir,
  gezelDir,
  gezelMemoriesDir,
  gezelPaths,
  gezelToolsetsInstallDir,
  gildeLiveRoot,
  globalHistoryFile,
  globalIndexDir,
  keurmeesterDir,
  meesterStatusDir,
  pendingGrantsFile,
  playwrightBrowsersDir,
  projectDir,
  projectIndexDir,
  projectPrivateDir,
  projectShadowDir,
  projectStorageDir,
  projectToolsetsInstallDir,
  projectTypesRoot,
  remotesFile,
  secretsFile,
  secretsKeyFile,
  sharedClonesRoot,
  sharedToolsetsFile,
  sharedToolsetsInstallDir,
  systemInstalledToolsetsFile,
  systemToolsetsFile,
  systemToolsetsInstallDir,
  tokensFile,
  toolsetConfigsDir,
  userScriptsDir,
} from '@bendyline/gezel/paths';
import { isPathInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { SHARED_ASSETS_ENV, modelStorageRoots } from '../models/storage-roots.js';

/**
 * The authoritative classification of everything under `~/.gezel`.
 *
 * Nothing owned this question before: `paths.ts` knows where user content
 * lives, the model and engine managers hardcode their own roots, and no
 * single place could answer "what is safe to delete". Cleanup, backup, and
 * the storage accounting all read from this one table, so a new directory
 * gets classified once rather than three times inconsistently.
 *
 * The registry only *describes* paths. It never deletes, and it deliberately
 * marks rather than hides paths that resolve outside the home directory so
 * callers can explain why cleanup leaves them alone. Storage accounting does
 * not traverse or include those external paths.
 */

/** Engines with a per-engine model store under `engines/<engine>/models`. */
const MODEL_ENGINES = [
  'llama-cpp',
  'ds4',
  'mlx',
  'video',
  'sd-cpp',
  'whisper-cpp',
  'recognition',
  'kokoro',
] as const;

export interface StoragePathEntry {
  path: string;
  /**
   * True when the path resolves outside the home directory — an externalized
   * folder scope, a real project working directory, or the machine-shared
   * root. Never deletable and never included in storage totals.
   */
  external: boolean;
  /** Stable id for item-granular categories (a model id, gezel id, ...). */
  itemId?: string;
  /** Display name for that item. */
  itemLabel?: string;
  /**
   * Tracking files that must die in the same step as the payload. A toolset
   * tree removed while its install record survives leaves the daemon
   * claiming an installed toolset whose files are gone — the roster lies and
   * nothing re-installs it.
   */
  coDelete?: string[];
  /** Set when this specific entry cannot be deleted, explaining why. */
  blockedReason?: string;
  /**
   * Nested subtrees another category already accounts for. A project's
   * generated index lives inside the project directory; counting it under
   * both would overstate how much room a person's actual work takes.
   */
  excludePaths?: string[];
}

export interface StorageCategoryDef {
  id: StorageCategoryId;
  class: StorageClass;
  label: string;
  description: string;
  /** False for uninstaller-owned trees and anything held out of cleanup. */
  deletable: boolean;
  /** Whether a content backup archives this category. */
  inBackup: boolean;
  /** Whether the UI should list individual items rather than one total. */
  itemGranular?: boolean;
  resolve(ctx: RegistryContext): Promise<StoragePathEntry[]>;
}

export interface RegistryContext {
  home: string;
  store: Store;
  env: NodeJS.ProcessEnv;
}

/** Paths that exist under the home directory but belong to no category. */
export function ephemeralPaths(home: string): string[] {
  return [gezelPaths(home).runtime.dir, join(home, '.transactions'), gezelPaths(home).logs];
}

function localEntry(path: string): StoragePathEntry {
  return { path, external: false };
}

/**
 * Mark an entry external when it escaped the home directory. Cleanup keys off
 * this flag, so the check lives here rather than at each call site.
 */
function scopedEntry(path: string, home: string): StoragePathEntry {
  return { path, external: !isPathInside(path, home) };
}

/** Re-exported so callers classifying storage share one containment rule. */
export { isPathInside };

async function externalFolders(store: Store): Promise<ExternalFolders | undefined> {
  return store.externalFolders;
}

/**
 * The directories one project owns. Without externalization several of these
 * resolve to the same place, so the caller deduplicates by path — otherwise a
 * project's bytes would be counted once per helper that names it.
 */
function projectOwnedPaths(home: string, id: string, external?: ExternalFolders): string[] {
  return [projectDir(home, id, external), projectStorageDir(home, id), projectPrivateDir(home, id)];
}

/** Subtrees inside a project that `derived-caches` accounts for instead. */
function projectDerivedPaths(home: string, id: string, external?: ExternalFolders): string[] {
  return [
    projectIndexDir(home, id),
    projectShadowDir(home, id, external),
    projectToolsetsInstallDir(home, id),
  ];
}

export const STORAGE_CATEGORIES: StorageCategoryDef[] = [
  {
    id: 'models',
    class: 'redownloadable',
    label: 'Downloaded models',
    description: 'Chat, image, video, speech, and recognition model weights.',
    deletable: true,
    inBackup: false,
    itemGranular: true,
    async resolve({ home, env }) {
      const entries: StoragePathEntry[] = [];
      for (const engine of MODEL_ENGINES) {
        // Only the writable root. The shared-assets overlay belongs to the
        // machine install and is read-only to this process by design.
        const { writableRoot } = modelStorageRoots({ home, engine, env });
        for (const id of await safeReaddir(writableRoot)) {
          entries.push({
            path: join(writableRoot, id),
            external: false,
            itemId: `${engine}/${id}`,
            itemLabel: `${id} (${engine})`,
          });
        }
      }
      return entries;
    },
  },
  {
    id: 'native-engines',
    class: 'redownloadable',
    label: 'Engine binaries',
    description: 'Downloaded llama.cpp, ds4, and other native engine builds.',
    deletable: true,
    inBackup: false,
    async resolve({ home }) {
      return [localEntry(join(enginesRoot(home), 'native-bin'))];
    },
  },
  {
    id: 'engine-caches',
    class: 'redownloadable',
    label: 'Engine caches',
    description: 'Python environments, model conversion caches, and scratch state.',
    deletable: true,
    inBackup: false,
    async resolve({ home }) {
      const root = enginesRoot(home);
      return [
        join(root, 'hf-cache'),
        join(root, 'uv'),
        join(root, 'mlx', 'cache'),
        join(root, 'ds4', 'kv'),
      ].map(localEntry);
    },
  },
  {
    id: 'toolsets',
    class: 'redownloadable',
    label: 'Tools and browsers',
    description: 'Installed toolset packages and the automation browser.',
    deletable: true,
    inBackup: false,
    async resolve({ home, store }) {
      const entries: StoragePathEntry[] = [
        {
          path: systemToolsetsInstallDir(home),
          external: false,
          coDelete: [systemToolsetsFile(home), systemInstalledToolsetsFile(home)],
        },
        localEntry(playwrightBrowsersDir(home)),
        {
          path: sharedToolsetsInstallDir(home),
          external: false,
          coDelete: [sharedToolsetsFile(home)],
        },
      ];
      for (const gezel of await safeList(() => store.listGezels())) {
        entries.push(localEntry(gezelToolsetsInstallDir(home, gezel.id)));
      }
      for (const project of await safeList(() => store.listProjects())) {
        entries.push(localEntry(projectToolsetsInstallDir(home, project.id)));
      }
      return entries;
    },
  },
  {
    id: 'gilde-cache',
    class: 'redownloadable',
    label: 'Catalog content updates',
    description: 'Downloaded catalog releases. The built-in catalog is the fallback.',
    deletable: true,
    inBackup: false,
    async resolve({ home }) {
      return [localEntry(gildeLiveRoot(home))];
    },
  },
  {
    id: 'derived-caches',
    class: 'redownloadable',
    label: 'Search indexes and generated files',
    description: 'Rebuilt automatically from your content when needed.',
    deletable: true,
    inBackup: false,
    async resolve({ home, store }) {
      const external = await externalFolders(store);
      const entries: StoragePathEntry[] = [
        localEntry(globalIndexDir(home)),
        localEntry(join(home, 'handboek', 'narration')),
        localEntry(join(home, 'sandbox')),
      ];
      for (const gezel of await safeList(() => store.listGezels())) {
        entries.push(localEntry(join(gezelMemoriesDir(home, gezel.id, external), 'index')));
      }
      for (const project of await safeList(() => store.listProjects())) {
        entries.push(localEntry(projectIndexDir(home, project.id)));
        entries.push(scopedEntry(projectShadowDir(home, project.id, external), home));
      }
      return entries;
    },
  },
  {
    id: 'service-bundle',
    class: 'uninstaller-owned',
    label: 'Gezel program files',
    description: 'Removed by the uninstaller; re-created automatically on launch.',
    deletable: false,
    inBackup: false,
    async resolve({ home }) {
      return [localEntry(gezelPaths(home).install)];
    },
  },
  {
    id: 'runtimes',
    class: 'uninstaller-owned',
    label: 'Bundled runtimes',
    description: 'Removed by the uninstaller; re-created automatically on launch.',
    deletable: false,
    inBackup: false,
    async resolve({ home }) {
      return [localEntry(binRuntimeRoot(home))];
    },
  },
  {
    id: 'git-clones',
    class: 'redownloadable',
    label: 'Code checkouts',
    description: 'Shared clones that project working copies still point at.',
    // Working copies elsewhere on disk reference these clones, so removing
    // one breaks a checkout that lives outside the home directory entirely.
    deletable: false,
    inBackup: false,
    async resolve({ home }) {
      return [localEntry(sharedClonesRoot(home))];
    },
  },
  {
    id: 'gezels',
    class: 'user-content',
    label: 'Gezels',
    description: 'Your gezels, their instructions, chat history, and memories.',
    deletable: true,
    inBackup: true,
    itemGranular: true,
    async resolve({ home, store }) {
      const external = await externalFolders(store);
      const entries: StoragePathEntry[] = [];
      for (const gezel of await safeList(() => store.listGezels())) {
        entries.push({
          ...scopedEntry(gezelDir(home, gezel.id, external), home),
          itemId: gezel.id,
          itemLabel: gezel.name ?? gezel.id,
          excludePaths: [
            join(gezelMemoriesDir(home, gezel.id, external), 'index'),
            gezelToolsetsInstallDir(home, gezel.id),
          ],
        });
      }
      return entries;
    },
  },
  {
    id: 'projects',
    class: 'user-content',
    label: 'Projects',
    description: 'Project workspaces, artifacts, tasks, and notes.',
    deletable: true,
    inBackup: true,
    itemGranular: true,
    async resolve({ home, store }) {
      const external = await externalFolders(store);
      const entries: StoragePathEntry[] = [];
      for (const project of await safeList(() => store.listProjects())) {
        // The shared library is a project, but it is the documents category's
        // to own. Leaving it here would let "delete my projects" take out the
        // document library through the back door.
        if (isSharedLibraryProject(project)) continue;
        const derived = projectDerivedPaths(home, project.id, external);
        for (const path of projectOwnedPaths(home, project.id, external)) {
          entries.push({
            ...scopedEntry(path, home),
            itemId: project.id,
            itemLabel: project.name ?? project.id,
            excludePaths: derived,
          });
        }
        // A working directory the user chose is their own folder, wherever it
        // sits. It is never enumerated as deletable — the same rule
        // Store.deleteProject enforces when it refuses to remove a
        // non-internal workspace.
        if (project.workingDir) {
          entries.push({
            ...scopedEntry(project.workingDir, home),
            itemId: `${project.id}:workingDir`,
            itemLabel: `${project.name ?? project.id} working folder`,
            blockedReason: 'A folder you chose, outside Gezel’s own storage.',
          });
        }
      }
      return entries;
    },
  },
  {
    id: 'documents',
    class: 'user-content',
    label: 'Documents',
    description: 'The shared document library.',
    deletable: true,
    inBackup: true,
    async resolve({ home, store }) {
      const external = await externalFolders(store);
      const entries: StoragePathEntry[] = [scopedEntry(gezelPaths(home, external).documents, home)];
      // The library is the shared project's workspace, so that project's own
      // state travels with it rather than with ordinary projects.
      for (const project of await safeList(() => store.listProjects())) {
        if (!isSharedLibraryProject(project)) continue;
        const derived = projectDerivedPaths(home, project.id, external);
        for (const path of projectOwnedPaths(home, project.id, external)) {
          entries.push({ ...scopedEntry(path, home), excludePaths: derived });
        }
      }
      return entries;
    },
  },
  {
    id: 'settings',
    class: 'user-content',
    label: 'Settings and history',
    description: 'Preferences, activity history, scripts, and installed templates.',
    deletable: true,
    inBackup: true,
    async resolve({ home }) {
      return [
        gezelPaths(home).config,
        globalHistoryFile(home),
        keurmeesterDir(home),
        userScriptsDir(home),
        craftbookTemplatesRoot(home),
        projectTypesRoot(home),
        meesterStatusDir(home),
        channelsDir(home),
        toolsetConfigsDir(home),
        foldersStateDir(home),
      ].map(localEntry);
    },
  },
  {
    id: 'secrets',
    class: 'user-content',
    label: 'Saved credentials',
    description: 'API keys and paired-device tokens for this machine.',
    deletable: true,
    // Device-bound by construction. Carrying these into a portable archive
    // would move a machine's credentials somewhere they cannot be trusted.
    inBackup: false,
    async resolve({ home }) {
      return [
        secretsFile(home),
        secretsKeyFile(home),
        tokensFile(home),
        remotesFile(home),
        deviceIdentityFile(home),
        pendingGrantsFile(home),
      ].map(localEntry);
    },
  },
  {
    id: 'folder-backups',
    class: 'user-content',
    label: 'Folder move snapshots',
    description: 'Copies made before moving a folder. May be the only copy of that content.',
    deletable: true,
    inBackup: false,
    async resolve({ home }) {
      return [localEntry(backupsDir(home))];
    },
  },
];

export function categoryById(id: StorageCategoryId): StorageCategoryDef | undefined {
  return STORAGE_CATEGORIES.find((c) => c.id === id);
}

/**
 * Every top-level name a category or the ephemeral list can account for.
 * The registry test asserts a fixture home has no unclassified entries, so
 * a new directory added elsewhere in the codebase fails loudly here instead
 * of silently escaping both cleanup and backup.
 */
export function classifiedTopLevelNames(): string[] {
  return [
    'engines',
    'bin',
    'service',
    'runtime',
    'logs',
    '.transactions',
    'gezels',
    'projects',
    'documents',
    'config.json',
    'history.jsonl',
    'keurmeester',
    'scripts',
    'craftbook-templates',
    'project-types',
    'meester-status',
    'channels',
    'toolset-configs',
    'folders',
    'backup',
    'index',
    'handboek',
    'sandbox',
    'gilde',
    'system-toolsets',
    'system-toolsets.json',
    'installed-toolsets-system.json',
    'toolsets',
    'toolsets.json',
    'playwright-browsers',
    'git-clones',
    'secrets.enc',
    'secrets.key',
    'secrets.backend',
    'tokens.json',
    'remotes.json',
    'device-identity.json',
    'device-identity.json.bak',
    'pending-grants.json',
  ];
}

async function safeReaddir(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Dot-prefixed names are staging and partial-download bookkeeping, not
    // installed items.
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeList<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch {
    return [];
  }
}

export { SHARED_ASSETS_ENV };
