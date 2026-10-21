/**
 * The shared half of the cloud-files connectors (`files-google-drive`,
 * `files-onedrive`, `files-sharepoint`). Three providers, one corpus shape:
 * a gezel reading a mirrored folder sees the same frontmatter keys, the same
 * body layout, and the same content decisions whether the bytes came from
 * Drive or Graph.
 *
 * Four things live here, each written once:
 *
 * - **The canonical file record.** `CloudFile` is what an adapter knows about a
 *   file; `buildFileRecord` turns it plus its resolved content into the
 *   `NormalizedRecord` the shared writer stores. The record id is the
 *   provider's file id, so renames and moves refresh one record instead of
 *   minting a new one; the folder path becomes `dirSegments`, which is why the
 *   adapters set `recordsMayMove`.
 * - **The content policy.** `planContent` decides, before any bytes move,
 *   whether a file is exported (Google Docs/Sheets/Slides), downloaded and
 *   inlined (text up to 512 KB), downloaded as an attachment (anything else up
 *   to `maxFileMB`), or mirrored as metadata only.
 * - **The download path.** `openDownload` sends the bearer token to the API
 *   origin and nowhere else: OneDrive and SharePoint answer `/content` with a
 *   302 to a pre-authenticated URL on another host, and following that hop
 *   with the token attached would hand a Microsoft credential to a storage
 *   front end that never asked for it. Downloads stream to a private staging
 *   file with a running sha256 and the size cap enforced mid-stream.
 * - **The folder-tree sync.** `syncTree` is the cursor state machine both
 *   providers drive through a small `TreeSource`: capture the change-feed
 *   token, walk the folder breadth-first, then follow the change feed,
 *   mapping each change to the configured folder through a cached folder map
 *   (Drive's change feed carries no paths, and Graph's delta deliberately
 *   omits `parentReference.path`).
 */

import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStatusError, createLogger } from '@bendyline/gezel';
import { registerNativeAdapter } from '../registry.js';
import {
  type ChangeBatch,
  type NormalizedAttachment,
  type NormalizedRecord,
  RecordGoneError,
  type RecordRef,
} from '../types.js';
import { slug } from '../writer.js';
import { type OAuthSession, ReconnectRequiredError } from './oauth-session.js';

const log = createLogger('connectors');

// ── The canonical file ────────────────────────────────────────────────────

export type CloudProvider = 'google-drive' | 'onedrive' | 'sharepoint';

/**
 * Google Workspace files have no bytes of their own and download only through
 * an export. `other` covers Forms, Drawings, Sites, and third-party types.
 */
export type NativeDocKind = 'document' | 'spreadsheet' | 'presentation' | 'other';

/** What an adapter knows about one file, provider-neutral. */
export interface CloudFile {
  provider: CloudProvider;
  /** Provider file / item id: stable across renames and moves. */
  id: string;
  name: string;
  mimeType: string;
  /** Size in bytes, when the provider reports one. */
  size?: number;
  modified?: string;
  created?: string;
  modifiedBy?: string;
  owner?: string;
  /** Web view link. */
  url?: string;
  /** Folder names from the synced folder down to this file's folder. */
  folders: string[];
  /** Set for Google Workspace files. */
  native?: NativeDocKind;
}

/** A file's metadata before the tree sync has placed it in a folder. */
export type CloudFileMeta = Omit<CloudFile, 'folders'>;

// ── Policy ────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_FILE_MB = 25;
export const MAX_FILE_MB_LIMIT = 1024;
export const DEFAULT_MAX_FILES = 2000;
export const MAX_FILES_LIMIT = 50_000;
/** Text files up to this size are inlined into the record body. */
export const MAX_INLINE_BYTES = 512 * 1024;
/** Google caps `files.export` output at 10 MB. */
export const EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;
/** A spreadsheet rendered into a body keeps this many data rows. */
export const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 40;
const MAX_CELL_CHARS = 300;
/** Folder levels kept as directories; deeper paths fold into the last one. */
const MAX_DIR_DEPTH = 6;

export interface FilesPolicy {
  /** Largest file downloaded as an attachment; 0 turns downloads off. */
  maxFileBytes: number;
  maxInlineBytes: number;
  /** Most files one folder enumeration emits. */
  maxFiles: number;
}

/** Read `maxFileMB` / `maxFiles` from a binding config, with bounds. */
export function parseFilesPolicy(raw: Record<string, unknown> | undefined): FilesPolicy {
  const mb = numberField(raw?.maxFileMB, 'Largest file to download (MB)', 0, MAX_FILE_MB_LIMIT);
  const files = numberField(raw?.maxFiles, 'Most files to mirror', 1, MAX_FILES_LIMIT);
  return {
    maxFileBytes: Math.floor((mb ?? DEFAULT_MAX_FILE_MB) * 1024 * 1024),
    maxInlineBytes: MAX_INLINE_BYTES,
    maxFiles: files === undefined ? DEFAULT_MAX_FILES : Math.floor(files),
  };
}

