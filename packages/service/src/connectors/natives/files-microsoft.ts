/**
 * OneDrive (`files-onedrive`) and SharePoint document libraries
 * (`files-sharepoint`) as native connectors. Both are Microsoft Graph drives,
 * so they share everything below the point where the drive is found: the
 * folder walk over `/children`, the change feed over the drive's root
 * `delta`, and downloads over `/content`. Records take the shape every
 * cloud-files connector shares (files-shared.ts).
 *
 * Why root delta, filtered: Graph documents `delta` on a drive's root only,
 * and OneDrive for Business and SharePoint have never served it on other
 * folders. So the first pass captures `delta?token=latest` BEFORE walking the
 * configured folder through `/children` (the walk then cannot miss an edit
 * made during it), and later passes follow the root's delta links, placing
 * each item by `parentReference.id` through the folder map. Delta omits
 * `parentReference.path` on purpose ("track items by id"), and a renamed
 * folder does not return its descendants, which is why a rename re-walks the
 * folder's subtree. A 410 means Graph can no longer serve changes since the
 * token: the scope starts over from a fresh `token=latest` and walk.
 *
 * Token boundary: every request carries the bearer token only to
 * `https://graph.microsoft.com`, and only under `/v1.0/me/drive`,
 * `/v1.0/drives/{id}` or `/v1.0/sites/{id}`; a pagination or delta link
 * pointing anywhere else is refused. `/content` answers with a 302 to a
 * pre-authenticated URL on a storage host, which is followed without the
 * token (files-shared.ts `openDownload`).
 */

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
  type CloudProvider,
  CursorExpiredError,
  type FilesPolicy,
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
  MICROSOFT_OAUTH,
  OAuthSession,
  authorizedJson,
  hasStatus,
  isThrottle,
  transport,
} from './oauth-session.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const SELECT =
  'id,name,size,file,folder,package,remoteItem,root,deleted,parentReference,' +
  'createdDateTime,lastModifiedDateTime,lastModifiedBy,webUrl';
/** Graph's default page size for drive collections; a larger `$top` is not promised. */
const GRAPH_PAGE_MAX = 200;
const GRAPH_PATH_RE = /^\/v1\.0\/(me\/drive(\/|$)|drives\/[^/]+(\/|$)|sites\/[^/]+(\/|$))/;

/** The slice of a Graph `driveItem` this connector selects. */
export interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: object;
  package?: object;
  remoteItem?: object;
  root?: object;
  deleted?: object;
  parentReference?: { id?: string; driveId?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  webUrl?: string;
}

interface GraphPage {
  value?: GraphDriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Thrown for a link that would carry the token somewhere it must not go. */
export class UnsafeGraphLinkError extends Error {
  constructor() {
    super(
      'Microsoft Graph returned a link outside graph.microsoft.com drive paths; it was refused so the sign-in is never sent anywhere else.',
    );
    this.name = 'UnsafeGraphLinkError';
  }
}

/**
 * The only URLs a Graph request (and so the bearer token) may go to:
 * `https://graph.microsoft.com` under `/v1.0/me/drive`, `/v1.0/drives/{id}`
 * or `/v1.0/sites/{id}`.
 */
export function assertGraphUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeGraphLinkError();
  }
  if (
    url.origin !== GRAPH_ORIGIN ||
    url.username ||
    url.password ||
    !GRAPH_PATH_RE.test(url.pathname)
  ) {
    throw new UnsafeGraphLinkError();
  }
  return url.toString();
}

function graphMeta(item: GraphDriveItem, provider: CloudProvider): CloudFileMeta {
  const by = item.lastModifiedBy?.user?.displayName || item.lastModifiedBy?.user?.email;
  return {
    provider,
    id: item.id ?? '',
    name: item.name ?? '',
    mimeType: item.file?.mimeType || 'application/octet-stream',
    ...(typeof item.size === 'number' ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime ? { modified: item.lastModifiedDateTime } : {}),
    ...(item.createdDateTime ? { created: item.createdDateTime } : {}),
    ...(by ? { modifiedBy: by } : {}),
    ...(item.webUrl ? { url: item.webUrl } : {}),
  };
}

/**
 * A driveItem as a tree item. OneNote notebooks (`package`) and items that
 * live in someone else's drive (`remoteItem`, "Add to My files" shortcuts)
 * are skipped: their bytes are not this drive's to download.
 */
export function graphTreeItem(item: GraphDriveItem, provider: CloudProvider): TreeItem {
  const kind =
    item.remoteItem || item.package
      ? 'skip'
      : item.folder || item.root
        ? 'folder'
        : item.file
          ? 'file'
          : 'skip';
  return {
    id: item.id ?? '',
    name: item.name ?? '',
    ...(item.parentReference?.id && !item.root ? { parentId: item.parentReference.id } : {}),
    kind,
    ...(kind === 'file' ? { file: graphMeta(item, provider) } : {}),
  };
}

