import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadWorkspaceFilesResponse } from '@bendyline/gezel';
import { WORKSPACE_READ_MAX_FILES } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-read-files-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  const workspaceDir = await svc.context.store.projectWorkspaceDir('default');
  await mkdir(join(workspaceDir, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(workspaceDir, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n'),
    writeFile(join(workspaceDir, 'src', 'b.ts'), 'alpha\nbeta\n'),
  ]);
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true });
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function readFiles(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/read-files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('read_files service route', () => {
  it('returns mixed results in request order without discarding successful ranges', async () => {
    const response = await readFiles({
      files: [
        { path: 'src/a.ts', startLine: 2, endLine: 3 },
        { path: 'missing.ts' },
        { path: 'src/b.ts' },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadWorkspaceFilesResponse;
    expect(body.results.map((result) => result.path)).toEqual([
      'src/a.ts',
      'missing.ts',
      'src/b.ts',
    ]);
    expect(body.results[0]).toMatchObject({
      status: 'ok',
      content: 'two\nthree',
      startLine: 2,
      endLine: 3,
    });
    expect(body.results[1]).toMatchObject({ status: 'error', code: 'path-not-found' });
    expect(body.results[2]).toMatchObject({ status: 'ok', completeFile: true });
  });

  it('rejects reversed, oversized, and over-count request contracts', async () => {
    const reversed = await readFiles({
      files: [{ path: 'src/a.ts', startLine: 3, endLine: 2 }],
    });
    expect(reversed.status).toBe(422);
    await expect(reversed.json()).resolves.toMatchObject({
      error: expect.stringContaining('endLine'),
    });

    const oversized = await readFiles({
      files: [{ path: 'src/a.ts', startLine: 1, endLine: 401 }],
    });
    expect(oversized.status).toBe(422);

    const tooMany = await readFiles({
      files: Array.from({ length: WORKSPACE_READ_MAX_FILES + 1 }, (_, index) => ({
        path: `file-${index}.txt`,
      })),
    });
    expect(tooMany.status).toBe(422);
  });
});
