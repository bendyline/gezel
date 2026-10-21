/**
 * A stateful Microsoft Graph drive fake for the `files-onedrive` and
 * `files-sharepoint` connectors: drives with folder trees, SharePoint sites
 * and their document libraries, `/children` paging, the root `delta` feed,
 * and `/content` downloads.
 *
 * Shapes follow the Graph v1.0 reference:
 *
 * - `GET /drives/{id}/root/delta` with no token enumerates the drive; with
 *   `token=latest` it answers an empty page and the current `deltaLink`; with
 *   an earlier token it returns the latest state of each changed item (one
 *   entry per item, as Graph does), preceded by the item's parent hierarchy
 *   (Graph returns ancestors of changed items unless `deltaExcludeParent` is
 *   sent), paged with `@odata.nextLink` and closed by `@odata.deltaLink`.
 *   Delta omits `parentReference.path`; deleted items carry the `deleted`
 *   facet and, like OneDrive for Business, no `name`.
 * - An expired token answers `410 Gone` with a `resyncRequired` error and a
 *   `Location` header holding a fresh enumeration link.
 * - `/items/{id}/content` answers `302 Found` with a pre-authenticated
 *   `Location` on a separate download origin. That origin refuses — and
 *   records in `authLeaks` — any request that carries an Authorization
 *   header, because the token must never leave Graph.
 * - `$select` and `$top` are honored.
 */

import { FakeHttp, FakeTokenEndpoint, json, status } from './fake-http.js';

export const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
/** Where `/content` redirects: a different origin, as SharePoint/OneDrive storage is. */
export const GRAPH_DOWNLOAD_ORIGIN = 'https://contoso-my.sharepoint.test';

export interface FakeGraphItem {
  id: string;
  driveId: string;
  name: string;
  parentId?: string;
  folder?: boolean;
  root?: boolean;
  /** OneNote notebook. */
  package?: boolean;
  /** "Add to My files" shortcut to another drive's item. */
  remote?: boolean;
  mimeType?: string;
  content?: Uint8Array;
  /** Reported size for a file whose bytes are not modeled. */
  reportedSize?: number;
  deleted: boolean;
  created: string;
  modified: string;
}

export interface FakeGraphDriveInfo {
  id: string;
  name: string;
  driveType: 'personal' | 'business' | 'documentLibrary';
  rootId: string;
  webUrl: string;
}

interface FakeSite {
  id: string;
  host: string;
  path: string;
  drives: string[];
  defaultDrive: string;
}

interface ChangeEntry {
  seq: number;
  itemId: string;
}

function graphError(
  code: number,
  errCode: string,
  message: string,
  headers?: Record<string, string>,
) {
  return status(code, { error: { code: errCode, message } }, headers);
}

export class FakeGraphDrive {
  readonly http: FakeHttp;
  readonly tokens: FakeTokenEndpoint[] = [];
  readonly drives = new Map<string, FakeGraphDriveInfo>();
  readonly items = new Map<string, FakeGraphItem>();
  readonly sites: FakeSite[] = [];
  /** Download requests that arrived carrying an Authorization header. */
  readonly authLeaks: string[] = [];
  /** Download requests served. */
  downloads = 0;
  revoked = false;
  meDrive = '';
  private changes: ChangeEntry[] = [];
  private seq = 0;
  private epoch = 1;
  private nextId = 1;
  private nextTempAuth = 1;
  private clock = Date.parse('2026-10-01T09:00:00Z');