function numberField(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}.`);
  }
  return n;
}

// ── Content policy ────────────────────────────────────────────────────────

/** How text lands in a body: as-is, fenced, or as a markdown table. */
export type TextRender = 'markdown' | 'prose' | 'code' | 'table';

export interface TextHint {
  render: TextRender;
  /** Fence language for `code`. */
  lang?: string;
  /** Field delimiter for `table`. */
  delimiter?: string;
}

export interface ExportFormat {
  mime: string;
  render: TextRender;
  /** Extension for the attachment when the export is too long to inline. */
  extension: string;
}

export type ContentPlan =
  | { kind: 'export'; formats: ExportFormat[]; note?: string }
  /** Download the bytes; inline them when `text` is set and they fit and decode. */
  | { kind: 'download'; text?: TextHint }
  | { kind: 'metadata-only'; reason: string };

const NATIVE_LABEL: Record<NativeDocKind, string> = {
  document: 'Google Docs',
  spreadsheet: 'Google Sheets',
  presentation: 'Google Slides',
  other: 'This kind of Google file',
};

/**
 * Decide how a file's content is mirrored, before any bytes move. Pure, so the
 * whole policy is unit-tested without a provider.
 */
export function planContent(file: CloudFile, policy: FilesPolicy): ContentPlan {
  switch (file.native) {
    case 'document':
      // Docs export Markdown natively (Drive export formats table); plain
      // text is the fallback for older or unusual documents.
      return {
        kind: 'export',
        formats: [
          { mime: 'text/markdown', render: 'markdown', extension: '.md' },
          { mime: 'text/plain', render: 'prose', extension: '.txt' },
        ],
      };
    case 'spreadsheet':
      return {
        kind: 'export',
        formats: [{ mime: 'text/csv', render: 'table', extension: '.csv' }],
        note: 'Only the first sheet is mirrored (Google exports one sheet as CSV).',
      };
    case 'presentation':
      return {
        kind: 'export',
        formats: [{ mime: 'text/plain', render: 'prose', extension: '.txt' }],
      };
    case 'other':
      return {
        kind: 'metadata-only',
        reason: `${NATIVE_LABEL.other} has no text export, so only its details are mirrored.`,
      };
    default:
      break;
  }
  if (policy.maxFileBytes <= 0) {
    return {
      kind: 'metadata-only',
      reason: 'File downloads are turned off for this connector, so only its details are mirrored.',
    };
  }
  if (file.size !== undefined && file.size > policy.maxFileBytes) {
    return { kind: 'metadata-only', reason: tooLargeReason(file.size, policy) };
  }
  const text = textHint(file.name, file.mimeType);
  if (text && (file.size === undefined || file.size <= policy.maxInlineBytes)) {
    return { kind: 'download', text };
  }
  return { kind: 'download' };
}

function tooLargeReason(size: number | undefined, policy: FilesPolicy): string {
  const of = size === undefined ? '' : ` (${formatBytes(size)})`;
  return `This file${of} is larger than the ${formatBytes(policy.maxFileBytes)} download limit, so only its details are mirrored.`;
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const PROSE_EXT = new Set(['txt', 'text', 'log', 'rst', 'adoc', 'org']);
const TABLE_EXT: Record<string, string> = { csv: ',', tsv: '\t' };
const CODE_EXT: Record<string, string> = {
  json: 'json',
  jsonl: 'json',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: '',
  env: '',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  bat: 'bat',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  r: 'r',
  lua: 'lua',
  pl: 'perl',
  dart: 'dart',
  scala: 'scala',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  tex: 'latex',
};
const CODE_BASENAME: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile' };
const TEXT_MIME: Record<string, TextHint> = {
  'text/markdown': { render: 'markdown' },
  'text/x-markdown': { render: 'markdown' },
  'text/plain': { render: 'prose' },
  'text/csv': { render: 'table', delimiter: ',' },
  'text/tab-separated-values': { render: 'table', delimiter: '\t' },
  'text/html': { render: 'code', lang: 'html' },
  'text/xml': { render: 'code', lang: 'xml' },
  'application/xml': { render: 'code', lang: 'xml' },
  'application/json': { render: 'code', lang: 'json' },
  'application/x-yaml': { render: 'code', lang: 'yaml' },
  'application/yaml': { render: 'code', lang: 'yaml' },
  'text/yaml': { render: 'code', lang: 'yaml' },
  'application/javascript': { render: 'code', lang: 'javascript' },
  'text/javascript': { render: 'code', lang: 'javascript' },
  'application/x-sh': { render: 'code', lang: 'bash' },
  'application/sql': { render: 'code', lang: 'sql' },
  'application/toml': { render: 'code', lang: 'toml' },
};

/**
 * Whether a file is text worth inlining, and how to render it. The extension
 * wins over the MIME type: providers label Markdown and source code as
 * `text/plain` or `application/octet-stream` more often than not.
 */
export function textHint(name: string, mimeType: string): TextHint | undefined {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (MARKDOWN_EXT.has(ext)) return { render: 'markdown' };
  if (PROSE_EXT.has(ext)) return { render: 'prose' };
  if (ext in TABLE_EXT) return { render: 'table', delimiter: TABLE_EXT[ext] };
  if (ext in CODE_EXT) return { render: 'code', lang: CODE_EXT[ext] };
  if (lower in CODE_BASENAME) return { render: 'code', lang: CODE_BASENAME[lower] };
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  if (mime in TEXT_MIME) return TEXT_MIME[mime];
  // SVG is XML, but it is an image a person opens, not text a model reads.
  if (mime.startsWith('text/')) return { render: 'code', lang: '' };
  return undefined;
}

// ── Rendering ─────────────────────────────────────────────────────────────

/** Fence text so no run of backticks inside it can close the block early. */
export function fenceBlock(text: string, lang = ''): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

/** RFC 4180 delimited text → rows (quoted fields, doubled quotes, CRLF). */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      fieldStarted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function tableCell(value: string): string {
  const flat = value.replace(/\r?\n|\r/g, ' ').trim();
  const cut = flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1)}…` : flat;
  return cut.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Delimited text as a markdown table: the first row is the header, at most
 * `maxRows` data rows and 40 columns. Truncation is stated, never silent.
 */
