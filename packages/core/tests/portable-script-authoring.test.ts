import { describe, expect, it } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { PortableProductService } from '../src/runtime/product-service.js';
import type { PortableScripts } from '../src/runtime/script-host.js';
import { portableFixture } from '../src/runtime/test-files.js';

async function fixture() {
  const fixture = portableFixture();
  const service = new PortableProductService(
    fixture.store,
    {
      providers: async () => [],
      generate: async () => {
        throw new Error('Unexpected inference');
      },
      cancel: async () => {},
    },
    'token',
  );
  const scripts: PortableScripts = {
    list: () => [],
    source: async () => {
      throw new Error('Standard script not found');
    },
    initialize: async () => {},
    isBusy: () => false,
    cancel: async () => {},
    run: async () => {
      throw new Error('Not part of storage test');
    },
    authoring: {
      scaffold: async (name) => `export const meta = { name: '${name}' };`,
      sdkTypes: () => ({ version: 'test', files: [] }),
      inspect: async (source, name) => {
        if (source === 'timeout') throw new Error('Script compilation timed out');
        return source === 'broken'
          ? {
              diagnostics: [
                { severity: 'error', source: 'meta', message: 'Invalid literal metadata' },
              ],
            }
          : { meta: { name, description: 'An editable script' }, diagnostics: [] };
      },
    },
  };
  service.setScripts(scripts);
  await service.initialize();
  return {
    ...fixture,
    client: new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'token',
      fetch: service.fetch,
    }),
  };
}

describe('portable source editing via the ordinary client', () => {
  it('saves broken edits and compiler failures without losing source, with atomic conflict handling', async () => {
    const { client } = await fixture();
    const initial = await client.createProjectScript('default', {
      name: 'hello',
      source: 'initial',
    });
    const result = await client.saveProjectScriptSource('default', {
      name: 'hello',
      source: 'broken',
      baseHash: initial.hash,
    });
    expect(result).toMatchObject({
      status: 'saved',
      metaOk: false,
      diagnostics: [{ source: 'meta' }],
    });
    const conflict = await client.saveProjectScriptSource('default', {
      name: 'hello',
      source: 'stale',
      baseHash: initial.hash,
    });
    expect(conflict).toMatchObject({ status: 'conflict', currentSource: 'broken' });
    expect((await client.getProjectScriptSource('default', 'hello')).metaError).toContain(
      'Invalid literal',
    );
    expect((await client.listProjectScripts('default')).scripts).toEqual([]);
    expect(
      await client.saveProjectScriptSource('default', { name: 'hello', source: 'timeout' }),
    ).toMatchObject({
      status: 'saved',
      metaOk: false,
      diagnostics: [{ message: 'Script compilation timed out' }],
    });
    expect((await client.getProjectScriptSource('default', 'hello')).source).toBe('timeout');
  });
  it('keeps project/user namespaces separate and enforces project and path authority', async () => {
    const { client, store } = await fixture();
    await client.createProjectScript('default', { name: 'hello', source: 'project source' });
    await client.createUserScript({ name: 'hello', source: 'user source' });
    expect((await client.getUserScriptSource('hello')).source).toBe('user source');
    expect((await client.getProjectScriptSource('default', 'hello')).source).toBe('project source');
    await expect(client.createUserScript({ name: 'hello' })).rejects.toMatchObject({
      details: { error: 'A script with this name already exists' },
    });
    await expect(client.createUserScript({ name: '../escape', source: 'bad' })).rejects.toThrow();
    await store.updateProject('default', { status: 'readonly' });
    await expect(
      client.saveProjectScriptSource('default', { name: 'hello', source: 'blocked' }),
    ).rejects.toMatchObject({ details: { error: 'This project is read-only' } });
    await expect(client.deleteProjectScript('default', 'hello')).rejects.toMatchObject({
      details: { error: 'This project is read-only' },
    });
    await client.deleteUserScript('hello');
    expect((await client.listUserScripts()).scripts).toEqual([]);
  });
});
