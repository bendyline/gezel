import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderNameSchema } from '@bendyline/gezel';
import type { ProviderName } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { resolveDefaultProviderName } from '../providers/default-provider.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * Lock the resolution contract for `ChatManager.providerForGezel`:
 *   1. Per-gezel frontmatter `provider:` wins over the global config.
 *   2. Without an override, we use `config.provider`.
 *   3. Without either, we fall back to the platform default —
 *      `resolveDefaultProviderName`, i.e. the on-device engine where one
 *      is bundled.
 *
 * The bug this guards against: previous impls re-checked each provider
 * variant with string literals (`if (x === 'copilot') ...`) and silently
 * fell through to copilot when a new value was added to the
 * `ProviderNameSchema` enum without updating every switch. See commit that
 * added `'llama-cpp'` to the schema but not to the switch — messages
 * silently routed to Copilot even when the user's default was on-device.
 *
 * We iterate over `ProviderNameSchema.options` rather than a literal array
 * so that adding a 5th provider to the enum forces these tests to
 * exercise it too (the test will fail on the missing case).
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let priorEvalProviderLock: string | undefined;

beforeEach(async () => {
  priorEvalProviderLock = process.env.GEZEL_EVAL_PROVIDER_LOCK;
  delete process.env.GEZEL_EVAL_PROVIDER_LOCK;
  home = await mkdtemp(join(tmpdir(), 'gezel-resolve-provider-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  events = new ChatEventBus();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', new MockProvider({ name: 'copilot' })]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
  if (priorEvalProviderLock === undefined) delete process.env.GEZEL_EVAL_PROVIDER_LOCK;
  else process.env.GEZEL_EVAL_PROVIDER_LOCK = priorEvalProviderLock;
});

describe('ChatManager.providerForGezel — exhaustiveness', () => {
  // With neither an override nor a config default, the fallback is
  // platform-derived — the on-device engine wherever we bundle one, and
  // copilot only where we don't. It used to be an unconditional 'copilot',
  // which stopped being defensible once the Copilot runtime became an opt-in
  // download: the default pointed at something a fresh install couldn't run.
  // `resolveDefaultProviderName` owns that decision and has its own tests;
  // asserting against it here keeps the two from drifting.
  it('falls back to the platform default when no override and no config default', async () => {
    const resolved = await manager.providerForGezel('ada');
    expect(resolved).toBe(resolveDefaultProviderName({}));
  });

  for (const provider of ProviderNameSchema.options) {
    it(`honors per-gezel frontmatter override: ${provider}`, async () => {
      await store.updateGezelSettings('ada', { provider });
      const resolved = await manager.providerForGezel('ada');
      expect(resolved).toBe(provider);
    });

    it(`honors global config default: ${provider}`, async () => {
      // Confirm no per-gezel override is in play for this case.
      await store.updateGezelSettings('ada', { provider: null });
      await store.writeConfig({ provider });
      const resolved = await manager.providerForGezel('ada');
      expect(resolved).toBe(provider);
    });
  }

  it('per-gezel override beats a conflicting global config default', async () => {
    await store.writeConfig({ provider: 'copilot' });
    await store.updateGezelSettings('ada', { provider: 'llama-cpp' });
    const resolved = await manager.providerForGezel('ada');
    expect(resolved).toBe('llama-cpp');
  });

  it('uses the Night Shift provider only when resolving deferred work', async () => {
    await store.writeConfig({
      provider: 'copilot',
      nightShift: {
        modelOverride: { enabled: true, provider: 'openai', model: 'gpt-slow-night' },
      },
    });

    expect(await manager.providerForGezel('ada')).toBe('copilot');
    expect(await manager.providerForGezel('ada', { nightShift: true })).toBe('openai');

    const normal = await manager.createSession({ gezelId: 'ada' });
    const night = await manager.createSession({ gezelId: 'ada', nightShift: true });
    expect(normal.providerName).toBe('copilot');
    expect(night.providerName).toBe('openai');
    expect(night.model).toBe('gpt-slow-night');
    expect(night.nightShift).toBe(true);
  });

  it('keeps per-gezel provider/model pins above Night Shift defaults', async () => {
    await store.writeConfig({
      provider: 'copilot',
      nightShift: {
        modelOverride: { enabled: true, provider: 'openai', model: 'gpt-slow-night' },
      },
    });
    await store.updateGezelSettings('ada', {
      provider: 'anthropic',
      model: 'pinned-worker-model',
    });

    const night = await manager.createSession({ gezelId: 'ada', nightShift: true });
    expect(night.providerName).toBe('anthropic');
    expect(night.model).toBe('pinned-worker-model');
  });

  it('locks local eval recovery sessions to the provider/model under test', async () => {
    await store.writeConfig({
      provider: 'ds4',
      defaultModel: { ds4: 'deepseek-v4-flash-284b-q2' },
    });
    await store.updateGezelSettings('ada', {
      provider: 'copilot',
      model: 'gpt-4o',
    });
    process.env.GEZEL_EVAL_PROVIDER_LOCK = 'ds4';

    expect(await manager.providerForGezel('ada')).toBe('ds4');
    const session = await manager.createSession({ gezelId: 'ada' });
    expect(session.providerName).toBe('ds4');
    expect(session.model).toBe('deepseek-v4-flash-284b-q2');
  });

  it('covers every ProviderName the schema knows about', () => {
    // Meta-check: if ProviderNameSchema grows, the for-loop above runs
    // more iterations automatically. This assertion just documents the
    // current set so regressions are loud in the diff.
    const known = [...ProviderNameSchema.options].sort();
    expect(known).toEqual(
      (
        [
          'anthropic',
          'anthropic-cli',
          'codex-cli',
          'copilot',
          'ds4',
          'llama-cpp',
          'mlx',
          'ollama',
          'openai',
          'remote',
        ] satisfies ProviderName[]
      ).sort(),
    );
  });
});

describe('ChatManager.createSession — project roster auto-add', () => {
  it('adds the gezel to the project roster the first time a session is created for them', async () => {
    await store.createProject({ name: 'Roster' });
    const beforeProject = await store.getProject('roster');
    expect(beforeProject!.gezelIds ?? []).not.toContain('ada');

    await manager.createSession({ gezelId: 'ada', projectId: 'roster' });

    // Auto-add is fire-and-forget; drain background so the assertion
    // sees the roster after the project.json write has flushed.
    await manager.drainBackground();
    const afterProject = await store.getProject('roster');
    expect(afterProject!.gezelIds).toContain('ada');
  });

  it('roster entry stays as a single occurrence across multiple sessions', async () => {
    await store.createProject({ name: 'Roster' });
    await manager.createSession({ gezelId: 'ada', projectId: 'roster' });
    await manager.createSession({ gezelId: 'ada', projectId: 'roster' });
    await manager.drainBackground();
    const project = await store.getProject('roster');
    expect(project!.gezelIds).toEqual(['ada']);
  });
});