export function delimitedToMarkdown(
  text: string,
  delimiter = ',',
  maxRows = MAX_TABLE_ROWS,
): { markdown: string; note?: string } {
  const rows = parseDelimited(text, delimiter).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) return { markdown: '_The table is empty._' };
  const width = Math.min(MAX_TABLE_COLUMNS, Math.max(...rows.map((r) => r.length)));
  const header = rows[0]!;
  const body = rows.slice(1);
  const kept = body.slice(0, maxRows);
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => tableCell(cells[i] ?? '')).join(' | ')} |`;
  const headerCells = Array.from(
    { length: width },
    (_, i) => header[i]?.trim() || `Column ${i + 1}`,
  );
  const lines = [
    line(headerCells),
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...kept.map(line),
  ];
  const notes: string[] = [];
  if (body.length > kept.length)
    notes.push(`Showing the first ${kept.length} of ${body.length} rows.`);
  const widest = Math.max(...rows.map((r) => r.length));
  if (widest > width) notes.push(`Showing the first ${width} of ${widest} columns.`);
  return { markdown: lines.join('\n'), ...(notes.length ? { note: notes.join(' ') } : {}) };
}

/** Text content rendered for a record body. */
export function renderText(text: string, hint: TextHint): { markdown: string; note?: string } {
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  switch (hint.render) {
    case 'table':
      return delimitedToMarkdown(clean, hint.delimiter ?? ',');
    case 'code':
      return { markdown: fenceBlock(clean, hint.lang ?? '') };
    default:
      return { markdown: clean.replace(/\s+$/, '') || '_The file is empty._' };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

// ── The record ────────────────────────────────────────────────────────────

/** What `resolveFileContent` produced for one file. */
export type ResolvedContent =
  | { mode: 'inline'; markdown: string; note?: string }
  | { mode: 'attachment'; attachment: NormalizedAttachment; note?: string }
  | { mode: 'metadata-only'; reason: string };

/** Human folder path relative to the synced folder: `/` or `/Reports/2026`. */
export function humanFolderPath(folders: string[]): string {
  return `/${folders.join('/')}`;
}

/** Slugged directory segments for a folder path, depth-capped. */
export function folderDirSegments(folders: string[]): string[] {
  const segs = folders.map((f) => slug(f));
  if (segs.length <= MAX_DIR_DEPTH) return segs;
  return [...segs.slice(0, MAX_DIR_DEPTH - 1), slug(folders.slice(MAX_DIR_DEPTH - 1).join(' '))];
}

const PROVIDER_LABEL: Record<CloudProvider, string> = {
  'google-drive': 'Google Drive',
  onedrive: 'OneDrive',
  sharepoint: 'SharePoint',
};

/**
 * The record for one file. Frontmatter keys are the same for every provider
 * (absent values are omitted, never blank); nothing volatile goes in, so an
 * unchanged file never rewrites.
 */
export function buildFileRecord(
  typeId: string,
  file: CloudFile,
  content: ResolvedContent,
): NormalizedRecord {
  const fm: Record<string, string> = {};
  const put = (key: string, value: string | undefined) => {
    if (value) fm[key] = value;
  };
  put('title', file.name || file.id);
  put('path', humanFolderPath(file.folders));
  put('mime_type', file.mimeType);
  put('size', file.size === undefined ? undefined : String(file.size));
  put('created', file.created);
  put('modified', file.modified);
  put('date', file.modified ?? file.created);
  put('modified_by', file.modifiedBy);
  put('owner', file.owner);
  put('url', file.url);
  put('provider', file.provider);
  put('file_id', file.id);
  put('content', content.mode);
  fm.direction = 'inbound';

  const title = (file.name || file.id).replace(/\s+/g, ' ').trim();
  const parts = [`# ${title}`];
  if (content.mode === 'inline') {
    if (content.note) parts.push(`_${content.note}_`);
    parts.push(content.markdown);
  } else if (content.mode === 'attachment') {
    const size = content.attachment.size ?? content.attachment.content?.byteLength ?? 0;
    parts.push(
      `The file (${formatBytes(size)}, ${file.mimeType}) is saved with this record as the attachment \`${content.attachment.filename}\`; its contents are not reproduced here.`,
    );
    if (content.note) parts.push(`_${content.note}_`);
  } else {
    parts.push(
      `${content.reason} Open it in ${PROVIDER_LABEL[file.provider]} from the link in this record's \`url\`.`,
    );
  }
  return {
    recordId: file.id,
    dirSegments: folderDirSegments(file.folders),
    fileStem: slug(file.name || file.id),
    frontmatter: fm,
    bodyMarkdown: parts.join('\n\n'),
    scanOrigin: typeId,
    quarantineNamespace: typeId,
    quarantineLabel: `File "${title.slice(0, 120)}"`,
    ...(content.mode === 'attachment' ? { attachments: [content.attachment] } : {}),
  };
}

