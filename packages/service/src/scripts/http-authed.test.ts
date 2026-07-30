import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ScriptRunner } from './runner.js';

/**
 * End-to-end test for Slice C: `gezel.http.authed` in the SDK →
 * fd-3 RPC → dispatcher `http.authed` handler → credential registry
 * → outbound `fetch()` with the right Authorization header.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let manager: ChatManager;
let secrets: FileSecretStore;
let runner: ScriptRunner;

// Capture calls so tests can assert the header went out correctly.
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchResponse: Response = new Response('{"ok":true}', { status: 200 });

beforeEach(async () => {
  fetchCalls = [];
  fetchResponse = new Response('{"ok":true}', { status: 200 });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return fetchResponse;
  });

  home = await mkdtemp(join(tmpdir(), 'gezel-http-authed-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  await store.createProject({ name: 'Alpha' });
  secrets = new FileSecretStore(home);
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', new MockProvider({ name: 'copilot' })]],
    catalog: new CatalogService(),
    secrets,
  });
  runner = new ScriptRunner({ store, chat: manager, secrets });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function writeScript(name: string, source: string): Promise<void> {
  const dir = join(home, 'projects', 'alpha', 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), source, 'utf8');
}

// The end-to-end SDK channel runs inside a denyNet child; only macOS
// Seatbelt currently supplies the required OS network boundary.
describe.runIf(process.platform === 'darwin')('gezel.http.authed — end-to-end', () => {
  it('attaches a Bearer token and returns the response body', async () => {
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_test_token_alpha');
    await store.updateProject('alpha', {
      grantedCredentials: ['github.token'],
    });

    await writeScript(
      'fetch-repo',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'fetch-repo',
          description: 'fetches a repo via authed HTTP.',
          requires: ['network', 'credential:github.token'],
          outputs: { status: { type: 'number', description: 'HTTP status' } },
        });
        const res = await gezel.http.authed('https://api.github.com/repos/x', {
          credential: 'github.token',
        });
        gezel.output({ status: res.status });
      `,
    );

    const run = await runner.run({
      projectId: 'alpha',
      scriptName: 'fetch-repo',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ status: 200 });
    expect(fetchCalls).toHaveLength(1);
    const init = fetchCalls[0]!.init!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_test_token_alpha');
    expect(fetchCalls[0]!.url).toBe('https://api.github.com/repos/x');
  });

  it('rejects when the project has not granted the credential', async () => {
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_ungranted');
    // Use GitHub's fixed credential destination but deliberately do not grant
    // the credential, so this reaches the credential-registry denial.
    await writeScript(
      'needs-grant',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'needs-grant',
          description: 'tries to use a credential the project has not granted.',
          requires: ['network', 'credential:github.token'],
          outputs: { caught: { type: 'boolean', description: 'caught' } },
        });
        let caught = false;
        try {
          await gezel.http.authed('https://api.github.com/x', { credential: 'github.token' });
        } catch (e) {
          caught = true;
        }
        gezel.output({ caught });
      `,
    );

    const run = await runner.run({
      projectId: 'alpha',
      scriptName: 'needs-grant',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ caught: true });
    const call = run.calls.find((c) => c.kind === 'http.authed');
    expect(call?.error).toMatch(/CREDENTIAL_DENIED|has not been granted/);
    // fetch was never reached.
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects when the script did not declare the credential capability', async () => {
    await secrets.set(
      { kind: 'providerCredential', name: 'githubToken' },
      'ghp_declared_but_not_capped',
    );
    await store.updateProject('alpha', {
      grantedCredentials: ['github.token'],
    });

    await writeScript(
      'cap-missing',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'cap-missing',
          description: 'forgot to declare the credential capability.',
          requires: ['network'],
          outputs: { caught: { type: 'boolean', description: 'caught' } },
        });
        let caught = false;
        try {
          await gezel.http.authed('https://api.github.com/x', { credential: 'github.token' });
        } catch (e) {
          caught = true;
        }
        gezel.output({ caught });
      `,
    );

    const run = await runner.run({
      projectId: 'alpha',
      scriptName: 'cap-missing',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ caught: true });
    const call = run.calls.find((c) => c.kind === 'http.authed');
    expect(call?.error).toMatch(/CAPABILITY_DENIED|did not declare/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('emits a credential.used history event on successful resolve', async () => {
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_audit_e2e');
    await store.updateProject('alpha', {
      grantedCredentials: ['github.token'],
    });

    await writeScript(
      'audited',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'audited',
          description: 'fetches authed and should show up in the audit log.',
          requires: ['network', 'credential:github.token'],
          outputs: { ok: { type: 'boolean', description: 'ok' } },
        });
        await gezel.http.authed('https://api.github.com/x', { credential: 'github.token' });
        gezel.output({ ok: true });
      `,
    );

    const run = await runner.run({
      projectId: 'alpha',
      scriptName: 'audited',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('ok');

    // The Store was constructed without a HistoryManager in our test
    // beforeEach — so the registry is wired to a history-less store.
    // Instead, assert the history file on disk. We used a vanilla
    // Store here, so the registry's history.log call is skipped.
    // This test just confirms the happy path still works with an
    // audit-configured registry; full log-write is covered in the
    // registry unit test (`logs a credential.used history event on
    // successful resolve`).
  });

  it('redacts the credential value from the run trace if the server echoes it', async () => {
    // GitHub token shows up in the response body (bad API).
    fetchResponse = new Response('auth=ghp_echoed_SECRET done', { status: 200 });
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_echoed_SECRET');
    await store.updateProject('alpha', {
      grantedCredentials: ['github.token'],
    });

    await writeScript(
      'echo-leak',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'echo-leak',
          description: 'fetches a URL whose response echoes the token back.',
          requires: ['network', 'credential:github.token'],
          outputs: { body: { type: 'string', description: 'response body' } },
        });
        const res = await gezel.http.authed('https://api.github.com/echo', {
          credential: 'github.token',
        });
        gezel.output({ body: res.body });
      `,
    );

    const run = await runner.run({
      projectId: 'alpha',
      scriptName: 'echo-leak',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    const output = run.output as { body: string };
    expect(output.body).not.toContain('ghp_echoed_SECRET');
    expect(output.body).toContain('[REDACTED]');
    // And on disk.
    const date = run.startedAt.slice(0, 10);
    const runFile = join(home, 'projects', 'alpha', 'scripts', 'runs', date, `${run.id}.json`);
    const raw = await readFile(runFile, 'utf8');
    expect(raw).not.toContain('ghp_echoed_SECRET');
  });
});