export function graphTreeEvent(item: GraphDriveItem, provider: CloudProvider): TreeEvent {
  const id = item.id ?? '';
  return item.deleted ? { id, removed: true } : { id, item: graphTreeItem(item, provider) };
}

/** Folder path → `/`-joined, each segment URL-encoded, for `root:/{path}` addressing. */
export function encodeDrivePath(folderPath: string): string {
  const segments = folderPath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of segments) {
    if (s === '.' || s === '..')
      throw new Error(`Folder path "${folderPath}" may not contain "${s}".`);
  }
  return segments.map(encodeURIComponent).join('/');
}

function normalizeFolderPath(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const segments = raw
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  encodeDrivePath(segments.join('/'));
  return segments.join('/');
}

function graphSiteId(id: string): string {
  // Site ids are `host,siteGuid,webGuid`; Graph takes the commas literally.
  return encodeURIComponent(id).replace(/%2C/gi, ',');
}

/** A Graph drive's listing and root delta feed. */
class GraphTreeSource implements TreeSource {
  constructor(
    private readonly session: OAuthSession,
    private readonly fetchImpl: typeof fetch,
    private readonly drive: string,
    private readonly provider: CloudProvider,
    private readonly label: string,
  ) {}

  private get<T>(url: string): Promise<T> {
    return authorizedJson<T>(this.session, this.fetchImpl, assertGraphUrl(url), {}, this.label);
  }

  private driveUrl(path: string): string {
    return `${GRAPH}/drives/${encodeURIComponent(this.drive)}${path}`;
  }

  async startToken(): Promise<string> {
    const page = await this.get<GraphPage>(
      this.driveUrl(`/root/delta?token=latest&$select=${SELECT}`),
    );
    const link = page['@odata.deltaLink'];
    if (!link) throw new Error(`${this.label} returned no delta link`);
    return assertGraphUrl(link);
  }

  async listChildren(
    folderId: string,
    opts: { pageToken?: string; pageSize: number; includeTrashed: boolean },
  ): Promise<{ items: TreeItem[]; nextPageToken?: string }> {
    const url =
      opts.pageToken ??
      this.driveUrl(
        `/items/${encodeURIComponent(folderId)}/children?$select=${SELECT}&$top=${Math.min(
          GRAPH_PAGE_MAX,
          opts.pageSize,
        )}`,
      );
    let page: GraphPage;
    try {
      page = await this.get<GraphPage>(url);
    } catch (err) {
      // A deleted folder (in the recycle bin) has no listable children.
      if (hasStatus(err, 404)) return { items: [] };
      throw err;
    }
    const next = page['@odata.nextLink'];
    return {
      items: (page.value ?? []).filter((i) => i.id).map((i) => graphTreeItem(i, this.provider)),
      ...(next ? { nextPageToken: assertGraphUrl(next) } : {}),
    };
  }

  async listChanges(
    token: string,
  ): Promise<{ events: TreeEvent[]; nextToken?: string; newStartToken?: string }> {
    let url: string;
    try {
      url = assertGraphUrl(token);
    } catch {
      throw new CursorExpiredError('stored delta link is not a Graph drive link');
    }
    let page: GraphPage;
    try {
      page = await this.get<GraphPage>(url);
    } catch (err) {
      if (
        hasStatus(err, 410) ||
        (hasStatus(err, 400, 404) &&
          /resync|syncStateNotFound|syncStateInvalid|invalid.*token/i.test((err as Error).message))
      ) {
        throw new CursorExpiredError((err as Error).message.slice(0, 160));
      }
      throw err;
    }
    const next = page['@odata.nextLink'];
    const delta = page['@odata.deltaLink'];
    return {
      events: (page.value ?? []).filter((i) => i.id).map((i) => graphTreeEvent(i, this.provider)),
      ...(next ? { nextToken: assertGraphUrl(next) } : {}),
      ...(delta ? { newStartToken: assertGraphUrl(delta) } : {}),
    };
  }
}

/** Shared machinery for a connector whose files live in one Graph drive. */
abstract class GraphFilesAdapter implements ConnectorAdapter<NormalizedRecord, TreeCursor> {
  abstract readonly typeId: string;
  readonly recordsMayMove = true;
  protected abstract readonly provider: 'onedrive' | 'sharepoint';
  protected abstract readonly label: string;
  protected readonly session: OAuthSession;
  protected readonly fetchImpl: typeof fetch;
  private readonly staging = new StagingDir('gezel-graph-files-');
  private policy?: FilesPolicy;

  constructor(
    protected readonly binding: ConnectorBindingRef,
    deps: AdapterDeps,
  ) {
    this.session = new OAuthSession(binding, deps, MICROSOFT_OAUTH);
    this.fetchImpl = transport(deps);
  }