// ── Downloads ─────────────────────────────────────────────────────────────

/** A download crossed its size cap mid-stream. */
export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileTooLargeError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export interface DownloadRequest {
  session: OAuthSession;
  fetchImpl: typeof fetch;
  url: string;
  /** The only origin that ever receives the bearer token. */
  apiOrigin: string;
  /** Short label for errors ("Google Drive download"). */
  label: string;
}

/**
 * Open a download. The token goes to the API origin only; a redirect to any
 * other origin is followed bare. OneDrive and SharePoint answer `/content`
 * with a 302 to a pre-authenticated URL and say the hop needs no
 * Authorization header (Graph "Download driveItem content"); a fetch left to
 * follow redirects itself would decide on its own what to send there.
 * A 404 or 410 means the file went away after it was listed.
 */
export async function openDownload(req: DownloadRequest): Promise<Response> {
  let target = new URL(req.url);
  if (target.origin !== req.apiOrigin) {
    throw new Error(`${req.label}: refusing to send this connector's sign-in to ${target.origin}`);
  }
  let token = await req.session.token();
  const send = (url: URL) =>
    req.fetchImpl(url, {
      redirect: 'manual',
      headers: url.origin === req.apiOrigin ? { Authorization: `Bearer ${token}` } : {},
    });
  let res = await send(target);
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    token = await req.session.forceRefresh();
    res = await send(target);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      throw new ReconnectRequiredError(
        `${req.label} refused this connector's sign-in (HTTP 401). Re-link the account from the project's Connections.`,
      );
    }
  }
  for (let hop = 0; REDIRECT_STATUSES.has(res.status); hop++) {
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error(`${req.label}: too many redirects`);
    if (!location) throw new Error(`${req.label}: redirect without a location`);
    const next = new URL(location, target);
    if (next.protocol !== 'https:') throw new Error(`${req.label}: refused a non-HTTPS redirect`);
    target = next;
    res = await send(target);
  }
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {});
    throw new RecordGoneError(`${req.label}: the file is gone (HTTP ${res.status})`);
  }
  if (!res.ok) {
    // The body names the provider's reason; the URL is never echoed because
    // a pre-authenticated download URL is itself a credential.
    const body = await res.text().catch(() => '');
    throw new HttpStatusError(res.status, `${req.label} ${res.status}: ${body}`.slice(0, 400));
  }
  return res;
}

function declaredLength(res: Response): number | undefined {
  const raw = res.headers.get('content-length');
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Stream a response body to `path`, hashing as it goes, and stop the moment
 * it passes `maxBytes` (the provider's reported size is a hint, not a
 * promise). The partial file is removed on any failure.
 */
export async function streamToFile(
  res: Response,
  path: string,
  maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  const declared = declaredLength(res);
  if (declared !== undefined && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FileTooLargeError(`download is ${declared} bytes, over the ${maxBytes}-byte cap`);
  }
  await rm(path, { force: true });
  const handle = await open(path, 'wx');
  const hash = createHash('sha256');
  let size = 0;
  try {
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FileTooLargeError(`download passed the ${maxBytes}-byte cap`);
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('staging write made no progress');
        offset += bytesWritten;
      }
      hash.update(value);
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(path, { force: true });
    throw err;
  }
  await handle.close();
  return { size, sha256: hash.digest('hex') };
}

