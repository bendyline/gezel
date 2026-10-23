/**
 * Google Drive files as a native connector (`files-google-drive`): one or more
 * Drive folders mirrored into a corpus, one record per file, in the shape
 * every cloud-files connector shares (files-shared.ts).
 *
 * Each configured folder is a scope. The first pass captures
 * `changes.getStartPageToken` BEFORE walking the folder breadth-first with
 * `files.list`, so nothing edited during the walk is missed; later passes
 * follow `changes.list` from the saved token (`newStartPageToken` arrives
 * only on the last page). The change feed covers the whole account and
 * carries no paths, so each change is placed by its parent through the
 * folder map the walk built. Folders that live in a shared drive are found
 * through their `driveId`, and that drive's own change feed is followed.
 *
 * Docs export as Markdown (falling back to plain text), Sheets as CSV of the
 * first sheet rendered into a table, Slides as plain text; other files
 * download through `alt=media`. Drive throttles with 403
 * `rateLimitExceeded`/`userRateLimitExceeded` as well as 429, and both count
 * as backpressure here.
 */

import { HttpStatusError } from '@bendyline/gezel';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import {
  type CloudFileMeta,
  CursorExpiredError,
  type FilesPolicy,
  type NativeDocKind,
  StagingDir,
  type TreeCursor,
  type TreeEvent,
  type TreeItem,
  type TreeSource,
  buildFileRecord,
  openDownload,
  parseFilesPolicy,
  planContent,
  resolveFileContent,
  syncTree,
  treeRefRaw,
} from './files-shared.js';
import {
  GOOGLE_OAUTH,
  OAuthSession,
  authorizedJson,
  hasStatus,
  isThrottle,
  transport,
} from './oauth-session.js';

const TYPE_ID = 'files-google-drive';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_ORIGIN = 'https://www.googleapis.com';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const NATIVE_PREFIX = 'application/vnd.google-apps.';
const FILE_FIELDS =
  'id,name,mimeType,parents,trashed,size,createdTime,modifiedTime,webViewLink,' +
  'lastModifyingUser(displayName,emailAddress),owners(displayName,emailAddress)';
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** The slice of a Drive `File` resource this connector requests. */
export interface DriveFileResource {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  /** int64 as a string; absent for folders and shortcuts. */
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  driveId?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  owners?: { displayName?: string; emailAddress?: string }[];
}

interface DriveChange {
  changeType?: string;
  removed?: boolean;
  fileId?: string;
  file?: DriveFileResource;
}

/** Drive's 403 rate-limit reasons are backpressure too, not failures. */
export function isDriveThrottle(err: unknown): boolean {
  if (isThrottle(err)) return true;
  return (
    hasStatus(err, 403) &&
    /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/i.test((err as Error).message)
  );
}

/** A folder link (`drive.google.com/drive/folders/<id>`, `?id=<id>`) or bare id. */
export function parseDriveFolderRef(value: string): string {
  const s = value.trim();
  let id = s;
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new Error(`"${s.slice(0, 80)}" is not a Google Drive folder link.`);
    }
    if (!/(^|\.)google\.com$/i.test(url.hostname)) {
      throw new Error(`"${s.slice(0, 80)}" is not a Google Drive link.`);
    }
    id = /\/folders\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id') ?? '';
  }
  if (!ID_RE.test(id)) {
    throw new Error(`"${s.slice(0, 80)}" is not a Google Drive folder link or ID.`);
  }
  return id;
}

function nativeKind(mimeType: string): NativeDocKind | undefined {
  if (!mimeType.startsWith(NATIVE_PREFIX)) return undefined;
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return 'document';
    case 'application/vnd.google-apps.spreadsheet':
      return 'spreadsheet';
    case 'application/vnd.google-apps.presentation':
      return 'presentation';
    default:
      return 'other';
  }
}

function person(
  p: { displayName?: string; emailAddress?: string } | undefined,
): string | undefined {
  return p?.displayName || p?.emailAddress || undefined;
}

/** A Drive file resource as provider-neutral metadata. */
export function driveFileMeta(f: DriveFileResource): CloudFileMeta {
  const mimeType = f.mimeType || 'application/octet-stream';
  const native = nativeKind(mimeType);
  const size = f.size === undefined ? Number.NaN : Number(f.size);
  return {
    provider: 'google-drive',
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType,
    // A Workspace file's `size` is its storage footprint, not anything a
    // reader downloads, so it is left out rather than shown misleadingly.
    ...(!native && Number.isFinite(size) ? { size } : {}),
    ...(f.modifiedTime ? { modified: f.modifiedTime } : {}),
    ...(f.createdTime ? { created: f.createdTime } : {}),
    ...(person(f.lastModifyingUser) ? { modifiedBy: person(f.lastModifyingUser) } : {}),
    ...(person(f.owners?.[0]) ? { owner: person(f.owners?.[0]) } : {}),
    ...(f.webViewLink ? { url: f.webViewLink } : {}),
    ...(native ? { native } : {}),
  };
}

