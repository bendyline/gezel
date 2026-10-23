import {
  type FolderKind,
  type GalleryFilter,
  type GalleryGroup,
  type GalleryItem,
  type GalleryRequest,
  type GalleryResponse,
  type GalleryShelf,
  type GalleryShelfRequest,
  type GalleryShelfResponse,
  fileUseOf,
  ruleFileType,
  summaryLead,
} from '@bendyline/gezel';
import { TOP_LEVEL, folderGroups, topFolder } from './folder-groups.js';
import type { FileRecord, PhotoRow } from './index-store-types.js';
import type { IndexStore } from './index-store.js';
import { photoEvents, photoGroups } from './photo-intel.js';

/**
 * The Gallery view's shelves, read from the index with no model: files
 * grouped by type, by folder, or — for a photo library — by outing, with
 * exact copies and look-alikes first. Every shelf is a pure function of the
 * index and the request, so a "Show more" page asks for the same shelf by id
 * and gets the next slice of it.
 */

const DEFAULT_SHELVES = 12;
const DEFAULT_PER_SHELF = 24;
const MAX_FOLDER_SHELVES = 16;
/** A Settings file share above which a folder counts as code. */
const CODE_SHARE = 0.3;
const META_KEYS = ['taken_at', 'screenshot', 'camera_make', 'camera_model', 'title'];
const MINIFIED = /\.min\.[cm]?(js|css)$|\.map$/i;

export interface GalleryContext {
  /** Paths the workspace's Git ignore rules hide. */
  ignoredPaths: ReadonlySet<string>;
  /** What the folder mostly holds, which picks the default grouping. */
  folderKind?: FolderKind;
}

interface Entry {
  item: GalleryItem;
  /** The type's label for a shelf of them. */
  plural: string;
  /** Newest first sorts on this descending. */
  when: string;
  haystack: string;
}

interface Shelf {
  id: string;
  label: string;
  description?: string;
  labelSource: GalleryShelf['labelSource'];
  entries: Entry[];
}

interface Prepared {
  entries: Entry[];
  photoRows: PhotoRow[];
  groups: GalleryGroup[];
  defaultGroup: GalleryGroup;
}

export function emptyGallery(req: GalleryRequest): GalleryResponse {
  return {
    indexed: false,
    group: req.group ?? 'type',
    groups: ['type'],
    filter: req.filter ?? 'all',
    families: {},
    total: 0,
    shelves: [],
    shelfCount: 0,
  };
}

export function buildGallery(
  index: IndexStore,
  req: GalleryRequest,
  ctx: GalleryContext,
): GalleryResponse {
  const prepared = prepare(index, ctx);
  const group =
    req.group && prepared.groups.includes(req.group) ? req.group : prepared.defaultGroup;
  const filter = req.filter ?? 'all';
  const matched = matching(prepared.entries, req.q);
  const families: Record<string, number> = {};
  for (const e of matched) families[e.item.family] = (families[e.item.family] ?? 0) + 1;
  const shown = matched.filter((e) => inFilter(e, filter));
  const shelves = shelvesFor(index, prepared, shown, group, filter);
  const perShelf = req.perShelf ?? DEFAULT_PER_SHELF;
  return {
    indexed: true,
    group,
    groups: prepared.groups,
    filter,
    families,
    total: shown.length,
    shelves: shelves.slice(0, req.shelves ?? DEFAULT_SHELVES).map((s) => toWire(s, 0, perShelf)),
    shelfCount: shelves.length,
  };
}

/** One shelf's next page; null when the shelf no longer exists. */
export function buildGalleryShelf(
  index: IndexStore,
  req: GalleryShelfRequest,
  ctx: GalleryContext,
): GalleryShelfResponse | null {
  const prepared = prepare(index, ctx);
  const group = prepared.groups.includes(req.group) ? req.group : prepared.defaultGroup;
  const filter = req.filter ?? 'all';
  const shown = matching(prepared.entries, req.q).filter((e) => inFilter(e, filter));
  const shelf = shelvesFor(index, prepared, shown, group, filter).find((s) => s.id === req.shelf);
  if (!shelf) return null;
  const offset = req.offset ?? 0;
  const wire = toWire(shelf, offset, req.limit ?? DEFAULT_PER_SHELF);
  return { shelf: shelf.id, offset, count: wire.count, items: wire.items };
}

