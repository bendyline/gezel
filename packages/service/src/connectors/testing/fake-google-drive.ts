/**
 * A stateful Google Drive v3 fake for the `files-google-drive` connector.
 *
 * Models the parts of the real API the connector leans on, with the real
 * shapes: `files.get` (with the `root` alias, `alt=media`, and field masks),
 * `files.list` over `'<id>' in parents [and trashed = false]` with
 * `nextPageToken` paging, `files.export` (Docs/Sheets/Slides formats from the
 * Drive export table, Google's 10 MB export refusal), and the account change
 * feed: `changes.getStartPageToken`, then `changes.list` pages that carry
 * `nextPageToken` while more remain and `newStartPageToken` only on the last
 * page. The feed keeps the latest change per file, as Drive does, so editing
 * a file twice moves its one entry to the end.
 *
 * Field masks are applied the way Drive applies them: a field the adapter did
 * not ask for is not in the response. That keeps the adapter honest about its
 * own `fields` parameter.
 *
 * Tokens are opaque `<epoch>.<seq>` strings; `expireTokens()` bumps the epoch
 * so every token issued before it answers 400 Invalid Value (`pageToken`),
 * which is how Drive refuses a token it no longer recognizes.
 */

import { FakeHttp, FakeTokenEndpoint, json, status } from './fake-http.js';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_FOLDER = 'application/vnd.google-apps.folder';
export const DRIVE_DOC = 'application/vnd.google-apps.document';
export const DRIVE_SHEET = 'application/vnd.google-apps.spreadsheet';
export const DRIVE_SLIDES = 'application/vnd.google-apps.presentation';
export const DRIVE_FORM = 'application/vnd.google-apps.form';
export const DRIVE_SHORTCUT = 'application/vnd.google-apps.shortcut';

/** Export formats Drive supports per Workspace type (developers.google.com export table). */
const EXPORTABLE: Record<string, string[]> = {
  [DRIVE_DOC]: ['text/markdown', 'text/plain', 'text/html', 'application/pdf'],
  [DRIVE_SHEET]: ['text/csv', 'text/tab-separated-values', 'application/pdf'],
  [DRIVE_SLIDES]: ['text/plain', 'application/pdf'],
};

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  /** Bytes for a blob file. */
  content?: Uint8Array;
  /** Export bodies for a Workspace file, by MIME type. */
  exports?: Record<string, string>;
  /** Reported size for a blob whose bytes are not modeled (huge files). */
  reportedSize?: number;
  createdTime: string;
  modifiedTime: string;
  driveId?: string;
  /** The owner turned off download/export for viewers. */
  downloadRestricted?: boolean;
  /** Export answers Google's exportSizeLimitExceeded. */
  exportTooLarge?: boolean;
}

interface ChangeEntry {
  seq: number;
  fileId: string;
  removed: boolean;
}

type FieldTree = Map<string, FieldTree | true>;

/** Parse a Drive field mask: `nextPageToken,files(id,owners(displayName))`. */
export function parseFieldMask(mask: string): FieldTree {
  const tree: FieldTree = new Map();
  let i = 0;
  const parseList = (into: FieldTree): void => {
    while (i < mask.length) {
      let name = '';
      while (i < mask.length && !',()'.includes(mask[i]!)) name += mask[i++];
      name = name.trim();
      if (mask[i] === '(') {
        i++;
        const sub: FieldTree = new Map();
        parseList(sub);
        if (name) into.set(name, sub);
      } else if (name) into.set(name, true);
      if (mask[i] === ',') {
        i++;
        continue;
      }
      if (mask[i] === ')') {
        i++;
        return;
      }
    }
  };
  parseList(tree);
  return tree;
}

function applyMask(value: unknown, tree: FieldTree | true): unknown {
  if (tree === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => applyMask(v, tree));
  const out: Record<string, unknown> = {};
  for (const [key, sub] of tree) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = applyMask(v, sub);
  }
  return out;
}

