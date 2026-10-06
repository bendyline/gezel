import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FindFilesResponse } from '@bendyline/gezel';
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;
let client: GezelClient;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-find-files-route-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });
  const workspace = await svc.context.store.projectWorkspaceDir('default');
  for (const dir of ['src', 'many', 'node_modules', '.git']) {
    await mkdir(join(workspace, dir), { recursive: true });
  }
  await Promise.all([
    ...[
      'a.ts',
      'b.tsx',
      'c.js',
      'file-1.txt',
      'file-2.txt',
      'literal{x}.txt',
      'literal{1..1000000000}.txt',
    ].map((file) => writeFile(join(workspace, 'src', file), 'fixture')),
    writeFile(join(workspace, '.hidden.ts'), 'fixture'),
    writeFile(join(workspace, 'node_modules', 'hidden.ts'), 'fixture'),
    writeFile(join(workspace, '.git', 'hidden.ts'), 'fixture'),
    ...Array.from({ length: 80 }, (_, i) =>
      writeFile(join(workspace, 'many', `${i}.txt`), 'fixture'),
    ),
  ]);
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  if (home) await rm(home, { recursive: true, force: true });
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function findFiles(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/find-files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('find_files service route', () => {
  it('retains ordinary brace choices, path scoping, case options, and exclusions through the client', async () => {
    const result = await client.toolFindFiles('default', {
      glob: '**/*.{TS,TSX}',
      caseInsensitive: true,
    });
    expect(result.files.sort()).toEqual(['src/a.ts', 'src/b.tsx']);
    expect(result.truncated).toBe(false);
    const scoped = await client.toolFindFiles('default', { glob: '*.{ts,tsx}', path: 'src' });
    expect(scoped.files.sort()).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it.each([
    ['src/file-{1..2}.txt', ['src/file-1.txt', 'src/file-2.txt']],
    ['src/*.+(ts|tsx)', ['src/a.ts', 'src/b.tsx']],
    ['src/literal\\{x\\}.txt', ['src/literal{x}.txt']],
    ['src/"literal{1..1000000000}".txt', ['src/literal{1..1000000000}.txt']],
  ])('retains bounded ranges, extglobs, and escaped literals: %s', async (glob, files) => {
    const result = await client.toolFindFiles('default', { glob });
    expect(result.files.sort()).toEqual(files);
  });

  it('reports truncation with capped results, exact matches, and no matches', async () => {
    const capped = await client.toolFindFiles('default', { glob: 'many/*', maxResults: 3 });
    expect(capped.files).toHaveLength(3);
    expect(new Set(capped.files).size).toBe(3);
    expect(capped.truncated).toBe(true);
    const exact = await client.toolFindFiles('default', { glob: 'src/*.{ts,tsx}', maxResults: 2 });
    expect(exact.files).toHaveLength(2);
    expect(exact.truncated).toBe(false);
    await expect(client.toolFindFiles('default', { glob: 'missing-*' })).resolves.toEqual({
      files: [],
      truncated: false,
    });
  });

  it.each([
    `${'{'.repeat(4999)}x${'}'.repeat(4999)}`,
    `${'{'.repeat(9)}x${'}'.repeat(9)}`,
    `${'('.repeat(9)}x${')'.repeat(9)}`,
    '{a,b}'.repeat(30),
    '{1..1000000000}',
    '{1..12}{1..12}',
    '{"}"'.repeat(9) + '"{"}'.repeat(9),
    '{1.\u00a0.1000000000}',
    '**/*.{ts,tsx',
  ])('rejects unsafe globs with an actionable 422 instead of a parser 500', async (glob) => {
    const response = await findFiles({ glob });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('glob'),
    });
    const health = await httpFetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${svc.context.token}` },
    });
    expect(health.status).toBe(200);
  });

  it.each(['../outside/*', '{src,..}/*', '/tmp/*', '{src,/tmp}/*', 'C:/Windows/*'])(
    'rejects glob paths escaping the search directory: %s',
    async (glob) => {
      const response = await findFiles({ glob });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('relative paths'),
      });
    },
  );

  it('rejects oversized result limits at the HTTP boundary', async () => {
    const response = await findFiles({ glob: '**/*', maxResults: 5001 });
    expect(response.status).toBe(422);
  });
});