/** Every file the gallery would show, newest first, for views that place them otherwise. */
export function galleryItems(index: IndexStore, ctx: GalleryContext): GalleryItem[] {
  return prepare(index, ctx).entries.map((e) => e.item);
}

function toWire(shelf: Shelf, offset: number, limit: number): GalleryShelf {
  return {
    id: shelf.id,
    label: shelf.label,
    ...(shelf.description ? { description: shelf.description } : {}),
    labelSource: shelf.labelSource,
    count: shelf.entries.length,
    items: shelf.entries.slice(offset, offset + limit).map((e) => e.item),
  };
}

// ── the files ────────────────────────────────────────────────────────────

function prepare(index: IndexStore, ctx: GalleryContext): Prepared {
  const meta = index.metadataValuesForKeys(META_KEYS);
  const headings = index.firstHeadings();
  const summaries = new Map(index.fileSummaries().map((s) => [s.path, s.summaryMd]));
  const entries: Entry[] = [];
  for (const rec of index.allFiles()) {
    if (ctx.ignoredPaths.has(rec.path) || hiddenFromGallery(rec)) continue;
    entries.push(entryFor(rec, meta.get(rec.path) ?? {}, headings, summaries));
  }
  entries.sort(newestFirst);

  const kept = new Set(entries.map((e) => e.item.path));
  const photoRows = index.photoRows().filter((r) => kept.has(r.path));
  const groups: GalleryGroup[] = [];
  if (photoEvents(photoRows).length > 0) groups.push('event');
  if (new Set(entries.map((e) => topFolder(e.item.path))).size > 1) groups.push('folder');
  groups.push('type');
  return {
    entries,
    photoRows,
    groups,
    defaultGroup: defaultGroup(ctx.folderKind, entries, groups),
  };
}

/** Lockfiles, binaries and minified bundles: files nobody browses. */
function hiddenFromGallery(rec: FileRecord): boolean {
  if (!rec.trivial || rec.modality !== 'text') return false;
  return rec.kind === 'binary' || rec.kind === 'config' || MINIFIED.test(rec.path);
}

function entryFor(
  rec: FileRecord,
  meta: Record<string, string>,
  headings: ReadonlyMap<string, string>,
  summaries: ReadonlyMap<string, string>,
): Entry {
  const structured = rec.kind === 'code' || rec.kind === 'config' || rec.kind === 'data';
  const type = ruleFileType(
    {
      path: rec.path,
      kind: rec.kind,
      modality: rec.modality,
      lang: rec.lang,
      photo: Boolean(meta.taken_at || meta.camera_make || meta.camera_model),
      screenshot: meta.screenshot === '1' || meta.screenshot === 'true',
    },
    structured ? fileUseOf(rec.path, rec.lang) : null,
  );
  const summary = summaries.get(rec.path)?.trim();
  const title = rec.kind === 'markdown' ? (meta.title ?? headings.get(rec.path)) : undefined;
  const lead = summary ? summaryLead(summary) : undefined;
  const takenAt = rec.modality === 'image' ? meta.taken_at : undefined;
  const item: GalleryItem = {
    path: rec.path,
    name: rec.path.slice(rec.path.lastIndexOf('/') + 1),
    type: type.id,
    typeLabel: type.label,
    family: type.family,
    size: rec.size ?? 0,
    mtimeMs: rec.mtimeMs ?? 0,
    ...(takenAt ? { takenAt } : {}),
    ...(title ? { title } : {}),
    ...(lead ? { lead } : {}),
  };
  return {
    item,
    plural: type.plural,
    when: takenAt ?? new Date(rec.mtimeMs ?? 0).toISOString().slice(0, 19),
    haystack: [rec.path, title, type.label, summary].filter(Boolean).join('\n').toLowerCase(),
  };
}