function googleError(code: number, reason: string, message: string, location?: string) {
  return status(code, {
    error: {
      code,
      message,
      errors: [
        {
          domain: code === 403 && /rate/i.test(reason) ? 'usageLimits' : 'global',
          reason,
          message,
          ...(location ? { location, locationType: 'parameter' } : {}),
        },
      ],
    },
  });
}

export class FakeGoogleDrive {
  readonly http: FakeHttp;
  readonly tokens: FakeTokenEndpoint;
  readonly files = new Map<string, FakeDriveFile>();
  readonly rootId = '0AMyDriveRootFolder';
  /** Set by `revokeAll()`: every bearer token is refused. */
  revoked = false;
  private changes: ChangeEntry[] = [];
  private seq = 0;
  private epoch = 1;
  private nextId = 1;
  private clock = Date.parse('2026-10-01T09:00:00Z');

  constructor(http = new FakeHttp()) {
    this.http = http;
    this.tokens = new FakeTokenEndpoint('https://oauth2.googleapis.com/token').install(http);
    const t = this.now();
    this.files.set(this.rootId, {
      id: this.rootId,
      name: 'My Drive',
      mimeType: DRIVE_FOLDER,
      parents: [],
      trashed: false,
      createdTime: t,
      modifiedTime: t,
    });
    this.install();
  }

  /** A credential blob the adapter will accept (seed it with `env.storeCredential`). */
  credential(): Record<string, string> {
    return {
      accessToken: 'seed-access',
      refreshToken: this.tokens.issueRefreshToken(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    };
  }

  // ── Mutations (each one lands in the change feed) ──────────────────────

  addFolder(name: string, parentId = this.rootId, opts: { driveId?: string } = {}): string {
    return this.create({ name, mimeType: DRIVE_FOLDER, parents: [parentId], ...opts });
  }

  addFile(
    name: string,
    parentId: string,
    opts: {
      mimeType?: string;
      content?: string | Uint8Array;
      exports?: Record<string, string>;
      reportedSize?: number;
      downloadRestricted?: boolean;
      exportTooLarge?: boolean;
    } = {},
  ): string {
    const content =
      typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : opts.content;
    return this.create({
      name,
      mimeType: opts.mimeType ?? 'text/plain',
      parents: [parentId],
      ...(content ? { content } : {}),
      ...(opts.exports ? { exports: opts.exports } : {}),
      ...(opts.reportedSize !== undefined ? { reportedSize: opts.reportedSize } : {}),
      ...(opts.downloadRestricted ? { downloadRestricted: true } : {}),
      ...(opts.exportTooLarge ? { exportTooLarge: true } : {}),
      ...(this.files.get(parentId)?.driveId ? { driveId: this.files.get(parentId)!.driveId } : {}),
    });
  }

  setContent(id: string, content: string | Uint8Array): void {
    const f = this.mustGet(id);
    f.content = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    f.modifiedTime = this.now();
    this.record(id);
  }

  setExport(id: string, mime: string, body: string): void {
    const f = this.mustGet(id);
    f.exports = { ...(f.exports ?? {}), [mime]: body };
    f.modifiedTime = this.now();
    this.record(id);
  }

  rename(id: string, name: string): void {
    this.mustGet(id).name = name;
    this.record(id);
  }

  move(id: string, parentId: string): void {
    this.mustGet(id).parents = [parentId];
    this.record(id);
  }

  /** A metadata-only change (starred, viewed, shared): content untouched. */
  touch(id: string): void {
    this.mustGet(id);
    this.record(id);
  }

  /**
   * Move to the trash. Only the item itself gets a change entry; its
   * descendants become trashed implicitly, as in Drive.
   */
  trash(id: string): void {
    for (const d of this.subtree(id)) this.files.get(d)!.trashed = true;
    this.record(id);
  }

  /** Permanent delete: every file in the subtree is removed and reported. */
  deleteForever(id: string): void {
    for (const d of this.subtree(id)) {
      this.files.delete(d);
      this.record(d, true);
    }
  }

  /** Invalidate every page token issued so far. */
  expireTokens(): void {
    this.epoch++;
  }

  /** Refuse every access token and every refresh from now on. */
  revokeAll(): void {
    this.revoked = true;
    this.tokens.rejectRefresh = true;
  }

  get(id: string): FakeDriveFile | undefined {
    return this.files.get(id);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private now(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private create(
    f: Omit<FakeDriveFile, 'id' | 'trashed' | 'createdTime' | 'modifiedTime'>,
  ): string {
    const id = `1Drv${String(this.nextId++).padStart(6, '0')}x`;
    const t = this.now();
    this.files.set(id, { ...f, id, trashed: false, createdTime: t, modifiedTime: t });
    this.record(id);
    return id;
  }

  private mustGet(id: string): FakeDriveFile {
    const f = this.files.get(id);
    if (!f) throw new Error(`fake drive has no file ${id}`);
    return f;
  }

  private subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const f of this.files.values()) {
        if (f.parents[0] === out[i]) out.push(f.id);
      }
    }
    return out.filter((x) => this.files.has(x));
  }

