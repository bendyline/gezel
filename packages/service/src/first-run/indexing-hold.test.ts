import { type GezelConfig, SHARED_PROJECT_MARKER } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { FirstUseIndexingHold, defaultProviderCanAnswer } from './indexing-hold.js';

const MINUTE = 60_000;
const start = Date.parse('2026-10-11T09:00:00.000Z');
/** Let a model check running in the background reach its verdict. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(config: Partial<GezelConfig>, modelReady = false) {
  let now = start;
  const state = { config: { ...config } as GezelConfig, modelReady };
  const chatModelReady = vi.fn(async () => state.modelReady);
  const hold = new FirstUseIndexingHold({
    readConfig: async () => state.config,
    writeConfig: async (patch) => {
      state.config = { ...state.config, ...patch };
    },
    chatModelReady,
    now: () => now,
  });
  return {
    hold,
    state,
    chatModelReady,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const firstUse = new Date(start).toISOString();
const ownFolder = { workingDir: 'C:/Users/me/Pictures' };
const sharedLibrary = {
  workingDir: 'C:/Users/me/.gezel/documents',
  properties: { [SHARED_PROJECT_MARKER]: '1' },
};
const defaultProject = {};

describe('the first-use indexing hold', () => {
  it('never holds an established install', async () => {
    const { hold, chatModelReady } = harness({});
    expect(await hold.isActive()).toBe(false);
    expect(await hold.holds(defaultProject)).toBe(false);
    expect(chatModelReady).not.toHaveBeenCalled();
  });

  it('holds the first half hour, except the person’s own folders', async () => {
    const { hold } = harness({ firstUseAt: firstUse }, true);
    expect(await hold.isActive()).toBe(true);
    expect(await hold.holds(defaultProject)).toBe(true);
    expect(await hold.holds(sharedLibrary)).toBe(true);
    expect(await hold.holds(ownFolder)).toBe(false);
  });

  it('keeps holding past half an hour until a chat model is ready', async () => {
    const { hold, state, advance } = harness({ firstUseAt: firstUse });
    advance(45 * MINUTE);
    expect(await hold.isActive()).toBe(true);
    await settle();
    expect(await hold.isActive()).toBe(true);

    state.modelReady = true;
    advance(30_000);
    // A held verdict stands for a minute before it is checked again.
    expect(await hold.isActive()).toBe(true);
    advance(31_000);
    expect(await hold.isActive()).toBe(true);
    await settle();
    expect(await hold.isActive()).toBe(false);
    expect(state.config.firstUseIndexingReleasedAt).toBeDefined();
  });

  it('holds every caller while the model check is still out', async () => {
    let answer!: (ready: boolean) => void;
    const hold = new FirstUseIndexingHold({
      readConfig: async () => ({ firstUseAt: new Date(start - 40 * MINUTE).toISOString() }),
      writeConfig: async () => {},
      chatModelReady: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
      now: () => start,
    });
    expect(await hold.isActive()).toBe(true);
    // The tick that once read a stale "not held" while the inventory loaded.
    expect(await hold.holds(defaultProject)).toBe(true);
    answer(true);
    await settle();
    expect(await hold.isActive()).toBe(false);
  });

  it('waits out the half hour even when a model is ready at once', async () => {
    const { hold, advance } = harness({ firstUseAt: firstUse }, true);
    advance(29 * MINUTE);
    expect(await hold.isActive()).toBe(true);
    advance(2 * MINUTE);
    await hold.isActive();
    await settle();
    expect(await hold.isActive()).toBe(false);
  });

  it('stays released once released, whatever happens to the model', async () => {
    const { hold, state, chatModelReady, advance } = harness({ firstUseAt: firstUse }, true);
    advance(31 * MINUTE);
    await hold.isActive();
    await settle();
    expect(await hold.isActive()).toBe(false);
    state.modelReady = false;
    advance(5 * MINUTE);
    expect(await hold.isActive()).toBe(false);
    expect(chatModelReady).toHaveBeenCalledTimes(1);
  });

  it('honours a release recorded by an earlier boot', async () => {
    const { hold, chatModelReady } = harness({
      firstUseAt: firstUse,
      firstUseIndexingReleasedAt: firstUse,
    });
    expect(await hold.isActive()).toBe(false);
    expect(chatModelReady).not.toHaveBeenCalled();
  });

  it('does not hold when the config cannot be read', async () => {
    const hold = new FirstUseIndexingHold({
      readConfig: async () => {
        throw new Error('locked');
      },
      writeConfig: async () => {},
      chatModelReady: async () => false,
    });
    expect(await hold.isActive()).toBe(false);
  });
});

describe('whether the default provider can answer', () => {
  const deps = (config: Partial<GezelConfig>, overrides: Partial<{ models: unknown[] }> = {}) => ({
    config: config as GezelConfig,
    listInstalledModels: async () => overrides.models ?? [],
    hasCredential: async (name: string) => name === 'anthropicApiKey',
    copilotAvailable: async () => false,
  });

  it('needs an installed model for an on-device engine', async () => {
    expect(await defaultProviderCanAnswer(deps({ provider: 'llama-cpp' }))).toBe(false);
    expect(
      await defaultProviderCanAnswer(deps({ provider: 'llama-cpp' }, { models: [{ id: 'm' }] })),
    ).toBe(true);
  });

  it('needs a key for a cloud provider and an install for Copilot', async () => {
    expect(await defaultProviderCanAnswer(deps({ provider: 'openai' }))).toBe(false);
    expect(await defaultProviderCanAnswer(deps({ provider: 'anthropic' }))).toBe(true);
    expect(await defaultProviderCanAnswer(deps({ provider: 'copilot' }))).toBe(false);
  });

  it('trusts a tool the person set up themselves', async () => {
    expect(await defaultProviderCanAnswer(deps({ provider: 'ollama' }))).toBe(true);
  });
});
