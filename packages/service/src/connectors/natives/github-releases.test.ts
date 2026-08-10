import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretKey, SecretStore } from '../../secrets/types.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';
import { GitHubReleasesAdapter, type GitHubReleasesRuntime } from './github-releases.js';

const ASSET_BYTES = Buffer.from('signed installer bytes');
const ASSET_SHA = createHash('sha256').update(ASSET_BYTES).digest('hex');

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return {
    id: 'release-binding',
    type: 'github-releases',
    config: { owner: 'octocat', repository: 'Hello-World', ...config },
  };
}

function deps(bindingToken?: string): AdapterDeps {
  const secrets = {
    get: async (key: SecretKey) =>
      key.kind === 'toolset' && key.toolsetId === 'connector-github-releases'
        ? (bindingToken ?? null)
        : null,
  } as unknown as SecretStore;
  return { secrets, store: {} as Store };
}

function release(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tag_name: `v${id}.0.0`,
    target_commitish: 'main',
    name: `Release ${id}`,
    body: `Notes for release ${id}`,
    draft: false,
    prerelease: false,
    immutable: false,
    created_at: `2026-07-${String(id).padStart(2, '0')}T00:00:00Z`,
    published_at: `2026-07-${String(id).padStart(2, '0')}T01:00:00Z`,
    author: { login: 'octocat' },
    html_url: `https://github.com/octocat/Hello-World/releases/tag/v${id}.0.0`,
    assets: [],
    ...overrides,
  };
}

function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77,
    name: 'hello-world.dmg',
    label: 'macOS installer',
    state: 'uploaded',
    content_type: 'application/x-apple-diskimage',
    size: ASSET_BYTES.length,
    digest: `sha256:${ASSET_SHA}`,
    download_count: 12,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:01:00Z',
    url: 'https://api.github.com/repos/octocat/Hello-World/releases/assets/77',
    browser_download_url:
      'https://github.com/octocat/Hello-World/releases/download/v1.0.0/hello-world.dmg',
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  headers: Headers;
}

function fakeRuntime(
  handler: (call: FetchCall) => Promise<Response> | Response,
  signedInToken: string | null = null,
): { runtime: GitHubReleasesRuntime; calls: FetchCall[]; removed: string[] } {
  const calls: FetchCall[] = [];
  const removed: string[] = [];
  return {
    calls,
    removed,
    runtime: {
      fetch: async (input, init) => {
        const call = { url: String(input), headers: new Headers(init?.headers) };
        calls.push(call);
        return handler(call);
      },
      makeTempDir: () => mkdtemp(join(tmpdir(), 'gezel-releases-test-')),
      removeTempDir: async (path) => {
        removed.push(path);
        await rm(path, { recursive: true, force: true });
      },
      signedInToken: async () => signedInToken,
    },
  };
}

describe('GitHubReleasesAdapter', () => {
  it('lists public releases anonymously, filters assets, and stages binary bytes on disk', async () => {
    const { runtime, calls, removed } = fakeRuntime((call) => {
      if (call.url.includes('/releases?')) {
        return Response.json([
          release(2, {
            assets: [asset(), asset({ id: 78, name: 'checksums.txt', size: 4 })],
          }),
          release(1),
        ]);
      }
      if (call.url.endsWith('/assets/77')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://objects.example.test/signed/hello-world.dmg' },
        });
      }
      if (call.url.startsWith('https://objects.example.test/')) return new Response(ASSET_BYTES);
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const adapter = new GitHubReleasesAdapter(
      binding({ maxReleases: 1, assetNamePattern: '*.dmg' }),
      deps(),
      runtime,
    );

    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('', undefined);
    expect(batch.records).toHaveLength(1);
    expect(batch.enumeratedAll).toBe(true);
    const normalized = await adapter.fetchRecord('', batch.records[0]!);
    expect(normalized).toMatchObject({
      recordId: '2',
      dirSegments: ['octocat-hello-world'],
      frontmatter: {
        tag: 'v2.0.0',
        draft: 'false',
        assetCount: '2',
        mirroredAssetCount: '1',
      },
      scanOrigin: 'github-releases',
    });
    expect(normalized.attachments).toHaveLength(1);
    const staged = normalized.attachments![0]!;
    expect(staged.sourcePath).toBeTypeOf('string');
    if (staged.sourcePath === undefined) throw new Error('expected file-backed attachment');
    await expect(readFile(staged.sourcePath)).resolves.toEqual(ASSET_BYTES);
    expect(staged.sha256).toBe(ASSET_SHA);
    expect(normalized.bodyMarkdown).toContain('checksums.txt');
    expect(calls.every((call) => !call.headers.has('authorization'))).toBe(true);

    await adapter.close();
    expect(removed).toHaveLength(1);
  });

  it('reuses signed-in GitHub auth for drafts and strips it from CDN redirects', async () => {
    const token = 'gho_signed_in_test';
    const { runtime, calls } = fakeRuntime((call) => {
      if (call.url.includes('/releases?')) {
        return Response.json([release(3, { draft: true, published_at: '', assets: [asset()] })]);
      }
      if (call.url.endsWith('/assets/77')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://objects.example.test/private/hello-world.dmg' },
        });
      }
      return new Response(ASSET_BYTES);
    }, token);
    const adapter = new GitHubReleasesAdapter(binding(), deps(), runtime);

    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('', undefined);
    const normalized = await adapter.fetchRecord('', batch.records[0]!);
    expect(normalized.frontmatter.draft).toBe('true');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(calls[1]!.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(calls[2]!.headers.has('authorization')).toBe(false);
    await adapter.close();
  });

  it('pages a stable release snapshot through the connector cursor', async () => {
    const { runtime, calls } = fakeRuntime((call) => {
      if (call.url.includes('/releases?'))
        return Response.json([release(3), release(2), release(1)]);
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const adapter = new GitHubReleasesAdapter(binding(), deps(), runtime);

    await adapter.ensureAuth();
    const first = await adapter.listChangesSince('', undefined, { limit: 2 });
    expect(first.records.map((record) => record.id)).toEqual(['3', '2']);
    expect(first.partial).toBe(true);
    const second = await adapter.listChangesSince('', first.cursor, { limit: 2 });
    expect(second.records.map((record) => record.id)).toEqual(['1']);
    expect(second.cursor.complete).toBe(true);
    const unchanged = await adapter.listChangesSince('', second.cursor, { limit: 2 });
    expect(unchanged.records).toEqual([]);
    expect(calls).toHaveLength(1);
    await adapter.close();
  });

  it('rejects an asset whose bytes do not match GitHub supplied integrity metadata', async () => {
    const { runtime } = fakeRuntime((call) => {
      if (call.url.includes('/releases?'))
        return Response.json([release(1, { assets: [asset()] })]);
      if (call.url.endsWith('/assets/77')) return new Response(Buffer.from('tampered payload'));
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const adapter = new GitHubReleasesAdapter(binding(), deps('github_pat_binding'), runtime);

    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('', undefined);
    await expect(adapter.fetchRecord('', batch.records[0]!)).rejects.toThrow(
      /size mismatch|digest mismatch/,
    );
    await adapter.close();
  });
});