export function driveTreeItem(f: DriveFileResource): TreeItem {
  const mime = f.mimeType ?? '';
  const kind = mime === FOLDER_MIME ? 'folder' : mime === SHORTCUT_MIME ? 'skip' : 'file';
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    ...(f.parents?.[0] ? { parentId: f.parents[0] } : {}),
    kind,
    ...(f.trashed ? { trashed: true } : {}),
    ...(kind === 'file' ? { file: driveFileMeta(f) } : {}),
  };
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out.set(k, String(v));
  return out.toString();
}

/** Drive's listing and change feed for My Drive, or for one shared drive. */
class DriveTreeSource implements TreeSource {
  constructor(
    private readonly session: OAuthSession,
    private readonly fetchImpl: typeof fetch,
    /** Shared-drive id; undefined for the user's own change feed. */
    private readonly drive: string | undefined,
  ) {}

  private get<T>(path: string, params: Record<string, string | number | boolean | undefined>) {
    return authorizedJson<T>(
      this.session,
      this.fetchImpl,
      `${DRIVE_API}${path}?${qs(params)}`,
      {},
      'Google Drive',
    );
  }

  async startToken(): Promise<string> {
    const res = await this.get<{ startPageToken?: string }>('/changes/startPageToken', {
      supportsAllDrives: true,
      driveId: this.drive,
    });
    if (!res.startPageToken) throw new Error('Google Drive returned no start page token');
    return res.startPageToken;
  }

  async listChildren(
    folderId: string,
    opts: { pageToken?: string; pageSize: number; includeTrashed: boolean },
  ): Promise<{ items: TreeItem[]; nextPageToken?: string }> {
    if (!ID_RE.test(folderId)) throw new Error(`unexpected Google Drive folder id ${folderId}`);
    let res: { files?: DriveFileResource[]; nextPageToken?: string };
    try {
      res = await this.get('/files', {
        q: `'${folderId}' in parents${opts.includeTrashed ? '' : ' and trashed = false'}`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: opts.pageSize,
        pageToken: opts.pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(this.drive ? { corpora: 'drive', driveId: this.drive } : {}),
      });
    } catch (err) {
      if (hasStatus(err, 404)) return { items: [] };
      throw err;
    }
    return {
      items: (res.files ?? []).filter((f) => f.id).map(driveTreeItem),
      ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}),
    };
  }

  async listChanges(
    token: string,
    pageSize: number,
  ): Promise<{ events: TreeEvent[]; nextToken?: string; newStartToken?: string }> {
    let res: { changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string };
    try {
      res = await this.get('/changes', {
        pageToken: token,
        pageSize,
        includeRemoved: true,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        spaces: 'drive',
        driveId: this.drive,
        fields: `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,file(${FILE_FIELDS}))`,
      });
    } catch (err) {
      // Drive tokens do not expire on a clock, but a token Drive no longer
      // recognizes is refused as an invalid `pageToken` value.
      if (
        hasStatus(err, 404, 410) ||
        (hasStatus(err, 400) && /pageToken|Invalid Value/i.test((err as Error).message))
      ) {
        throw new CursorExpiredError((err as Error).message.slice(0, 160));
      }
      throw err;
    }
    const events: TreeEvent[] = [];
    for (const change of res.changes ?? []) {
      if (change.changeType === 'drive') continue;
      const id = change.fileId ?? change.file?.id;
      if (!id) continue;
      if (change.removed) events.push({ id, removed: true });
      else if (change.file) events.push({ id, item: driveTreeItem({ ...change.file, id }) });
    }
    return {
      events,
      ...(res.nextPageToken ? { nextToken: res.nextPageToken } : {}),
      ...(res.newStartPageToken ? { newStartToken: res.newStartPageToken } : {}),
    };
  }
}

