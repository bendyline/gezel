/**
 * GitHub wiki connector. GitHub exposes each wiki as a separate Git repository
 * rather than through the REST API, so a shallow, disposable clone is the
 * read-only transport for a normalized page corpus. Public wikis clone
 * anonymously; a binding may carry a PAT for private repositories.
 *
 * Each pass first asks the remote for its HEAD (`git ls-remote`, one round
 * trip). A wiki that has not moved since the last complete pass is never
 * cloned; one that has is cloned shallowly and listed.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { realpathContained, safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { type RunGitOptions, type RunGitResult, isGitInstalled, runGit } from '../../git/git.js';
import { connectorSecretKey, registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { slug } from '../writer.js';

const DEFAULT_HOST = 'github.com';
const PAGE_BATCH_SIZE = 500;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  '.adoc',
  '.asc',
  '.asciidoc',
  '.creole',
  '.markdown',
  '.md',
  '.mdown',
  '.mediawiki',
  '.mkdn',
  '.org',
  '.pod',
  '.rdoc',
  '.rst',
  '.textile',
  '.wiki',
]);

interface GitHubWikiConfig {
  owner: string;
  repository: string;
  host: string;
}

interface GitHubWikiCursor {
  sha: string;
  offset: number;
  complete: boolean;
}

interface WikiPage {
  path: string;
  blobSha: string;
}

export interface GitHubWikiRuntime {
  runGit(args: string[], opts?: RunGitOptions): Promise<RunGitResult>;
  isGitInstalled(): Promise<boolean>;
  makeTempDir(): Promise<string>;
  removeTempDir(path: string): Promise<void>;
}

const defaultRuntime: GitHubWikiRuntime = {
  runGit,
  isGitInstalled,
  makeTempDir: () => mkdtemp(join(tmpdir(), 'gezel-github-wiki-')),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
};

export class GitHubWikiAdapter implements ConnectorAdapter {
  readonly typeId = 'github-wiki';
  private config?: GitHubWikiConfig;
  private tempDir?: string;
  private checkoutDir?: string;
  private commitSha = '';
  private commitDate = '';
  private pages: WikiPage[] = [];
  /** The remote's HEAD from `ls-remote`, when the probe answered. */
  private remoteSha = '';
  private cloneUrl = '';
  private gitAuth: { args: string[]; redact: string[] } = { args: [], redact: [] };

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly runtime: GitHubWikiRuntime = defaultRuntime,
  ) {}

  async ensureAuth(): Promise<void> {
    this.config = parseConfig(this.binding.config);
    if (!(await this.runtime.isGitInstalled())) {
      throw new Error('Git is required to sync GitHub wikis, but it is not installed or on PATH.');
    }

    const secret = await this.deps.secrets.get(
      connectorSecretKey(this.binding.type, this.binding.id),
    );
    const token = secret?.trim() ?? '';
    this.cloneUrl = `https://${this.config.host}/${this.config.owner}/${this.config.repository}.wiki.git`;
    const args: string[] = [];
    const redact: string[] = [];
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      const authHeader = `AUTHORIZATION: Basic ${basic}`;
      // Scoped to the wiki's host, so a redirect elsewhere never receives it.
      args.push('-c', `http.https://${this.config.host}/.extraheader=${authHeader}`);
      redact.push(token, basic, authHeader);
    }
    this.gitAuth = { args, redact };

    // The cheap probe; when it cannot answer, the clone below will say why.
    try {
      const head = await this.runtime.runGit([...args, 'ls-remote', '--', this.cloneUrl, 'HEAD'], {
        redact,
      });
      this.remoteSha = /^([0-9a-f]{40,64})\s/m.exec(head.stdout)?.[1] ?? '';
    } catch {
      this.remoteSha = '';
    }
    if (!this.remoteSha) await this.checkout();
  }

  /** Clone the wiki shallowly and read its page list (once per pass). */
  private async checkout(): Promise<void> {
    if (this.checkoutDir && this.commitSha) return;
    const config = this.config!;
    this.tempDir = await this.runtime.makeTempDir();
    this.checkoutDir = join(this.tempDir, 'wiki');
    const args = [
      ...this.gitAuth.args,
      'clone',
      '--depth=1',
      '--single-branch',
      '--no-tags',
      '--',
      this.cloneUrl,
      this.checkoutDir,
    ];
    const redact = this.gitAuth.redact;
    try {
      await this.runtime.runGit(args, { redact });
      const [commit, date, files] = await Promise.all([
        this.runtime.runGit(['rev-parse', 'HEAD'], { cwd: this.checkoutDir }),
        this.runtime.runGit(['show', '-s', '--format=%cI', 'HEAD'], { cwd: this.checkoutDir }),
        this.runtime.runGit(['ls-files', '-s', '-z'], { cwd: this.checkoutDir }),
      ]);
      this.commitSha = commit.stdout.trim();
      this.commitDate = date.stdout.trim();
      this.pages = parseTrackedPages(files.stdout);
      if (!this.commitSha) throw new Error('the cloned wiki has no HEAD commit');
    } catch (error) {
      await this.cleanup();
      const detail = error instanceof Error ? ` ${error.message}` : '';
      throw new Error(
        `Unable to read the GitHub wiki for ${config.owner}/${config.repository}. ` +
          `Check that the wiki exists and that the optional PAT can access the repository.${detail}`,
      );
    }
  }

  async listScopes(): Promise<string[]> {
    if (!this.config) throw new Error('GitHub wiki connector has not been initialized.');
    return [''];
  }

  async listChangesSince(
    _scope: string,
    cursor: unknown,
    opts?: { limit?: number },
  ): Promise<ChangeBatch<GitHubWikiCursor>> {
    if (!this.config) throw new Error('GitHub wiki connector has not been initialized.');
    const prior = parseCursor(cursor);
    // The remote has not moved since the last complete pass: no clone.
    if (prior?.complete && this.remoteSha && prior.sha === this.remoteSha) {
      return { records: [], cursor: prior };
    }
    await this.checkout();
    this.assertReady();
    if (prior?.sha === this.commitSha && prior.complete) {
      return { records: [], cursor: prior };
    }

    const batchSize = Math.max(1, Math.min(PAGE_BATCH_SIZE, opts?.limit ?? PAGE_BATCH_SIZE));
    const offset = prior?.sha === this.commitSha ? Math.min(prior.offset, this.pages.length) : 0;
    const pageSlice = this.pages.slice(offset, offset + batchSize);
    const nextOffset = offset + pageSlice.length;
    const nextCursor: GitHubWikiCursor = {
      sha: this.commitSha,
      offset: nextOffset,
      complete: nextOffset >= this.pages.length,
    };
    return {
      records: pageSlice.map((page) => ({
        id: `${page.path}:${page.blobSha}`,
        raw: page,
        ...(this.commitDate ? { ts: this.commitDate } : {}),
      })),
      cursor: nextCursor,
      ...(nextCursor.complete ? {} : { partial: true }),
      // A single batch from the start is the whole wiki; a list spread over
      // batches is reconciled once its last batch lands.
      ...(nextCursor.complete && offset === 0
        ? { enumeratedAll: true }
        : { fullListing: { first: offset === 0, last: nextCursor.complete } }),
    };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    await this.checkout();
    this.assertReady();
    const page = parsePageRef(ref.raw);
    const pagePath = safeJoin(this.checkoutDir!, page.path);
    if (!pagePath || !(await realpathContained(this.checkoutDir!, pagePath))) {
      throw new Error(`GitHub wiki page escaped its checkout: ${page.path}`);
    }
    const info = await stat(pagePath);
    if (!info.isFile()) throw new Error(`GitHub wiki page is not a regular file: ${page.path}`);

    const title = pageTitle(page.path);
    const bodyMarkdown =
      info.size <= MAX_PAGE_BYTES
        ? await readFile(pagePath, 'utf8')
        : `This wiki page was not mirrored because it is larger than ${MAX_PAGE_BYTES} bytes.`;
    const format = extname(page.path).slice(1).toLowerCase();
    const repository = `${this.config!.owner}/${this.config!.repository}`;
    return {
      // The page path is the record identity, so an edited page refreshes in
      // place instead of accumulating revisions. Repo-global fields (HEAD
      // commit sha/date) deliberately stay out of the frontmatter: they change
      // on every wiki commit and would churn every page's content hash.
      recordId: page.path,
      dirSegments: [slug(`${this.config!.owner}-${this.config!.repository}`, 64)],
      fileStem: slug(title, 72),
      frontmatter: {
        direction: 'inbound',
        title,
        repository,
        path: page.path,
        format,
        url: wikiPageUrl(this.config!, page.path),
      },
      bodyMarkdown,
      scanOrigin: 'github-wiki',
      quarantineNamespace: 'github-wiki',
      quarantineLabel: `Wiki page "${title}"`,
    };
  }

  async close(): Promise<void> {
    await this.cleanup();
  }

  private assertReady(): void {
    if (!this.config || !this.checkoutDir || !this.commitSha) {
      throw new Error('GitHub wiki connector has not been initialized.');
    }
  }

  private async cleanup(): Promise<void> {
    const tempDir = this.tempDir;
    this.tempDir = undefined;
    this.checkoutDir = undefined;
    this.commitSha = '';
    this.pages = [];
    if (tempDir) await this.runtime.removeTempDir(tempDir);
  }
}

