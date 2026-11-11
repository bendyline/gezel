/**
 * The few Hugging Face Hub calls a model review needs: the repo's metadata,
 * its file listing at one commit, and the first megabytes of one GGUF. Plain
 * HTTPS with Gezel's honest User-Agent, and the optional HF_TOKEN only toward
 * huggingface.co itself (never a CDN), exactly like the installer.
 */

import {
  type HubRepoFile,
  awakeTimeoutSignal,
  baseModelRefs,
  isHubCommitId,
} from '@bendyline/gezel';
import { huggingFaceRequestHeaders } from '../../utils/download-common.js';

const HUB = 'https://huggingface.co';
const API_TIMEOUT_MS = 20_000;
const RANGE_TIMEOUT_MS = 60_000;
/** The tree API pages at 1,000 entries; a GGUF repo past this many is not one to offer. */
const MAX_TREE_PAGES = 10;

/** A failure a person can act on, with the HTTP status the review route answers. */
export class HubRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HubRequestError';
    this.status = status;
  }
}

export interface HubModelInfo {
  id: string;
  /** Commit the default branch points at. */
  sha: string;
  gated: false | 'auto' | 'manual';
  private: boolean;
  disabled: boolean;
  author?: string;
  license?: string;
  tags: string[];
  /** `cardData.base_model` as `owner/name`: what this repo was made from. */
  baseModels: string[];
}

function repoPath(repo: string): string {
  return repo
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

async function hubFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  try {
    return await fetchImpl(url, {
      ...rest,
      headers: { ...huggingFaceRequestHeaders(url), ...(rest.headers ?? {}) },
      signal: awakeTimeoutSignal(timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new HubRequestError(`Couldn't reach Hugging Face (${reason}).`, 502);
  }
}

function describeStatus(res: Response, what: string): HubRequestError {
  if (res.status === 401 || res.status === 404) {
    return new HubRequestError(
      `Hugging Face has no public ${what} by that name. Check the link, or whether the model is private.`,
      404,
    );
  }
  if (res.status === 403) {
    return new HubRequestError(`Hugging Face refused access to that ${what}.`, 403);
  }
  if (res.status === 429) {
    return new HubRequestError(
      'Hugging Face is limiting requests right now. Try again in a minute.',
      429,
    );
  }
  return new HubRequestError(`Hugging Face answered ${res.status} for that ${what}.`, 502);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function fetchHubModelInfo(
  fetchImpl: typeof fetch,
  repo: string,
): Promise<HubModelInfo> {
  const res = await hubFetch(fetchImpl, `${HUB}/api/models/${repoPath(repo)}`);
  if (!res.ok) throw describeStatus(res, 'model');
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.sha !== 'string' || !isHubCommitId(body.sha)) {
    throw new HubRequestError('Hugging Face returned an unreadable answer for that model.', 502);
  }
  const gatedRaw = body.gated;
  const gated: HubModelInfo['gated'] =
    gatedRaw === 'auto' || gatedRaw === 'manual' ? gatedRaw : gatedRaw === true ? 'manual' : false;
  const card = (body.cardData ?? {}) as Record<string, unknown>;
  const license =
    stringField(card.license_name) ??
    (Array.isArray(card.license) ? stringField(card.license[0]) : stringField(card.license));
  const author = stringField(body.author);
  return {
    id: stringField(body.id) ?? repo,
    sha: body.sha,
    gated,
    private: body.private === true,
    disabled: body.disabled === true,
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    baseModels: baseModelRefs([card.base_model]),
    tags: Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 64)
      : [],
  };
}

/** Resolve a branch or tag to the commit it names now. */
export async function fetchHubCommit(
  fetchImpl: typeof fetch,
  repo: string,
  revision: string,
): Promise<string> {
  if (isHubCommitId(revision)) return revision;
  const res = await hubFetch(
    fetchImpl,
    `${HUB}/api/models/${repoPath(repo)}/revision/${encodeURIComponent(revision)}`,
  );
  if (!res.ok) throw describeStatus(res, 'revision');
  const body = (await res.json().catch(() => null)) as { sha?: unknown } | null;
  if (!body || typeof body.sha !== 'string' || !isHubCommitId(body.sha)) {
    throw new HubRequestError('Hugging Face returned no commit for that revision.', 502);
  }
  return body.sha;
}

interface RawTreeEntry {
  type?: string;
  path?: unknown;
  size?: unknown;
  lfs?: { oid?: unknown; size?: unknown } | null;
}

function nextPage(link: string | null): string | null {
  if (!link) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  if (!match) return null;
  try {
    const url = new URL(match[1] as string);
    return url.origin === HUB ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Every file in the repo at `commit`, with the SHA-256 the Hub stores for LFS files. */
export async function fetchHubTree(
  fetchImpl: typeof fetch,
  repo: string,
  commit: string,
): Promise<HubRepoFile[]> {
  const files: HubRepoFile[] = [];
  let url: string | null =
    `${HUB}/api/models/${repoPath(repo)}/tree/${encodeURIComponent(commit)}?recursive=true`;
  for (let page = 0; url && page < MAX_TREE_PAGES; page++) {
    const res = await hubFetch(fetchImpl, url);
    if (!res.ok) throw describeStatus(res, 'model');
    const entries = (await res.json().catch(() => null)) as RawTreeEntry[] | null;
    if (!Array.isArray(entries)) {
      throw new HubRequestError('Hugging Face returned an unreadable file list.', 502);
    }
    for (const entry of entries) {
      if (entry.type !== 'file' || typeof entry.path !== 'string') continue;
      const lfsOid = typeof entry.lfs?.oid === 'string' ? entry.lfs.oid.toLowerCase() : undefined;
      const size =
        typeof entry.lfs?.size === 'number'
          ? entry.lfs.size
          : typeof entry.size === 'number'
            ? entry.size
            : 0;
      files.push({
        path: entry.path,
        sizeBytes: Math.max(0, Math.floor(size)),
        ...(lfsOid && /^[a-f0-9]{64}$/.test(lfsOid) ? { sha256: lfsOid } : {}),
      });
    }
    url = nextPage(res.headers.get('link'));
  }
  return files;
}

/**
 * The first `bytes` of one file at a pinned commit. The Hub redirects to its
 * CDN, which honors the range; a server that ignores it and starts a full
 * download is cut off at `bytes`, so a review never pulls a whole model.
 */
export async function fetchHubFilePrefix(
  fetchImpl: typeof fetch,
  repo: string,
  commit: string,
  path: string,
  bytes: number,
): Promise<Buffer> {
  const url = `${HUB}/${repoPath(repo)}/resolve/${encodeURIComponent(commit)}/${path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
  const res = await hubFetch(fetchImpl, url, {
    headers: { Range: `bytes=0-${bytes - 1}` },
    timeoutMs: RANGE_TIMEOUT_MS,
  });
  if (!res.ok) throw describeStatus(res, 'file');
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < bytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = Buffer.concat(chunks);
  return joined.length > bytes ? joined.subarray(0, bytes) : joined;
}

/**
 * A small file (a config, a tokenizer list) in full, at a pinned commit.
 * Throws past `maxBytes`, so a file named config.json cannot be made to
 * stream gigabytes into memory.
 */
export async function fetchHubSmallFile(
  fetchImpl: typeof fetch,
  repo: string,
  commit: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const bytes = await fetchHubFilePrefix(fetchImpl, repo, commit, path, maxBytes + 1);
  if (bytes.length > maxBytes) {
    throw new HubRequestError(`${path} is larger than a configuration file should be.`, 422);
  }
  return bytes;
}
