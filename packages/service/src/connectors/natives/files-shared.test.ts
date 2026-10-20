import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpStatusError } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHttp, FakeTokenEndpoint, bytes, status } from '../testing/fake-http.js';
import { type ConnectorTestEnv, createConnectorTestEnv } from '../testing/harness.js';
import { RecordGoneError } from '../types.js';
import {
  type CloudFile,
  type ContentIo,
  CursorExpiredError,
  type FilesPolicy,
  MAX_TRACKED_FOLDERS,
  StagingDir,
  type TreeCursor,
  type TreeEvent,
  type TreeItem,
  type TreeRefRaw,
  type TreeSource,
  buildFileRecord,
  delimitedToMarkdown,
  fenceBlock,
  folderDirSegments,
  openDownload,
  parseDelimited,
  parseFilesPolicy,
  planContent,
  readBounded,
  resolveFileContent,
  streamToFile,
  stripDataImages,
  syncTree,
  textHint,
} from './files-shared.js';
import { GOOGLE_OAUTH, OAuthSession, ReconnectRequiredError } from './oauth-session.js';

const POLICY: FilesPolicy = {
  maxFileBytes: 25 * 1024 * 1024,
  maxInlineBytes: 512 * 1024,
  maxFiles: 2000,
};

function file(over: Partial<CloudFile> = {}): CloudFile {
  return {
    provider: 'google-drive',
    id: 'f1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 10,
    modified: '2026-10-01T10:00:00.000Z',
    created: '2026-09-01T10:00:00.000Z',
    modifiedBy: 'Ada Lovelace',
    owner: 'Ada Lovelace',
    url: 'https://drive.google.com/file/d/f1/view',
    folders: ['Reports', '2026'],
    ...over,
  };
}

let env: ConnectorTestEnv | null = null;
const stagings: StagingDir[] = [];
afterEach(async () => {
  for (const s of stagings.splice(0)) await s.dispose();
  await env?.dispose();
  env = null;
});

function staging(): StagingDir {
  const s = new StagingDir('gezel-files-test-');
  stagings.push(s);
  return s;
}

/** A ContentIo whose download/export answer from canned responses. */
function io(
  over: Partial<ContentIo> & { exports?: Record<string, () => Response> } = {},
): ContentIo {
  const dir = staging();
  return {
    download: over.download ?? (async () => bytes('hello')),
    exportAs: async (mime) => {
      const make = over.exports?.[mime];
      if (!make)
        throw new HttpStatusError(400, `export 400: conversion to ${mime} is not supported`);
      return make();
    },
    stagingDir: () => dir.get(),
    isThrottle: over.isThrottle ?? ((err) => err instanceof HttpStatusError && err.status === 429),
  };
}

/** A body that streams `total` bytes in chunks and declares no length. */
function streamingBody(total: number, chunk = 64 * 1024): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(65));
    },
  });
  return new Response(stream, { status: 200 });
}

describe('parseFilesPolicy', () => {
  it('defaults to 25 MB / 2000 files and validates bounds', () => {
    expect(parseFilesPolicy(undefined)).toEqual({
      maxFileBytes: 25 * 1024 * 1024,
      maxInlineBytes: 512 * 1024,
      maxFiles: 2000,
    });
    expect(parseFilesPolicy({ maxFileMB: 0, maxFiles: '10' }).maxFileBytes).toBe(0);
    expect(parseFilesPolicy({ maxFiles: '10' }).maxFiles).toBe(10);
    expect(() => parseFilesPolicy({ maxFileMB: -1 })).toThrow(/Largest file/);
    expect(() => parseFilesPolicy({ maxFiles: 0 })).toThrow(/Most files/);
  });
});

