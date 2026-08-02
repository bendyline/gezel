import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ensureGezel } from './ensure.js';

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
let manager: ChatManager;
let mock: MockProvider;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-ensure-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  const events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  catalog = new CatalogService();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test',
    home,
    providers: [['copilot', mock]],
    catalog,
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ensureGezel — roster reuse', () => {
  it('reuses an existing gezel when the role matches', async () => {
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    const res = await ensureGezel({
      opts: { jobTitle: 'designer' },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).toBe('reused');
    expect(res.gezelId).toBe('maya');
    expect(res.name).toBe('Maya');
  });

  it('reuses via an alias (UX/UI designer → designer)', async () => {
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    const res = await ensureGezel({
      opts: { jobTitle: 'UX/UI designer' },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).toBe('reused');
    expect(res.gezelId).toBe('maya');
  });

  it('reuses via an abbreviation (dev → developer)', async () => {
    await store.createGezel({ name: 'Alex', role: 'Developer' });
    const res = await ensureGezel({
      opts: { jobTitle: 'dev' },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).toBe('reused');
    expect(res.gezelId).toBe('alex');
  });

  it('does not reuse when the roles are genuinely different', async () => {
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    // Ask for a reviewer — not on roster, not in gilde match, falls
    // through to gilde (which has "reviewer"). Mock the bespoke LLM
    // call just in case we land there.
    mock.script(
      '## Identity\n\nYou are a reviewer.\n\n## Expertise\n\nReading.\n\n## Working Style\n\nCareful.\n\n## Preferences\n\nTerse.',
    );
    const res = await ensureGezel({
      opts: { jobTitle: 'reviewer' },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).not.toBe('reused');
    expect(res.gezelId).not.toBe('maya');
  });
});

describe('ensureGezel — gilde creation', () => {
  it('creates from a gilde template when the roster has no fit', async () => {
    // Empty roster → gilde path.
    const res = await ensureGezel({
      opts: {
        jobTitle: 'copywriter',
        preferredName: 'Ines',
      },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).toBe('created-from-gilde');
    expect(res.templateId).toBe('copywriter');
    expect(res.name).toBe('Ines');
    const onDisk = await store.getGezel(res.gezelId);
    expect(onDisk?.role).toBe('Copywriter');
    expect(onDisk?.about).toContain('Copywriter');
  });

  it('auto-picks a first name when none is supplied', async () => {
    const res = await ensureGezel({
      opts: { jobTitle: 'designer' },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).toBe('created-from-gilde');
    expect(res.name).toBeTruthy();
    expect(res.name.length).toBeGreaterThan(1);
  });
});

describe('ensureGezel — bespoke fallback', () => {
  it('creates a bespoke gezel when neither roster nor gilde fits', async () => {
    mock.script(
      '## Identity\n\nYou are a marine biologist helping gezels reason about aquatic systems.\n\n' +
        '## Expertise\n\nTidal ecosystems, species classification.\n\n' +
        '## Working Style\n\nCurious, patient.\n\n' +
        '## Preferences\n\nCite sources.',
    );
    const res = await ensureGezel({
      opts: {
        jobTitle: 'marine biologist',
      },
      store,
      catalog,
      chat: manager,
    });
    expect(res.action).toBe('created-bespoke');
    expect(res.role).toBe('marine biologist');
    const onDisk = await store.getGezel(res.gezelId);
    expect(onDisk?.about).toContain('marine biologist');
  });
});

describe('ensureGezel — idempotency', () => {
  it('two calls in a row reuse the first-created gezel instead of doubling up', async () => {
    const first = await ensureGezel({
      opts: { jobTitle: 'designer' },
      store,
      catalog,
      chat: manager,
    });
    const second = await ensureGezel({
      opts: { jobTitle: 'designer' },
      store,
      catalog,
      chat: manager,
    });
    expect(second.action).toBe('reused');
    expect(second.gezelId).toBe(first.gezelId);
  });
});

describe('resolveGildeTemplateForRole', () => {
  it('resolves a standard role to its shipped template with a real about', async () => {
    const { resolveGildeTemplateForRole } = await import('./ensure.js');
    const res = await resolveGildeTemplateForRole(catalog, 'Developer');
    expect(res).not.toBeNull();
    expect(res!.templateId).toBe('developer');
    expect(res!.about.length).toBeGreaterThan(500);
    expect(res!.about).toContain('You are a **Developer**');
  });

  it('returns null for a role no template matches', async () => {
    const { resolveGildeTemplateForRole } = await import('./ensure.js');
    const res = await resolveGildeTemplateForRole(catalog, 'submarine acoustician');
    expect(res).toBeNull();
  });

  it('refuses a matched template whose about failed to load (empty-system-prompt guard)', async () => {
    const { resolveGildeTemplateForRole } = await import('./ensure.js');
    const stub = {
      list: async () => [
        {
          sourceId: 'test',
          kind: 'gezel-template',
          manifest: {
            kind: 'gezel-template',
            id: 'developer',
            name: 'Developer',
            role: 'Developer',
            description: 'dev',
            tags: ['developer'],
          },
        },
      ],
      get: async () => ({
        manifest: {
          kind: 'gezel-template',
          id: 'developer',
          name: 'Developer',
          role: 'Developer',
          version: '1.0.0',
        },
        about: '',
      }),
    } as unknown as CatalogService;
    const res = await resolveGildeTemplateForRole(stub, 'Developer');
    expect(res).toBeNull();
  });

  it('fixed-function templates are exempt from the about requirement', async () => {
    const { resolveGildeTemplateForRole } = await import('./ensure.js');
    const stub = {
      list: async () => [
        {
          sourceId: 'test',
          kind: 'gezel-template',
          manifest: {
            kind: 'gezel-template',
            id: 'image-generator',
            name: 'Image generator',
            role: 'Image generator',
            description: 'renders images',
            tags: ['image-generator'],
          },
        },
      ],
      get: async () => ({
        manifest: {
          kind: 'gezel-template',
          id: 'image-generator',
          name: 'Image generator',
          role: 'Image generator',
          version: '1.0.0',
          frontmatter: { fixedFunction: { tool: 'generate_image', promptKey: 'prompt' } },
        },
        about: '',
      }),
    } as unknown as CatalogService;
    const res = await resolveGildeTemplateForRole(stub, 'Image generator');
    expect(res).not.toBeNull();
    expect(res!.frontmatter?.fixedFunction).toBeTruthy();
  });
});