/** Read a response body into memory, refusing past `maxBytes`. */
export async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = declaredLength(res);
  if (declared !== undefined && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FileTooLargeError(`response is ${declared} bytes, over the ${maxBytes}-byte cap`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FileTooLargeError(`response passed the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** UTF-8 text, or undefined when the bytes are not text a model can read. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The provider calls `resolveFileContent` needs, bound to one file. */
export interface ContentIo {
  download(): Promise<Response>;
  exportAs?(mime: string): Promise<Response>;
  /** The adapter's private staging directory (created on first use). */
  stagingDir(): Promise<string>;
  /** Provider-specific backpressure test (Drive throttles with 403s). */
  isThrottle(err: unknown): boolean;
}

/** Lazily-created private staging directory, removed by `dispose()`. */
export class StagingDir {
  private dir?: Promise<string>;

  constructor(private readonly prefix: string) {}

  get(): Promise<string> {
    this.dir ??= mkdtemp(join(tmpdir(), this.prefix));
    return this.dir;
  }

  async dispose(): Promise<void> {
    const dir = this.dir;
    this.dir = undefined;
    if (dir) await rm(await dir, { recursive: true, force: true }).catch(() => {});
  }
}

function stagingName(file: CloudFile, suffix = ''): string {
  const id = createHash('sha256').update(file.id).digest('hex').slice(0, 12);
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';
  return `${id}-${safe}${suffix}`;
}

/**
 * True for a refusal that will not change on retry and should leave the file
 * as metadata only: an unsupported export, a file whose owner turned off
 * downloads, an export over Google's 10 MB cap.
 */
function isContentRefusal(err: unknown, io: ContentIo): boolean {
  return (
    err instanceof HttpStatusError &&
    (err.status === 400 || err.status === 403) &&
    !io.isThrottle(err)
  );
}

/**
 * Fetch a file's content according to its plan. Throttles, auth failures, and
 * vanished files propagate (the engine retries, reports, or skips them); a
 * refusal that will not change becomes a metadata-only record.
 */
export async function resolveFileContent(
  file: CloudFile,
  plan: ContentPlan,
  io: ContentIo,
  policy: FilesPolicy,
): Promise<ResolvedContent> {
  if (plan.kind === 'metadata-only') return { mode: 'metadata-only', reason: plan.reason };

  if (plan.kind === 'export') {
    let refusal: unknown;
    for (const format of plan.formats) {
      let bytes: Uint8Array;
      try {
        if (!io.exportAs) throw new Error('this provider has no export');
        bytes = await readBounded(await io.exportAs(format.mime), EXPORT_LIMIT_BYTES);
      } catch (err) {
        if (err instanceof FileTooLargeError || isContentRefusal(err, io)) {
          refusal = err;
          continue;
        }
        throw err;
      }
      const decoded = new TextDecoder().decode(bytes);
      const text = format.render === 'markdown' ? stripDataImages(decoded) : decoded;
      const textBytes = Buffer.from(text, 'utf8');
      if (textBytes.byteLength <= policy.maxInlineBytes) {
        const rendered = renderText(text, { render: format.render });
        const note = [plan.note, rendered.note].filter(Boolean).join(' ');
        return { mode: 'inline', markdown: rendered.markdown, ...(note ? { note } : {}) };
      }
      const attachment = await stageBytes(file, textBytes, io, format.extension);
      return {
        mode: 'attachment',
        attachment,
        note: `The ${format.mime} export is too long to show here; the attachment is the full text.${plan.note ? ` ${plan.note}` : ''}`,
      };
    }
    const tooLarge =
      refusal instanceof FileTooLargeError || /exportSizeLimitExceeded/i.test(String(refusal));
    return {
      mode: 'metadata-only',
      reason: tooLarge
        ? `This ${NATIVE_LABEL[file.native ?? 'other']} file is too large to export (Google exports at most 10 MB of text), so only its details are mirrored.`
        : `This ${NATIVE_LABEL[file.native ?? 'other']} file could not be exported (the owner may have turned off downloading), so only its details are mirrored.`,
    };
  }

  let res: Response;
  try {
    res = await io.download();
  } catch (err) {
    if (isContentRefusal(err, io)) {
      return {
        mode: 'metadata-only',
        reason:
          'This file could not be downloaded (the owner may have turned off downloading), so only its details are mirrored.',
      };
    }
    throw err;
  }
  const path = join(await io.stagingDir(), stagingName(file));
  let staged: { size: number; sha256: string };
  try {
    staged = await streamToFile(res, path, policy.maxFileBytes);
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      return { mode: 'metadata-only', reason: tooLargeReason(file.size, policy) };
    }
    throw err;
  }
  if (file.size !== undefined && staged.size !== file.size) {
    await rm(path, { force: true });
    throw new Error(
      `download of "${file.name}" ended at ${staged.size} of ${file.size} bytes; it will be retried`,
    );
  }
  if (plan.text && staged.size <= policy.maxInlineBytes) {
    const text = decodeText(await readFile(path));
    if (text !== undefined) {
      await rm(path, { force: true });
      const rendered = renderText(text, plan.text);
      return {
        mode: 'inline',
        markdown: rendered.markdown,
        ...(rendered.note ? { note: rendered.note } : {}),
      };
    }
  }
  return {
    mode: 'attachment',
    attachment: {
      filename: file.name || file.id,
      sourcePath: path,
      size: staged.size,
      sha256: staged.sha256,
    },
  };
}

async function stageBytes(
  file: CloudFile,
  bytes: Uint8Array,
  io: ContentIo,
  extension: string,
): Promise<NormalizedAttachment> {
  const path = join(await io.stagingDir(), stagingName(file, extension));
  await writeFile(path, bytes);
  const base = file.name || file.id;
  const filename = base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
  return {
    filename,
    sourcePath: path,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Google's Markdown export inlines every image as a base64 data URI, which
 * would push an illustrated document past the inline limit on pictures a
 * model cannot read anyway.
 */
export function stripDataImages(markdown: string): string {
  return markdown.replace(
    /<?data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*>?/gi,
    '#image-omitted',
  );
}

// ── The folder-tree sync ──────────────────────────────────────────────────

/** One entry of a folder listing or a change, provider-neutral. */
export interface TreeItem {
  id: string;
  name: string;
  /** Parent folder id; absent for a drive root. */
  parentId?: string;
  /** `skip`: shortcuts, OneNote packages, items living in another drive. */
  kind: 'folder' | 'file' | 'skip';
  /** In the provider's trash: gone for sync purposes, still listable. */
  trashed?: boolean;
  /** File metadata (files only). */
  file?: CloudFileMeta;
}

export type TreeEvent =
  | { id: string; removed: true }
  | { id: string; removed?: false; item: TreeItem };

/** A provider's listing and change feed, bound to one drive. */
export interface TreeSource {
  /** The change-feed position "now", captured before a walk begins. */
  startToken(): Promise<string>;
  /** One page of a folder's children; a vanished folder lists as empty. */
  listChildren(
    folderId: string,
    opts: { pageToken?: string; pageSize: number; includeTrashed: boolean },
  ): Promise<{ items: TreeItem[]; nextPageToken?: string }>;
  /**
   * One page of changes. `nextToken` while more remain, `newStartToken` on
   * the last page. Throws `CursorExpiredError` when the token is no longer
   * honored.
   */
  listChanges(
    token: string,
    pageSize: number,
  ): Promise<{ events: TreeEvent[]; nextToken?: string; newStartToken?: string }>;
}

/** The provider refused a stored change-feed token; the scope resyncs. */
export class CursorExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorExpiredError';
  }
}

export interface TreeSyncHooks {
  /** Fingerprint of the configuration that picked this root; a change restarts. */
  key: string;
  provider: CloudProvider;
  /** Resolve the synced folder (only on a fresh start). Throws actionable errors. */
  resolveRoot(): Promise<{ rootId: string; drive?: string }>;
  /** The provider's listing + change feed for the resolved drive. */
  source(drive: string | undefined): TreeSource;
  isThrottle(err: unknown): boolean;
}

/** Persisted per-scope state. Folder names, never file ids, so it stays small. */
export interface TreeCursor {
  v: 1;
  key: string;
  root: string;
  /** Graph drive id, or a Drive shared-drive id. */
  drive?: string;
  /** Change-feed position; captured before the first walk. */
  token: string;
  /** In-scope folders: id → [parent id, name]. The root maps to ['', '']. */
  folders: Record<string, [string, string]>;
  /** Folders whose subtree still has to be (re)listed. */
  queue?: string[];
  queueToken?: string;
  /** Files the current walk has emitted (bounded by `maxFiles`). */
  walked?: number;
  /** Folders that left the scope; their subtree is listed to tombstone it. */
  tombs?: string[];
  tombToken?: string;
  /** Files a change page produced past the batch limit, emitted next call. */
  pending?: TreeItem[];
}

/** What a tree-sync ref carries to `fetchRecord`. */
export interface TreeRefRaw {
  file: CloudFile;
  drive?: string;
}

export interface TreeSyncOptions {
  limit?: number;
  maxFiles: number;
}

const PAGE_MAX = 1000;
const MAX_PAGES_PER_CALL = 25;
const MAX_REMOVED_PER_CALL = 10_000;
/** In-scope folders tracked in the cursor; beyond this, subtrees are not mirrored. */
export const MAX_TRACKED_FOLDERS = 2000;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function parseTreeCursor(raw: unknown, key: string): TreeCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<TreeCursor>;
  if (c.v !== 1 || c.key !== key || typeof c.root !== 'string' || typeof c.token !== 'string') {
    return undefined;
  }
  if (!c.folders || typeof c.folders !== 'object') return undefined;
  for (const entry of Object.values(c.folders)) {
    if (!isStringArray(entry) || entry.length !== 2) return undefined;
  }
  if (!(c.root in c.folders)) return undefined;
  if (c.queue !== undefined && !isStringArray(c.queue)) return undefined;
  if (c.tombs !== undefined && !isStringArray(c.tombs)) return undefined;
  if (c.pending !== undefined && !Array.isArray(c.pending)) return undefined;
  return JSON.parse(JSON.stringify(c)) as TreeCursor;
}

/**
 * One batch of the folder-tree sync. Order of work in a call: files a
 * previous change page could not fit, then the breadth-first walk of any
 * queued folder, then the tombstone walk of folders that left the scope, then
 * the change feed. The cursor always covers exactly the returned batch: state
 * is mutated only after a page has been fetched, so a throttle mid-call
 * returns the batch so far with its matching cursor.
 */
export async function syncTree(
  hooks: TreeSyncHooks,
  priorRaw: unknown,
  opts: TreeSyncOptions,
): Promise<ChangeBatch<TreeCursor>> {
  const limit = Math.max(1, opts.limit ?? 500);
  const records = new Map<string, RecordRef>();
  const removed = new Set<string>();
  let st = parseTreeCursor(priorRaw, hooks.key);
  let fresh = false;
  let truncated = false;
  let reachedEnd = false;
  let expiredOnce = false;
  let pages = 0;
  let folderCount = st ? Object.keys(st.folders).length : 0;

  const restart = async (rootId: string, drive: string | undefined): Promise<TreeCursor> => {
    // The token is captured BEFORE the walk: anything written during the walk
    // then shows up in the change feed instead of being missed.
    const token = await hooks.source(drive).startToken();
    folderCount = 1;
    return {
      v: 1,
      key: hooks.key,
      root: rootId,
      ...(drive ? { drive } : {}),
      token,
      folders: { [rootId]: ['', ''] },
      queue: [rootId],
    };
  };

  const pathOf = (cur: TreeCursor, folderId: string): string[] => {
    const names: string[] = [];
    let id = folderId;
    for (let depth = 0; depth < 256 && id !== cur.root; depth++) {
      const entry = cur.folders[id];
      if (!entry) break;
      names.push(entry[1]);
      id = entry[0];
    }
    return names.reverse();
  };

  const descendantsOf = (cur: TreeCursor, folderId: string): string[] => {
    const out: string[] = [];
    for (const id of Object.keys(cur.folders)) {
      let at = id;
      for (let depth = 0; depth < 256 && at && at !== cur.root; depth++) {
        if (at === folderId) {
          out.push(id);
          break;
        }
        at = cur.folders[at]?.[0] ?? '';
      }
    }
    return out;
  };

  try {
    if (!st) {
      const { rootId, drive } = await hooks.resolveRoot();
      st = await restart(rootId, drive);
      fresh = true;
    }
    const cur = (): TreeCursor => st!;
    let source = hooks.source(cur().drive);

    const enqueue = (id: string) => {
      const c = cur();
      if (!c.queue) c.queue = [];
      if (!c.queue.includes(id)) c.queue.push(id);
    };
    const pushTomb = (id: string) => {
      const c = cur();
      if (!c.tombs) c.tombs = [];
      if (!c.tombs.includes(id)) c.tombs.push(id);
    };
    const addFolder = (id: string, parentId: string, name: string): boolean => {
      const c = cur();
      if (id in c.folders) {
        c.folders[id] = [parentId, name];
        return true;
      }
      if (folderCount >= MAX_TRACKED_FOLDERS) {
        if (!truncated) {
          log.warn(
            `${hooks.provider}: more than ${MAX_TRACKED_FOLDERS} folders under the synced folder; deeper folders are not mirrored`,
          );
        }
        truncated = true;
        return false;
      }
      c.folders[id] = [parentId, name];
      folderCount++;
      return true;
    };
    const dropFolder = (id: string) => {
      const c = cur();
      for (const d of descendantsOf(c, id)) {
        delete c.folders[d];
        folderCount--;
      }
    };
    const markRemoved = (id: string) => {
      removed.add(id);
      records.delete(id);
      const c = cur();
      if (c.pending) c.pending = c.pending.filter((p) => p.id !== id);
    };
    const emitFile = (item: TreeItem): void => {
      const c = cur();
      if (!item.file || item.parentId === undefined || !(item.parentId in c.folders)) {
        markRemoved(item.id);
        return;
      }
      if (!records.has(item.id) && records.size >= limit) {
        c.pending = [...(c.pending ?? []).filter((p) => p.id !== item.id), item];
        return;
      }
      removed.delete(item.id);
      const file: CloudFile = { ...item.file, folders: pathOf(c, item.parentId) };
      const raw: TreeRefRaw = { file, ...(c.drive ? { drive: c.drive } : {}) };
      records.set(item.id, {
        id: item.id,
        ordinalKey: Date.parse(file.modified ?? file.created ?? '') || 0,
        ...(file.modified ? { ts: file.modified } : {}),
        raw,
      });
    };

    const applyFolder = (item: TreeItem) => {
      const c = cur();
      if (item.id === c.root) {
        if (item.trashed) throw new RootGoneSignal();
        return;
      }
      const known = item.id in c.folders;
      const parentIn =
        !item.trashed &&
        item.parentId !== undefined &&
        item.parentId !== item.id &&
        item.parentId in c.folders;
      if (known && parentIn) {
        const [parent, name] = c.folders[item.id]!;
        // Graph's delta repeats every ancestor of a changed item, so an
        // unchanged folder is the common case and must cost nothing.
        if (parent !== item.parentId || name !== item.name) {
          c.folders[item.id] = [item.parentId!, item.name];
          enqueue(item.id);
        }
      } else if (known) {
        dropFolder(item.id);
        pushTomb(item.id);
      } else if (parentIn && addFolder(item.id, item.parentId!, item.name)) {
        enqueue(item.id);
      }
    };

    const applyEvents = (events: TreeEvent[]) => {
      // The same item can appear more than once in a page; the last wins.
      const latest = new Map<string, TreeEvent>();
      for (const ev of events) {
        latest.delete(ev.id);
        latest.set(ev.id, ev);
      }
      const list = [...latest.values()];
      // Folders first, so a file whose folder appears later in the same page
      // still finds it.
      for (const ev of list) {
        if (ev.removed) {
          if (ev.id === cur().root) throw new RootGoneSignal();
          if (ev.id in cur().folders) {
            dropFolder(ev.id);
            pushTomb(ev.id);
          }
        } else if (ev.item.kind === 'folder') {
          applyFolder(ev.item);
        }
      }
      for (const ev of list) {
        if (ev.removed) markRemoved(ev.id);
        else if (ev.item.kind === 'file' && !ev.item.trashed) emitFile(ev.item);
        else if (ev.item.kind !== 'folder') markRemoved(ev.id);
      }
    };

    for (;;) {
      if (
        records.size >= limit ||
        pages >= MAX_PAGES_PER_CALL ||
        removed.size >= MAX_REMOVED_PER_CALL
      ) {
        break;
      }
      const c = cur();
      if (c.pending?.length) {
        const queued = c.pending;
        delete c.pending;
        for (const item of queued) emitFile(item);
        continue;
      }
      if (c.queue?.length) {
        const folderId = c.queue[0]!;
        if (!(folderId in c.folders)) {
          c.queue.shift();
          delete c.queueToken;
        } else {
          const page = await source.listChildren(folderId, {
            ...(c.queueToken ? { pageToken: c.queueToken } : {}),
            pageSize: Math.min(PAGE_MAX, limit - records.size),
            includeTrashed: false,
          });
          pages++;
          for (const item of page.items) {
            if (item.trashed) continue;
            if (item.kind === 'folder') {
              if (addFolder(item.id, folderId, item.name)) enqueue(item.id);
            } else if (item.kind === 'file') {
              if ((c.walked ?? 0) >= opts.maxFiles) {
                if (!truncated) {
                  log.info(
                    `${hooks.provider}: the folder walk reached its ${opts.maxFiles}-file limit; the rest is not mirrored`,
                  );
                }
                truncated = true;
                c.queue = [];
                break;
              }
              c.walked = (c.walked ?? 0) + 1;
              emitFile({ ...item, parentId: folderId });
            }
          }
          if (page.nextPageToken && c.queue.length > 0) c.queueToken = page.nextPageToken;
          else {
            c.queue.shift();
            delete c.queueToken;
          }
        }
        if (!c.queue?.length) {
          delete c.queue;
          delete c.queueToken;
          delete c.walked;
        }
        continue;
      }
      if (c.tombs?.length) {
        const folderId = c.tombs[0]!;
        if (folderId in c.folders) {
          c.tombs.shift();
          delete c.tombToken;
        } else {
          const page = await source.listChildren(folderId, {
            ...(c.tombToken ? { pageToken: c.tombToken } : {}),
            pageSize: PAGE_MAX,
            includeTrashed: true,
          });
          pages++;
          for (const item of page.items) {
            if (item.kind === 'folder') {
              if (!(item.id in c.folders)) pushTomb(item.id);
            } else markRemoved(item.id);
          }
          if (page.nextPageToken) c.tombToken = page.nextPageToken;
          else {
            c.tombs.shift();
            delete c.tombToken;
          }
        }
        if (!c.tombs.length) {
          delete c.tombs;
          delete c.tombToken;
        }
        continue;
      }
      if (reachedEnd) break;
      let page: Awaited<ReturnType<TreeSource['listChanges']>>;
      try {
        page = await source.listChanges(c.token, Math.min(PAGE_MAX, limit - records.size));
      } catch (err) {
        if (!(err instanceof CursorExpiredError) || expiredOnce) throw err;
        expiredOnce = true;
        log.info(
          `${hooks.provider}: change token no longer valid (${err.message}); resyncing the folder`,
        );
        st = await restart(c.root, c.drive);
        source = hooks.source(st.drive);
        fresh = true;
        continue;
      }
      pages++;
      applyEvents(page.events);
      if (page.newStartToken) {
        c.token = page.newStartToken;
        reachedEnd = true;
      } else if (page.nextToken) {
        c.token = page.nextToken;
      } else {
        reachedEnd = true;
      }
    }

    const final = cur();
    const moreWork =
      !reachedEnd || Boolean(final.pending?.length || final.queue?.length || final.tombs?.length);
    return {
      records: [...records.values()],
      cursor: final,
      ...(removed.size ? { removed: [...removed] } : {}),
      ...(moreWork ? { partial: true } : {}),
      // A walk that started and finished inside this one batch saw the whole
      // folder, so the engine may prune whatever it did not return.
      ...(!moreWork && fresh && !truncated ? { enumeratedAll: true } : {}),
    };
  } catch (err) {
    if (hooks.isThrottle(err)) {
      return {
        records: [...records.values()],
        cursor: (st ?? priorRaw) as TreeCursor,
        ...(removed.size ? { removed: [...removed] } : {}),
        rateLimited: true,
      };
    }
    if (err instanceof RootGoneSignal) {
      // Start over next pass: resolving the folder again either finds it
      // restored (a fresh walk reconciles the corpus) or fails with the
      // provider's own "not found / in the trash" message in `lastError`.
      log.warn(
        `${hooks.provider}: the synced folder was deleted or trashed; it will be re-resolved`,
      );
      return { records: [], cursor: { v: 1, key: hooks.key, root: '', token: '', folders: {} } };
    }
    throw err;
  }
}

/** The synced folder itself was deleted or trashed. */
class RootGoneSignal extends Error {
  constructor() {
    super('the synced folder is gone');
    this.name = 'RootGoneSignal';
  }
}

/** Read a tree-sync ref back in `fetchRecord`. */
export function treeRefRaw(ref: RecordRef): TreeRefRaw {
  const raw = ref.raw as Partial<TreeRefRaw> | undefined;
  const file = raw?.file;
  if (!file || typeof file.id !== 'string' || !Array.isArray(file.folders)) {
    throw new Error(`file reference ${ref.id} is missing its metadata`);
  }
  return { file, ...(typeof raw.drive === 'string' ? { drive: raw.drive } : {}) };
}

/**
 * Register the cloud-files family: `files-google-drive`, `files-onedrive`,
 * `files-sharepoint`. The adapter modules import this one, so they are loaded
 * on first construction rather than imported here.
 */
export function registerFilesAdapters(): void {
  registerNativeAdapter('files-google-drive', async (binding, deps) => {
    const { GoogleDriveFilesAdapter } = await import('./files-google-drive.js');
    return new GoogleDriveFilesAdapter(binding, deps);
  });
  registerNativeAdapter('files-onedrive', async (binding, deps) => {
    const { OneDriveFilesAdapter } = await import('./files-microsoft.js');
    return new OneDriveFilesAdapter(binding, deps);
  });
  registerNativeAdapter('files-sharepoint', async (binding, deps) => {
    const { SharePointFilesAdapter } = await import('./files-microsoft.js');
    return new SharePointFilesAdapter(binding, deps);
  });
}
