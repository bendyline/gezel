import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import { GitHubWikiAdapter, type GitHubWikiRuntime } from './github-wiki.js';

const COMMIT = 'a'.repeat(40);
const COMMIT_DATE = '2026-07-13T12:34:56-07:00';

interface GitCall {
  args: string[];
  opts?: Parameters<GitHubWikiRuntime['runGit']>[1];
}

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return {
    id: 'wiki-binding',
    type: 'github-wiki',
    config: { owner: 'octocat', repository: 'Hello-World', ...config },
  };
}

function deps(secret?: string): AdapterDeps {
  return {
    secrets: { get: async () => secret ?? null } as unknown as SecretStore,
    store: {} as Store,
  };
}

function fakeRuntime(files: Record<string, string>): {
  runtime: GitHubWikiRuntime;
  calls: GitCall[];
  removed: string[];
} {
  const calls: GitCall[] = [];
  const removed: string[] = [];
  const tracked = Object.entries(files)
    .map(([path, content]) => {
      const blobSha = createHash('sha1').update(content).digest('hex');
      return `100644 ${blobSha} 0\t${path}\0`;
    })
    .join('');
  const runtime: GitHubWikiRuntime = {
    isGitInstalled: async () => true,
    makeTempDir: () => mkdtemp(join(tmpdir(), 'gezel-wiki-test-')),
    removeTempDir: async (path) => {
      removed.push(path);
      await rm(path, { recursive: true, force: true });
    },
    runGit: async (args, opts) => {
      calls.push({ args: [...args], ...(opts ? { opts } : {}) });
      if (args.includes('clone')) {
        const checkout = args.at(-1)!;
        await mkdir(checkout, { recursive: true });
        for (const [path, content] of Object.entries(files)) {
          const target = join(checkout, ...path.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
        }
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') return { stdout: `${COMMIT}\n`, stderr: '' };
      if (args[0] === 'show') return { stdout: `${COMMIT_DATE}\n`, stderr: '' };
      if (args[0] === 'ls-files') return { stdout: tracked, stderr: '' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
  };
  return { runtime, calls, removed };
}

describe('GitHubWikiAdapter', () => {
  it('clones public wikis anonymously and normalizes supported page formats', async () => {
    const { runtime, calls, removed } = fakeRuntime({
      'Home.md': '# Welcome\n\nPublic documentation.',
      'guides/Setup-Guide.rst': 'Setup Guide\n===========',
      'assets/logo.png': 'not mirrored',
    });
    const adapter = new GitHubWikiAdapter(binding(), deps(), runtime);

    await adapter.ensureAuth();
    expect(await adapter.listScopes()).toEqual(['']);
    const batch = await adapter.listChangesSince('', undefined);
    expect(batch.records).toHaveLength(2);
    expect(batch.cursor).toEqual({ sha: COMMIT, offset: 2, complete: true });

    const clone = calls.find((call) => call.args.includes('clone'))!;
    expect(clone.args).toContain('https://github.com/octocat/Hello-World.wiki.git');
    expect(clone.args.join(' ')).not.toContain('http.extraheader');

    const guideRef = batch.records.find((record) => record.id.startsWith('guides/'))!;
    const guide = await adapter.fetchRecord('', guideRef);
    expect(guide).toMatchObject({
      recordId: guideRef.id,
      dirSegments: ['octocat-hello-world'],
      fileStem: 'setup-guide',
      frontmatter: {
        direction: 'inbound',
        title: 'Setup Guide',
        repository: 'octocat/Hello-World',
        path: 'guides/Setup-Guide.rst',
        format: 'rst',
        url: 'https://github.com/octocat/Hello-World/wiki/guides/Setup-Guide',
        commit: COMMIT,
        date: COMMIT_DATE,
      },
      bodyMarkdown: 'Setup Guide\n===========',
      scanOrigin: 'github-wiki',
    });

    await expect(
      adapter.fetchRecord('', {
        id: 'escape',
        raw: { path: '../outside.md', blobSha: 'b'.repeat(40) },
      }),
    ).rejects.toThrow('escaped its checkout');
    await adapter.close();
    expect(removed).toHaveLength(1);
  });

  it('sends an optional PAT via a redacted Git config header, never in the URL', async () => {
    const token = 'github_pat_PRIVATE_TEST';
    const { runtime, calls } = fakeRuntime({ 'Home.md': '# Private wiki' });
    const adapter = new GitHubWikiAdapter(
      binding({ host: 'github.example.test' }),
      deps(token),
      runtime,
    );

    await adapter.ensureAuth();
    const clone = calls.find((call) => call.args.includes('clone'))!;
    const joined = clone.args.join(' ');
    expect(joined).toContain('http.extraheader=AUTHORIZATION: Basic ');
    expect(joined).toContain('https://github.example.test/octocat/Hello-World.wiki.git');
    expect(joined).not.toContain(token);
    expect(clone.opts?.redact).toContain(token);
    await adapter.close();
  });

  it('continues wikis larger than the sync backfill limit without dropping pages', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `Page-${String(index).padStart(3, '0')}.md`,
        `page ${index}`,
      ]),
    );
    const { runtime } = fakeRuntime(files);
    const adapter = new GitHubWikiAdapter(binding(), deps(), runtime);

    await adapter.ensureAuth();
    const first = await adapter.listChangesSince('', undefined);
    expect(first.records).toHaveLength(500);
    expect(first.cursor).toEqual({ sha: COMMIT, offset: 500, complete: false });

    const second = await adapter.listChangesSince('', first.cursor);
    expect(second.records).toHaveLength(1);
    expect(second.cursor).toEqual({ sha: COMMIT, offset: 501, complete: true });

    const complete = await adapter.listChangesSince('', second.cursor);
    expect(complete.records).toEqual([]);
    expect(complete.cursor).toEqual(second.cursor);
    await adapter.close();
  });

  it('ships as a native mirror with an optional GitHub PAT', async () => {
    const catalog = new CatalogService([new BundledSource({ noIndex: true })]);
    const detail = await catalog.get('connector-type', 'github-wiki');
    expect(detail?.manifest.kind).toBe('connector-type');
    if (!detail || detail.manifest.kind !== 'connector-type') throw new Error('unreachable');

    expect(detail.manifest.driver).toBe('native');
    expect(detail.manifest.source).toEqual({ adapterId: 'github-wiki' });
    expect(detail.manifest.completeness).toBe('mirror');
    expect(detail.manifest.secretShape).toMatchObject({
      kind: 'apikey',
      label: 'GitHub personal access token',
      required: false,
    });
  });
});