  private record(fileId: string, removed = false): void {
    this.seq++;
    this.changes = this.changes.filter((c) => c.fileId !== fileId);
    this.changes.push({ seq: this.seq, fileId, removed });
  }

  private resource(f: FakeDriveFile): Record<string, unknown> {
    const blob = !f.mimeType.startsWith('application/vnd.google-apps.');
    const size = f.reportedSize ?? f.content?.byteLength;
    return {
      kind: 'drive#file',
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      ...(f.parents.length ? { parents: f.parents } : {}),
      trashed: f.trashed,
      ...(blob && size !== undefined ? { size: String(size) } : {}),
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      webViewLink:
        f.mimeType === DRIVE_FOLDER
          ? `https://drive.google.com/drive/folders/${f.id}`
          : `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
      ...(f.driveId ? { driveId: f.driveId } : {}),
      lastModifyingUser: {
        kind: 'drive#user',
        displayName: 'Ada Lovelace',
        emailAddress: 'ada@example.com',
      },
      ...(f.driveId
        ? {}
        : {
            owners: [
              { kind: 'drive#user', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
            ],
          }),
    };
  }

  private parseToken(raw: string | null): number | undefined {
    const m = /^(\d+)\.(\d+)$/.exec(raw ?? '');
    if (!m || Number(m[1]) !== this.epoch) return undefined;
    return Number(m[2]);
  }

  private token(seq: number): string {
    return `${this.epoch}.${seq}`;
  }

  /**
   * Any bearer token passes until the grant is revoked, so this fake also
   * serves credentials minted by the simulated world's shared token endpoint.
   */
  private authorized(bearer: string | undefined): boolean {
    return !this.revoked && !!bearer;
  }

  private unauthorized() {
    return status(401, {
      error: {
        code: 401,
        message: 'Request had invalid authentication credentials.',
        errors: [
          {
            domain: 'global',
            reason: 'authError',
            message: 'Invalid Credentials',
            location: 'Authorization',
            locationType: 'header',
          },
        ],
        status: 'UNAUTHENTICATED',
      },
    });
  }

  private notFound(id: string) {
    return googleError(404, 'notFound', `File not found: ${id}.`, 'fileId');
  }

  private install(): void {
    const masked = (body: Record<string, unknown>, fields: string | null, fallback: string) =>
      json(applyMask(body, parseFieldMask(fields ?? fallback)));

    this.http.on('GET', `${DRIVE_API}/changes/startPageToken`, (req) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      return json({ kind: 'drive#startPageToken', startPageToken: this.token(this.seq + 1) });
    });

    this.http.on('GET', `${DRIVE_API}/changes`, (req) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      const p = req.url.searchParams;
      const from = this.parseToken(p.get('pageToken'));
      if (from === undefined) return googleError(400, 'invalid', 'Invalid Value', 'pageToken');
      const size = Math.min(1000, Number(p.get('pageSize') ?? 100) || 100);
      const driveId = p.get('driveId');
      const pending = this.changes
        .filter((c) => c.seq >= from)
        .filter((c) => {
          if (!driveId) return true;
          const f = this.files.get(c.fileId);
          return !f || f.driveId === driveId;
        });
      const page = pending.slice(0, size);
      const more = pending.length > page.length;
      const body: Record<string, unknown> = {
        kind: 'drive#changeList',
        changes: page.map((c) => {
          const f = this.files.get(c.fileId);
          return {
            kind: 'drive#change',
            changeType: 'file',
            fileId: c.fileId,
            removed: c.removed || !f,
            time: new Date(this.clock).toISOString(),
            ...(f && !c.removed ? { file: this.resource(f) } : {}),
          };
        }),
        ...(more
          ? { nextPageToken: this.token(pending[page.length]!.seq) }
          : { newStartPageToken: this.token(this.seq + 1) }),
      };
      return masked(
        body,
        p.get('fields'),
        'kind,nextPageToken,newStartPageToken,changes(kind,changeType,removed,fileId,time,file(kind,id,name,mimeType))',
      );
    });

    this.http.on('GET', `${DRIVE_API}/files`, (req) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      const p = req.url.searchParams;
      const m = /^'([A-Za-z0-9_-]+)' in parents( and trashed ?= ?false)?$/.exec(p.get('q') ?? '');
      if (!m) return googleError(400, 'invalid', 'Invalid Value', 'q');
      const parent = m[1]!;
      const live = !!m[2];
      const children = [...this.files.values()].filter(
        (f) => f.parents[0] === parent && (!live || !f.trashed),
      );
      const size = Math.min(1000, Number(p.get('pageSize') ?? 100) || 100);
      const offset = Number(p.get('pageToken') ?? 0) || 0;
      const page = children.slice(offset, offset + size);
      const body = {
        kind: 'drive#fileList',
        incompleteSearch: false,
        files: page.map((f) => this.resource(f)),
        ...(offset + size < children.length ? { nextPageToken: String(offset + size) } : {}),
      };
      return masked(
        body,
        p.get('fields'),
        'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)',
      );
    });

    this.http.on('GET', `${DRIVE_API}/files/:id`, (req, params) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      const id = params.id === 'root' ? this.rootId : params.id!;
      const f = this.files.get(id);
      if (!f) return this.notFound(params.id!);
      if (req.url.searchParams.get('alt') === 'media') {
        if (f.mimeType.startsWith('application/vnd.google-apps.')) {
          return googleError(
            403,
            'fileNotDownloadable',
            'Only files with binary content can be downloaded. Use Export with Docs Editors files.',
          );
        }
        if (f.downloadRestricted) {
          return googleError(
            403,
            'cannotDownloadFile',
            'The user does not have sufficient permissions for this file.',
          );
        }
        const body = f.content ?? new Uint8Array();
        return new Response(Buffer.from(body), {
          status: 200,
          headers: { 'content-type': f.mimeType, 'content-length': String(body.byteLength) },
        });
      }
      return masked(this.resource(f), req.url.searchParams.get('fields'), 'kind,id,name,mimeType');
    });

    this.http.on('GET', `${DRIVE_API}/files/:id/export`, (req, params) => {
      if (!this.authorized(req.bearer)) return this.unauthorized();
      const f = this.files.get(params.id!);
      if (!f) return this.notFound(params.id!);
      const mime = req.url.searchParams.get('mimeType') ?? '';
      const formats = EXPORTABLE[f.mimeType];
      if (!formats)
        return googleError(403, 'fileNotExportable', 'Export only supports Docs Editors files.');
      if (!formats.includes(mime)) {
        return googleError(
          400,
          'badRequest',
          'The requested conversion is not supported.',
          'convertTo',
        );
      }
      if (f.exportTooLarge) {
        return googleError(
          403,
          'exportSizeLimitExceeded',
          'This file is too large to be exported.',
        );
      }
      if (f.downloadRestricted) {
        return googleError(403, 'cannotExportFile', 'This file cannot be exported by the user.');
      }
      return new Response(f.exports?.[mime] ?? '', {
        status: 200,
        headers: { 'content-type': mime },
      });
    });
  }
}
