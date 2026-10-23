import type {
  GalleryItem,
  TimelineBucket,
  TimelineBucketRequest,
  TimelineBucketResponse,
  TimelineBucketSize,
  TimelineCommit,
  TimelineFile,
  TimelineLane,
  TimelineRequest,
  TimelineResponse,
} from '@bendyline/gezel';
import { TOP_LEVEL, folderGroups } from './folder-groups.js';
import { type GalleryContext, galleryItems } from './gallery.js';
import type { IndexStore } from './index-store.js';

/**
 * The Timeline view's data, read from the index with no model: what changed
 * when. A git repository is told by its commits, each file change landing on
 * that file's area of the project; any other folder by its files' own dates
 * (a photo when it was taken), by kind of file. Buckets are weeks, months or
 * years in the machine's time zone, so "this week" means the person's week.
 */

/** About five years of weeks; a longer history is cut to its newest buckets. */
const MAX_BUCKETS = 260;
const MAX_LANES = 7;
const OTHER_LANE = 'other';
const MAX_COMMITS = 200;
const MAX_FILES = 60;
const COMMIT_FILES = 12;
const WEEKS_UP_TO_DAYS = 120;
const MONTHS_UP_TO_DAYS = 4 * 366;

const FAMILY_LANE: Record<GalleryItem['family'], string> = {
  photos: 'Photos',
  documents: 'Documents',
  data: 'Data',
  media: 'Recordings and videos',
  code: 'Code',
  other: 'Other files',
};

interface Change {
  at: number;
  path: string;
  sha?: string;
}

interface Source {
  source: 'git' | 'files';
  changes: Change[];
  items: Map<string, GalleryItem>;
}

export function emptyTimeline(req: TimelineRequest): TimelineResponse {
  return {
    indexed: false,
    source: 'files',
    bucket: req.bucket ?? 'month',
    lanes: [],
    buckets: [],
    truncated: false,
  };
}

export function buildTimeline(
  index: IndexStore,
  req: TimelineRequest,
  ctx: GalleryContext,
): TimelineResponse {
  const { source, changes, items } = gather(index, ctx);
  const laneOf = lanesFor(source, changes, items);
  if (changes.length === 0) {
    return { ...emptyTimeline(req), indexed: true, source, lanes: laneOf.lanes };
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const c of changes) {
    if (c.at < first) first = c.at;
    if (c.at > last) last = c.at;
  }
  const size = req.bucket ?? defaultSize(first, last);

  const acc = new Map<
    string,
    { commits: Set<string>; files: Set<string>; lanes: Map<string, number> }
  >();
  for (const c of changes) {
    const key = localDate(bucketStart(c.at, size));
    let bucket = acc.get(key);
    if (!bucket) {
      bucket = { commits: new Set(), files: new Set(), lanes: new Map() };
      acc.set(key, bucket);
    }
    if (c.sha) bucket.commits.add(c.sha);
    bucket.files.add(c.path);
    const lane = laneOf.lane(c.path);
    bucket.lanes.set(lane, (bucket.lanes.get(lane) ?? 0) + 1);
  }

  const buckets: TimelineBucket[] = [];
  const end = bucketStart(last, size).getTime();
  for (let at = bucketStart(first, size); at.getTime() <= end; at = nextBucket(at, size)) {
    const key = localDate(at);
    const b = acc.get(key);
    buckets.push({
      start: key,
      end: localDate(nextBucket(at, size)),
      label: bucketLabel(at, size),
      commits: b?.commits.size ?? 0,
      files: b?.files.size ?? 0,
      lanes: b ? Object.fromEntries(b.lanes) : {},
    });
  }
  const truncated = buckets.length > MAX_BUCKETS;
  return {
    indexed: true,
    source,
    bucket: size,
    lanes: laneOf.lanes,
    buckets: truncated ? buckets.slice(-MAX_BUCKETS) : buckets,
    truncated,
  };
}

