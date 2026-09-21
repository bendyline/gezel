import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ScriptRunTrigger, securityPolicyForLevel } from '@bendyline/gezel';
import type { ScriptExecutor } from '@bendyline/gezel-script-runtime';
import { projectScriptRunFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import { ScriptRunner } from './runner.js';

let home: string;
let store: Store;
const success = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
const invocation = {
  projectId: 'default',
  scriptName: 'example',
  trigger: { kind: 'manual', userInitiated: true } as const,
};
const source = (name = 'example', requires = ['artifacts.write']) =>
  `export const meta = { name: '${name}', description: 'Policy regression', requires: ${JSON.stringify(requires)} };`;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-script-policy-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
});
afterEach(() => rm(home, { recursive: true, force: true }));
function runner(execute: ScriptExecutor['execute'], maxNestedDepth?: number) {
  return new ScriptRunner({
    store,
    chat: {} as ChatManager,
    executor: { execute },
    maxNestedDepth,
  });
}
async function lockDown() {
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('super-lockdown') });
}

describe('desktop and portable script policy contract', () => {
  it.each(['chat', 'step'] as const)(
    'revokes an authored %s script before its next effect',
    async (kind) => {
      const scripts = runner(async (options) => {
        await options.onRequest('artifact.write', { path: 'first.md', content: 'Saved' });
        await lockDown();
        await options.onRequest('artifact.write', { path: 'second.md', content: 'Denied' });
        return success;
      });
      const trigger: ScriptRunTrigger =
        kind === 'chat'
          ? { kind, gezelId: 'noor', sessionId: 'session' }
          : { kind, taskRef: 'default/1', stepId: 'work', moment: 'enter' };
      const run = await scripts.run({ ...invocation, inlineSource: source(), trigger });
      expect(run.status).toBe('error');
      expect(run.calls[1]?.error).toContain('script execution is disabled');
      expect(await store.readProjectArtifact('default', 'first.md')).toBe('Saved');
      expect(await store.readProjectArtifact('default', 'second.md')).toBeNull();
      expect(
        JSON.parse(
          await readFile(
            projectScriptRunFile(home, 'default', run.startedAt.slice(0, 10), run.id),
            'utf8',
          ),
        ),
      ).toEqual(run);
    },
  );
  it('keeps manual authored artifact operations available', async () => {
    const scripts = runner(async (options) => {
      await lockDown();
      await options.onRequest('artifact.write', { path: 'manual.md', content: 'Saved' });
      return success;
    });
    expect(await scripts.run({ ...invocation, inlineSource: source() })).toMatchObject({
      status: 'ok',
    });
    expect(await store.readProjectArtifact('default', 'manual.md')).toBe('Saved');
  });
  it('keeps immutable standard step operations available', async () => {
    const scripts = runner(async (options) => {
      await lockDown();
      await options.onRequest('fs.write', { path: 'standard.md', content: 'Saved' });
      options.onNotification('script.output', {
        value: { ok: true, action: 'list', id: null, record: null, records: [], total: 0 },
      });
      return success;
    });
    expect(
      await scripts.run({
        projectId: 'default',
        scriptName: 'storeRecords',
        scope: 'standard',
        trigger: { kind: 'step', taskRef: 'default/1', stepId: 'work', moment: 'enter' },
        inputs: { action: 'list', root: 'records', mode: 'single-file' },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await store.readProjectWorkspaceFile('default', 'standard.md')).toBe('Saved');
  });
  it.each([
    ['network', 'mcp.call', { tool: 'external', args: {} }],
    ['documents.write', 'document.write', { name: 'policy.md', content: 'Denied' }],
    ['workspace.write', 'fs.write', { path: 'policy.md', content: 'Denied' }],
  ] as const)('revokes declared %s for manual scripts too', async (capability, method, params) => {
    const scripts = runner(async (options) => {
      await lockDown();
      await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
      await options.onRequest(method, params);
      return success;
    });
    const run = await scripts.run({ ...invocation, inlineSource: source('example', [capability]) });
    expect(run.status).toBe('error');
    expect(run.calls[0]?.error).toContain('currently denied');
    expect(await store.readProjectWorkspaceFile('default', 'policy.md')).toBeNull();
  });
  it('revokes AI before invoking the completion provider', async () => {
    const completion = vi.fn();
    const scripts = new ScriptRunner({
      store,
      chat: { oneShotCompletion: completion } as unknown as ChatManager,
      executor: {
        execute: async (options) => {
          await store.writeConfig({ aiEngagementMode: 'off' });
          await options.onRequest('llm.oneShot', { prompt: 'Denied' });
          return success;
        },
      },
    });
    expect(
      await scripts.run({ ...invocation, inlineSource: source('example', ['llm']) }),
    ).toMatchObject({ status: 'error', error: expect.stringContaining('off') });
    expect(completion).not.toHaveBeenCalled();
  });
  it('retains the parent policy inside a nested script', async () => {
    await mkdir(join(home, 'projects/default/scripts'), { recursive: true });
    await writeFile(join(home, 'projects/default/scripts/child.ts'), source('child'));
    let nested: unknown;
    const scripts = runner(async (options) => {
      if (options.scriptName === 'example')
        nested = await options.onRequest('script.run', { name: 'child' });
      else {
        await lockDown();
        await options.onRequest('artifact.write', { path: 'nested.md', content: 'Denied' });
      }
      return success;
    });
    await scripts.run({
      ...invocation,
      inlineSource: source(),
      trigger: { kind: 'chat', gezelId: 'noor', sessionId: 'session' },
    });
    expect(nested).toMatchObject({
      status: 'error',
      error: expect.stringContaining('script execution is disabled'),
    });
    expect(await store.readProjectArtifact('default', 'nested.md')).toBeNull();
  });
  it('carries the real nesting depth into each child', async () => {
    await mkdir(join(home, 'projects/default/scripts'), { recursive: true });
    await writeFile(join(home, 'projects/default/scripts/child.ts'), source('child'));
    let calls = 0;
    let nested: unknown;
    const scripts = runner(async (options) => {
      calls++;
      nested = await options.onRequest('script.run', { name: 'child' });
      return success;
    }, 1);
    await scripts.run({ ...invocation, inlineSource: source() });
    expect(calls).toBe(2);
    expect(nested).toMatchObject({
      status: 'error',
      error: expect.stringContaining('nested script depth exceeded'),
    });
  });
});