  constructor(http = new FakeHttp()) {
    this.http = http;
    for (const tenant of ['common', 'organizations']) {
      this.tokens.push(
        new FakeTokenEndpoint(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          rotateRefreshToken: true,
        }).install(http),
      );
    }
    this.install();
  }

  /** A credential blob for `tenant` (seed it with `env.storeCredential`). */
  credential(tenant: 'common' | 'organizations'): Record<string, string> {
    const endpoint = this.tokens[tenant === 'common' ? 0 : 1]!;
    return {
      accessToken: 'seed-access',
      refreshToken: endpoint.issueRefreshToken(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-id',
      tenant,
      tokenUrl: endpoint.url,
    };
  }

  // ── Setup ──────────────────────────────────────────────────────────────

  addDrive(
    name: string,
    driveType: FakeGraphDriveInfo['driveType'],
    webUrl: string,
  ): FakeGraphDriveInfo {
    const id = `b!${name.replace(/\W+/g, '')}Drv${this.nextId++}`;
    const rootId = this.newId();
    const t = this.now();
    this.items.set(rootId, {
      id: rootId,
      driveId: id,
      name: 'root',
      root: true,
      folder: true,
      deleted: false,
      created: t,
      modified: t,
    });
    const drive = { id, name, driveType, rootId, webUrl };
    this.drives.set(id, drive);
    return drive;
  }

  addSite(host: string, path: string, drives: FakeGraphDriveInfo[]): FakeSite {
    const site = {
      id: `${host},${this.guid()},${this.guid()}`,
      host,
      path,
      drives: drives.map((d) => d.id),
      defaultDrive: drives[0]!.id,
    };
    this.sites.push(site);
    return site;
  }

  // ── Mutations (each one lands in the delta feed) ────────────────────────

  addFolder(name: string, parentId: string): string {
    return this.create({ name, parentId, folder: true });
  }

  addFile(
    name: string,
    parentId: string,
    opts: {
      mimeType?: string;
      content?: string | Uint8Array;
      reportedSize?: number;
      package?: boolean;
      remote?: boolean;
    } = {},
  ): string {
    const content =
      typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : opts.content;
    return this.create({
      name,
      parentId,
      ...(opts.package ? { package: true } : { mimeType: opts.mimeType ?? 'text/plain' }),
      ...(content ? { content } : {}),
      ...(opts.reportedSize !== undefined ? { reportedSize: opts.reportedSize } : {}),
      ...(opts.remote ? { remote: true } : {}),
    });
  }

  setContent(id: string, content: string | Uint8Array): void {
    const item = this.mustGet(id);
    item.content = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    item.modified = this.now();
    this.record(id);
  }

  rename(id: string, name: string): void {
    this.mustGet(id).name = name;
    this.record(id);
  }

  move(id: string, parentId: string): void {
    this.mustGet(id).parentId = parentId;
    this.record(id);
  }

  /**
   * Delete to the recycle bin. Business drives report every deleted
   * descendant; pass `reportDescendants: false` for consumer OneDrive, which
   * reports only the deleted item.
   */
  delete(id: string, opts: { reportDescendants?: boolean } = {}): void {
    const all = this.subtree(id);
    for (const d of all) this.items.get(d)!.deleted = true;
    for (const d of opts.reportDescendants === false ? [id] : all) this.record(d);
  }

  expireTokens(): void {
    this.epoch++;
  }

  revokeAll(): void {
    this.revoked = true;
    for (const t of this.tokens) t.rejectRefresh = true;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private newId(): string {
    return `01ITEM${String(this.nextId++).padStart(6, '0')}`;
  }

  private guid(): string {
    const n = String(this.nextId++).padStart(12, '0');
    return `00000000-0000-4000-8000-${n}`;
  }

  private now(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private create(f: Partial<FakeGraphItem> & { name: string; parentId: string }): string {
    const parent = this.mustGet(f.parentId);
    const id = this.newId();
    const t = this.now();
    this.items.set(id, {
      ...f,
      id,
      driveId: parent.driveId,
      deleted: false,
      created: t,
      modified: t,
    });
    this.record(id);
    return id;
  }

  private mustGet(id: string): FakeGraphItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`fake graph has no item ${id}`);
    return item;
  }

  private subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const item of this.items.values()) {
        if (item.parentId === out[i] && !item.deleted) out.push(item.id);
      }
    }
    return out;
  }

  private record(itemId: string): void {
    this.seq++;
    this.changes = this.changes.filter((c) => c.itemId !== itemId);
    this.changes.push({ seq: this.seq, itemId });
  }

  private pathOf(item: FakeGraphItem): string {
    const names: string[] = [];
    let at = item.parentId ? this.items.get(item.parentId) : undefined;
    while (at && !at.root) {
      names.unshift(encodeURIComponent(at.name));
      at = at.parentId ? this.items.get(at.parentId) : undefined;
    }
    return `/drive/root:${names.length ? `/${names.join('/')}` : ''}`;
  }

  private resource(item: FakeGraphItem, opts: { delta: boolean }): Record<string, unknown> {
    const drive = this.drives.get(item.driveId)!;
    if (item.deleted && opts.delta) {
      return {
        id: item.id,
        deleted: { state: 'deleted' },
        parentReference: { driveId: item.driveId, driveType: drive.driveType, id: item.parentId },
      };
    }
    const size = item.reportedSize ?? item.content?.byteLength ?? 0;
    return {
      id: item.id,
      name: item.name,
      size,
      createdDateTime: item.created,
      lastModifiedDateTime: item.modified,
      lastModifiedBy: { user: { displayName: 'Grace Hopper', email: 'grace@contoso.test' } },
      webUrl: `${drive.webUrl}/${encodeURIComponent(item.name)}`,
      eTag: `"{${item.id}},${this.seq}"`,
      ...(item.root ? { root: {} } : {}),
      ...(item.folder ? { folder: { childCount: this.childrenOf(item.id).length } } : {}),
      ...(item.package ? { package: { type: 'oneNote' } } : {}),
      ...(item.remote
        ? { remoteItem: { id: 'REMOTE!1', parentReference: { driveId: 'other' } } }
        : {}),
      ...(!item.folder && !item.root && !item.package
        ? { file: { mimeType: item.mimeType ?? 'application/octet-stream', hashes: {} } }
        : {}),
      ...(item.parentId
        ? {
            parentReference: {
              driveId: item.driveId,
              driveType: drive.driveType,
              id: item.parentId,
              ...(opts.delta ? {} : { path: this.pathOf(item) }),
            },
          }
        : {}),
    };
  }

  private childrenOf(id: string): FakeGraphItem[] {
    return [...this.items.values()].filter((i) => i.parentId === id && !i.deleted);
  }

  private select(body: Record<string, unknown>, select: string | null): Record<string, unknown> {
    if (!select) return body;
    const keep = new Set(select.split(',').map((s) => s.trim()));
    return Object.fromEntries(Object.entries(body).filter(([k]) => keep.has(k)));
  }

  /**
   * Any bearer token passes until the grant is revoked, so this fake also
   * serves credentials minted by the simulated world's shared token endpoint.
   */
  private authorized(bearer: string | undefined): boolean {
    return !this.revoked && !!bearer;
  }

  private unauthorized() {
    return graphError(
      401,
      'InvalidAuthenticationToken',
      'Access token has expired or is not yet valid.',
    );
  }

  private deltaLink(driveId: string, token: string, top: number, select: string | null): string {
    const q = [
      `token=${encodeURIComponent(token)}`,
      `$top=${top}`,
      ...(select ? [`$select=${select}`] : []),
    ];
    return `${GRAPH_V1}/drives/${encodeURIComponent(driveId)}/root/delta?${q.join('&')}`;
  }

  private delta(driveId: string, url: URL): Response {
    const drive = this.drives.get(driveId)!;
    const p = url.searchParams;
    const select = p.get('$select');
    const top = Math.min(999, Number(p.get('$top') ?? 200) || 200);
    const token = p.get('token');
    const out = (items: FakeGraphItem[]) =>
      items.map((i) => this.select(this.resource(i, { delta: true }), select));
    if (token === 'latest') {
      return json({
        value: [],
        '@odata.deltaLink': this.deltaLink(driveId, `${this.epoch}.${this.seq}`, top, select),
      });
    }
    if (token === null) {
      const all = this.subtree(drive.rootId).map((id) => this.items.get(id)!);
      return json({
        value: out(all),
        '@odata.deltaLink': this.deltaLink(driveId, `${this.epoch}.${this.seq}`, top, select),
      });
    }
    const m = /^(\d+)\.(\d+)$/.exec(token);
    if (!m || Number(m[1]) !== this.epoch) {
      return graphError(
        410,
        'resyncRequired',
        "Resync required. Replace any local items with the server's version (including deletes) if you're sure that the service was up to date with your local changes when you last sync'd.",
        { Location: `${GRAPH_V1}/drives/${encodeURIComponent(driveId)}/root/delta` },
      );
    }
    const after = Number(m[2]);
    const pending = this.changes.filter(
      (c) => c.seq > after && this.items.get(c.itemId)?.driveId === driveId,
    );
    const page = pending.slice(0, top);
    const value: FakeGraphItem[] = [];
    const seen = new Set<string>();
    for (const c of page) {
      const item = this.items.get(c.itemId)!;
      const ancestors: FakeGraphItem[] = [];
      let at = item.parentId ? this.items.get(item.parentId) : undefined;
      while (at) {
        ancestors.unshift(at);
        at = at.parentId ? this.items.get(at.parentId) : undefined;
      }
      for (const a of [...ancestors, item]) {
        if (a.deleted && a !== item) continue;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        value.push(a);
      }
    }
    const last = page[page.length - 1]?.seq ?? after;
    const more = pending.length > page.length;
    return json({
      value: out(value),
      ...(more
        ? { '@odata.nextLink': this.deltaLink(driveId, `${this.epoch}.${last}`, top, select) }
        : {
            '@odata.deltaLink': this.deltaLink(driveId, `${this.epoch}.${this.seq}`, top, select),
          }),
    });
  }

  private itemByPath(drive: FakeGraphDriveInfo, path: string): FakeGraphItem | undefined {
    let at = this.items.get(drive.rootId);
    for (const name of path.split('/').filter(Boolean)) {
      at = this.childrenOf(at!.id).find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!at) return undefined;
    }
    return at;
  }

  private driveRoute(driveId: string, rest: string, url: URL): Response {
    const drive = this.drives.get(driveId);
    if (!drive) return graphError(404, 'itemNotFound', 'The drive could not be found.');
    const select = url.searchParams.get('$select');
    const missing = () => graphError(404, 'itemNotFound', 'The resource could not be found.');
    if (rest === 'root/delta') return this.delta(driveId, url);
    if (rest === 'root')
      return json(
        this.select(this.resource(this.items.get(drive.rootId)!, { delta: false }), select),
      );
    if (rest.startsWith('root:/')) {
      const item = this.itemByPath(drive, rest.slice('root:/'.length).replace(/:$/, ''));
      return item ? json(this.select(this.resource(item, { delta: false }), select)) : missing();
    }
    const m = /^items\/([^/]+)(?:\/(children|content))?$/.exec(rest);
    if (!m) return graphError(400, 'invalidRequest', `Unsupported segment: ${rest}`);
    const item = this.items.get(m[1]!);
    if (!item || item.deleted || item.driveId !== driveId) return missing();
    if (m[2] === 'content') {
      if (item.folder || item.package) return missing();
      return new Response(null, {
        status: 302,
        headers: {
          location: `${GRAPH_DOWNLOAD_ORIGIN}/dl/${item.id}?tempauth=t${this.nextTempAuth++}`,
        },
      });
    }
    if (m[2] === 'children') {
      const top = Math.min(999, Number(url.searchParams.get('$top') ?? 200) || 200);
      const offset = Number(url.searchParams.get('$skiptoken') ?? 0) || 0;
      const kids = this.childrenOf(item.id);
      const page = kids.slice(offset, offset + top);
      const next =
        offset + top < kids.length
          ? `${GRAPH_V1}/drives/${encodeURIComponent(driveId)}/items/${item.id}/children?$top=${top}${select ? `&$select=${select}` : ''}&$skiptoken=${offset + top}`
          : undefined;
      return json({
        value: page.map((k) => this.select(this.resource(k, { delta: false }), select)),
        ...(next ? { '@odata.nextLink': next } : {}),
      });
    }
    return json(this.select(this.resource(item, { delta: false }), select));
  }

  private install(): void {
    this.http.on('GET', `${GRAPH_V1}/me/drive`, (req) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      const drive = this.drives.get(this.meDrive);
      if (!drive) return graphError(404, 'itemNotFound', 'The user has no drive.');
      return json(
        this.select(
          { id: drive.id, driveType: drive.driveType, name: drive.name, webUrl: drive.webUrl },
          req.url.searchParams.get('$select'),
        ),
      );
    });

    this.http.on('GET', `${GRAPH_V1}/drives/:drive/*`, (req, params) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      return this.driveRoute(params.drive!, params['*']!, req.url);
    });

    this.http.on('GET', `${GRAPH_V1}/sites/*`, (req, params) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      const rest = params['*']!;
      const select = req.url.searchParams.get('$select');
      const colon = rest.indexOf(':');
      if (colon > 0) {
        const host = rest.slice(0, colon).toLowerCase();
        const path = rest.slice(colon + 1).replace(/:$/, '');
        const site = this.sites.find(
          (s) => s.host === host && s.path.toLowerCase() === path.toLowerCase(),
        );
        if (!site) return graphError(404, 'itemNotFound', 'Requested site could not be found');
        return json(
          this.select({ id: site.id, webUrl: `https://${site.host}${site.path}` }, select),
        );
      }
      const [siteId, sub] = rest.split('/');
      const site = this.sites.find((s) => s.id === siteId || (s.host === siteId && s.path === ''));
      if (!site) return graphError(404, 'itemNotFound', 'Requested site could not be found');
      if (sub === undefined) return json(this.select({ id: site.id }, select));
      if (sub === 'drive') {
        const d = this.drives.get(site.defaultDrive)!;
        return json(this.select({ id: d.id, name: d.name, webUrl: d.webUrl }, select));
      }
      if (sub === 'drives') {
        return json({
          value: site.drives.map((id) => {
            const d = this.drives.get(id)!;
            return this.select(
              { id: d.id, name: d.name, webUrl: d.webUrl, driveType: d.driveType },
              select,
            );
          }),
        });
      }
      return graphError(400, 'invalidRequest', `Unsupported segment: ${sub}`);
    });

    this.http.on('GET', `${GRAPH_DOWNLOAD_ORIGIN}/dl/:id`, (req, params) => {
      if (req.headers.has('authorization')) {
        this.authLeaks.push(`${req.method} ${req.url.origin}${req.url.pathname}`);
        return status(400, {
          error: 'an Authorization header must not be sent to a pre-authenticated URL',
        });
      }
      if (!/^t\d+$/.test(req.url.searchParams.get('tempauth') ?? '')) return status(401);
      const item = this.items.get(params.id!);
      if (!item || item.deleted) return status(404);
      this.downloads++;
      const body = item.content ?? new Uint8Array();
      return new Response(Buffer.from(body), {
        status: 200,
        headers: {
          'content-type': item.mimeType ?? 'application/octet-stream',
          'content-length': String(body.byteLength),
        },
      });
    });
  }
}
