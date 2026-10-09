import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { craftbookTemplateManifestFromRuntime } from '../src/craftbook-doc.js';
import { projectTypeScriptProvenance } from '../src/project-types/composition.js';
import { portableToolResultText } from '../src/runtime/portable-tool-results.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { executePortableTool, portableToolSurface } from '../src/runtime/product-tools.js';
import { portableProjectScriptTools } from '../src/runtime/project-type-routes.js';
import { type PortableProjectType, PortableProjectTypes } from '../src/runtime/project-types.js';
import type { PortableScripts } from '../src/runtime/script-host.js';
import { portableFixture } from '../src/runtime/test-files.js';
import type { CatalogItemDetail } from '../src/schemas/catalog.js';
import type { Craftbook } from '../src/schemas/craftbook.js';
import type { ScriptRun } from '../src/schemas/script.js';

const GAME_STORE = `import { defineScript, gezel } from '@bendyline/gezel-sdk';
export const meta = defineScript({ name: 'game-store', description: 'Board state.', inputs: {}, requires: ['workspace.read', 'workspace.write'] } as const);
gezel.output({ lastMove: 'c3-d4' });
`;

function checkersType(overrides: Partial<Record<string, unknown>> = {}): PortableProjectType {
  return {
    item: {
      sourceId: 'bundled',
      kind: 'project-type',
      manifest: {
        schemaVersion: 1,
        kind: 'project-type',
        id: 'checkers',
        name: 'Checkers',
        description: 'Play checkers against a gezel.',
        tags: [],
        category: 'game',
        maintainer: { name: 'Bendyline' },
        version: '1.2.0',
        releasedAt: '2026-08-12T00:00:00Z',
        mode: 'solo',
        leadLabel: 'Opponent',
        leanProfile: true,
        params: {
          type: 'object',
          properties: { personality: { type: 'string', default: 'peppy' } },
        },
        aboutTemplate: 'about.md',
        gezels: [{ templateId: 'checkers-player', voorman: true }],
        toolsets: [],
        craftbooks: [],
        scripts: { 'game-store': GAME_STORE },
        tools: [
          {
            name: 'make_move',
            description: 'Play your move.',
            script: 'game-store',
            inputs: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
            },
            bind: { action: 'ai_move' },
          },
          {
            name: 'user_move',
            description: "The user's move, played from the board page.",
            script: 'game-store',
            inputs: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
            },
            bind: { action: 'user_move' },
            reaction: {
              gezel: 'checkers-player',
              prompt: 'Your opponent played {{output.lastMove}}. Make your move.',
              hideSeed: true,
            },
          },
        ],
        pages: {
          entry: 'board/index.html',
          api: 1,
          reads: [{ source: 'workspace', path: 'game.json' }],
          tools: ['user_move'],
        },
        schedules: [],
        workspaceSeed: ['game.json'],
        artifactsSeed: [],
        availableVersions: ['1.2.0'],
        ...overrides,
      },
    } as CatalogItemDetail,
    files: {
      'about.md': 'A {{personality}} opponent across the board.',
      'game.json': '{"turn":"user","personality":"{{personality}}"}\n',
      'pages/board/index.html':
        '<!doctype html><script>window.gezel.data.read("game.json")</script>',
    },
  };
}

const template = {
  sourceId: 'bundled',
  kind: 'gezel-template',
  manifest: {
    schemaVersion: 1,
    kind: 'gezel-template',
    id: 'checkers-player',
    name: 'Checkers player',
    description: 'Plays checkers.',
    tags: [],
    maintainer: { name: 'Bendyline' },
    version: '1.0.0',
    releasedAt: '2026-08-12T00:00:00Z',
    role: 'Damspeler',
    about: 'about.md',
    availableVersions: ['1.0.0'],
  },
  about: 'You play checkers.',
} as unknown as CatalogItemDetail;

