import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { FileSecretStore } from './file-store.js';
import {
  CredentialDeniedError,
  CredentialMissingError,
  DefaultCredentialRegistry,
  secretKeyForCredential,
} from './registry.js';

let home: string;
let store: Store;
let secrets: FileSecretStore;
let registry: DefaultCredentialRegistry;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-cred-registry-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Alpha' });
  secrets = new FileSecretStore(home);
  registry = new DefaultCredentialRegistry(store, secrets);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('secretKeyForCredential', () => {
  it('maps provider names to providerCredential keys', () => {
    expect(secretKeyForCredential('github.token')).toEqual({
      kind: 'providerCredential',
      name: 'githubToken',
    });
    expect(secretKeyForCredential('openai.key')).toEqual({
      kind: 'providerCredential',
      name: 'openaiApiKey',
    });
    expect(secretKeyForCredential('webhook.bearer')).toEqual({
      kind: 'providerCredential',
      name: 'webhookBearerToken',
    });
  });

  it('treats any other dotted name as a toolset.field', () => {
    expect(secretKeyForCredential('slack.webhook')).toEqual({
      kind: 'toolset',
      toolsetId: 'slack',
      fieldId: 'webhook',
    });
    expect(secretKeyForCredential('my-tool.api_key')).toEqual({
      kind: 'toolset',
      toolsetId: 'my-tool',
      fieldId: 'api_key',
    });
  });

  it('rejects malformed names', () => {
    expect(secretKeyForCredential('bareword')).toBeNull();
    expect(secretKeyForCredential('.leading-dot')).toBeNull();
    expect(secretKeyForCredential('trailing.')).toBeNull();
  });
});

describe('DefaultCredentialRegistry', () => {
  it('throws CredentialDeniedError when project has not granted the name', async () => {
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_secret_value');
    await expect(registry.resolve('github.token', 'alpha')).rejects.toBeInstanceOf(
      CredentialDeniedError,
    );
  });

  it('throws CredentialMissingError when granted but no value stored', async () => {
    await store.updateProject('alpha', { grantedCredentials: ['github.token'] });
    await expect(registry.resolve('github.token', 'alpha')).rejects.toBeInstanceOf(
      CredentialMissingError,
    );
  });

  it('returns the secret value when granted + stored', async () => {
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_happy_path');
    await store.updateProject('alpha', { grantedCredentials: ['github.token'] });
    const value = await registry.resolve('github.token', 'alpha');
    expect(value).toBe('ghp_happy_path');
  });

  it('isolates grants between projects', async () => {
    await store.createProject({ name: 'Beta' });
    await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_shared_value');
    // Grant only to alpha.
    await store.updateProject('alpha', { grantedCredentials: ['github.token'] });

    const alphaValue = await registry.resolve('github.token', 'alpha');
    expect(alphaValue).toBe('ghp_shared_value');
    await expect(registry.resolve('github.token', 'beta')).rejects.toBeInstanceOf(
      CredentialDeniedError,
    );
  });

  it('resolves toolset credentials via the <toolsetId>.<fieldId> pattern', async () => {
    await secrets.set(
      { kind: 'toolset', toolsetId: 'slack', fieldId: 'webhook' },
      'https://hooks.slack.example/acme',
    );
    await store.updateProject('alpha', { grantedCredentials: ['slack.webhook'] });
    const value = await registry.resolve('slack.webhook', 'alpha');
    expect(value).toBe('https://hooks.slack.example/acme');
  });

  it('lists grants for a project', async () => {
    await store.updateProject('alpha', {
      grantedCredentials: ['github.token', 'slack.webhook'],
    });
    const grants = await registry.listGrants('alpha');
    expect(grants).toEqual(['github.token', 'slack.webhook']);
  });

  describe('credential.used audit event', () => {
    it('logs a credential.used history event on successful resolve', async () => {
      const history = new HistoryManager(home);
      const auditingStore = new Store({ home, history });
      const auditingRegistry = new DefaultCredentialRegistry(auditingStore, secrets, history);

      await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_audit_sentinel');
      await auditingStore.updateProject('alpha', { grantedCredentials: ['github.token'] });

      await auditingRegistry.resolve('github.token', 'alpha', {
        kind: 'script',
        scriptName: 'fetch-repo',
        runId: 'r-123',
      });

      const entries = await history.listEntries({
        kinds: ['credential.used'],
        limit: 10,
      });
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.entryType).toBe('event');
      if (entry.entryType !== 'event') return;
      expect(entry.kind).toBe('credential.used');
      expect(entry.projectId).toBe('alpha');
      expect(entry.summary).toContain('github.token');
      expect(entry.summary).toContain('fetch-repo');
      // The raw secret must NOT appear anywhere in the event.
      expect(JSON.stringify(entry)).not.toContain('ghp_audit_sentinel');
    });

    it('does not log when resolve throws (denial, missing value)', async () => {
      const history = new HistoryManager(home);
      const auditingStore = new Store({ home, history });
      const auditingRegistry = new DefaultCredentialRegistry(auditingStore, secrets, history);

      // Grant missing → denial. No secret stored either.
      await expect(
        auditingRegistry.resolve('github.token', 'alpha', {
          kind: 'script',
          scriptName: 'blocked',
          runId: 'r-abc',
        }),
      ).rejects.toBeInstanceOf(CredentialDeniedError);

      const entries = await history.listEntries({
        kinds: ['credential.used'],
        limit: 10,
      });
      expect(entries).toHaveLength(0);
    });

    it('skips the audit log when no useContext is passed', async () => {
      const history = new HistoryManager(home);
      const auditingStore = new Store({ home, history });
      const auditingRegistry = new DefaultCredentialRegistry(auditingStore, secrets, history);

      await secrets.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_no_ctx');
      await auditingStore.updateProject('alpha', { grantedCredentials: ['github.token'] });

      const value = await auditingRegistry.resolve('github.token', 'alpha');
      expect(value).toBe('ghp_no_ctx');

      const entries = await history.listEntries({
        kinds: ['credential.used'],
        limit: 10,
      });
      expect(entries).toHaveLength(0);
    });
  });
});