/** What changed between two local dates: the commits and the files they touched most. */
export function buildTimelineBucket(
  index: IndexStore,
  req: TimelineBucketRequest,
  ctx: GalleryContext,
): TimelineBucketResponse {
  const from = parseLocalDate(req.start);
  const to = parseLocalDate(req.end);
  const items = shownItems(index, ctx);
  const source = req.source ?? (index.gitHistory.count() > 0 ? 'git' : 'files');
  const base = { start: req.start, end: req.end, source };
  if (source === 'files') {
    const files = [...items.values()]
      .map((item) => ({ item, at: dateOf(item) }))
      .filter((d) => d.at >= from && d.at < to)
      .sort((a, b) => b.at - a.at || (a.item.path < b.item.path ? -1 : 1))
      .map((d) => d.item);
    return {
      ...base,
      commits: [],
      files: files.slice(0, MAX_FILES),
      truncated: files.length > MAX_FILES,
    };
  }

  const commits: TimelineCommit[] = [];
  const changed = new Map<string, number>();
  for (const commit of index.gitHistory.commits({ from, to }).reverse()) {
    const shown = commit.files.filter((p) => items.has(p));
    if (shown.length === 0) continue;
    for (const path of shown) changed.set(path, (changed.get(path) ?? 0) + 1);
    commits.push({
      sha: commit.sha,
      at: new Date(commit.at).toISOString(),
      subject: commit.subject,
      files: shown.slice(0, COMMIT_FILES),
      fileCount: shown.length,
    });
  }
  const files: TimelineFile[] = [...changed.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .flatMap(([path, n]) => {
      const item = items.get(path);
      return item ? [{ ...item, changes: n }] : [];
    });
  return {
    ...base,
    commits: commits.slice(0, MAX_COMMITS),
    files: files.slice(0, MAX_FILES),
    truncated: commits.length > MAX_COMMITS || files.length > MAX_FILES,
  };
}

// ── what changed ─────────────────────────────────────────────────────────

function shownItems(index: IndexStore, ctx: GalleryContext): Map<string, GalleryItem> {
  return new Map(galleryItems(index, ctx).map((i) => [i.path, i]));
}

/**
 * The dated changes: one per (commit, shown file) from the stored history,
 * or one per shown file at its own date when the folder has no history (or
 * none of it touches a shown file).
 */
function gather(index: IndexStore, ctx: GalleryContext): Source {
  const items = shownItems(index, ctx);
  if (index.gitHistory.count() > 0) {
    const changes: Change[] = [];
    for (const commit of index.gitHistory.commits()) {
      for (const path of commit.files) {
        if (items.has(path)) changes.push({ at: commit.at, path, sha: commit.sha });
      }
    }
    if (changes.length > 0) return { source: 'git', changes, items };
  }
  const changes = [...items.values()].map((item) => ({ at: dateOf(item), path: item.path }));
  return { source: 'files', changes, items };
}

/** A photo's capture time (the camera's wall clock), else the file's modified time. */
function dateOf(item: GalleryItem): number {
  const m = item.takenAt ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(item.takenAt) : null;
  if (!m) return item.mtimeMs;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime();
}

/**
 * The lanes: the busiest areas of the project (git), or kinds of file (file
 * dates), at most {@link MAX_LANES} with the rest as one.
 */
function lanesFor(
  source: Source['source'],
  changes: readonly Change[],
  items: ReadonlyMap<string, GalleryItem>,
): { lanes: TimelineLane[]; lane: (path: string) => string } {
  const keyOf =
    source === 'git'
      ? folderGroups([...new Set(changes.map((c) => c.path))])
      : new Map([...items.values()].map((i) => [i.path, i.family]));
  const counts = new Map<string, number>();
  for (const c of changes) {
    const key = keyOf.get(c.path) ?? TOP_LEVEL;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const kept = new Set(
    ranked.slice(0, ranked.length > MAX_LANES ? MAX_LANES - 1 : MAX_LANES).map(([k]) => k),
  );
  const label = (key: string) =>
    source === 'git' ? key || 'Top level' : (FAMILY_LANE[key as GalleryItem['family']] ?? key);
  const lanes: TimelineLane[] = [...kept].map((id) => ({ id: id || '.', label: label(id) }));
  if (kept.size < counts.size) lanes.push({ id: OTHER_LANE, label: 'Everything else' });
  return {
    lanes,
    lane: (path) => {
      const key = keyOf.get(path) ?? TOP_LEVEL;
      return kept.has(key) ? key || '.' : OTHER_LANE;
    },
  };
}

// ── buckets in local time ────────────────────────────────────────────────

function defaultSize(first: number, last: number): TimelineBucketSize {
  const days = (last - first) / 86_400_000;
  if (days <= WEEKS_UP_TO_DAYS) return 'week';
  if (days <= MONTHS_UP_TO_DAYS) return 'month';
  return 'year';
}

function bucketStart(at: number, size: TimelineBucketSize): Date {
  const d = new Date(at);
  if (size === 'year') return new Date(d.getFullYear(), 0, 1);
  if (size === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  // Weeks start on Monday.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

function nextBucket(d: Date, size: TimelineBucketSize): Date {
  if (size === 'year') return new Date(d.getFullYear() + 1, 0, 1);
  if (size === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
}

function bucketLabel(d: Date, size: TimelineBucketSize): string {
  const month = d.toLocaleDateString('en-US', { month: 'long' });
  if (size === 'year') return String(d.getFullYear());
  if (size === 'month') return `${month} ${d.getFullYear()}`;
  return `Week of ${month} ${d.getDate()}, ${d.getFullYear()}`;
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseLocalDate(day: string): number {
  return new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)).getTime();
}
