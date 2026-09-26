import {
  basenameOf,
  compareKey,
  isSameOrInside,
  joinPath,
  normalizePath,
  pathsEqual,
} from './path-compare.js';
import type {
  CloudProvider,
  InferencePlatform,
  WellKnownContext,
  WellKnownFolder,
  WellKnownKind,
} from './types.js';

/**
 * The user's well-known folders (Documents, Pictures, …) and cloud-sync
 * roots, per platform. Returns CANDIDATES: the caller filters by existence
 * (and ideally realpaths them). Deterministic for a given context, which is
 * what the table-driven tests pin.
 */

const DEFAULT_FOLDERS: Record<
  InferencePlatform,
  ReadonlyArray<{ kind: Exclude<WellKnownKind, 'cloud'>; name: string; label: string }>
> = {
  win32: [
    { kind: 'documents', name: 'Documents', label: 'Documents' },
    { kind: 'pictures', name: 'Pictures', label: 'Pictures' },
    { kind: 'desktop', name: 'Desktop', label: 'Desktop' },
    { kind: 'downloads', name: 'Downloads', label: 'Downloads' },
    { kind: 'music', name: 'Music', label: 'Music' },
    { kind: 'videos', name: 'Videos', label: 'Videos' },
  ],
  darwin: [
    { kind: 'documents', name: 'Documents', label: 'Documents' },
    { kind: 'pictures', name: 'Pictures', label: 'Pictures' },
    { kind: 'desktop', name: 'Desktop', label: 'Desktop' },
    { kind: 'downloads', name: 'Downloads', label: 'Downloads' },
    { kind: 'music', name: 'Music', label: 'Music' },
    { kind: 'videos', name: 'Movies', label: 'Movies' },
  ],
  linux: [
    { kind: 'documents', name: 'Documents', label: 'Documents' },
    { kind: 'pictures', name: 'Pictures', label: 'Pictures' },
    { kind: 'desktop', name: 'Desktop', label: 'Desktop' },
    { kind: 'downloads', name: 'Downloads', label: 'Downloads' },
    { kind: 'music', name: 'Music', label: 'Music' },
    { kind: 'videos', name: 'Videos', label: 'Videos' },
  ],
};

/** Folders a cloud client may redirect into itself (Windows Known Folder Move, iCloud Desktop & Documents). */
const CLOUD_CHILDREN: ReadonlyArray<{ kind: Exclude<WellKnownKind, 'cloud'>; name: string }> = [
  { kind: 'documents', name: 'Documents' },
  { kind: 'desktop', name: 'Desktop' },
  { kind: 'pictures', name: 'Pictures' },
];

const XDG_KEYS: ReadonlyArray<{
  key: string;
  kind: Exclude<WellKnownKind, 'cloud'>;
  label: string;
}> = [
  { key: 'XDG_DOCUMENTS_DIR', kind: 'documents', label: 'Documents' },
  { key: 'XDG_PICTURES_DIR', kind: 'pictures', label: 'Pictures' },
  { key: 'XDG_DESKTOP_DIR', kind: 'desktop', label: 'Desktop' },
  { key: 'XDG_DOWNLOAD_DIR', kind: 'downloads', label: 'Downloads' },
  { key: 'XDG_MUSIC_DIR', kind: 'music', label: 'Music' },
  { key: 'XDG_VIDEOS_DIR', kind: 'videos', label: 'Videos' },
];

const PROVIDER_LABELS: Record<CloudProvider, string> = {
  onedrive: 'OneDrive',
  icloud: 'iCloud Drive',
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  box: 'Box',
  nextcloud: 'Nextcloud',
  other: 'Cloud folder',
};

/**
 * Parse `~/.config/user-dirs.dirs`. Values look like `"$HOME/Documents"` or
 * an absolute path. A key pointing at `$HOME` itself means "disabled" and is
 * skipped, as xdg-user-dirs documents.
 */
export function parseUserDirs(text: string, home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(XDG_[A-Z]+_DIR)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (value.startsWith('$HOME')) value = `${home}${value.slice('$HOME'.length)}`;
    if (!value.startsWith('/')) continue;
    const normalized = normalizePath(value, 'linux');
    if (normalized === normalizePath(home, 'linux')) continue;
    out[key] = normalized;
  }
  return out;
}

/**
 * Classify a `~/Library/CloudStorage/<name>` entry (macOS File Provider
 * mounts): `OneDrive-Personal`, `Dropbox`, `GoogleDrive-me@x.com`, `Box-Box`.
 */
export function classifyCloudStorageEntry(name: string): CloudProvider | null {
  if (!name || name.startsWith('.')) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith('onedrive')) return 'onedrive';
  if (lower.startsWith('dropbox')) return 'dropbox';
  if (lower.startsWith('googledrive')) return 'gdrive';
  if (lower.startsWith('box')) return 'box';
  if (lower.startsWith('nextcloud')) return 'nextcloud';
  return 'other';
}

