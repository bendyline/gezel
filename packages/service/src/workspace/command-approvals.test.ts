import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lookupApproval, readCommandApprovals, recordApproval } from './command-approvals.js';

let home: string;
const projectId = 'proj-test';

beforeEach(async () => {
  home = join(tmpdir(), `gezel-cmdappr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(home, 'projects', projectId), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('command-approvals', () => {
  it('returns empty buckets when no file exists', async () => {
    const data = await readCommandApprovals(home, projectId);
    expect(data.scripts).toEqual({});
    expect(data.npx).toEqual({});
  });

  it('records approvals and looks them up by scope', async () => {
    await recordApproval(home, projectId, 'script', 'build', 'approved');
    await recordApproval(home, projectId, 'npx', 'vitest', 'declined');
    const data = await readCommandApprovals(home, projectId);
    expect(lookupApproval(data, 'script', 'build')).toBe('approved');
    expect(lookupApproval(data, 'script', 'test')).toBeUndefined();
    expect(lookupApproval(data, 'npx', 'vitest')).toBe('declined');
    expect(lookupApproval(data, 'npx', 'build')).toBeUndefined();
  });

  it('persists decisions to JSON on disk', async () => {
    await recordApproval(home, projectId, 'script', 'build', 'approved');
    const file = join(home, 'projects', projectId, 'command-approvals.json');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.scripts.build).toBe('approved');
  });

  it('overwrites existing decisions on repeated record calls', async () => {
    await recordApproval(home, projectId, 'script', 'lint', 'approved');
    await recordApproval(home, projectId, 'script', 'lint', 'declined');
    const data = await readCommandApprovals(home, projectId);
    expect(data.scripts.lint).toBe('declined');
  });

  it('normalizes malformed on-disk data to known decisions only', async () => {
    const file = join(home, 'projects', projectId, 'command-approvals.json');
    await (await import('node:fs/promises')).writeFile(
      file,
      JSON.stringify({ scripts: { bad: 'maybe', good: 'approved' }, npx: null }),
      'utf8',
    );
    const data = await readCommandApprovals(home, projectId);
    expect(data.scripts.bad).toBeUndefined();
    expect(data.scripts.good).toBe('approved');
    expect(data.npx).toEqual({});
  });
});