async function setup(type: PortableProjectType = checkersType()) {
  const fixture = portableFixture();
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Fixture',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 8192,
        maxOutputTokens: 1024,
        capabilities: {
          text: true,
          tools: false,
          structuredOutput: false,
          images: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: async () => ({ text: 'Your move.', stopReason: 'stop' }),
    cancel: async () => {},
    models: async () => ({
      models: [{ id: 'gemma-4-e4b', name: 'Gemma 4 E4B', sizeBytes: 3_000_000_000 }],
      selectedModelId: 'gemma-4-e4b',
    }),
  };
  const service = new PortableProductService(fixture.store, inference, 'secret', {
    projectTypes: async () => [type],
  });
  service.setContent({ templates: [template], craftbooks: [] });
  const runs: Array<Parameters<PortableScripts['run']>[0]> = [];
  service.setScripts({
    list: () => [],
    source: async () => {
      throw new Error('No standard scripts');
    },
    initialize: async () => {},
    isBusy: () => false,
    cancel: async () => {},
    run: async (options) => {
      runs.push(options);
      return {
        id: `run-${runs.length}`,
        projectId: options.projectId,
        scriptName: options.scriptName,
        startedAt: '2026-10-06T00:00:00Z',
        finishedAt: '2026-10-06T00:00:01Z',
        status: 'ok',
        trigger: options.trigger,
        inputs: options.inputs ?? {},
        output: { lastMove: 'c3-d4' },
        calls: [],
        logs: '',
      } satisfies ScriptRun;
    },
  });
  await service.initialize();
  const client = new GezelClient({
    baseUrl: 'https://gezel.local',
    token: 'secret',
    fetch: service.fetch,
  });
  return { ...fixture, service, client, runs };
}

