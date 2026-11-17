/**
 * GitHub Releases connector. Release metadata becomes one normalized record
 * per release; uploaded release assets are streamed to private staging files
 * and handed to the shared connector writer as file-backed attachments.
 *
 * Public repositories work anonymously. A binding-specific PAT wins when
 * supplied; github.com bindings otherwise reuse Gezel's signed-in GitHub
 * credential (including `gh auth login` / GH_TOKEN ambient auth), which lets
 * users with push access mirror draft releases too.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { HttpStatusError, parseRetryAfterMs } from '@bendyline/gezel';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import { AmbientGitHubAuth } from '../../github/ambient.js';
import { getStoredGitHubToken } from '../../github/identity.js';
import { connectorSecretKey, registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedAttachment,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { slug } from '../writer.js';

const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;
const MAX_RELEASES = 10_000;
const MAX_REDIRECTS = 5;
const ambientGitHubAuth = new AmbientGitHubAuth();

interface GitHubReleasesConfig {
  owner: string;
  repository: string;
  apiBaseUrl: string;
  maxReleases?: number;
  includeDrafts: boolean;
  includePrereleases: boolean;
  downloadAssets: boolean;
  assetNamePattern?: string;
  maxAssetSizeMb?: number;
}

/**
 * What the corpus holds: a fingerprint per release (release id → 12 hex
 * characters over the release and the asset settings). A pass fetches only
 * releases whose fingerprint changed, so one new release or an edited note
 * no longer re-downloads every asset of every release.
 */
interface GitHubReleaseCursor {
  v: 2;
  seen: Record<string, string>;
}

/** The cursor shape before per-release fingerprints (one hash of the whole list). */
interface LegacyReleaseCursor {
  fingerprint: string;
  offset: number;
  complete: boolean;
}

interface GitHubReleaseAsset {
  id: number;
  name: string;
  label: string;
  state: string;
  contentType: string;
  size: number;
  digest?: string;
  createdAt: string;
  updatedAt: string;
  apiUrl: string;
  downloadUrl: string;
}

interface GitHubRelease {
  id: number;
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  createdAt: string;
  publishedAt: string;
  author: string;
  htmlUrl: string;
  assets: GitHubReleaseAsset[];
}

export interface GitHubReleasesRuntime {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  makeTempDir(): Promise<string>;
  removeTempDir(path: string): Promise<void>;
  signedInToken(secrets: SecretStore): Promise<string | null>;
}

const defaultRuntime: GitHubReleasesRuntime = {
  fetch: (input, init) => fetch(input, init),
  makeTempDir: () => mkdtemp(join(tmpdir(), 'gezel-github-releases-')),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
  signedInToken: async (secrets) =>
    (await getStoredGitHubToken(secrets)) ?? (await ambientGitHubAuth.getToken())?.token ?? null,
};