function parseFolderScopes(config: Record<string, unknown> | undefined): string[] {
  const raw = config?.folderIds;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  const ids = [
    ...new Set(
      list
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
        .map(parseDriveFolderRef),
    ),
  ];
  if (ids.length > 0) return ids;
  const whole = config?.wholeDrive === true || config?.wholeDrive === 'true';
  if (whole) return [''];
  throw new Error(
    'Choose at least one Google Drive folder to sync (paste the folder link), or turn on "Sync my whole Drive". A whole Drive can take a long time and a lot of disk.',
  );
}

export class GoogleDriveFilesAdapter implements ConnectorAdapter<NormalizedRecord, TreeCursor> {
  readonly typeId = TYPE_ID;
  readonly recordsMayMove = true;
  private readonly session: OAuthSession;
  private readonly fetchImpl: typeof fetch;
  private readonly staging = new StagingDir('gezel-drive-files-');
  private policy?: FilesPolicy;
  private scopes: string[] = [];

  constructor(
    private readonly binding: ConnectorBindingRef,
    deps: AdapterDeps,
  ) {
    this.session = new OAuthSession(binding, deps, GOOGLE_OAUTH);
    this.fetchImpl = transport(deps);
  }

  async ensureAuth(): Promise<void> {
    this.policy = parseFilesPolicy(this.binding.config);
    this.scopes = parseFolderScopes(this.binding.config);
    await this.session.credential();
  }

  async listScopes(): Promise<string[]> {
    return this.scopes;
  }

  async listChangesSince(
    scope: string,
    cursor: TreeCursor | undefined,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<TreeCursor>> {
    const policy = this.ready();
    return syncTree(
      {
        key: `google-drive|${scope || 'root'}`,
        provider: 'google-drive',
        resolveRoot: () => this.resolveRoot(scope || 'root'),
        source: (drive) => new DriveTreeSource(this.session, this.fetchImpl, drive),
        isThrottle: isDriveThrottle,
      },
      cursor,
      { ...(opts?.limit ? { limit: opts.limit } : {}), maxFiles: policy.maxFiles },
    );
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const policy = this.ready();
    const { file } = treeRefRaw(ref);
    const fileUrl = `${DRIVE_API}/files/${encodeURIComponent(file.id)}`;
    const open = (url: string, label: string) =>
      openDownload({
        session: this.session,
        fetchImpl: this.fetchImpl,
        url,
        apiOrigin: DRIVE_ORIGIN,
        label,
      });
    try {
      const content = await resolveFileContent(
        file,
        planContent(file, policy),
        {
          download: () =>
            open(`${fileUrl}?alt=media&supportsAllDrives=true`, 'Google Drive download'),
          exportAs: (mime) =>
            open(`${fileUrl}/export?mimeType=${encodeURIComponent(mime)}`, 'Google Drive export'),
          stagingDir: () => this.staging.get(),
          isThrottle: isDriveThrottle,
        },
        policy,
      );
      return buildFileRecord(TYPE_ID, file, content);
    } catch (err) {
      // A 403 rate limit becomes a 429 so the engine's per-record retry backs
      // off and tries again instead of counting it as a failed record.
      if (isDriveThrottle(err) && !isThrottle(err)) {
        throw new HttpStatusError(429, (err as Error).message);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.staging.dispose();
  }

  private ready(): FilesPolicy {
    if (!this.policy) throw new Error('Google Drive files connector has not been initialized.');
    return this.policy;
  }

  private async resolveRoot(id: string): Promise<{ rootId: string; drive?: string }> {
    let folder: DriveFileResource;
    try {
      folder = await authorizedJson<DriveFileResource>(
        this.session,
        this.fetchImpl,
        `${DRIVE_API}/files/${encodeURIComponent(id)}?${qs({
          fields: 'id,name,mimeType,driveId,trashed',
          supportsAllDrives: true,
        })}`,
        {},
        'Google Drive',
      );
    } catch (err) {
      if (hasStatus(err, 404)) {
        throw new Error(
          `The Google Drive folder ${id} was not found, or this Google account cannot open it. Check the folder link in the connector settings.`,
        );
      }
      throw err;
    }
    if (!folder.id) throw new Error(`Google Drive returned no id for folder ${id}`);
    if (folder.mimeType !== FOLDER_MIME) {
      throw new Error(
        `"${folder.name ?? id}" is a file, not a folder. Paste the link of the folder that contains it.`,
      );
    }
    if (folder.trashed) {
      throw new Error(
        `The Google Drive folder "${folder.name ?? id}" is in the trash. Restore it, or choose another folder.`,
      );
    }
    return { rootId: folder.id, ...(folder.driveId ? { drive: folder.driveId } : {}) };
  }
}