describe('content policy', () => {
  it('exports Google Docs as Markdown with a plain-text fallback', () => {
    const plan = planContent(
      file({ native: 'document', mimeType: 'application/vnd.google-apps.document' }),
      POLICY,
    );
    expect(plan).toEqual({
      kind: 'export',
      formats: [
        { mime: 'text/markdown', render: 'markdown', extension: '.md' },
        { mime: 'text/plain', render: 'prose', extension: '.txt' },
      ],
    });
  });

  it('exports Sheets as CSV of the first sheet and Slides as plain text', () => {
    const sheet = planContent(file({ native: 'spreadsheet' }), POLICY);
    expect(sheet).toMatchObject({
      kind: 'export',
      formats: [{ mime: 'text/csv', render: 'table' }],
    });
    expect(sheet.kind === 'export' && sheet.note).toMatch(/first sheet/);
    expect(planContent(file({ native: 'presentation' }), POLICY)).toMatchObject({
      kind: 'export',
      formats: [{ mime: 'text/plain', render: 'prose' }],
    });
    expect(planContent(file({ native: 'other' }), POLICY).kind).toBe('metadata-only');
  });

  it('inlines small text, attaches binaries and long text, and keeps only details past the cap', () => {
    expect(
      planContent(file({ name: 'a.py', mimeType: 'application/octet-stream' }), POLICY),
    ).toEqual({
      kind: 'download',
      text: { render: 'code', lang: 'python' },
    });
    expect(
      planContent(file({ name: 'r.pdf', mimeType: 'application/pdf', size: 2_000_000 }), POLICY),
    ).toEqual({
      kind: 'download',
    });
    expect(planContent(file({ size: 600 * 1024 }), POLICY)).toEqual({ kind: 'download' });
    const huge = planContent(
      file({ name: 'v.mov', mimeType: 'video/quicktime', size: 30 * 1024 * 1024 }),
      POLICY,
    );
    expect(huge.kind).toBe('metadata-only');
    expect(huge.kind === 'metadata-only' && huge.reason).toMatch(/30 MB.*25 MB download limit/);
    const off = planContent(file(), { ...POLICY, maxFileBytes: 0 });
    expect(off.kind === 'metadata-only' && off.reason).toMatch(/turned off/);
  });

  it('lets the extension win over the MIME type', () => {
    expect(textHint('README.md', 'text/plain')).toEqual({ render: 'markdown' });
    expect(textHint('rows.tsv', 'application/octet-stream')).toEqual({
      render: 'table',
      delimiter: '\t',
    });
    expect(textHint('Dockerfile', 'application/octet-stream')).toEqual({
      render: 'code',
      lang: 'dockerfile',
    });
    expect(textHint('x.bin', 'application/json')).toEqual({ render: 'code', lang: 'json' });
    expect(textHint('logo.svg', 'image/svg+xml')).toBeUndefined();
    expect(textHint('photo.jpg', 'image/jpeg')).toBeUndefined();
  });
});