export class GitHubReleasesAdapter implements ConnectorAdapter {
  readonly typeId = 'github-releases';
  private config?: GitHubReleasesConfig;
  private token: string | null = null;
  /** The token is the app-wide sign-in, not one stored on this binding. */
  private tokenIsAmbient = false;
  private tempDir?: string;
  private releases?: GitHubRelease[];
  private fingerprint = '';

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: GitHubReleasesRuntime = defaultRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    const bindingToken = (
      await this.deps.secrets.get(connectorSecretKey(this.binding.type, this.binding.id))
    )?.trim();
    // A github.com connector participates in the app-wide GitHub sign-in.
    // Enterprise bindings only use their explicit per-binding credential, so
    // a github.com token can never leak to an operator-supplied host.
    const signedIn =
      !bindingToken && new URL(this.config.apiBaseUrl).origin === DEFAULT_API_BASE
        ? await this.runtime.signedInToken(this.deps.secrets)
        : null;
    this.token = bindingToken || signedIn?.trim() || null;
    this.tokenIsAmbient = !bindingToken && Boolean(this.token);
    this.tempDir = await this.runtime.makeTempDir();
  }

  async listScopes(): Promise<string[]> {
    this.assertReady();
    return [''];
  }

  async listChangesSince(
    _scope: string,
    cursor: unknown,
    opts?: { limit?: number },
  ): Promise<ChangeBatch<GitHubReleaseCursor>> {
    this.assertReady();
    await this.loadReleases();
    const releases = this.releases!;
    const fingerprints = new Map(releases.map((r) => [String(r.id), this.releaseFingerprint(r)]));
    const prior = parseCursor(cursor);
    let seen: Record<string, string>;
    if (prior && 'v' in prior) {
      seen = { ...prior.seen };
    } else if (prior?.complete && prior.fingerprint === this.fingerprint) {
      // A cursor from before per-release fingerprints, over a list that has
      // not changed since: everything it covered is already in the corpus.
      seen = Object.fromEntries(fingerprints);
    } else {
      seen = {};
    }
    const firstListing = Object.keys(seen).length === 0;

    // The listing is the whole configured window (a repository past the hard
    // cap fails instead), so a release no longer in it leaves the mirror.
    const removed: string[] = [];
    for (const id of Object.keys(seen)) {
      if (!fingerprints.has(id)) {
        removed.push(id);
        delete seen[id];
      }
    }

    const changed = releases.filter((r) => seen[String(r.id)] !== fingerprints.get(String(r.id)));
    const limit = Math.max(1, Math.min(MAX_RELEASES, opts?.limit ?? PAGE_SIZE));
    const selected = changed.slice(0, limit);
    for (const r of selected) seen[String(r.id)] = fingerprints.get(String(r.id))!;
    const partial = changed.length > selected.length;

    return {
      records: selected.map((release) => ({
        id: String(release.id),
        ordinalKey: Date.parse(release.publishedAt || release.createdAt) || release.id,
        ts: release.publishedAt || release.createdAt,
        raw: release,
      })),
      cursor: { v: 2, seen },
      ...(removed.length > 0 ? { removed } : {}),
      ...(partial ? { partial: true } : {}),
      ...(!partial && firstListing ? { enumeratedAll: true } : {}),
    };
  }

  /** A release's fingerprint, including the settings that decide its attachments. */
  private releaseFingerprint(release: GitHubRelease): string {
    const c = this.config!;
    const settings = [c.downloadAssets, c.assetNamePattern ?? '', c.maxAssetSizeMb ?? ''];
    return createHash('sha256')
      .update(JSON.stringify([release, settings]))
      .digest('hex')
      .slice(0, 12);
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    this.assertReady();
    const release = parseReleaseRef(ref.raw);
    const attachments: NormalizedAttachment[] = [];
    const mirrored = release.assets.filter(
      (asset) =>
        asset.state === 'uploaded' &&
        matchesAssetPattern(asset.name, this.config!.assetNamePattern) &&
        withinAssetSize(asset, this.config!.maxAssetSizeMb),
    );
    if (this.config!.downloadAssets) {
      for (const asset of mirrored) {
        attachments.push(await this.downloadAsset(release, asset));
      }
    }

    const title = release.name || release.tagName || `Release ${release.id}`;
    const repository = `${this.config!.owner}/${this.config!.repository}`;
    return {
      recordId: String(release.id),
      dirSegments: [slug(`${this.config!.owner}-${this.config!.repository}`, 64)],
      fileStem: slug(`${release.publishedAt || release.createdAt}-${release.tagName || title}`, 96),
      frontmatter: {
        direction: 'inbound',
        title,
        repository,
        tag: release.tagName,
        target: release.targetCommitish,
        author: release.author,
        draft: String(release.draft),
        prerelease: String(release.prerelease),
        immutable: String(release.immutable),
        createdAt: release.createdAt,
        publishedAt: release.publishedAt,
        assetCount: String(release.assets.length),
        mirroredAssetCount: String(attachments.length),
        url: release.htmlUrl,
      },
      bodyMarkdown: releaseMarkdown(release, mirrored, this.config!.downloadAssets),
      scanOrigin: 'github-releases',
      quarantineNamespace: 'github-releases',
      quarantineLabel: `GitHub release "${title}"`,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  async close(): Promise<void> {
    const tempDir = this.tempDir;
    this.tempDir = undefined;
    this.releases = undefined;
    if (tempDir) await this.runtime.removeTempDir(tempDir);
  }

  private assertReady(): void {
    if (!this.config || !this.tempDir) {
      throw new Error('GitHub Releases connector has not been initialized.');
    }
  }

  private async loadReleases(): Promise<void> {
    if (this.releases) return;
    const releases: GitHubRelease[] = [];
    const config = this.config!;
    for (let page = 1; releases.length < (config.maxReleases ?? MAX_RELEASES); page++) {
      const url = new URL(
        `${config.apiBaseUrl}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/releases`,
      );
      url.searchParams.set('per_page', String(PAGE_SIZE));
      url.searchParams.set('page', String(page));
      let response = await this.runtime.fetch(url, {
        headers: this.apiHeaders('application/vnd.github+json'),
      });
      if (response.status === 401 && this.tokenIsAmbient) {
        // The app-wide GitHub sign-in went stale: a public repository is
        // still readable without it, so try once more anonymously.
        void response.body?.cancel().catch(() => {});
        this.token = null;
        this.tokenIsAmbient = false;
        response = await this.runtime.fetch(url, {
          headers: this.apiHeaders('application/vnd.github+json'),
        });
      }
      if (!response.ok) throw await githubError(response, config, this.token !== null);
      const raw = (await response.json()) as unknown;
      if (!Array.isArray(raw)) throw new Error('GitHub returned a non-array releases response.');
      const parsed = raw.map(parseRelease);
      for (const release of parsed) {
        if (!config.includeDrafts && release.draft) continue;
        if (!config.includePrereleases && release.prerelease) continue;
        releases.push(release);
        if (releases.length >= (config.maxReleases ?? MAX_RELEASES)) break;
      }
      if (raw.length < PAGE_SIZE) break;
      if (page >= Math.ceil(MAX_RELEASES / PAGE_SIZE)) {
        throw new Error(
          `GitHub repository has more than ${MAX_RELEASES} releases; set "Latest releases" to a smaller window.`,
        );
      }
    }
    this.releases = releases;
    this.fingerprint = createHash('sha256').update(JSON.stringify(releases)).digest('hex');
  }

  private apiHeaders(accept: string): Record<string, string> {
    return {
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'Gezel-GitHub-Releases-Connector',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async downloadAsset(
    release: GitHubRelease,
    asset: GitHubReleaseAsset,
  ): Promise<NormalizedAttachment> {
    const apiOrigin = new URL(this.config!.apiBaseUrl).origin;
    let target = new URL(asset.apiUrl);
    if (target.origin !== apiOrigin) {
      throw new Error(`GitHub release asset API URL changed origin: ${asset.name}`);
    }

    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const sameOrigin = target.origin === apiOrigin;
      response = await this.runtime.fetch(target, {
        redirect: 'manual',
        headers: sameOrigin
          ? this.apiHeaders('application/octet-stream')
          : { 'User-Agent': 'Gezel-GitHub-Releases-Connector' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) throw new Error(`GitHub asset redirect had no location: ${asset.name}`);
      target = new URL(location, target);
      if (target.protocol !== 'https:') {
        throw new Error(`GitHub asset download refused a non-HTTPS redirect: ${asset.name}`);
      }
      await response.body?.cancel().catch(() => {});
      response = undefined;
    }
    if (!response)
      throw new Error(`GitHub asset exceeded ${MAX_REDIRECTS} redirects: ${asset.name}`);
    if (!response.ok || !response.body) {
      throw new Error(`GitHub asset download failed (${response.status}): ${asset.name}`);
    }
    if (response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`GitHub returned metadata instead of asset bytes: ${asset.name}`);
    }

    const releaseDir = join(this.tempDir!, String(release.id));
    await mkdir(releaseDir, { recursive: true });
    const sourcePath = join(releaseDir, `${asset.id}-${safeStagingName(asset.name)}`);
    await rm(sourcePath, { force: true });
    const { size, sha256 } = await streamResponseToFile(response, sourcePath);
    if (size !== asset.size) {
      await rm(sourcePath, { force: true });
      throw new Error(
        `GitHub asset size mismatch for ${asset.name}: expected ${asset.size}, downloaded ${size}`,
      );
    }
    const expectedDigest = parseSha256Digest(asset.digest);
    if (expectedDigest && expectedDigest !== sha256) {
      await rm(sourcePath, { force: true });
      throw new Error(`GitHub asset digest mismatch for ${asset.name}`);
    }
    return { filename: asset.name, sourcePath, size, sha256 };
  }
}

async function streamResponseToFile(
  response: Response,
  path: string,
): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, 'wx');
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('asset staging write made no progress');
        offset += bytesWritten;
      }
      hash.update(chunk);
      size += chunk.byteLength;
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  return { size, sha256: hash.digest('hex') };
}

