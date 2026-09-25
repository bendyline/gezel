import { describe, expect, it } from 'vitest';
import { GezelClient } from './client.js';
import type { FolderMovePlan, FolderMoveStatus, FoldersStatusResponse } from './folders.js';

const plan: FolderMovePlan = {
  scope: 'documents',
  sourcePath: 'C:/Users/a/.gezel/documents',
  destPath: 'D:/Library',
  files: 12,
  bytes: 4096,
  conflicts: 1,
  sourceExists: true,
  destExists: true,
  destNonEmpty: true,
  validation: { ok: true },
};

const status: FolderMoveStatus = {
  id: 'job/1',
  scope: 'documents',
  sourcePath: plan.sourcePath,
  destPath: plan.destPath,
  conflictPolicy: 'skip-all',
  status: 'running',
  phase: 'copy',
  filesDone: 3,
  totalFiles: 12,
  bytesDone: 1024,
  totalBytes: 4096,
  restartRequired: false,
  startedAt: '2026-09-25T00:00:00.000Z',
};

const folders: FoldersStatusResponse = {
  defaults: { documents: 'a', gezels: 'b', projects: 'c' },
  current: { documents: 'D:/Library', gezels: 'b', projects: 'c' },
  externalized: { documents: 'D:/Library', gezels: null, projects: null },
  activeJob: true,
  job: status,
  backups: { count: 0, totalBytes: 0, path: 'C:/Users/a/.gezel/backup', snapshots: [] },
};

describe('folder moves', () => {
  it('drives the plan → move → status lifecycle over the folders routes', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new GezelClient({
      baseUrl: 'https://local',
      token: 'private',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const text = await request.text();
        calls.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
        if (path === '/api/folders') return Response.json(folders);
        if (path === '/api/folders/plan') return Response.json(plan);
        if (path.endsWith('/cancel')) return Response.json({ ok: true });
        if (path.startsWith('/api/folders/move/')) return Response.json(status);
        return Response.json({ jobId: 'job/1' });
      },
    });

    expect(await client.getFolders()).toEqual(folders);
    expect(await client.planFolderMove({ scope: 'documents', destPath: 'D:/Library' })).toEqual(
      plan,
    );
    expect(
      await client.startFolderMove({
        scope: 'documents',
        destPath: 'D:/Library',
        conflictPolicy: 'skip-all',
      }),
    ).toEqual({ jobId: 'job/1' });
    expect(await client.getFolderMoveStatus('job/1')).toEqual(status);
    expect(await client.cancelFolderMove('job/1')).toEqual({ ok: true });
    expect(await client.resetFolder('gezels')).toEqual({ jobId: 'job/1' });

    expect(calls).toEqual([
      { method: 'GET', path: '/api/folders', body: undefined },
      {
        method: 'POST',
        path: '/api/folders/plan',
        body: { scope: 'documents', destPath: 'D:/Library' },
      },
      {
        method: 'POST',
        path: '/api/folders/move',
        body: { scope: 'documents', destPath: 'D:/Library', conflictPolicy: 'skip-all' },
      },
      // A job id is a path segment, never a path.
      { method: 'GET', path: '/api/folders/move/job%2F1', body: undefined },
      { method: 'POST', path: '/api/folders/move/job%2F1/cancel', body: undefined },
      { method: 'POST', path: '/api/folders/reset', body: { scope: 'gezels' } },
    ]);
  });
});