  /** Validate the binding config; throw a message a person can act on. */
  protected abstract parseConfig(config: Record<string, unknown>): void;
  /** Fingerprint of the configured location; a change starts the sync over. */
  protected abstract scopeKey(): string;
  /** Find the drive and the folder to mirror. */
  protected abstract resolveRoot(): Promise<{ rootId: string; drive: string }>;

  async ensureAuth(): Promise<void> {
    const config = this.binding.config ?? {};
    this.policy = parseFilesPolicy(config);
    this.parseConfig(config);
    await this.session.credential();
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(
    _scope: string,
    cursor: TreeCursor | undefined,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<TreeCursor>> {
    const policy = this.ready();
    return syncTree(
      {
        key: this.scopeKey(),
        provider: this.provider,
        resolveRoot: () => this.resolveRoot(),
        source: (drive) => {
          if (!drive) throw new Error(`${this.label}: the drive was never resolved`);
          return new GraphTreeSource(
            this.session,
            this.fetchImpl,
            drive,
            this.provider,
            this.label,
          );
        },
        isThrottle,
      },
      cursor,
      { ...(opts?.limit ? { limit: opts.limit } : {}), maxFiles: policy.maxFiles },
    );
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const policy = this.ready();
    const { file, drive } = treeRefRaw(ref);
    if (!drive) throw new Error(`${this.label}: file reference ${ref.id} names no drive`);
    const url = assertGraphUrl(
      `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(file.id)}/content`,
    );
    const content = await resolveFileContent(
      file,
      planContent(file, policy),
      {
        download: () =>
          openDownload({
            session: this.session,
            fetchImpl: this.fetchImpl,
            url,
            apiOrigin: GRAPH_ORIGIN,
            label: `${this.label} download`,
          }),
        stagingDir: () => this.staging.get(),
        isThrottle,
      },
      policy,
    );
    return buildFileRecord(this.typeId, file, content);
  }

  async close(): Promise<void> {
    await this.staging.dispose();
  }

  private ready(): FilesPolicy {
    if (!this.policy) throw new Error(`${this.label} files connector has not been initialized.`);
    return this.policy;
  }

  protected getJson<T>(url: string): Promise<T> {
    return authorizedJson<T>(this.session, this.fetchImpl, assertGraphUrl(url), {}, this.label);
  }

  /** The folder at `folderPath` in `drive`, or the drive root when blank. */
  protected async resolveFolder(drive: string, folderPath: string, where: string): Promise<string> {
    const driveUrl = `${GRAPH}/drives/${encodeURIComponent(drive)}`;
    if (!folderPath) {
      const root = await this.getJson<GraphDriveItem>(`${driveUrl}/root?$select=id`);
      if (!root.id) throw new Error(`${this.label} returned no root folder for ${where}`);
      return root.id;
    }
    let item: GraphDriveItem;
    try {
      item = await this.getJson<GraphDriveItem>(
        `${driveUrl}/root:/${encodeDrivePath(folderPath)}?$select=id,name,folder`,
      );
    } catch (err) {
      if (hasStatus(err, 404)) {
        throw new Error(
          `The folder "${folderPath}" was not found in ${where}. Check the folder path in the connector settings (folders are separated by "/").`,
        );
      }
      throw err;
    }
    if (!item.id) throw new Error(`${this.label} returned no id for "${folderPath}"`);
    if (!item.folder) {
      throw new Error(`"${folderPath}" in ${where} is a file, not a folder.`);
    }
    return item.id;
  }
}

/** The signed-in person's own OneDrive (personal or work/school). */
export class OneDriveFilesAdapter extends GraphFilesAdapter {
  readonly typeId = 'files-onedrive';
  protected readonly provider = 'onedrive' as const;
  protected readonly label = 'OneDrive';
  private folderPath = '';
  private wholeDrive = false;

  protected parseConfig(config: Record<string, unknown>): void {
    this.folderPath = normalizeFolderPath(config.folderPath);
    this.wholeDrive = config.wholeDrive === true || config.wholeDrive === 'true';
    if (!this.folderPath && !this.wholeDrive) {
      throw new Error(
        'Enter the OneDrive folder to sync (for example "Documents/Reports"), or turn on "Sync my whole OneDrive". A whole OneDrive can take a long time and a lot of disk.',
      );
    }
  }

  protected scopeKey(): string {
    return `onedrive|${this.folderPath ? this.folderPath.toLowerCase() : '(whole drive)'}`;
  }

  protected async resolveRoot(): Promise<{ rootId: string; drive: string }> {
    const me = await this.getJson<{ id?: string }>(`${GRAPH}/me/drive?$select=id,driveType`);
    if (!me.id) {
      throw new Error(
        'This Microsoft account has no OneDrive. Work and school accounts get one once OneDrive is opened in a browser for the first time.',
      );
    }
    return {
      rootId: await this.resolveFolder(me.id, this.folderPath, 'your OneDrive'),
      drive: me.id,
    };
  }
}

/** Parse a SharePoint site address into the host and server-relative path. */
export function parseSharePointSiteUrl(raw: unknown): { host: string; path: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'Enter the SharePoint site address, for example https://contoso.sharepoint.com/sites/Finance.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.sharepoint\.com$/i.test(url.hostname)
  ) {
    throw new Error(
      `"${value.slice(0, 120)}" is not a SharePoint Online address (https://<tenant>.sharepoint.com/...).`,
    );
  }
  // People paste library and page URLs as often as site URLs; the site is
  // everything before the first library, list, or page segment. A library
  // view (`/<Library>/Forms/AllItems.aspx`) also drops the library itself.
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  let end = segments.length;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (/^Forms$/i.test(seg)) {
      end = Math.max(0, i - 1);
      break;
    }
    if (/\.aspx$/i.test(seg) || /^(_layouts|Lists|Shared Documents|SitePages)$/i.test(seg)) {
      end = i;
      break;
    }
  }
  const kept = segments.slice(0, end);
  return { host: url.hostname.toLowerCase(), path: kept.length ? `/${kept.join('/')}` : '' };
}

