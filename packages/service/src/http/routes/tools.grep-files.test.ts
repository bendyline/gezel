import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchFilesResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let home: string;
let outsideDir: string;
let workspaceDir: string;
let baseUrl: string;
let httpFetch: typeof fetch;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-grep-route-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'gezel-grep-route-outside-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  workspaceDir = await svc.context.store.projectWorkspaceDir('default');
  await mkdir(join(workspaceDir, 'src'), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspaceDir, 'src', 'options.txt'),
      'before\n--pre=echo-owned\nafter\n--pre=echo-owned again\n',
    ),
    writeFile(join(outsideDir, 'sentinel.txt'), '--pre=echo-owned outside\n'),
  ]);
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ]);
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function grep(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/search-files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('grep_files service route', () => {
  it('treats option-looking input as data and returns context for a regular-file path', async () => {
    const response = await grep({
      path: 'src/options.txt',
      pattern: '--pre=echo-owned',
      literal: true,
      contextLines: 1,
      maxResults: 1,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchFilesResponse;
    expect(body).toMatchObject({
      mode: 'matches',
      truncated: true,
      truncationReason: 'limit',
      nextCursor: 1,
    });
    expect(body.matches).toEqual([
      {
        path: 'src/options.txt',
        line: 2,
        text: '--pre=echo-owned',
        before: [{ line: 1, text: 'before' }],
        after: [{ line: 3, text: 'after' }],
      },
    ]);
  });

  it('continues from a cursor without falsely truncating the final page', async () => {
    const response = await grep({
      path: 'src/options.txt',
      pattern: '--pre=echo-owned',
      literal: true,
      cursor: 1,
      maxResults: 1,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchFilesResponse;
    expect(body.matches).toEqual([
      { path: 'src/options.txt', line: 4, text: '--pre=echo-owned again' },
    ]);
    expect(body.truncated).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });

  it('returns structured path errors for missing and symlink-escaping targets', async () => {
    const missing = await grep({ path: 'missing', pattern: 'x', literal: true });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: 'path-not-found' });

    if (process.platform === 'win32') return;
    await symlink(outsideDir, join(workspaceDir, 'escape'), 'dir');
    const escaping = await grep({ path: 'escape', pattern: 'owned', literal: true });
    expect(escaping.status).toBe(403);
    await expect(escaping.json()).resolves.toMatchObject({ code: 'path-safety' });
  });
});