describe('catalog project types on the portable host', () => {
  it('offers its bundled types to the New Project gallery', async () => {
    const { client, service } = await setup();
    expect(service.capabilities.projectTypes).toBe(true);
    const { items } = await client.listCatalogItems('project-type');
    expect(items.map((item) => item.manifest.id)).toEqual(['checkers']);
    expect(items[0]!.unavailableReason).toBeUndefined();
    const detail = await client.getCatalogItem('project-type', 'checkers', { version: '1.0.0' });
    expect(detail.manifest).toMatchObject({ id: 'checkers', version: '1.2.0' });
  });

  it('marks a type whose capability floor is above the device model, and refuses to create it', async () => {
    const { client } = await setup(checkersType({ capabilityFloor: 'large' }));
    const { items } = await client.listCatalogItems('project-type');
    expect(items[0]!.unavailableReason).toMatch(/larger model/);
    await expect(
      client.createTypedProject({ name: 'Game', projectType: { typeId: 'checkers' } }),
    ).rejects.toMatchObject({
      status: 409,
      details: { error: expect.stringContaining('larger model') },
    });
    expect((await client.listProjects()).projects.map((project) => project.name)).not.toContain(
      'Game',
    );
  });

  it('creates a typed project in one step: crew, provenance, rendered about, seeds and scripts', async () => {
    const { client, store } = await setup();
    const { project, applied } = await client.createTypedProject({
      name: 'Checkers vs the Damspeler',
      projectType: { typeId: 'checkers' },
    });
    expect(project).toMatchObject({
      mode: 'solo',
      leadLabel: 'Opponent',
      leanProfile: true,
      about: 'A peppy opponent across the board.',
      projectType: { id: 'checkers', version: '1.2.0', params: { personality: 'peppy' } },
    });
    const [opponent] = applied.gezelsCreated;
    expect(opponent).toMatchObject({ templateId: 'checkers-player', voorman: true });
    expect(project.voormanGezelId).toBe(opponent!.id);
    expect(project.gezelIds).toEqual([opponent!.id]);
    expect((await store.getGezel(opponent!.id))?.role).toBe('Damspeler');
    expect(await store.readFile('workspace', project.id, 'game.json')).toContain('"peppy"');
    const script = await store.readScriptSource(
      { scope: 'project', projectId: project.id },
      'game-store',
    );
    expect(projectTypeScriptProvenance(script!.source)).toBe('checkers@1.2.0');
    expect(applied).toMatchObject({
      scriptsInstalled: ['game-store'],
      workspaceSeeded: ['game.json'],
      toolsBound: ['make_move', 'user_move'],
      schedulesCreated: [],
    });

    // The checkers opponent is one recurring character, as on the desktop.
    const second = await client.createTypedProject({
      name: 'Rematch',
      projectType: { typeId: 'checkers', params: { personality: 'zen' } },
    });
    expect(second.applied.gezelsCreated).toEqual([
      expect.objectContaining({ id: opponent!.id, reused: true }),
    ]);
    expect(second.project.about).toBe('A zen opponent across the board.');
  });

  it("suggests the type's own craftbooks, carried or bundled, under the type's name", async () => {
    const book = (id: string, name: string) =>
      ({
        id,
        name,
        description: `${name} for this project.`,
        version: '1.0.0',
        entryStepId: 'write',
        steps: [{ id: 'write', name: 'Write it', prompt: 'Write the report.', terminal: true }],
        createdAt: '2026-08-12T00:00:00Z',
        updatedAt: '2026-08-12T00:00:00Z',
      }) as unknown as Craftbook;
    const type = checkersType({ craftbooks: ['season-recap', 'weekly-review', 'month-close'] });
    type.craftbooks = { 'season-recap': book('season-recap', 'Season recap') };
    const { client, service } = await setup(type);
    const review = book('weekly-review', 'Weekly review');
    const other = book('trip-notes', 'Trip notes');
    service.setContent({
      templates: [template],
      craftbooks: [review, other].map((entry) => ({
        book: entry,
        item: {
          sourceId: 'bundled',
          kind: 'craftbook-template',
          manifest: craftbookTemplateManifestFromRuntime(entry)!,
        } as CatalogItemDetail,
      })),
    });
    const { project } = await client.createTypedProject({
      name: 'League night',
      projectType: { typeId: 'checkers' },
    });
    const offer = await client.listProjectCraftbooks(project.id);
    expect(offer.items.map((item) => `${item.sourceId}:${item.manifest.id}`)).toEqual([
      'project:season-recap',
      'bundled:weekly-review',
      'bundled:trip-notes',
    ]);
    // month-close is declared but no phone can run it, so it is not offered.
    expect(offer.suggestedIds).toEqual(['season-recap', 'weekly-review']);
    expect(offer.projectType).toEqual({ id: 'checkers', label: 'Checkers' });

    const plain = await client.listProjectCraftbooks('default');
    expect(plain.suggestedIds).toEqual([]);
    expect(plain.projectType).toBeNull();
  });

  it('refuses a version this device does not carry', async () => {
    const { client } = await setup();
    await expect(
      client.createTypedProject({
        name: 'Old',
        projectType: { typeId: 'checkers', version: '1.0.0' },
      }),
    ).rejects.toMatchObject({
      status: 404,
      details: { error: expect.stringContaining('not available on this device') },
    });
  });

  it("serves the page bridge from the type's manifest, never wider", async () => {
    const { client, runs } = await setup();
    const { project } = await client.createTypedProject({
      name: 'Game',
      projectType: { typeId: 'checkers' },
    });
    const read = await client.invokeProjectPageRead(project.id, {
      op: 'read',
      source: 'workspace',
      path: 'game.json',
    });
    expect(read).toMatchObject({ op: 'read', encoding: 'utf8' });
    expect(read.content).toContain('"turn":"user"');
    await expect(
      client.invokeProjectPageRead(project.id, {
        op: 'read',
        source: 'workspace',
        path: 'notes.md',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      client.invokeProjectPageRead(project.id, {
        op: 'read',
        source: 'workspace',
        path: '../escape.json',
      }),
    ).rejects.toMatchObject({ status: 400 });

    // The model's own tool is never page-invokable; an unknown one is not found.
    await expect(
      client.invokeProjectPageTool(project.id, {
        tool: 'make_move',
        input: { from: 'a', to: 'b' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      client.invokeProjectPageTool(project.id, { tool: 'resign' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.invokeProjectPageTool(project.id, { tool: 'user_move', input: { from: 'c3' } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(runs).toHaveLength(0);
  });

  it('runs a page tool with the bound action and summons the opponent with a hidden seed', async () => {
    const { client, runs, store, service } = await setup();
    const { project, applied } = await client.createTypedProject({
      name: 'Game',
      projectType: { typeId: 'checkers' },
    });
    const opponent = applied.gezelsCreated[0]!.id;
    const result = await client.invokeProjectPageTool(project.id, {
      tool: 'user_move',
      input: { from: 'c3', to: 'd4', action: 'ai_move' },
    });
    expect(runs[0]).toMatchObject({
      projectId: project.id,
      scriptName: 'game-store',
      scope: 'project',
      // The manifest's bind wins over anything the page sends.
      inputs: { from: 'c3', to: 'd4', action: 'user_move' },
      trigger: { kind: 'page', tool: 'user_move' },
    });
    expect(result).toMatchObject({
      status: 'ok',
      reaction: { delivered: true, gezelId: opponent },
    });
    await vi.waitFor(() => expect(service.busy).toBe(false));
    const [summary] = await store.listSessions({ gezelId: opponent, projectId: project.id });
    const session = await store.getSession(opponent, summary!.id);
    const seed = session!.messages.find((message) => message.role === 'user')!;
    expect(seed).toMatchObject({
      hidden: true,
      content: '[Checkers page]: Your opponent played c3-d4. Make your move.',
    });
  });

  it('reports a reaction it could not deliver while AI engagement is off, without failing the move', async () => {
    const { client, store } = await setup();
    const { project } = await client.createTypedProject({
      name: 'Game',
      projectType: { typeId: 'checkers' },
    });
    await store.writeConfig({ aiEngagementMode: 'off' });
    const result = await client.invokeProjectPageTool(project.id, {
      tool: 'user_move',
      input: { from: 'c3', to: 'd4' },
    });
    expect(result).toMatchObject({
      status: 'ok',
      reaction: { delivered: false, reason: 'engagement-off' },
    });
  });

  it('gives the page the bootstrap the desktop bakes into its shim', async () => {
    const { client, service } = await setup();
    const { project } = await client.createTypedProject({
      name: 'Game',
      projectType: { typeId: 'checkers' },
    });
    const response = await service.fetch(
      `https://gezel.local/api/projects/${project.id}/type/bootstrap?path=board/index.html`,
      { headers: { Authorization: 'Bearer secret' } },
    );
    expect(await response.json()).toEqual({
      apiV1: true,
      bootstrap: {
        api: 1,
        projectId: project.id,
        source: 'type',
        entry: 'board/index.html',
        typeName: 'Checkers',
        params: { personality: 'peppy' },
        tools: ['user_move'],
      },
    });
    const page = await service.fetch(
      `https://gezel.local/api/projects/${project.id}/type/read?raw=1&path=board/index.html`,
      { headers: { Authorization: 'Bearer secret' } },
    );
    expect(await page.text()).toContain('window.gezel');
    const outside = await service.fetch(
      `https://gezel.local/api/projects/${project.id}/type/read?raw=1&path=../about.md`,
      { headers: { Authorization: 'Bearer secret' } },
    );
    expect(outside.status).toBe(400);
  });
});

describe("a project type's tools in a phone session", () => {
  it('gives a lean session its own tools and ask_user_question, hides page-only tools, and runs the bound script', async () => {
    const { client, store } = await setup();
    const { project, applied } = await client.createTypedProject({
      name: 'Game',
      projectType: { typeId: 'checkers' },
    });
    const session = await store.createSession({
      gezelId: applied.gezelsCreated[0]!.id,
      projectId: project.id,
    });
    const projectTools = await portableProjectScriptTools(
      new PortableProjectTypes(async () => [checkersType()]),
      project,
    );
    const surface = await portableToolSurface(store, session, true, projectTools);
    expect(surface.map((tool) => tool.name)).toEqual(['ask_user_question', 'make_move']);
    expect(surface.find((tool) => tool.name === 'make_move')).toMatchObject({ core: true });

    const runs: unknown[] = [];
    const actions = {
      recruit: async () => ({ id: 'x', name: 'x' }),
      templates: () => [],
      createTask: async () => ({}),
      completeTask: async () => ({}),
      assertHandoffAllowed: () => {},
      message: async () => ({}),
      startProject: async () => ({}),
      projectTools,
      scripts: {
        list: () => ({ items: [] }),
        run: async (name: string, inputs: Record<string, unknown>, _s: unknown, scope: string) => {
          runs.push({ name, inputs, scope });
          return { runId: 'run-1', status: 'ok', output: { lastMove: 'b6-a5' }, calls: [] };
        },
      },
    };
    await expect(
      executePortableTool(store, session, 'make_move', { from: 'b6' }, actions),
    ).rejects.toThrow(/schema/);
    await expect(
      executePortableTool(store, session, 'user_move', { from: 'b6', to: 'a5' }, actions),
    ).rejects.toThrow(/unavailable/);
    const value = await executePortableTool(
      store,
      session,
      'make_move',
      { from: 'b6', to: 'a5', action: 'user_move' },
      actions,
    );
    expect(runs).toEqual([
      { name: 'game-store', inputs: { from: 'b6', to: 'a5', action: 'ai_move' }, scope: 'project' },
    ]);
    const rendered = await portableToolResultText(store, session, 'make_move', {}, value);
    expect(rendered).toMatchObject({ isError: false });
    expect(rendered!.text).toContain('b6-a5');
  });
});

describe('a long game on a small system model', () => {
  it('keeps every move playable on a 4K window by leaving out old turns, not tools', async () => {
    const fixture = portableFixture();
    const type = checkersType();
    const manifest = type.item.manifest as { tools: { reaction?: { prompt: string } }[] };
    manifest.tools[1]!.reaction!.prompt = 'They played {{output.lastMove}}.\n{{output.board}}';
    const requests: Array<{ maxTokens?: number; system: string; count: number }> = [];
    const service = new PortableProductService(
      fixture.store,
      {
        providers: async () => [
          {
            id: 'android-mlkit',
            name: 'Android on-device AI',
            locality: 'on-device',
            availability: 'available',
            contextTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: {
              text: true,
              tools: false,
              structuredOutput: false,
              images: false,
              foregroundOnly: true,
            },
          },
        ],
        // About four bytes a token; ML Kit refuses before generating anything.
        generate: async (request) => {
          const bytes = request.messages.reduce(
            (sum, message) => sum + new TextEncoder().encode(message.content).byteLength,
            0,
          );
          requests.push({
            maxTokens: request.maxTokens,
            system: request.messages[0]!.content,
            count: request.messages.length,
          });
          if (bytes / 4 > request.contextSize! - request.maxTokens!)
            throw Object.assign(
              new Error(
                "This conversation is too long for Android's on-device AI. Start a new conversation.",
              ),
              { code: 'CONTEXT_LIMIT' },
            );
          return { text: 'Nice move.', stopReason: 'stop' };
        },
        cancel: async () => {},
      },
      'secret',
      { projectTypes: async () => [type] },
    );
    service.setContent({ templates: [template], craftbooks: [] });
    service.setScripts({
      list: () => [],
      source: async () => {
        throw new Error('No standard scripts');
      },
      initialize: async () => {},
      isBusy: () => false,
      cancel: async () => {},
      run: async (options) => ({
        id: crypto.randomUUID(),
        projectId: options.projectId,
        scriptName: options.scriptName,
        startedAt: '2026-10-06T00:00:00Z',
        status: 'ok',
        trigger: options.trigger,
        inputs: options.inputs ?? {},
        // The authoritative board every reaction seed carries.
        output: { lastMove: 'c3-d4', board: 'x'.repeat(2_400) },
        calls: [],
        logs: '',
      }),
    });
    await service.initialize();
    await fixture.store.writeConfig({ provider: 'android-mlkit' });
    const client = new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'secret',
      fetch: service.fetch,
    });
    const { project, applied } = await client.createTypedProject({
      name: 'Long game',
      projectType: { typeId: 'checkers' },
    });
    const opponent = applied.gezelsCreated[0]!.id;
    for (let move = 0; move < 30; move++) {
      await client.invokeProjectPageTool(project.id, {
        tool: 'user_move',
        input: { from: 'c3', to: 'd4' },
      });
      await vi.waitFor(() => expect(service.busy).toBe(false));
    }
    const [summary] = await fixture.store.listSessions({
      gezelId: opponent,
      projectId: project.id,
    });
    const session = await fixture.store.getSession(opponent, summary!.id);
    expect(session!.lastTurnError).toBeUndefined();
    const replies = session!.messages.filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(30);
    expect(replies.every((reply) => reply.content === 'Nice move.' && !reply.error)).toBe(true);
    // The game keeps its tools; the reply budget makes room for the board.
    const last = requests.at(-1)!;
    expect(last.system).toContain('make_move');
    expect(last.system).toContain('Earlier turns of this conversation are left out');
    expect(requests.every((request) => request.maxTokens === 512)).toBe(true);
  });
});

describe('a standalone game reaction on a small system model', () => {
  it('answers each move from the instructions and the board alone', async () => {
    const fixture = portableFixture();
    const type = checkersType();
    const manifest = type.item.manifest as { tools: { reaction?: { prompt: string } }[] };
    manifest.tools[1]!.reaction!.prompt = 'They played {{output.lastMove}}.\n{{output.board}}';
    (manifest.tools[1]!.reaction as { standalone?: boolean }).standalone = true;
    const requests: Array<{ maxTokens?: number; system: string; count: number }> = [];
    const service = new PortableProductService(
      fixture.store,
      {
        providers: async () => [
          {
            id: 'android-mlkit',
            name: 'Android on-device AI',
            locality: 'on-device',
            availability: 'available',
            contextTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: {
              text: true,
              tools: false,
              structuredOutput: false,
              images: false,
              foregroundOnly: true,
            },
          },
        ],
        // About four bytes a token; ML Kit refuses before generating anything.
        generate: async (request) => {
          const bytes = request.messages.reduce(
            (sum, message) => sum + new TextEncoder().encode(message.content).byteLength,
            0,
          );
          requests.push({
            maxTokens: request.maxTokens,
            system: request.messages[0]!.content,
            count: request.messages.length,
          });
          if (bytes / 4 > request.contextSize! - request.maxTokens!)
            throw Object.assign(
              new Error(
                "This conversation is too long for Android's on-device AI. Start a new conversation.",
              ),
              { code: 'CONTEXT_LIMIT' },
            );
          return { text: 'Nice move.', stopReason: 'stop' };
        },
        cancel: async () => {},
      },
      'secret',
      { projectTypes: async () => [type] },
    );
    service.setContent({ templates: [template], craftbooks: [] });
    service.setScripts({
      list: () => [],
      source: async () => {
        throw new Error('No standard scripts');
      },
      initialize: async () => {},
      isBusy: () => false,
      cancel: async () => {},
      run: async (options) => ({
        id: crypto.randomUUID(),
        projectId: options.projectId,
        scriptName: options.scriptName,
        startedAt: '2026-10-06T00:00:00Z',
        status: 'ok',
        trigger: options.trigger,
        inputs: options.inputs ?? {},
        // The authoritative board every reaction seed carries.
        output: { lastMove: 'c3-d4', board: 'x'.repeat(2_400) },
        calls: [],
        logs: '',
      }),
    });
    await service.initialize();
    await fixture.store.writeConfig({ provider: 'android-mlkit' });
    const client = new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'secret',
      fetch: service.fetch,
    });
    const { project, applied } = await client.createTypedProject({
      name: 'Long game',
      projectType: { typeId: 'checkers' },
    });
    const opponent = applied.gezelsCreated[0]!.id;
    for (let move = 0; move < 30; move++) {
      await client.invokeProjectPageTool(project.id, {
        tool: 'user_move',
        input: { from: 'c3', to: 'd4' },
      });
      await vi.waitFor(() => expect(service.busy).toBe(false));
    }
    const [summary] = await fixture.store.listSessions({
      gezelId: opponent,
      projectId: project.id,
    });
    const session = await fixture.store.getSession(opponent, summary!.id);
    expect(session!.lastTurnError).toBeUndefined();
    const replies = session!.messages.filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(30);
    expect(replies.every((reply) => reply.content === 'Nice move.' && !reply.error)).toBe(true);
    // Every move went out as the instructions and the newest board alone,
    // so nothing was ever trimmed and the game never refused.
    expect(requests.every((request) => request.count === 2)).toBe(true);
    expect(requests.some((request) => request.system.includes('Earlier turns'))).toBe(false);
    expect(requests).toHaveLength(30);
  });
});

describe('a person talking to a game gezel on the phone', () => {
  it('answers from the board as it stands, and the move ends the turn', async () => {
    const type = checkersType();
    const manifest = type.item.manifest as { tools: Array<Record<string, unknown>> };
    manifest.tools.unshift({
      name: 'get_board',
      description: 'See the position and legal moves.',
      script: 'game-store',
      inputs: { type: 'object', properties: {} },
      bind: { action: 'board' },
    });
    const { client, store, service, runs } = await setup(type);
    const requests: Parameters<PortableInference['generate']>[0][] = [];
    (service.inference as { generate: PortableInference['generate'] }).generate = async (
      request,
    ) => {
      requests.push(request);
      return {
        text: JSON.stringify({
          name: 'make_move',
          arguments: { from: 'b6', to: 'a5', moveThought: 'A little hop!' },
        }),
        stopReason: 'stop',
      };
    };
    const { project, applied } = await client.createTypedProject({
      name: 'Game',
      projectType: { typeId: 'checkers' },
    });
    const opponent = applied.gezelsCreated[0]!.id;
    const session = await client.createChatSession({ gezelId: opponent, projectId: project.id });
    await client.sendToChatSession(session.id, { message: 'It is your move.' });
    await vi.waitFor(() => expect(service.busy).toBe(false));

    // The board was read for this turn and handed to the model with the words.
    expect(runs.map((run) => run.inputs)).toContainEqual({ action: 'board' });
    expect(requests).toHaveLength(1);
    const sent = requests[0]!.messages.at(-1)!.content;
    expect(sent).toContain('[Latest state — read from `get_board`');
    expect(sent.endsWith('It is your move.')).toBe(true);
    // The transcript keeps the person's words; the move ended the turn.
    const saved = await store.getSession(opponent, session.id);
    expect(saved!.messages.find((m) => m.role === 'user')!.content).toBe('It is your move.');
    const reply = saved!.messages.find((m) => m.role === 'assistant')!;
    expect(reply.content).toBe('A little hop!');
    expect(reply.toolCalls?.map((call) => call.name)).toEqual(['make_move']);
  });
});

describe('a reaction whose turn is one move', () => {
  it('offers only the move while one is due, and every tool once the game is over', async () => {
    const fixture = portableFixture();
    const type = checkersType();
    const manifest = type.item.manifest as {
      tools: Array<{ name: string; turn?: object; reaction?: object }>;
    };
    manifest.tools[0]!.turn = { say: 'moveThought' };
    manifest.tools[1]!.reaction = {
      ...manifest.tools[1]!.reaction,
      turn: { tool: 'make_move', when: { op: 'equals', field: 'status', value: 'playing' } },
    };
    const prompts: string[] = [];
    const service = new PortableProductService(
      fixture.store,
      {
        providers: async () => [
          {
            id: 'android-mlkit',
            name: 'Android on-device AI',
            locality: 'on-device',
            availability: 'available',
            contextTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: {
              text: true,
              tools: false,
              structuredOutput: false,
              images: false,
              foregroundOnly: true,
            },
          },
        ],
        generate: async (request) => {
          prompts.push(request.messages.map((message) => message.content).join('\n'));
          return { text: 'Good game.', stopReason: 'stop' };
        },
        cancel: async () => {},
      },
      'secret',
      { projectTypes: async () => [type] },
    );
    service.setContent({ templates: [template], craftbooks: [] });
    const statuses = ['playing', 'won'];
    service.setScripts({
      list: () => [],
      source: async () => {
        throw new Error('No standard scripts');
      },
      initialize: async () => {},
      isBusy: () => false,
      cancel: async () => {},
      run: async (options) => ({
        id: crypto.randomUUID(),
        projectId: options.projectId,
        scriptName: options.scriptName,
        startedAt: '2026-10-06T00:00:00Z',
        status: 'ok',
        trigger: options.trigger,
        inputs: options.inputs ?? {},
        output: { lastMove: 'c3-d4', status: statuses.shift() ?? 'won' },
        calls: [],
        logs: '',
      }),
    });
    await service.initialize();
    await fixture.store.writeConfig({ provider: 'android-mlkit' });
    const client = new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'secret',
      fetch: service.fetch,
    });
    const { project } = await client.createTypedProject({
      name: 'Short game',
      projectType: { typeId: 'checkers' },
    });
    for (let move = 0; move < 2; move++) {
      await client.invokeProjectPageTool(project.id, {
        tool: 'user_move',
        input: { from: 'c3', to: 'd4' },
      });
      await vi.waitFor(() => expect(service.busy).toBe(false));
    }
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('make_move');
    expect(prompts[0]).not.toContain('ask_user_question');
    expect(prompts[1]).toContain('make_move');
    expect(prompts[1]).toContain('ask_user_question');
  });
});
