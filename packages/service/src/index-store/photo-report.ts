import {
  type OnThisDayResponse,
  type PhotoGroupsResponse,
  type ProjectIndexOverview,
  createLogger,
} from '@bendyline/gezel';

const log = createLogger('index');

/** A folder with fewer photos than this is not a photo library. */
const MIN_PHOTOS = 20;
/** Outings from this many days back make the report. */
const RECENT_EVENT_DAYS = 45;
const MAX_EVENTS = 6;

export interface PhotoReportDeps {
  store: {
    readProjectArtifact(id: string, path: string): Promise<string | null>;
    writeProjectArtifact(id: string, path: string, content: string): Promise<unknown>;
  };
  contentIndex: {
    overview(projectId: string): Promise<ProjectIndexOverview | null>;
    photoGroups(
      projectId: string,
      req: { by: 'event' | 'duplicate'; limit?: number },
      includeLocation: boolean,
    ): Promise<PhotoGroupsResponse>;
    onThisDay(projectId: string, now?: Date): Promise<OnThisDayResponse | null>;
  };
}

/**
 * The nightly photo report for a folder of photos: recent outings, duplicates
 * and the space they take, and photos from this day in earlier years. Read
 * from the index after the night's sweep, with no model, so it runs on any
 * machine and costs nothing; the morning review finds it under `reports/`.
 * One per day; nothing worth saying writes nothing. Locations stay out: a
 * report is an artifact any session can read.
 */
export async function writeNightlyPhotoReport(
  deps: PhotoReportDeps,
  projectId: string,
  now: Date,
  /** The night's day key, so one night files one report whichever side of midnight it lands. */
  day = localDay(now),
): Promise<string | null> {
  const path = `reports/photos-${day}.md`;
  if ((await deps.store.readProjectArtifact(projectId, path).catch(() => null)) !== null) {
    return null;
  }
  const overview = await deps.contentIndex.overview(projectId);
  const photos = overview?.byModality.image ?? 0;
  if (!overview || photos < MIN_PHOTOS) return null;

  const [events, duplicates, onThisDay] = await Promise.all([
    deps.contentIndex.photoGroups(projectId, { by: 'event', limit: 50 }, false),
    deps.contentIndex.photoGroups(projectId, { by: 'duplicate', limit: 200 }, false),
    deps.contentIndex.onThisDay(projectId, now),
  ]);
  const cutoff = localDay(new Date(now.getTime() - RECENT_EVENT_DAYS * 86_400_000));
  const recent = events.groups.filter((g) => (g.to ?? '') >= cutoff).slice(0, MAX_EVENTS);
  const extraCopies = duplicates.groups.reduce((n, g) => n + g.count - 1, 0);
  const reclaim = duplicates.groups.reduce((n, g) => n + (g.bytes ?? 0), 0);
  const memories = onThisDay?.years ?? [];
  if (recent.length === 0 && extraCopies === 0 && memories.length === 0) return null;

  const lines = [`# Your photos · ${day}`, ''];
  lines.push(`${photos.toLocaleString('en-US')} photos in this folder.`);
  if (recent.length > 0) {
    lines.push('', '## Recent outings', '');
    for (const e of recent) {
      lines.push(
        `- **${span(e.from, e.to)}** · ${e.count} photos: ${e.paths.slice(0, 4).map(code).join(', ')}`,
      );
    }
  }
  if (memories.length > 0) {
    lines.push('', '## On this day', '');
    for (const y of memories) {
      lines.push(
        `- **${y.year}** · ${y.count} photo${y.count === 1 ? '' : 's'}: ${y.paths.slice(0, 4).map(code).join(', ')}`,
      );
    }
  }
  if (extraCopies > 0) {
    lines.push(
      '',
      '## Duplicates',
      '',
      `${extraCopies.toLocaleString('en-US')} photo${extraCopies === 1 ? ' is a' : 's are'} byte-for-byte cop${extraCopies === 1 ? 'y' : 'ies'} of another, taking ${megabytes(reclaim)}. Nothing has been moved or deleted.`,
      '',
    );
    for (const g of duplicates.groups.slice(0, 10)) {
      lines.push(`- ${g.paths.map(code).join(' = ')}`);
    }
  }
  lines.push('');
  await deps.store.writeProjectArtifact(projectId, path, lines.join('\n'));
  log.info(`[index] ${projectId}: wrote ${path}`);
  return path;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function span(from?: string, to?: string): string {
  if (!from) return 'Undated';
  const a = from.slice(0, 10);
  const b = to?.slice(0, 10);
  return !b || a === b ? a : `${a} to ${b}`;
}

function code(path: string): string {
  return `\`${path}\``;
}

function megabytes(bytes: number): string {
  return bytes >= 1_073_741_824
    ? `${(bytes / 1_073_741_824).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}
