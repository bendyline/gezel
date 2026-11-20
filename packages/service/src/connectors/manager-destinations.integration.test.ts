import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ConnectorManager, ConnectorPolicyError } from './manager.js';
import { registerBlueskyAdapters } from './natives/bluesky-posts.js';
import { connectorCredentialName } from './registry.js';

let home: string | null = null;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
});

async function setup() {
  home = await mkdtemp(join(tmpdir(), 'gezel-destinations-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  const project = await store.createProject({ name: 'Destinations' });
  const connectors = new ConnectorManager({
    store,
    secrets: new FileSecretStore(home),
    catalog: new CatalogService(),
  });
  return { store, project, connectors };
}

// Editing where a binding sends its credential needed no credential: an
// approved app could point the server at itself and receive the sign-in on
// the next sync.
describe('where a connection sends its sign-in', () => {
  it("is the person's own app's to change, and the credential's origins follow it", async () => {
    const { store, project, connectors } = await setup();
    const binding = await connectors.bind(project, {
      type: 'github-issues',
      sourceId: 'bundled',
      config: { owner: 'bendyline', repository: 'gezel' },
      credential: 'ghp_person',
    });
    const credential = connectorCredentialName(binding.type, binding.id);
    const origins = async () =>
      (await store.getProject(project.id))!.credentialAllowedOrigins?.[credential];
    expect(await origins()).toEqual(['https://api.github.com']);

    const toGhe = { owner: 'bendyline', repository: 'gezel', apiBaseUrl: 'https://ghe.test' };
    await expect(connectors.patchBinding(project, binding.id, { config: toGhe })).rejects.toThrow(
      ConnectorPolicyError,
    );
    expect(await origins()).toEqual(['https://api.github.com']);

    // A setting that does not move the credential stays open to other callers.
    await connectors.patchBinding(project, binding.id, {
      config: { owner: 'bendyline', repository: 'gilde' },
    });

    await connectors.patchBinding(project, binding.id, { config: toGhe, firstParty: true });
    expect(await origins()).toEqual(['https://api.github.com', 'https://ghe.test']);
  });

  it('is never widened by a sync from a setting someone else changed', async () => {
    const { store, project, connectors } = await setup();
    const binding = await connectors.bind(project, {
      type: 'github-issues',
      sourceId: 'bundled',
      config: { owner: 'bendyline', repository: 'gezel' },
      credential: 'ghp_person',
    });
    const current = (await store.getProject(project.id))!;
    await store.updateProject(project.id, {
      connectors: current.connectors!.map((b) =>
        b.id === binding.id
          ? { ...b, config: { ...b.config, apiBaseUrl: 'https://collector.test' } }
          : b,
      ),
    });
    // The pass itself fails here (no script runner); the heal runs first.
    await connectors.syncBinding(project, binding.id).catch(() => {});
    const credential = connectorCredentialName(binding.type, binding.id);
    expect((await store.getProject(project.id))!.credentialAllowedOrigins?.[credential]).toEqual([
      'https://api.github.com',
    ]);
  });

  it('is an https address for Bluesky, where sign-in sends the app password', async () => {
    registerBlueskyAdapters();
    const { project, connectors } = await setup();
    const binding = await connectors.bind(project, {
      type: 'bluesky-posts',
      sourceId: 'bundled',
      config: { handle: 'me.bsky.social' },
      credential: 'app-password',
    });
    await expect(
      connectors.patchBinding(project, binding.id, {
        config: { handle: 'me.bsky.social', service: 'http://pds.test' },
        firstParty: true,
      }),
    ).rejects.toThrow(/must be an https:\/\/ address/);
    await expect(
      connectors.patchBinding(project, binding.id, {
        config: { handle: 'me.bsky.social', service: 'https://pds.test' },
      }),
    ).rejects.toThrow(/Only the Gezel app can change where/);
    const moved = await connectors.patchBinding(project, binding.id, {
      config: { handle: 'me.bsky.social', service: 'https://pds.test' },
      firstParty: true,
    });
    expect(moved.config).toMatchObject({ service: 'https://pds.test' });
    await expect(
      connectors.bind(project, {
        type: 'bluesky-posts',
        sourceId: 'bundled',
        config: { handle: 'you.bsky.social', service: 'http://pds.test' },
      }),
    ).rejects.toThrow(/must be an https:\/\/ address/);
  });
});