function parseConfig(raw: Record<string, unknown> | undefined): GitHubReleasesConfig {
  const owner = stringField(raw?.owner);
  const repository = stringField(raw?.repository);
  const repoPart = /^[A-Za-z0-9._-]+$/;
  if (!owner || !repoPart.test(owner)) {
    throw new Error(
      'GitHub Releases owner is required and may contain letters, numbers, dot, dash, or underscore.',
    );
  }
  if (!repository || !repoPart.test(repository)) {
    throw new Error(
      'GitHub Releases repository is required and may contain letters, numbers, dot, dash, or underscore.',
    );
  }
  const apiBaseUrl = parseApiBaseUrl(stringField(raw?.apiBaseUrl) || DEFAULT_API_BASE);
  const maxReleases = optionalPositiveInt(raw?.maxReleases, 'Latest releases', MAX_RELEASES);
  const maxAssetSizeMb = optionalPositiveNumber(raw?.maxAssetSizeMb, 'Maximum asset size');
  return {
    owner,
    repository,
    apiBaseUrl,
    ...(maxReleases ? { maxReleases } : {}),
    includeDrafts: boolField(raw?.includeDrafts, true),
    includePrereleases: boolField(raw?.includePrereleases, true),
    downloadAssets: boolField(raw?.downloadAssets, true),
    ...(stringField(raw?.assetNamePattern)
      ? { assetNamePattern: stringField(raw?.assetNamePattern) }
      : {}),
    ...(maxAssetSizeMb ? { maxAssetSizeMb } : {}),
  };
}

function parseApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('GitHub API base URL must be an absolute HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'GitHub API base URL must be an absolute HTTPS URL without credentials or a query.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function parseRelease(raw: unknown): GitHubRelease {
  const value = objectValue(raw, 'GitHub release');
  const assets = Array.isArray(value.assets) ? value.assets.map(parseAsset) : [];
  return {
    id: integerField(value.id, 'GitHub release id'),
    tagName: stringField(value.tag_name),
    targetCommitish: stringField(value.target_commitish),
    name: stringField(value.name),
    body: stringField(value.body),
    draft: value.draft === true,
    prerelease: value.prerelease === true,
    immutable: value.immutable === true,
    createdAt: stringField(value.created_at),
    publishedAt: stringField(value.published_at),
    author: stringField(objectValueOrEmpty(value.author).login),
    htmlUrl: stringField(value.html_url),
    assets,
  };
}

function parseAsset(raw: unknown): GitHubReleaseAsset {
  const value = objectValue(raw, 'GitHub release asset');
  return {
    id: integerField(value.id, 'GitHub release asset id'),
    name: stringField(value.name) || `asset-${String(value.id ?? 'unknown')}`,
    label: stringField(value.label),
    state: stringField(value.state),
    contentType: stringField(value.content_type),
    size: nonNegativeInt(value.size, 'GitHub release asset size'),
    ...(stringField(value.digest) ? { digest: stringField(value.digest) } : {}),
    createdAt: stringField(value.created_at),
    updatedAt: stringField(value.updated_at),
    apiUrl: stringField(value.url),
    downloadUrl: stringField(value.browser_download_url),
  };
}

function parseReleaseRef(raw: unknown): GitHubRelease {
  if (!raw || typeof raw !== 'object') throw new Error('GitHub release reference is missing.');
  return raw as GitHubRelease;
}

function parseCursor(raw: unknown): GitHubReleaseCursor | LegacyReleaseCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.v === 2 && value.seen && typeof value.seen === 'object') {
    const seen: Record<string, string> = {};
    for (const [id, fp] of Object.entries(value.seen as Record<string, unknown>)) {
      if (typeof fp === 'string') seen[id] = fp;
    }
    return { v: 2, seen };
  }
  if (
    typeof value.fingerprint !== 'string' ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0 ||
    typeof value.complete !== 'boolean'
  ) {
    return undefined;
  }
  return {
    fingerprint: value.fingerprint,
    offset: value.offset as number,
    complete: value.complete,
  };
}