describe('rendering', () => {
  it('parses RFC 4180 CSV: quotes, doubled quotes, embedded newlines, CRLF', () => {
    expect(parseDelimited('a,"b,c","say ""hi"""\r\n1,"two\nlines",3\n')).toEqual([
      ['a', 'b,c', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ]);
    expect(parseDelimited('')).toEqual([]);
  });

  it('renders a table with escaped pipes and states truncation', () => {
    const csv = ['name,note', 'a|b,"x\ny"', ...Array.from({ length: 5 }, (_, i) => `r${i},v`)].join(
      '\n',
    );
    const { markdown, note } = delimitedToMarkdown(csv, ',', 3);
    expect(markdown.split('\n')).toEqual([
      '| name | note |',
      '| --- | --- |',
      '| a\\|b | x y |',
      '| r0 | v |',
      '| r1 | v |',
    ]);
    expect(note).toBe('Showing the first 3 of 6 rows.');
    expect(delimitedToMarkdown('\n\n').markdown).toBe('_The table is empty._');
  });

  it('fences text that itself contains backtick fences', () => {
    const block = fenceBlock('code:\n```js\nx\n```\n', 'md');
    expect(block.startsWith('````md\n')).toBe(true);
    expect(block.endsWith('\n````')).toBe(true);
  });

  it('strips inline base64 images from a Docs Markdown export', () => {
    const md = '# T\n\n![][image1]\n\n[image1]: <data:image/png;base64,iVBORw0KGgo=>\n';
    expect(stripDataImages(md)).toBe('# T\n\n![][image1]\n\n[image1]: #image-omitted\n');
  });
});

describe('buildFileRecord', () => {
  it('produces the shared frontmatter shape with the provider id as identity', () => {
    const rec = buildFileRecord('files-google-drive', file(), {
      mode: 'inline',
      markdown: 'hello',
    });
    expect(rec.recordId).toBe('f1');
    expect(rec.dirSegments).toEqual(['reports', '2026']);
    expect(rec.fileStem).toBe('notes-txt');
    expect(Object.keys(rec.frontmatter)).toEqual([
      'title',
      'path',
      'mime_type',
      'size',
      'created',
      'modified',
      'date',
      'modified_by',
      'owner',
      'url',
      'provider',
      'file_id',
      'content',
      'direction',
    ]);
    expect(rec.frontmatter).toMatchObject({
      path: '/Reports/2026',
      size: '10',
      date: '2026-10-01T10:00:00.000Z',
      content: 'inline',
      direction: 'inbound',
    });
    expect(rec.bodyMarkdown).toBe('# notes.txt\n\nhello');
    expect(rec.quarantineNamespace).toBe('files-google-drive');
  });

  it('omits unknown values instead of writing blanks, and slugs hostile names', () => {
    const rec = buildFileRecord(
      'files-onedrive',
      file({
        provider: 'onedrive',
        name: '../../etc/passwd <x>',
        folders: ['..', 'a/b\\c'],
        size: undefined,
        owner: undefined,
        url: undefined,
      }),
      { mode: 'metadata-only', reason: 'Too big.' },
    );
    expect(rec.frontmatter).not.toHaveProperty('size');
    expect(rec.frontmatter).not.toHaveProperty('owner');
    expect(rec.frontmatter.content).toBe('metadata-only');
    expect([...rec.dirSegments, rec.fileStem].every((s) => /^[a-z0-9-]+$/.test(s))).toBe(true);
    expect(rec.bodyMarkdown).toContain('Open it in OneDrive');
  });

  it('caps directory depth and folds the remainder into the last level', () => {
    expect(folderDirSegments(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f-g-h',
    ]);
  });
});

describe('resolveFileContent', () => {
  it('inlines a Docs Markdown export and falls back to plain text when Markdown is refused', async () => {
    const doc = file({ name: 'Plan', native: 'document', size: undefined });
    const plan = planContent(doc, POLICY);
    const md = await resolveFileContent(
      doc,
      plan,
      io({ exports: { 'text/markdown': () => bytes('# Plan\n\nGo.') } }),
      POLICY,
    );
    expect(md).toEqual({ mode: 'inline', markdown: '# Plan\n\nGo.' });
    const plain = await resolveFileContent(
      doc,
      plan,
      io({ exports: { 'text/plain': () => bytes('Plan\nGo.') } }),
      POLICY,
    );
    expect(plain).toEqual({ mode: 'inline', markdown: 'Plan\nGo.' });
  });

  it('renders a Sheets CSV export as a table and says only the first sheet is included', async () => {
    const sheet = file({ name: 'Budget', native: 'spreadsheet', size: undefined });
    const got = await resolveFileContent(
      sheet,
      planContent(sheet, POLICY),
      io({ exports: { 'text/csv': () => bytes('item,cost\nrent,100\n') } }),
      POLICY,
    );
    expect(got).toEqual({
      mode: 'inline',
      markdown: '| item | cost |\n| --- | --- |\n| rent | 100 |',
      note: 'Only the first sheet is mirrored (Google exports one sheet as CSV).',
    });
  });

  it('attaches an export too long to inline, and keeps details only when Google refuses the size', async () => {
    const doc = file({ name: 'Novel', native: 'document', size: undefined });
    const long = 'x'.repeat(600 * 1024);
    const got = await resolveFileContent(
      doc,
      planContent(doc, POLICY),
      io({ exports: { 'text/markdown': () => bytes(long) } }),
      POLICY,
    );
    expect(got.mode).toBe('attachment');
    if (got.mode !== 'attachment') return;
    expect(got.attachment.filename).toBe('Novel.md');
    expect(got.attachment.size).toBe(long.length);
    expect(await readFile(got.attachment.sourcePath!, 'utf8')).toBe(long);

    const refusedAll = await resolveFileContent(
      doc,
      planContent(doc, POLICY),
      io({ exports: {} }),
      POLICY,
    );
    expect(refusedAll).toMatchObject({
      mode: 'metadata-only',
      reason: expect.stringMatching(/could not be exported/),
    });
    const viaRefusal = await resolveFileContent(
      doc,
      planContent(doc, POLICY),
      {
        ...io(),
        exportAs: async () => {
          throw new HttpStatusError(
            403,
            'export 403: {"error":{"errors":[{"reason":"exportSizeLimitExceeded"}]}}',
          );
        },
      },
      POLICY,
    );
    expect(viaRefusal).toMatchObject({
      mode: 'metadata-only',
      reason: expect.stringMatching(/too large to export/),
    });
  });

  it('inlines small text files (fenced code) and attaches binaries with a verified digest', async () => {
    const code = file({ name: 'main.py', mimeType: 'text/x-python', size: 12 });
    expect(
      await resolveFileContent(
        code,
        planContent(code, POLICY),
        io({ download: async () => bytes('print("hi")\n') }),
        POLICY,
      ),
    ).toEqual({
      mode: 'inline',
      markdown: '```python\nprint("hi")\n```',
    });

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    const pdf = file({ name: 'r.pdf', mimeType: 'application/pdf', size: pdfBytes.length });
    const got = await resolveFileContent(
      pdf,
      planContent(pdf, POLICY),
      io({ download: async () => bytes(pdfBytes) }),
      POLICY,
    );
    expect(got.mode).toBe('attachment');
    if (got.mode !== 'attachment') return;
    expect(got.attachment).toMatchObject({
      filename: 'r.pdf',
      size: pdfBytes.length,
      sha256: createHash('sha256').update(pdfBytes).digest('hex'),
    });
    expect(new Uint8Array(await readFile(got.attachment.sourcePath!))).toEqual(pdfBytes);
  });

  it('attaches a "text" file whose bytes are not UTF-8', async () => {
    const latin = file({ name: 'old.txt', size: 3 });
    const got = await resolveFileContent(
      latin,
      planContent(latin, POLICY),
      io({ download: async () => bytes(new Uint8Array([0x63, 0x61, 0xe9])) }),
      POLICY,
    );
    expect(got.mode).toBe('attachment');
  });

  it('enforces the size cap while streaming when the provider under-reports the size', async () => {
    const policy = { ...POLICY, maxFileBytes: 100_000 };
    const liar = file({ name: 'clip.bin', mimeType: 'application/octet-stream', size: undefined });
    const dir = staging();
    const got = await resolveFileContent(
      liar,
      planContent(liar, policy),
      { ...io(), download: async () => streamingBody(300_000), stagingDir: () => dir.get() },
      policy,
    );
    expect(got).toMatchObject({
      mode: 'metadata-only',
      reason: expect.stringMatching(/download limit/),
    });
    expect(await readdir(await dir.get())).toEqual([]);
  });

  it('retries a truncated download instead of storing it', async () => {
    const short = file({ name: 'a.bin', mimeType: 'application/octet-stream', size: 10 });
    await expect(
      resolveFileContent(
        short,
        planContent(short, POLICY),
        io({ download: async () => bytes('12345') }),
        POLICY,
      ),
    ).rejects.toThrow(/ended at 5 of 10 bytes/);
  });

  it('propagates throttles, and mirrors details only when a download is refused', async () => {
    const pdf = file({ name: 'r.pdf', mimeType: 'application/pdf', size: 5 });
    await expect(
      resolveFileContent(
        pdf,
        planContent(pdf, POLICY),
        io({
          download: async () => {
            throw new HttpStatusError(429, 'slow down');
          },
        }),
        POLICY,
      ),
    ).rejects.toThrow(/slow down/);
    const refused = await resolveFileContent(
      pdf,
      planContent(pdf, POLICY),
      io({
        download: async () => {
          throw new HttpStatusError(403, 'cannotDownloadFile');
        },
      }),
      POLICY,
    );
    expect(refused).toMatchObject({
      mode: 'metadata-only',
      reason: expect.stringMatching(/turned off downloading/),
    });
  });
});

describe('streaming helpers', () => {
  it('streamToFile hashes as it writes and refuses past the cap without leaving a file', async () => {
    const dir = await staging().get();
    const ok = await streamToFile(streamingBody(200_000), join(dir, 'ok'), 200_000);
    expect(ok.size).toBe(200_000);
    expect(ok.sha256).toBe(
      createHash('sha256').update(new Uint8Array(200_000).fill(65)).digest('hex'),
    );
    await expect(streamToFile(streamingBody(200_001), join(dir, 'big'), 200_000)).rejects.toThrow(
      /cap/,
    );
    expect(existsSync(join(dir, 'big'))).toBe(false);
  });

  it('readBounded refuses a declared or streamed overflow', async () => {
    await expect(readBounded(bytes('x'.repeat(20)), 10)).rejects.toThrow(/cap/);
    await expect(readBounded(streamingBody(50, 10), 40)).rejects.toThrow(/cap/);
    expect(new TextDecoder().decode(await readBounded(bytes('abc'), 10))).toBe('abc');
  });
});

describe('openDownload — the token never leaves the API origin', () => {
  async function session(http: FakeHttp) {
    env = await createConnectorTestEnv();
    const tokens = new FakeTokenEndpoint('https://oauth2.googleapis.com/token').install(http);
    const binding = { id: 'b1', type: 'files-google-drive' };
    await env.storeCredential(binding, {
      accessToken: 'seed-access',
      refreshToken: tokens.issueRefreshToken(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'cid',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });
    return {
      tokens,
      session: new OAuthSession(binding, env.deps({ fetch: http.fetch }), GOOGLE_OAUTH),
    };
  }

  it('sends the bearer to the API, then follows a cross-origin 302 without it', async () => {
    const http = new FakeHttp()
      .on(
        'GET',
        'https://api.test/items/:id/content',
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://files.storage.test/dl/1?tempauth=abc' },
          }),
      )
      .on('GET', 'https://files.storage.test/dl/:id', (req) =>
        req.headers.has('authorization') ? status(400) : bytes('payload'),
      );
    const { session: s } = await session(http);
    const res = await openDownload({
      session: s,
      fetchImpl: http.fetch,
      url: 'https://api.test/items/1/content',
      apiOrigin: 'https://api.test',
      label: 'test download',
    });
    expect(await res.text()).toBe('payload');
    const [api, storage] = http.calls;
    expect(api!.bearer).toBe('seed-access');
    expect(storage!.url.origin).toBe('https://files.storage.test');
    expect(storage!.headers.has('authorization')).toBe(false);
  });

  it('refuses to start anywhere but the API origin, and refuses a non-HTTPS hop', async () => {
    const http = new FakeHttp().on(
      'GET',
      'https://api.test/x',
      () => new Response(null, { status: 302, headers: { location: 'http://plain.test/x' } }),
    );
    const { session: s } = await session(http);
    const base = { session: s, fetchImpl: http.fetch, apiOrigin: 'https://api.test', label: 'dl' };
    await expect(openDownload({ ...base, url: 'https://evil.test/x' })).rejects.toThrow(
      /refusing to send/,
    );
    await expect(openDownload({ ...base, url: 'https://api.test/x' })).rejects.toThrow(/non-HTTPS/);
    expect(http.calls.map((c) => c.url.origin)).toEqual(['https://api.test']);
  });

  it('retries once with a refreshed token on 401, then asks for a re-link', async () => {
    let first = true;
    const http = new FakeHttp().on('GET', 'https://api.test/x', (req) => {
      if (first) {
        first = false;
        return status(401);
      }
      return req.bearer?.startsWith('access-') ? bytes('ok') : status(401);
    });
    const { session: s, tokens } = await session(http);
    const base = {
      session: s,
      fetchImpl: http.fetch,
      apiOrigin: 'https://api.test',
      label: 'dl',
      url: 'https://api.test/x',
    };
    expect(await (await openDownload(base)).text()).toBe('ok');
    first = true;
    tokens.rejectRefresh = true;
    await expect(openDownload(base)).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('maps 404 to RecordGoneError and other failures to HttpStatusError', async () => {
    const http = new FakeHttp()
      .on('GET', 'https://api.test/gone', () => status(404))
      .on('GET', 'https://api.test/busy', () => status(503, { error: 'busy' }));
    const { session: s } = await session(http);
    const base = { session: s, fetchImpl: http.fetch, apiOrigin: 'https://api.test', label: 'dl' };
    await expect(openDownload({ ...base, url: 'https://api.test/gone' })).rejects.toBeInstanceOf(
      RecordGoneError,
    );
    await expect(openDownload({ ...base, url: 'https://api.test/busy' })).rejects.toMatchObject({
      status: 503,
    });
  });
});

// ── syncTree over an in-memory tree ──────────────────────────────────────

class MemoryTree implements TreeSource {
  readonly items = new Map<string, TreeItem>();
  private log: { seq: number; id: string; removed: boolean }[] = [];
  private seq = 0;
  epoch = 1;
  /** Max events per change page (models a provider's fixed page size). */
  changePage = 1000;
  calls: string[] = [];
  throttleNext = false;

  constructor(readonly rootId = 'root') {
    this.items.set(rootId, { id: rootId, name: '', kind: 'folder' });
  }

  folder(id: string, name: string, parentId = this.rootId): string {
    return this.put({ id, name, parentId, kind: 'folder' });
  }

  file(
    id: string,
    name: string,
    parentId = this.rootId,
    modified = '2026-10-01T00:00:00Z',
  ): string {
    return this.put({
      id,
      name,
      parentId,
      kind: 'file',
      file: { provider: 'google-drive', id, name, mimeType: 'text/plain', size: 1, modified },
    });
  }

  put(item: TreeItem): string {
    this.items.set(item.id, item);
    this.touch(item.id);
    return item.id;
  }

  patch(id: string, patch: Partial<TreeItem>): void {
    this.items.set(id, { ...this.items.get(id)!, ...patch });
    this.touch(id);
  }

  remove(id: string): void {
    this.items.delete(id);
    this.touch(id, true);
  }

  private touch(id: string, removed = false): void {
    this.seq++;
    this.log = this.log.filter((l) => l.id !== id);
    this.log.push({ seq: this.seq, id, removed });
  }

  private guard(call: string): void {
    this.calls.push(call);
    if (this.throttleNext) {
      this.throttleNext = false;
      throw new HttpStatusError(429, 'throttled');
    }
  }

  async startToken(): Promise<string> {
    this.guard('start');
    return `${this.epoch}:${this.seq + 1}`;
  }

  async listChildren(
    folderId: string,
    opts: { pageToken?: string; pageSize: number; includeTrashed: boolean },
  ): Promise<{ items: TreeItem[]; nextPageToken?: string }> {
    this.guard(`children:${folderId}`);
    const kids = [...this.items.values()].filter(
      (i) => i.parentId === folderId && (opts.includeTrashed || !i.trashed),
    );
    const offset = Number(opts.pageToken ?? 0);
    const page = kids.slice(offset, offset + opts.pageSize);
    return {
      items: page,
      ...(offset + opts.pageSize < kids.length
        ? { nextPageToken: String(offset + opts.pageSize) }
        : {}),
    };
  }

  async listChanges(
    token: string,
  ): Promise<{ events: TreeEvent[]; nextToken?: string; newStartToken?: string }> {
    this.guard('changes');
    const [epoch, from] = token.split(':').map(Number);
    if (epoch !== this.epoch) throw new CursorExpiredError('stale');
    const pending = this.log.filter((l) => l.seq >= from!);
    const page = pending.slice(0, this.changePage);
    const events: TreeEvent[] = page.map((l) =>
      l.removed || !this.items.has(l.id)
        ? { id: l.id, removed: true }
        : { id: l.id, item: this.items.get(l.id)! },
    );
    return pending.length > page.length
      ? { events, nextToken: `${this.epoch}:${pending[page.length]!.seq}` }
      : { events, newStartToken: `${this.epoch}:${this.seq + 1}` };
  }
}

function hooks(tree: MemoryTree, key = 'k') {
  return {
    key,
    provider: 'google-drive' as const,
    resolveRoot: async () => ({ rootId: tree.rootId }),
    source: () => tree,
    isThrottle: (err: unknown) => err instanceof HttpStatusError && err.status === 429,
  };
}

const paths = (batch: { records: { raw?: unknown }[] }) =>
  batch.records.map((r) => {
    const { file: f } = r.raw as TreeRefRaw;
    return `${f.folders.join('/')}/${f.name}`;
  });

describe('syncTree', () => {
  it('captures the change token before walking, and a one-batch walk enumerates everything', async () => {
    const tree = new MemoryTree();
    const a = tree.folder('A', 'Alpha');
    tree.file('f1', 'one.txt');
    tree.file('f2', 'two.txt', a);
    const batch = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    expect(tree.calls[0]).toBe('start');
    expect(paths(batch).sort()).toEqual(['/one.txt', 'Alpha/two.txt']);
    expect(batch.enumeratedAll).toBe(true);
    expect(batch.partial).toBeUndefined();
    expect(batch.cursor.folders).toEqual({ root: ['', ''], A: ['root', 'Alpha'] });
    expect(batch.cursor.queue).toBeUndefined();
    // Quiet afterwards.
    const again = await syncTree(hooks(tree), batch.cursor, { limit: 50, maxFiles: 100 });
    expect(again.records).toEqual([]);
    expect(again.enumeratedAll).toBeUndefined();
  });

  it('pages a walk within the limit and loses nothing across batches', async () => {
    const tree = new MemoryTree();
    for (let i = 0; i < 7; i++) tree.file(`f${i}`, `file-${i}.txt`);
    const seen = new Set<string>();
    let cursor: TreeCursor | undefined;
    for (let i = 0; i < 10; i++) {
      const b = await syncTree(hooks(tree), cursor, { limit: 3, maxFiles: 100 });
      expect(b.records.length).toBeLessThanOrEqual(3);
      for (const r of b.records) seen.add(r.id);
      cursor = b.cursor;
      if (!b.partial) break;
    }
    expect(seen.size).toBe(7);
  });

  it('stashes change-page overflow past the limit and emits it next batch', async () => {
    const tree = new MemoryTree();
    const b0 = await syncTree(hooks(tree), undefined, { limit: 10, maxFiles: 100 });
    for (let i = 0; i < 5; i++) tree.file(`n${i}`, `new-${i}.txt`);
    const b1 = await syncTree(hooks(tree), b0.cursor, { limit: 2, maxFiles: 100 });
    expect(b1.records).toHaveLength(2);
    expect(b1.partial).toBe(true);
    expect(b1.cursor.pending).toHaveLength(3);
    const b2 = await syncTree(hooks(tree), b1.cursor, { limit: 10, maxFiles: 100 });
    expect(b2.records.map((r) => r.id).sort()).toEqual(['n2', 'n3', 'n4']);
    expect(b2.cursor.pending).toBeUndefined();
  });

  it('re-walks a renamed folder so its files move, and tombstones a folder that left the scope', async () => {
    const tree = new MemoryTree();
    const a = tree.folder('A', 'Alpha');
    const b = tree.folder('B', 'Beta', a);
    tree.file('f1', 'one.txt', b);
    tree.file('f2', 'two.txt', a);
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });

    tree.patch(a, { name: 'Alpha 2' });
    const renamed = await syncTree(hooks(tree), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(paths(renamed).sort()).toEqual(['Alpha 2/Beta/one.txt', 'Alpha 2/two.txt']);

    // Move B out of the synced tree: its files become tombstones.
    tree.items.set('X', { id: 'X', name: 'Out', kind: 'folder' });
    tree.patch(b, { parentId: 'X' });
    const left = await syncTree(hooks(tree), renamed.cursor, { limit: 50, maxFiles: 100 });
    expect(left.removed).toEqual(['f1']);
    expect(left.cursor.folders).not.toHaveProperty('B');

    // Move it back: the subtree is walked again.
    tree.patch(b, { parentId: a });
    const back = await syncTree(hooks(tree), left.cursor, { limit: 50, maxFiles: 100 });
    expect(paths(back)).toEqual(['Alpha 2/Beta/one.txt']);
  });

  it('finds a folder created later in the same change page than its file', async () => {
    const tree = new MemoryTree();
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    tree.put({ id: 'C', name: 'Child', parentId: 'P', kind: 'folder' });
    tree.file('f', 'deep.txt', 'C');
    tree.put({ id: 'P', name: 'Parent', parentId: 'root', kind: 'folder' });
    const b1 = await syncTree(hooks(tree), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(paths(b1)).toContain('Parent/Child/deep.txt');
  });

  it('resyncs from a fresh token and walk when the change token expires', async () => {
    const tree = new MemoryTree();
    tree.file('f1', 'one.txt');
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    tree.epoch++;
    tree.file('f2', 'two.txt');
    const b1 = await syncTree(hooks(tree), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(b1.records.map((r) => r.id).sort()).toEqual(['f1', 'f2']);
    expect(b1.enumeratedAll).toBe(true);
    expect(b1.cursor.token.startsWith('2:')).toBe(true);
  });

  it('a throttle returns the batch so far with the cursor that covers exactly it', async () => {
    const tree = new MemoryTree();
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    const before = JSON.stringify(b0.cursor);
    tree.file('f1', 'one.txt');
    tree.throttleNext = true;
    const t = await syncTree(hooks(tree), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(t.rateLimited).toBe(true);
    expect(t.records).toEqual([]);
    expect(JSON.stringify(t.cursor)).toBe(before);
    // Throttled while resolving a fresh start: the prior cursor comes back.
    tree.throttleNext = true;
    const fresh = await syncTree(hooks(tree, 'other-key'), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(fresh.rateLimited).toBe(true);
    expect(fresh.cursor).toBe(b0.cursor);
  });

  it('starts over when the configured folder changes (a different key)', async () => {
    const tree = new MemoryTree();
    tree.file('f1', 'one.txt');
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    const b1 = await syncTree(hooks(tree, 'k2'), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(b1.enumeratedAll).toBe(true);
    expect(b1.records.map((r) => r.id)).toEqual(['f1']);
  });

  it('stops a walk at maxFiles and never claims a full enumeration', async () => {
    const tree = new MemoryTree();
    for (let i = 0; i < 5; i++) tree.file(`f${i}`, `f${i}.txt`);
    const b = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 3 });
    expect(b.records).toHaveLength(3);
    expect(b.enumeratedAll).toBeUndefined();
    expect(b.cursor.walked).toBeUndefined();
  });

  it('stops tracking folders past the cap instead of growing the cursor without bound', async () => {
    const tree = new MemoryTree();
    for (let i = 0; i < MAX_TRACKED_FOLDERS + 5; i++) tree.folder(`d${i}`, `dir-${i}`);
    let cursor: TreeCursor | undefined;
    let last: Awaited<ReturnType<typeof syncTree>> | undefined;
    for (let i = 0; i < 10; i++) {
      last = await syncTree(hooks(tree), cursor, { limit: 5000, maxFiles: 100 });
      cursor = last.cursor;
      if (!last.partial) break;
    }
    expect(Object.keys(cursor!.folders)).toHaveLength(MAX_TRACKED_FOLDERS);
    expect(last!.enumeratedAll).toBeUndefined();
  });

  it('resets to re-resolve the root when the synced folder itself is deleted', async () => {
    const tree = new MemoryTree();
    tree.file('f1', 'one.txt');
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    tree.remove('root');
    const gone = await syncTree(hooks(tree), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(gone.records).toEqual([]);
    expect(gone.cursor.folders).toEqual({});
    let resolved = 0;
    const again = await syncTree(
      {
        ...hooks(tree),
        resolveRoot: async () => {
          resolved++;
          throw new Error('folder not found');
        },
      },
      gone.cursor,
      { limit: 50, maxFiles: 100 },
    ).catch((e: Error) => e);
    expect(resolved).toBe(1);
    expect(again).toBeInstanceOf(Error);
  });

  it('keeps out-of-scope files as removals so a file moved out leaves the corpus', async () => {
    const tree = new MemoryTree();
    tree.file('f1', 'one.txt');
    const b0 = await syncTree(hooks(tree), undefined, { limit: 50, maxFiles: 100 });
    tree.items.set('X', { id: 'X', name: 'Out', kind: 'folder' });
    tree.patch('f1', { parentId: 'X' });
    const b1 = await syncTree(hooks(tree), b0.cursor, { limit: 50, maxFiles: 100 });
    expect(b1.records).toEqual([]);
    expect(b1.removed).toEqual(['f1']);
  });

  it('rejects a corrupted cursor and starts fresh', async () => {
    const tree = new MemoryTree();
    tree.file('f1', 'one.txt');
    const b = await syncTree(
      hooks(tree),
      { v: 1, key: 'k', root: 'root', token: 'x', folders: { root: 'bad' } },
      {
        limit: 50,
        maxFiles: 100,
      },
    );
    expect(b.enumeratedAll).toBe(true);
  });
});