function cloudLabel(provider: CloudProvider, entryName?: string): string {
  const base = PROVIDER_LABELS[provider];
  if (!entryName) return base;
  // `OneDrive-Contoso` → "OneDrive (Contoso)"; `OneDrive-Personal` → "OneDrive".
  const dash = entryName.indexOf('-');
  if (dash < 0) return base;
  const suffix = entryName.slice(dash + 1).trim();
  if (!suffix || /^personal$/i.test(suffix) || suffix.includes('@')) return base;
  return `${base} (${suffix})`;
}

export function wellKnownFolders(ctx: WellKnownContext): WellKnownFolder[] {
  const { platform } = ctx;
  const home = normalizePath(ctx.homedir, platform);
  const out: WellKnownFolder[] = [];
  const push = (f: WellKnownFolder): void => {
    const path = normalizePath(f.path, platform);
    if (pathsEqual(path, home, platform)) return;
    if (out.some((o) => pathsEqual(o.path, path, platform))) return;
    out.push({ ...f, path });
  };
  const addCloudRoot = (
    path: string,
    provider: CloudProvider,
    label: string,
    withChildren: boolean,
  ) => {
    push({ kind: 'cloud', path, label, cloud: provider, source: 'cloud-root' });
    if (!withChildren) return;
    for (const child of CLOUD_CHILDREN) {
      push({
        kind: child.kind,
        path: joinPath(platform, path, child.name),
        label: `${child.name} (${label})`,
        cloud: provider,
        source: 'cloud-child',
      });
    }
  };

  if (platform === 'linux') {
    const fromFile = ctx.userDirs ? parseUserDirs(ctx.userDirs, home) : {};
    for (const x of XDG_KEYS) {
      const envValue = ctx.env[x.key];
      if (envValue?.startsWith('/')) {
        push({ kind: x.kind, path: envValue, label: x.label, source: 'env' });
      } else if (fromFile[x.key]) {
        push({ kind: x.kind, path: fromFile[x.key]!, label: x.label, source: 'xdg' });
      }
    }
  }
  for (const d of DEFAULT_FOLDERS[platform]) {
    // On Linux an xdg/env entry for this kind wins; the default is a fallback.
    if (platform === 'linux' && out.some((o) => o.kind === d.kind)) continue;
    push({
      kind: d.kind,
      path: joinPath(platform, home, d.name),
      label: d.label,
      source: 'default',
    });
  }

  if (platform === 'win32') {
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const value = ctx.env[key];
      if (!value) continue;
      addCloudRoot(value, 'onedrive', cloudLabel('onedrive', basenameOf(value, platform)), true);
    }
    addCloudRoot(joinPath(platform, home, 'OneDrive'), 'onedrive', 'OneDrive', true);
    addCloudRoot(joinPath(platform, home, 'Dropbox'), 'dropbox', 'Dropbox', false);
    addCloudRoot(joinPath(platform, home, 'Google Drive'), 'gdrive', 'Google Drive', false);
    addCloudRoot(joinPath(platform, home, 'Box'), 'box', 'Box', false);
    addCloudRoot(joinPath(platform, home, 'iCloudDrive'), 'icloud', 'iCloud Drive', false);
  } else if (platform === 'darwin') {
    addCloudRoot(
      joinPath(platform, home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
      'icloud',
      'iCloud Drive',
      true,
    );
    for (const entry of ctx.cloudStorageEntries ?? []) {
      const provider = classifyCloudStorageEntry(entry);
      if (!provider) continue;
      addCloudRoot(
        joinPath(platform, home, 'Library', 'CloudStorage', entry),
        provider,
        cloudLabel(provider, entry),
        provider === 'onedrive',
      );
    }
    addCloudRoot(joinPath(platform, home, 'Dropbox'), 'dropbox', 'Dropbox', false);
    addCloudRoot(joinPath(platform, home, 'OneDrive'), 'onedrive', 'OneDrive', false);
    addCloudRoot(joinPath(platform, home, 'Google Drive'), 'gdrive', 'Google Drive', false);
    addCloudRoot(joinPath(platform, home, 'Box'), 'box', 'Box', false);
  } else {
    addCloudRoot(joinPath(platform, home, 'Dropbox'), 'dropbox', 'Dropbox', false);
    addCloudRoot(joinPath(platform, home, 'OneDrive'), 'onedrive', 'OneDrive', false);
    addCloudRoot(joinPath(platform, home, 'Nextcloud'), 'nextcloud', 'Nextcloud', false);
    addCloudRoot(joinPath(platform, home, 'Insync'), 'gdrive', 'Insync', false);
    addCloudRoot(joinPath(platform, home, 'Google Drive'), 'gdrive', 'Google Drive', false);
  }
  return out;
}

/** The deepest well-known folder that contains (or equals) `path`. */
export function wellKnownFolderFor(
  path: string,
  folders: readonly WellKnownFolder[],
  platform: InferencePlatform,
): WellKnownFolder | null {
  let best: WellKnownFolder | null = null;
  for (const f of folders) {
    if (!isSameOrInside(path, f.path, platform)) continue;
    if (!best || compareKey(f.path, platform).length > compareKey(best.path, platform).length) {
      best = f;
    }
  }
  return best;
}

export function cloudRootsFor(folders: readonly WellKnownFolder[]): WellKnownFolder[] {
  return folders.filter((f) => f.kind === 'cloud');
}
