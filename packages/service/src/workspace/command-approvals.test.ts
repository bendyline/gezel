import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashCommandInvocation,
  lookupApproval,
  readCommandApprovals,
  recordApproval,
} from './command-approvals.js';

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
    const buildHash = hashCommandInvocation('tsc -b', ['--pretty', 'false']);
    await recordApproval(home, projectId, 'script', 'build', 'approved', buildHash);
    await recordApproval(home, projectId, 'npx', 'vitest', 'declined');
    const data = await readCommandApprovals(home, projectId);
    expect(lookupApproval(data, 'script', 'build', buildHash)).toBe('approved');
    expect(lookupApproval(data, 'script', 'test')).toBeUndefined();
    expect(lookupApproval(data, 'npx', 'vitest')).toBe('declined');
    expect(lookupApproval(data, 'npx', 'build')).toBeUndefined();
  });

  it('persists decisions to JSON on disk', async () => {
    const invocationHash = hashCommandInvocation('tsc -b', []);
    await recordApproval(home, projectId, 'script', 'build', 'approved', invocationHash);
    const file = join(home, 'projects', projectId, 'command-approvals.json');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.scripts.build).toBe('approved');
  });

  it('overwrites existing decisions on repeated record calls', async () => {
    await recordApproval(
      home,
      projectId,
      'script',
      'lint',
      'approved',
      hashCommandInvocation('eslint .', []),
    );
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

  it('binds an approval to the ordered argument vector', async () => {
    const body = 'C:\\workspace\\node_modules\\.bin\\vitest.cmd';
    const approved = hashCommandInvocation(body, ['run', '--coverage']);
    await recordApproval(home, projectId, 'npx', 'vitest', 'approved', approved);
    const data = await readCommandApprovals(home, projectId);

    expect(lookupApproval(data, 'npx', 'vitest', approved)).toBe('approved');
    expect(
      lookupApproval(data, 'npx', 'vitest', hashCommandInvocation(body, ['run', '--watch'])),
    ).toBeUndefined();
    expect(
      lookupApproval(data, 'npx', 'vitest', hashCommandInvocation(body, ['--coverage', 'run'])),
    ).toBeUndefined();
    expect(
      lookupApproval(
        data,
        'npx',
        'vitest',
        hashCommandInvocation(`${body}.changed`, ['run', '--coverage']),
      ),
    ).toBeUndefined();
  });

  it('binds an approval to canonical identifiable file content', async () => {
    const body = 'node tools/build.mjs';
    const originalFiles = [
      { path: 'tools/build.mjs', sha256: 'a'.repeat(64) },
      { path: 'package.json', sha256: 'b'.repeat(64) },
    ];
    const approved = hashCommandInvocation(body, [], originalFiles);
    await recordApproval(home, projectId, 'script', 'build', 'approved', approved);
    const data = await readCommandApprovals(home, projectId);

    expect(
      lookupApproval(
        data,
        'script',
        'build',
        hashCommandInvocation(body, [], [...originalFiles].reverse()),
      ),
    ).toBe('approved');
    expect(
      lookupApproval(
        data,
        'script',
        'build',
        hashCommandInvocation(
          body,
          [],
          [{ path: 'tools/build.mjs', sha256: 'c'.repeat(64) }, originalFiles[1]!],
        ),
      ),
    ).toBeUndefined();
  });

  it('fails closed for legacy approved decisions without an invocation hash', async () => {
    const file = join(home, 'projects', projectId, 'command-approvals.json');
    await (await import('node:fs/promises')).writeFile(
      file,
      JSON.stringify({ scripts: { build: 'approved' }, npx: {} }),
      'utf8',
    );
    const data = await readCommandApprovals(home, projectId);
    expect(
      lookupApproval(data, 'script', 'build', hashCommandInvocation('tsc -b', [])),
    ).toBeUndefined();
    expect(lookupApproval(data, 'script', 'build')).toBeUndefined();
  });

  it('retains concurrent exact approvals without authorizing other arguments or content', async () => {
    const body = 'node build.mjs';
    const inputs = [{ path: 'build.mjs', sha256: 'a'.repeat(64) }];
    const school = hashCommandInvocation(body, ['school'], inputs);
    const tower = hashCommandInvocation(body, ['tower'], inputs);
    const npx = hashCommandInvocation('/bin/validator', ['asset.glb']);
    await Promise.all([
      recordApproval(home, projectId, 'script', 'build', 'approved', school),
      recordApproval(home, projectId, 'script', 'build', 'approved', tower),
      recordApproval(home, projectId, 'npx', 'validator', 'approved', npx),
    ]);
    const data = await readCommandApprovals(home, projectId);
    for (const hash of [school, tower])
      expect(lookupApproval(data, 'script', 'build', hash)).toBe('approved');
    expect(lookupApproval(data, 'npx', 'validator', npx)).toBe('approved');
    for (const hash of [
      hashCommandInvocation(body, ['other'], inputs),
      hashCommandInvocation('node different.mjs', ['school'], inputs),
      hashCommandInvocation(body, ['school'], [{ path: 'build.mjs', sha256: 'b'.repeat(64) }]),
    ])
      expect(lookupApproval(data, 'script', 'build', hash)).toBeUndefined();
  });

  it('revokes all invocations on decline and does not restore them on reapproval', async () => {
    const first = hashCommandInvocation('build', ['first']);
    const second = hashCommandInvocation('build', ['second']);
    await recordApproval(home, projectId, 'script', 'build', 'approved', first);
    await recordApproval(home, projectId, 'script', 'build', 'approved', second);
    await recordApproval(home, projectId, 'script', 'build', 'declined');
    let data = await readCommandApprovals(home, projectId);
    expect(data.scriptInvocationHashes?.build).toBeUndefined();
    expect(data.scriptHashes?.build).toBeUndefined();
    expect(lookupApproval(data, 'script', 'build', first)).toBe('declined');
    await recordApproval(home, projectId, 'script', 'build', 'approved', second);
    data = await readCommandApprovals(home, projectId);
    expect(lookupApproval(data, 'script', 'build', first)).toBeUndefined();
    expect(lookupApproval(data, 'script', 'build', second)).toBe('approved');
  });

  it('preserves an existing exact approval when migrating to multiple invocations', async () => {
    const first = hashCommandInvocation('build', ['first']);
    const second = hashCommandInvocation('build', ['second']);
    await (await import('node:fs/promises')).writeFile(
      join(home, 'projects', projectId, 'command-approvals.json'),
      JSON.stringify({ scripts: { build: 'approved' }, npx: {}, scriptHashes: { build: first } }),
    );
    await recordApproval(home, projectId, 'script', 'build', 'approved', second);
    const data = await readCommandApprovals(home, projectId);
    expect(lookupApproval(data, 'script', 'build', first)).toBe('approved');
    expect(lookupApproval(data, 'script', 'build', second)).toBe('approved');
    expect(data.scriptHashes?.build).toBe(second);
  });
});
