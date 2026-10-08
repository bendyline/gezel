import {
  KeyedLock,
  PHOTO_ALBUMS_ARTIFACT_DIR,
  PHOTO_ALBUM_FROM_KEY,
  PHOTO_ALBUM_ORIGINALS_KEY,
  PHOTO_ALBUM_TO_KEY,
  type PhotoAlbum,
  type PhotoAlbumPhoto,
  type PhotoAlbumSummary,
  type ProjectFileEntry,
  createLogger,
} from '@bendyline/gezel';

import { realpathContained, safeJoin } from '../fs/safe-paths.js';
import { makePhotoRendition } from './thumbnails.js';

const log = createLogger('index');

/** Albums one listing returns; a library makes a few a week. */
const MAX_ALBUMS = 200;

/**
 * Albums are Squisq slideshow documents in the artifacts drawer,
 * `albums/<date>-<slug>.md`: one heading per moment with an
 * `{[imageWithCaption]}` or `{[photoGrid]}` layout, played, edited and
 * exported to video in the document editor. A gezel links each photo by its
 * workspace path; `storeAlbumPhotos` replaces those links with resized,
 * metadata-free copies in the album's companion folder (`<stem>_files/`),
 * the only place the editor and the video export read images from, and
 * records each copy's original under `PHOTO_ALBUM_ORIGINALS_KEY`. The
 * originals are never moved.
 */

export interface PhotoAlbumStore {
  listProjectArtifacts(id: string, subpath?: string): Promise<ProjectFileEntry[]>;
  readProjectArtifact(id: string, filePath: string): Promise<string | null>;
  statProjectArtifactPath(
    id: string,
    filePath: string,
  ): Promise<{ kind: 'file' | 'dir' | 'missing'; mtime?: string }>;
}

/** `albums/<name>.md`, one level deep: the only paths an album read accepts. */
export function isPhotoAlbumPath(path: string): boolean {
  const prefix = `${PHOTO_ALBUMS_ARTIFACT_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.md')) return false;
  const name = path.slice(prefix.length);
  return name.length > '.md'.length && !name.includes('/') && !name.includes('\\');
}

/** The companion folder an album's copies live in, as its links spell it: `<stem>_files/`. */
export function albumCompanionPrefix(albumPath: string): string {
  const name = albumPath.slice(albumPath.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return `${name}_files/`;
}

// ── Markdown ────────────────────────────────────────────────────────────────

interface Frontmatter {
  values: Map<string, string>;
  /** The raw frontmatter lines, without the `---` fences. */
  lines: string[];
  body: string;
  present: boolean;
}

/** Squisq's frontmatter subset: flat `key: value` lines, and `|` / `|-` block scalars. */
function splitFrontmatter(markdown: string): Frontmatter {
  const text = markdown.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { values: new Map(), lines: [], body: text, present: false };
  const lines = match[1]!.split(/\r?\n/);
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw === '|' || raw === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!)) block.push(lines[++i]!);
      const indent = Math.min(
        ...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length),
      );
      values.set(key!, block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n'));
      continue;
    }
    values.set(key!, raw!.trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return { values, lines, body: text.slice(match[0].length), present: true };
}

/** Replace one key's value (and any block-scalar lines under it) with a single line. */
function withFrontmatterValue(fm: Frontmatter, key: string, value: string): string {
  const out: string[] = [];
  for (let i = 0; i < fm.lines.length; i++) {
    const line = fm.lines[i]!;
    if (line.startsWith(`${key}:`)) {
      while (i + 1 < fm.lines.length && /^\s+\S|^\s*$/.test(fm.lines[i + 1]!)) i++;
      continue;
    }
    out.push(line);
  }
  out.push(`${key}: ${value}`);
  return `---\n${out.join('\n')}\n---\n${fm.present ? fm.body : `\n${fm.body}`}`;
}

function readOriginals(fm: Frontmatter): Record<string, string> {
  const raw = fm.values.get(PHOTO_ALBUM_ORIGINALS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/** `![alt](src)`, `![alt](<src with spaces> "title")`. */
const IMAGE_REF = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** `imageSrc=` inside a heading's `{[ ]}` annotation. */
const IMAGE_SRC_ATTR = /\bimageSrc=("([^"\n]*)"|'([^'\n]*)'|([^\s\]}]+))/g;

function refTarget(raw: string): string {
  const bare = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  try {
    return decodeURI(bare);
  } catch {
    return bare;
  }
}

function isExternal(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('//');
}

function attr(annotation: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}=("([^"\\n]*)"|'([^'\\n]*)'|([^\\s\\]}]+))`).exec(annotation);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/**
 * Read an album document. Null when it is not one: no photos at all, or not
 * under `albums/`. Lenient otherwise, because a model and a person both edit it.
 */