function newestFirst(a: Entry, b: Entry): number {
  if (a.when !== b.when) return a.when < b.when ? 1 : -1;
  return a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0;
}

function matching(entries: Entry[], q: string | undefined): Entry[] {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((e) => words.every((w) => e.haystack.includes(w)));
}

function inFilter(e: Entry, filter: GalleryFilter): boolean {
  return filter === 'all' || e.item.family === filter;
}

/** Outings for a photo library, folders for code, types for everything else. */
function defaultGroup(
  kind: FolderKind | undefined,
  entries: readonly Entry[],
  groups: readonly GalleryGroup[],
): GalleryGroup {
  const code = entries.filter((e) => e.item.family === 'code').length;
  const resolved =
    kind ?? (entries.length > 0 && code / entries.length >= CODE_SHARE ? 'code' : undefined);
  if (resolved === 'pictures' && groups.includes('event')) return 'event';
  if (resolved === 'code' && groups.includes('folder')) return 'folder';
  return 'type';
}

// ── the shelves ──────────────────────────────────────────────────────────

function shelvesFor(
  index: IndexStore,
  prepared: Prepared,
  shown: Entry[],
  group: GalleryGroup,
  filter: GalleryFilter,
): Shelf[] {
  if (group === 'folder') return folderShelves(index, shown);
  if (group === 'event') return eventShelves(index, prepared, shown, filter);
  return typeShelves(shown);
}

function typeShelves(entries: readonly Entry[]): Shelf[] {
  const byType = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byType.get(e.item.type);
    if (list) list.push(e);
    else byType.set(e.item.type, [e]);
  }
  return [...byType.values()]
    .map((list) => ({
      id: `type:${list[0]!.item.type}`,
      label: list[0]!.plural,
      labelSource: 'rule' as const,
      entries: list,
    }))
    .sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
}

/**
 * One shelf per folder group (see `folder-groups.ts`), labeled by path and
 * described by what the index says the folder is for.
 */
function folderShelves(index: IndexStore, entries: readonly Entry[]): Shelf[] {
  const keyOf = folderGroups(
    entries.map((e) => e.item.path),
    MAX_FOLDER_SHELVES,
  );
  const purposes = new Map(index.allAreaSummaries().map((a) => [a.areaPath, a.summaryMd]));
  const byFolder = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = keyOf.get(e.item.path) ?? TOP_LEVEL;
    const list = byFolder.get(key);
    if (list) list.push(e);
    else byFolder.set(key, [e]);
  }
  return [...byFolder.entries()]
    .sort(([a], [b]) => folderRank(a) - folderRank(b) || a.localeCompare(b))
    .map(([folder, list]) => {
      const purpose = purposes.get(folder || '.');
      return {
        id: `folder:${folder || '.'}`,
        label: folder || 'Top level',
        ...(purpose ? { description: summaryLead(purpose) } : {}),
        labelSource: 'path' as const,
        entries: list,
      };
    });
}

/** The top level first, then ordinary folders, then dot-folders (`.github`, `.vscode`). */
function folderRank(folder: string): number {
  if (folder === TOP_LEVEL) return 0;
  return folder.startsWith('.') || folder.includes('/.') ? 2 : 1;
}

/**
 * A photo library's shelves: exact copies and look-alikes first, then each
 * outing newest first, then screenshots and the photos no outing holds, then
 * every other file by type.
 */
