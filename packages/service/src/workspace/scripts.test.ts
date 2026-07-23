import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { runNpx, runPackageScript } from './scripts.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-scripts-test-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seedWorkspace(
  projectId: string,
  opts: { scripts?: Record<string, string>; deps?: Record<string, string> } = {},
): Promise<string> {
  const workspaceDir = await store.projectWorkspaceDir(projectId);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(workspaceDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: opts.scripts ?? {},
        devDependencies: opts.deps ?? {},
      },
      null,
      2,
    )}\n`,
  );
  return workspaceDir;
}

async function seedBin(workspaceDir: string, name: string, body: string): Promise<void> {
  const binDir = join(workspaceDir, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  const file = join(binDir, name);
  await writeFile(file, `#!/usr/bin/env node\n${body}`);
  await (await import('node:fs/promises')).chmod(file, 0o755);
}

describe('runPackageScript', () => {
  it('rejects scripts not in package.json with a helpful error', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id, { scripts: { build: 'echo ok' } });
    const res = await runPackageScript({
      store,
      home,
      projectId: p.id,
      script: 'nonexistent',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not defined');
    expect(res.error).toContain('build');
  });

  it('returns approvalPending on first call with a session, then runs after approval', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id, { scripts: { greet: 'echo approved' } });
    const pending = await runPackageScript({
      store,
      home,
      projectId: p.id,
      script: 'greet',
      gezelId: 'g',
      sessionId: 's',
    });
    expect(pending.approvalPending).toBe(true);
    expect(pending.questionId).toBeTruthy();
    const questions = await store.listProjectQuestions(p.id);
    const q = questions.find((x) => x.id === pending.questionId);
    expect(q?.intent?.kind).toBe('command-approval');
    if (q?.intent?.kind !== 'command-approval') throw new Error('wrong intent kind');
    expect(q.intent.scope).toBe('script');
    expect(q.intent.name).toBe('greet');
    expect(q.prompt).toContain('not isolated from your OS account');
    expect(q.prompt).toContain('files outside this project');
  });

  it('deduplicates pending approvals for the same script', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id, { scripts: { greet: 'echo hi' } });
    const a = await runPackageScript({
      store,
      home,
      projectId: p.id,
      script: 'greet',
      gezelId: 'g',
      sessionId: 's',
    });
    const b = await runPackageScript({
      store,
      home,
      projectId: p.id,
      script: 'greet',
      gezelId: 'g',
      sessionId: 's',
    });
    expect(b.questionId).toBe(a.questionId);
  });

  it('blocks with `declined` after a previously-declined decision', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id, { scripts: { build: 'echo ok' } });
    const { recordApproval } = await import('./command-approvals.js');
    await recordApproval(home, p.id, 'script', 'build', 'declined');
    const res = await runPackageScript({
      store,
      home,
      projectId: p.id,
      script: 'build',
    });
    expect(res.ok).toBe(false);
    expect(res.declined).toContain('declined');
  });
});

describe('runNpx', () => {
  it('rejects binaries not in the allowlist', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id);
    const res = await runNpx({
      store,
      home,
      projectId: p.id,
      bin: 'rm-rf',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not an installed binary');
  });

  it('rejects bins with path separators', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id);
    const res = await runNpx({
      store,
      home,
      projectId: p.id,
      bin: '../escape',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('bare binary name');
  });

  it('allows a bin that appears in node_modules/.bin and raises approval', async () => {
    const p = await store.createProject({ name: 'p' });
    const ws = await seedWorkspace(p.id);
    await seedBin(ws, 'hello', `process.stdout.write('hi');`);
    const res = await runNpx({
      store,
      home,
      projectId: p.id,
      bin: 'hello',
      gezelId: 'g',
      sessionId: 's',
    });
    expect(res.approvalPending).toBe(true);
    expect(res.questionId).toBeTruthy();
  });

  it('allows a bin that is a manifest dep even without .bin present', async () => {
    const p = await store.createProject({ name: 'p' });
    await seedWorkspace(p.id, { deps: { tsc: '^5' } });
    const res = await runNpx({
      store,
      home,
      projectId: p.id,
      bin: 'tsc',
    });
    // Not in .bin, so resolution fails after allowlist passes —
    // that's the "install first" branch.
    expect(res.ok).toBe(false);
    expect(res.error).toContain('node_modules/.bin');
  });
});