/** A document library on a SharePoint Online site. */
export class SharePointFilesAdapter extends GraphFilesAdapter {
  readonly typeId = 'files-sharepoint';
  protected readonly provider = 'sharepoint' as const;
  protected readonly label = 'SharePoint';
  private site = { host: '', path: '' };
  private library = '';
  private folderPath = '';

  protected parseConfig(config: Record<string, unknown>): void {
    this.site = parseSharePointSiteUrl(config.siteUrl);
    this.library = typeof config.library === 'string' ? config.library.trim() : '';
    this.folderPath = normalizeFolderPath(config.folderPath);
  }

  protected scopeKey(): string {
    return [
      'sharepoint',
      `${this.site.host}${this.site.path}`.toLowerCase(),
      this.library.toLowerCase(),
      this.folderPath.toLowerCase(),
    ].join('|');
  }

  protected async resolveRoot(): Promise<{ rootId: string; drive: string }> {
    const siteAddress = `https://${this.site.host}${this.site.path}`;
    const sitePath = this.site.path
      ? `${this.site.host}:${this.site.path.split('/').map(encodeURIComponent).join('/')}`
      : this.site.host;
    let site: { id?: string };
    try {
      site = await this.getJson<{ id?: string }>(`${GRAPH}/sites/${sitePath}?$select=id`);
    } catch (err) {
      if (hasStatus(err, 404)) {
        throw new Error(
          `The SharePoint site ${siteAddress} was not found, or this account cannot open it. Check the site address in the connector settings.`,
        );
      }
      if (hasStatus(err, 403)) {
        throw new Error(
          `This account was not allowed to read ${siteAddress}. Many organizations require an administrator to approve the connector app's "Sites.Read.All" permission first; ask yours, then re-link the account.`,
        );
      }
      throw err;
    }
    if (!site.id) throw new Error(`SharePoint returned no id for ${siteAddress}`);
    const siteUrl = `${GRAPH}/sites/${graphSiteId(site.id)}`;
    let drive: string | undefined;
    if (this.library) {
      const drives = await this.getJson<{
        value?: { id?: string; name?: string; webUrl?: string }[];
      }>(`${siteUrl}/drives?$select=id,name,webUrl`);
      const wanted = this.library.toLowerCase();
      const lastSegment = (webUrl?: string) => {
        try {
          return decodeURIComponent(
            new URL(webUrl ?? '').pathname.split('/').filter(Boolean).pop() ?? '',
          );
        } catch {
          return '';
        }
      };
      const match = (drives.value ?? []).find(
        (d) => d.name?.toLowerCase() === wanted || lastSegment(d.webUrl).toLowerCase() === wanted,
      );
      if (!match?.id) {
        const names = (drives.value ?? []).map((d) => d.name).filter(Boolean);
        throw new Error(
          `${siteAddress} has no document library named "${this.library}".${names.length ? ` Its libraries are: ${names.join(', ')}.` : ''}`,
        );
      }
      drive = match.id;
    } else {
      drive = (await this.getJson<{ id?: string }>(`${siteUrl}/drive?$select=id`)).id;
      if (!drive) throw new Error(`${siteAddress} has no default document library.`);
    }
    const where = `the ${this.library ? `"${this.library}"` : 'default'} library of ${siteAddress}`;
    return { rootId: await this.resolveFolder(drive, this.folderPath, where), drive };
  }
}