function parseConfig(raw: Record<string, unknown> | undefined): GitHubWikiConfig {
  const owner = typeof raw?.owner === 'string' ? raw.owner.trim() : '';
  const repository = typeof raw?.repository === 'string' ? raw.repository.trim() : '';
  const host = typeof raw?.host === 'string' && raw.host.trim() ? raw.host.trim() : DEFAULT_HOST;
  const repoPart = /^[A-Za-z0-9._-]+$/;
  if (!owner || !repoPart.test(owner)) {
    throw new Error(
      'GitHub wiki owner is required and may contain letters, numbers, dot, dash, or underscore.',
    );
  }
  if (!repository || !repoPart.test(repository)) {
    throw new Error(
      'GitHub wiki repository is required and may contain letters, numbers, dot, dash, or underscore.',
    );
  }
  if (!isValidHost(host)) {
    throw new Error(
      'GitHub wiki host must be a hostname with an optional port, not a URL or path.',
    );
  }
  return { owner, repository, host };
}

function isValidHost(host: string): boolean {
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) || host.includes('..')) return false;
  try {
    const parsed = new URL(`https://${host}`);
    const port = parsed.port ? Number(parsed.port) : 443;
    return parsed.pathname === '/' && port > 0 && port <= 65_535;
  } catch {
    return false;
  }
}