function eventShelves(
  index: IndexStore,
  prepared: Prepared,
  shown: Entry[],
  filter: GalleryFilter,
): Shelf[] {
  const byPath = new Map(shown.map((e) => [e.item.path, e]));
  const rows = prepared.photoRows.filter((r) => byPath.has(r.path));
  const shelves: Shelf[] = [];
  const pick = (paths: readonly string[]) =>
    paths.map((p) => byPath.get(p)).filter((e): e is Entry => e !== undefined);

  if (filter === 'all' || filter === 'photos') {
    const copies = photoGroups({ rows, includeLocation: false }, { by: 'duplicate', limit: 500 });
    if (copies.groups.length > 0) {
      const bytes = copies.groups.reduce((n, g) => n + (g.bytes ?? 0), 0);
      const extra = copies.groups.reduce((n, g) => n + g.count - 1, 0);
      shelves.push({
        id: 'copies',
        label: 'Exact copies',
        description: `${extra} ${extra === 1 ? 'photo is a copy' : 'photos are copies'} of another · ${megabytes(bytes)} could be freed`,
        labelSource: 'rule',
        entries: pick(copies.groups.flatMap((g) => g.paths)),
      });
    }
    if (rows.length > 1) {
      const alike = photoGroups(
        { rows, includeLocation: false },
        { by: 'similar', limit: 500 },
        () => index.allImageVectors(),
      );
      if (alike.groups.length > 0) {
        shelves.push({
          id: 'lookalikes',
          label: 'Look-alikes',
          description: 'Bursts and retakes that look nearly the same',
          labelSource: 'rule',
          entries: pick(alike.groups.flatMap((g) => g.paths)),
        });
      }
    }
  }

  const inEvent = new Set<string>();
  for (const event of photoEvents(rows).reverse()) {
    for (const r of event) inEvent.add(r.path);
    const from = event[0]!.taken_at!;
    const to = event[event.length - 1]!.taken_at!;
    const span = timeSpan(from, to);
    shelves.push({
      id: `event:${from}`,
      label: eventLabel(from, to),
      ...(span ? { description: span } : {}),
      labelSource: 'date',
      entries: pick(event.map((r) => r.path)),
    });
  }

  const rest = shown.filter((e) => !inEvent.has(e.item.path));
  const screenshots = rest.filter((e) => e.item.type === 'screenshot');
  if (screenshots.length > 0) {
    shelves.push({
      id: 'type:screenshot',
      label: 'Screenshots',
      labelSource: 'rule',
      entries: screenshots,
    });
  }
  const loose = rest.filter((e) => e.item.family === 'photos' && e.item.type !== 'screenshot');
  if (loose.length > 0) {
    shelves.push({
      id: 'photos:rest',
      label: 'Other pictures',
      labelSource: 'rule',
      entries: loose,
    });
  }
  shelves.push(...typeShelves(rest.filter((e) => e.item.family !== 'photos')));
  return shelves;
}

const MONTH = (m: number) =>
  new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });

function dayOf(taken: string): { y: number; m: number; d: number } {
  return {
    y: Number(taken.slice(0, 4)),
    m: Number(taken.slice(5, 7)),
    d: Number(taken.slice(8, 10)),
  };
}

/** "Saturday, June 1, 2024", "June 1–3, 2024", "May 30 – June 2, 2024". */
export function eventLabel(from: string, to: string): string {
  const a = dayOf(from);
  const b = dayOf(to);
  if (a.y === b.y && a.m === b.m && a.d === b.d) {
    const weekday = new Date(Date.UTC(a.y, a.m - 1, a.d)).toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    });
    return `${weekday}, ${MONTH(a.m)} ${a.d}, ${a.y}`;
  }
  if (a.y === b.y && a.m === b.m) return `${MONTH(a.m)} ${a.d}–${b.d}, ${a.y}`;
  if (a.y === b.y) return `${MONTH(a.m)} ${a.d} – ${MONTH(b.m)} ${b.d}, ${a.y}`;
  return `${MONTH(a.m)} ${a.d}, ${a.y} – ${MONTH(b.m)} ${b.d}, ${b.y}`;
}

/** "2:10 PM – 5:45 PM" for an outing within one day; nothing for a longer one. */
function timeSpan(from: string, to: string): string | undefined {
  if (from.slice(0, 10) !== to.slice(0, 10) || from.length < 16) return undefined;
  const clock = (t: string) => {
    const h = Number(t.slice(11, 13));
    const m = t.slice(14, 16);
    return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const a = clock(from);
  const b = clock(to);
  return a === b ? a : `${a} – ${b}`;
}

function megabytes(bytes: number): string {
  return bytes >= 1_073_741_824
    ? `${(bytes / 1_073_741_824).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}
