import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { AmbientGitHubAuth } from '../github/ambient.js';
import type { SecretKey, SecretStore, SecretStoreBackend } from '../secrets/types.js';

const runGitMock = vi.hoisted(() => vi.fn());
const isGitInstalledMock = vi.hoisted(() => vi.fn());

vi.mock('./git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git.js')>();
  return {
    ...actual,
    isGitInstalled: isGitInstalledMock,
    runGit: runGitMock,
  };
});

const { GitManager } = await import('./manager.js');

class InMemorySecrets implements SecretStore {
  readonly backend: SecretStoreBackend = 'file';
  private readonly map = new Map<string, string>();

  private key(k: SecretKey): string {
    if (k.kind === 'toolset') return `t:${k.toolsetId}:${k.fieldId}`;
    if (k.kind === 'providerCredential') return `p:${k.name}`;
    return `k:${k.kind}`;
  }

  async get(k: SecretKey): Promise<string | null> {
    return this.map.get(this.key(k)) ?? null;
  }

  async set(k: SecretKey, value: string): Promise<void> {
    this.map.set(this.key(k), value);
  }

  async delete(k: SecretKey): Promise<void> {
    this.map.delete(this.key(k));
  }

  async has(k: SecretKey): Promise<boolean> {
    return this.map.has(this.key(k));
  }

  async listForToolset(): Promise<string[]> {
    return [];
  }
}

const SENTINEL = 'GEZEL_MANAGER_CLONE_AUTH_SENTINEL';
const REPO_URL = 'https://github.com/octocat/Hello-World';
const REPO_URL_WITH_STALE_CREDENTIALS =
  'https://stale-user:stale-token@github.com/octocat/Hello-World';
const CLEAN_CLONE_URL = `${REPO_URL}.git`;
const AUTH_CONFIG = `http.extraheader=AUTHORIZATION: Bearer ${SENTINEL}`;

let home: string;
let store: Store;
let secrets: InMemorySecrets;
let manager: InstanceType<typeof GitManager>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-clone-auth-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  secrets = new InMemorySecrets();
  await secrets.set({ kind: 'toolset', toolsetId: 'github', fieldId: 'token' }, SENTINEL);
  manager = new GitManager(
    home,
    store,
    secrets,
    new AmbientGitHubAuth({ env: {}, ghToken: async () => null }),
  );
  isGitInstalledMock.mockReset();
  isGitInstalledMock.mockResolvedValue(true);
  runGitMock.mockReset();
  runGitMock.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('rev-parse') ? 'main\n' : '',
    stderr: '',
  }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cloneCall(): string[] {
  const call = runGitMock.mock.calls.find(([args]) => (args as string[]).includes('clone'));
  expect(call, 'expected GitManager to invoke git clone').toBeDefined();
  return call![0] as string[];
}

function expectHeaderAuthWithCleanUrl(args: string[]): void {
  expect(args).toContain(AUTH_CONFIG);
  expect(args).toContain(CLEAN_CLONE_URL);
  expect(args.join(' ')).not.toContain(`x-access-token:${SENTINEL}`);
  expect(args.filter((arg) => arg.includes(SENTINEL))).toEqual([AUTH_CONFIG]);
}

describe('GitManager clone authentication', () => {
  it('uses one-shot header auth and a credential-free URL for an ordinary clone', async () => {
    const created = await store.createProject({
      name: 'ordinary clone',
      github: { url: REPO_URL },
    });
    const project = (await store.getProject(created.id)) as ProjectDetail;

    await manager.ensureClone(project);

    const args = cloneCall();
    expect(args.slice(0, 3)).toEqual(['-c', AUTH_CONFIG, 'clone']);
    expectHeaderAuthWithCleanUrl(args);
  });

  it('uses one-shot header auth and a credential-free URL for a bare shared clone', async () => {
    await manager.ensureSharedClone(REPO_URL_WITH_STALE_CREDENTIALS);

    const args = cloneCall();
    expect(args.slice(0, 5)).toEqual(['-c', AUTH_CONFIG, 'clone', '--bare', '--filter=blob:none']);
    expectHeaderAuthWithCleanUrl(args);
    expect(args.join(' ')).not.toContain('stale-user');
    expect(args.join(' ')).not.toContain('stale-token');
  });
});