export function parsePhotoAlbum(path: string, markdown: string): PhotoAlbum | null {
  const fm = splitFrontmatter(markdown);
  const originals = readOriginals(fm);
  const companion = albumCompanionPrefix(path);
  const photos: PhotoAlbumPhoto[] = [];
  let title = fm.values.get('title')?.trim() || '';
  // The paragraph under the first `#` title is the cover's subtitle: the story.
  let cover: 'before' | 'collecting' | 'done' = 'before';
  const story: string[] = [];
  let annotation = '';
  let headingText = '';
  for (const line of fm.body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const ann = /\{\[([^\]]*)\]\}\s*(?:\{[^}]*\}\s*)?$/.exec(heading[2]!);
      annotation = ann ? ann[1]! : '';
      headingText = heading[2]!
        .replace(/\s*\{\[[^\]]*\]\}.*$/, '')
        .replace(/\s*\{#[^}]*\}\s*$/, '');
      if (heading[1] === '#' && cover === 'before') {
        cover = 'collecting';
        if (!title) title = headingText;
      } else if (cover === 'collecting') {
        cover = 'done';
      }
      for (const m of annotation.matchAll(IMAGE_SRC_ATTR)) {
        const src = m[2] ?? m[3] ?? m[4] ?? '';
        if (src) photos.push(photoFor(src, attr(annotation, 'caption') ?? headingText));
      }
      continue;
    }
    if (cover === 'collecting') {
      if (!line.trim()) {
        if (story.length > 0) cover = 'done';
      } else if (!line.includes('![') && !line.trim().startsWith('{[')) {
        story.push(line.trim());
      }
    }
    for (const m of line.matchAll(IMAGE_REF)) {
      const src = refTarget(m[2]!);
      const caption = attr(annotation, 'caption') ?? (m[1]?.trim() || headingText || undefined);
      photos.push(photoFor(src, caption));
    }
  }
  if (photos.length === 0) return null;
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const from = fm.values.get(PHOTO_ALBUM_FROM_KEY);
  const to = fm.values.get(PHOTO_ALBUM_TO_KEY);
  return {
    path,
    title: title || name,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(story.length > 0 ? { story: story.join(' ') } : {}),
    photos,
  };

  function photoFor(src: string, caption: string | undefined): PhotoAlbumPhoto {
    const original = src.startsWith(companion) ? originals[src] : isExternal(src) ? undefined : src;
    return {
      src,
      ...(original ? { original } : {}),
      ...(caption ? { caption } : {}),
    };
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function readPhotoAlbum(
  store: PhotoAlbumStore,
  projectId: string,
  path: string,
): Promise<PhotoAlbum | null> {
  if (!isPhotoAlbumPath(path)) return null;
  const raw = await store.readProjectArtifact(projectId, path).catch(() => null);
  return raw ? parsePhotoAlbum(path, raw) : null;
}

/** The project's album proposals, newest first. */
export async function listPhotoAlbums(
  store: PhotoAlbumStore,
  projectId: string,
): Promise<PhotoAlbumSummary[]> {
  const entries = await store
    .listProjectArtifacts(projectId, PHOTO_ALBUMS_ARTIFACT_DIR)
    .catch(() => [] as ProjectFileEntry[]);
  const paths = entries
    .filter((e) => !e.isDirectory)
    .map((e) => (e.path.includes('/') ? e.path : `${PHOTO_ALBUMS_ARTIFACT_DIR}/${e.name}`))
    .filter(isPhotoAlbumPath)
    .slice(0, MAX_ALBUMS);
  const summaries = await Promise.all(
    paths.map(async (path): Promise<PhotoAlbumSummary | null> => {
      const album = await readPhotoAlbum(store, projectId, path);
      if (!album) return null;
      const stat = await store.statProjectArtifactPath(projectId, path).catch(() => null);
      const companion = albumCompanionPrefix(path);
      const pending = album.photos.filter(
        (p) => !p.src.startsWith(companion) && !isExternal(p.src),
      ).length;
      const cover = album.photos.find((p) => p.original)?.original;
      return {
        path,
        title: album.title,
        ...(album.from ? { from: album.from } : {}),
        ...(album.to ? { to: album.to } : {}),
        ...(cover ? { cover } : {}),
        count: album.photos.length,
        ...(pending > 0 ? { pending } : {}),
        ...(stat?.mtime ? { updatedAt: stat.mtime } : {}),
      };
    }),
  );
  return summaries
    .filter((s): s is PhotoAlbumSummary => s !== null)
    .sort((a, b) => (b.from ?? b.updatedAt ?? '').localeCompare(a.from ?? a.updatedAt ?? ''));
}

// ── Storing the photos with the album ───────────────────────────────────────

export interface AlbumMediaStore extends PhotoAlbumStore {
  writeProjectArtifact(id: string, filePath: string, content: string): Promise<void>;
  writeProjectArtifactBinary(id: string, filePath: string, data: Buffer): Promise<string>;
  statProjectWorkspacePath(
    id: string,
    filePath: string,
  ): Promise<{ kind: 'file' | 'dir' | 'missing' }>;
}

export interface AlbumMediaDeps {
  store: AlbumMediaStore;
  /** A resized, upright, metadata-free JPEG of a workspace photo; null when unreadable here. */
  copyPhoto(projectId: string, workspacePath: string): Promise<Buffer | null>;
}

export interface StoreAlbumPhotosResult {
  stored: number;
  skipped: Array<{ src: string; reason: string }>;
}

/** The daemon's wiring: copies are made from the project's own workspace, never from elsewhere. */
export function albumMediaDeps(
  store: AlbumMediaStore & { projectWorkspaceDir(id: string): Promise<string> },
): AlbumMediaDeps {
  return {
    store,
    copyPhoto: async (projectId, workspacePath) => {
      const base = await store.projectWorkspaceDir(projectId);
      const abs = safeJoin(base, workspacePath);
      if (!abs || !(await realpathContained(base, abs))) return null;
      return makePhotoRendition(abs);
    },
  };
}

const albumLocks = new KeyedLock();

function copyName(original: string): string {
  const base = original.slice(original.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const slug = base
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'photo';
}

/**
 * Store the album's photos with it: every link to a workspace photo becomes a
 * link to a copy in `<stem>_files/`, made once and reused when the same photo
 * is linked again. Idempotent; an album already stored is left byte-for-byte
 * alone. A photo this machine cannot read keeps its workspace link, and is
 * reported as skipped.
 */
export async function storeAlbumPhotos(
  deps: AlbumMediaDeps,
  projectId: string,
  albumPath: string,
): Promise<StoreAlbumPhotosResult> {
  if (!isPhotoAlbumPath(albumPath)) return { stored: 0, skipped: [] };
  return albumLocks.run(`${projectId}\0${albumPath}`, async () => {
    const result: StoreAlbumPhotosResult = { stored: 0, skipped: [] };
    const raw = await deps.store.readProjectArtifact(projectId, albumPath).catch(() => null);
    if (!raw) return result;
    const fm = splitFrontmatter(raw);
    const originals = readOriginals(fm);
    const companion = albumCompanionPrefix(albumPath);
    const dir = albumPath.slice(0, albumPath.lastIndexOf('/') + 1);
    const byOriginal = new Map(Object.entries(originals).map(([copy, orig]) => [orig, copy]));
    const taken = new Set(Object.keys(originals));
    const replacements = new Map<string, string>();

    const targets = new Set<string>();
    for (const m of fm.body.matchAll(IMAGE_REF)) targets.add(refTarget(m[2]!));
    for (const m of fm.body.matchAll(IMAGE_SRC_ATTR)) targets.add(m[2] ?? m[3] ?? m[4] ?? '');
    for (const src of targets) {
      if (!src || src.startsWith(companion) || isExternal(src)) continue;
      const stat = await deps.store.statProjectWorkspacePath(projectId, src).catch(() => null);
      if (stat?.kind !== 'file') {
        result.skipped.push({ src, reason: 'not a photo in this folder' });
        continue;
      }
      let copy = byOriginal.get(src);
      const existing = copy
        ? await deps.store.statProjectArtifactPath(projectId, `${dir}${copy}`).catch(() => null)
        : null;
      if (!copy || existing?.kind !== 'file') {
        const bytes = await deps.copyPhoto(projectId, src).catch(() => null);
        if (!bytes) {
          result.skipped.push({ src, reason: 'this computer cannot read that format' });
          continue;
        }
        if (!copy) {
          const stem = copyName(src);
          for (let n = 1; ; n++) {
            const candidate = `${companion}${n === 1 ? stem : `${stem}-${n}`}.jpg`;
            if (!taken.has(candidate)) {
              copy = candidate;
              break;
            }
          }
          taken.add(copy);
        }
        await deps.store.writeProjectArtifactBinary(projectId, `${dir}${copy}`, bytes);
        result.stored += 1;
      }
      originals[copy] = src;
      byOriginal.set(src, copy);
      replacements.set(src, copy);
    }
    if (replacements.size === 0) return result;

    const body = fm.body
      .replace(IMAGE_REF, (whole, alt: string, target: string, title: string | undefined) => {
        const copy = replacements.get(refTarget(target));
        return copy ? `![${alt}](${copy}${title ?? ''})` : whole;
      })
      .replace(IMAGE_SRC_ATTR, (whole, _q, d: string, s: string, b: string) => {
        const copy = replacements.get(d ?? s ?? b ?? '');
        return copy ? `imageSrc="${copy}"` : whole;
      });
    const next = withFrontmatterValue(
      { ...fm, body },
      PHOTO_ALBUM_ORIGINALS_KEY,
      JSON.stringify(originals),
    );
    await deps.store.writeProjectArtifact(projectId, albumPath, next);
    log.info(`[index] ${projectId}: stored ${result.stored} photo(s) with ${albumPath}`);
    return result;
  });
}

/** Store every album in the project that still links workspace photos. */
export async function storeAllAlbumPhotos(
  deps: AlbumMediaDeps,
  projectId: string,
): Promise<number> {
  let stored = 0;
  for (const album of await listPhotoAlbums(deps.store, projectId)) {
    if (!album.pending) continue;
    stored += (await storeAlbumPhotos(deps, projectId, album.path)).stored;
  }
  return stored;
}

const scheduled = new Set<string>();

/**
 * Store an album's photos soon, in the background: after a gezel writes it,
 * or when a listing finds it still linking workspace photos. One run per
 * album at a time; a write that lands while one runs is picked up by it.
 */
export function scheduleAlbumPhotos(deps: AlbumMediaDeps, projectId: string, path: string): void {
  if (!isPhotoAlbumPath(path)) return;
  const key = `${projectId}\0${path}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  setTimeout(() => {
    scheduled.delete(key);
    void storeAlbumPhotos(deps, projectId, path).catch((err: unknown) =>
      log.warn(`[index] storing photos for ${path} failed: ${String(err)}`),
    );
  }, 1500).unref?.();
}

// ── Copying the originals into the folder ───────────────────────────────────

export interface AlbumCopyStore extends PhotoAlbumStore {
  statProjectWorkspacePath(
    id: string,
    filePath: string,
  ): Promise<{ kind: 'file' | 'dir' | 'missing' }>;
  copyProjectWorkspacePath(
    id: string,
    fromPath: string,
    toPath: string,
    ctx?: undefined,
    opts?: { userInitiated?: boolean },
  ): Promise<void>;
}

export interface AlbumCopyResult {
  folder: string;
  copied: number;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Copy an album's original photos into a folder of the workspace, as the
 * person: the one write an album makes, and only from their click. Full-size
 * originals, not the album's resized copies. Nothing at the destination is
 * replaced — a name already taken gets ` (2)`, ` (3)`… — and the originals
 * stay where they are.
 */
export async function copyAlbumToFolder(
  store: AlbumCopyStore,
  projectId: string,
  albumPath: string,
  folder: string,
): Promise<AlbumCopyResult> {
  const album = await readPhotoAlbum(store, projectId, albumPath);
  if (!album) throw new Error('not an album');
  const dest = folder.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!dest || dest.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error('choose a folder inside this project');
  }
  if ((await store.statProjectWorkspacePath(projectId, dest)).kind === 'file') {
    throw new Error(`${dest} is a file`);
  }
  const result: AlbumCopyResult = { folder: dest, copied: 0, skipped: [] };
  const taken = new Set<string>();
  const seen = new Set<string>();
  for (const photo of album.photos) {
    const original = photo.original;
    if (!original) {
      result.skipped.push({ path: photo.src, reason: 'not a photo from this folder' });
      continue;
    }
    if (seen.has(original)) continue;
    seen.add(original);
    const source = await store.statProjectWorkspacePath(projectId, original);
    if (source.kind !== 'file') {
      result.skipped.push({ path: original, reason: 'not in the folder any more' });
      continue;
    }
    const target = await freeName(store, projectId, dest, basename(original), taken);
    try {
      await store.copyProjectWorkspacePath(projectId, original, target, undefined, {
        userInitiated: true,
      });
      result.copied += 1;
    } catch (err) {
      result.skipped.push({
        path: original,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function freeName(
  store: AlbumCopyStore,
  projectId: string,
  folder: string,
  name: string,
  taken: Set<string>,
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = `${folder}/${n === 1 ? name : `${stem} (${n})${ext}`}`;
    if (taken.has(candidate)) continue;
    if ((await store.statProjectWorkspacePath(projectId, candidate)).kind !== 'missing') continue;
    taken.add(candidate);
    return candidate;
  }
  throw new Error(`no free name for ${name} in ${folder}`);
}