function parseTrackedPages(output: string): WikiPage[] {
  const pages: WikiPage[] = [];
  for (const entry of output.split('\0')) {
    if (!entry) continue;
    const match = /^(100644|100755) ([0-9a-f]{40,64}) \d\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const path = match[3]!.replaceAll('\\', '/');
    if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    pages.push({ path, blobSha: match[2]! });
  }
  return pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function parseCursor(raw: unknown): GitHubWikiCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.sha !== 'string' ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0 ||
    typeof value.complete !== 'boolean'
  ) {
    return undefined;
  }
  return {
    sha: value.sha,
    offset: value.offset as number,
    complete: value.complete,
  };
}

function parsePageRef(raw: unknown): WikiPage {
  if (!raw || typeof raw !== 'object') throw new Error('GitHub wiki page reference is missing.');
  const value = raw as Record<string, unknown>;
  if (
    typeof value.path !== 'string' ||
    !value.path ||
    typeof value.blobSha !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(value.blobSha)
  ) {
    throw new Error('GitHub wiki page reference is malformed.');
  }
  return { path: value.path, blobSha: value.blobSha };
}

function pageTitle(path: string): string {
  const name = basename(path, extname(path));
  return name.replaceAll('-', ' ').trim() || 'Untitled';
}

function wikiPageUrl(config: GitHubWikiConfig, path: string): string {
  const withoutExtension = path.slice(0, -extname(path).length);
  const encodedPage = withoutExtension.split('/').map(encodeURIComponent).join('/');
  return `https://${config.host}/${config.owner}/${config.repository}/wiki/${encodedPage}`;
}

/** Register the GitHub wiki native adapter. */
export function registerGitHubWikiAdapters(): void {
  registerNativeAdapter('github-wiki', async (binding, deps) =>
    Promise.resolve(new GitHubWikiAdapter(binding, deps)),
  );
}