function matchesAssetPattern(filename: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  return pattern
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => globRegex(part).test(filename));
}

function globRegex(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${source}$`, 'i');
}

function withinAssetSize(asset: GitHubReleaseAsset, maxMb: number | undefined): boolean {
  return maxMb === undefined || asset.size <= maxMb * 1024 * 1024;
}

function releaseMarkdown(
  release: GitHubRelease,
  mirrored: GitHubReleaseAsset[],
  downloadAssets: boolean,
): string {
  const title = release.name || release.tagName || `Release ${release.id}`;
  const lines = [
    `# ${title}`,
    '',
    release.body || '_No release notes were provided._',
    '',
    '## Release assets',
    '',
    '| Name | Type | Bytes | SHA-256 | Mirrored |',
    '| --- | --- | ---: | --- | --- |',
  ];
  for (const asset of release.assets) {
    const selected = mirrored.some((candidate) => candidate.id === asset.id);
    const digest = parseSha256Digest(asset.digest) ?? '';
    lines.push(
      `| ${escapeTable(asset.name)} | ${escapeTable(asset.contentType)} | ${asset.size} | ${digest || 'not supplied'} | ${downloadAssets && selected ? 'yes' : 'no'} |`,
    );
  }
  if (release.assets.length === 0) lines.push('| _No uploaded assets_ |  | 0 |  | no |');
  return lines.join('\n');
}

async function githubError(
  response: Response,
  config: GitHubReleasesConfig,
  authenticated: boolean,
): Promise<Error> {
  const detail = (await response.text()).slice(0, 240).replace(/\s+/g, ' ').trim();
  const repo = `${config.owner}/${config.repository}`;
  if (response.status === 401) {
    return new Error('GitHub rejected the current credential. Sign in again or replace the token.');
  }
  if (response.status === 404) {
    return new Error(
      `GitHub repository ${repo} was not found or is not accessible${authenticated ? ' with the current credential' : ' anonymously; sign in for private or draft releases'}.`,
    );
  }
  if (response.status === 429 || (response.status === 403 && isGitHubRateLimit(response))) {
    // Backpressure, not a failure: the engine backs the binding off until
    // GitHub's reset time instead of reporting an error a person must read.
    const retryAfterMs = gitHubRetryAfterMs(response);
    return new HttpStatusError(
      429,
      `GitHub rate limit reached for ${repo}. ${detail}`,
      retryAfterMs !== undefined ? { retryAfterMs } : {},
    );
  }
  if (response.status === 403) {
    return new Error(`GitHub's access policy blocked releases for ${repo}. ${detail}`);
  }
  return new Error(`GitHub releases request failed (${response.status}) for ${repo}. ${detail}`);
}

/** GitHub answers an exhausted quota or a secondary limit with 403. */
function isGitHubRateLimit(response: Response): boolean {
  return (
    response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
  );
}

/** `Retry-After`, else the quota's `x-ratelimit-reset` (epoch seconds). */
function gitHubRetryAfterMs(response: Response): number | undefined {
  const asked = parseRetryAfterMs(response.headers.get('retry-after'));
  if (asked !== undefined) return asked;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset * 1000 > Date.now()
    ? reset * 1000 - Date.now()
    : undefined;
}

function parseSha256Digest(value: string | undefined): string | undefined {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value ?? '');
  return match?.[1]?.toLowerCase();
}

function safeStagingName(value: string): string {
  return (
    basename(value)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 160) || 'asset'
  );
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boolField(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function optionalPositiveInt(value: unknown, label: string, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${label} must be an integer from 1 to ${max}.`);
  }
  return parsed;
}

function optionalPositiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than 0.`);
  return parsed;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function objectValueOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integerField(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${label} is malformed.`);
  return value as number;
}

function nonNegativeInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} is malformed.`);
  return value as number;
}

/** Register the GitHub Releases native adapter. */
export function registerGitHubReleasesAdapters(): void {
  // The transport comes from the deps like every other native adapter's, so
  // tests and the provider simulator reach this one too.
  registerNativeAdapter('github-releases', async (binding, deps) =>
    Promise.resolve(
      new GitHubReleasesAdapter(
        binding,
        deps,
        deps.fetch ? { ...defaultRuntime, fetch: deps.fetch } : defaultRuntime,
      ),
    ),
  );
}
