/**
 * ChatManager + fixed-function gezels. These gezels skip the LLM
 * entirely — `runSend` dispatches to `runFixedFunctionSend`, which
 * forwards the user's message text to a pre-declared MCP tool via
 * the per-session bridge pool. The provider is never invoked.
 *
 * The tests below script no provider replies; if `MockProvider`'s
 * `sendAndWait` were reached, the session would hang waiting for a
 * scripted reply that never arrives. So a passing test is itself
 * proof the LLM path was bypassed. We additionally assert
 * `mock.toolCallOutputs` stays empty (the LLM-path bridge wasn't
 * invoked) and that the on-disk side effect of the chosen tool
 * lands as expected.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { TaskManager } from '../tasks/manager.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let svc: RunningService;
let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

beforeEach(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-ff-test-'));
  svc = await startService({ home });
  store = svc.context.store;
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => svc.port,
    getToken: () => svc.context.token,
    getCert: () => svc.cert?.certPem ?? null,
    home,
    providers: [['copilot', mock]],
    catalog: svc.context.catalog,
    secrets: svc.context.secrets,
  });
}, 20_000);

afterEach(async () => {
  await manager?.shutdown();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
});

/**
 * Test through `write_document` rather than `generate_image` so the
 * test doesn't depend on having an image engine installed. The
 * shape of the path (user text → promptKey arg → MCP tool → side
 * effect on disk) is identical; `generate_image` is the same code
 * path with a different tool name and arg shape.
 */
function makeWriteDocFf() {
  return {
    name: 'Picasso',
    role: 'Image generator',
    frontmatter: {
      fixedFunction: {
        tool: 'write_document',
        promptKey: 'content',
        defaults: { path: 'ff-out.md' },
      },
    },
  };
}

describe('ChatManager — fixed-function gezels', () => {
  it('skips the LLM and forwards user text to the named MCP tool', async () => {
    const gezel = await store.createGezel(makeWriteDocFf());
    const session = await manager.ensureOrCreateSession({ gezelId: gezel.id });

    const reply = await manager.send(session.id, 'hello from the user');

    // No provider sendAndWait should have been invoked — the LLM
    // path's bridge tracker stays empty. (If it had been invoked
    // and we hadn't scripted a reply, the test would have hung.)
    expect(mock.toolCallOutputs).toHaveLength(0);

    // The user text landed in the configured `promptKey` argument
    // (`content`) — verifiable on disk because `write_document`
    // wrote it under the configured `path` default.
    const onDisk = await readFile(join(home, 'documents', 'ff-out.md'), 'utf8');
    expect(onDisk).toBe('hello from the user');

    // The assistant message carries the tool call so the UI can
    // render the "thinking" expando.
    expect(reply.role).toBe('assistant');
    expect(reply.toolCalls?.length).toBe(1);
    expect(reply.toolCalls![0]!.name).toBe('write_document');
    expect(reply.toolCalls![0]!.success).toBe(true);

    // User and assistant messages persisted in order.
    const disk = await store.getSession(gezel.id, session.id);
    expect(disk?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(disk?.messages[0]!.content).toBe('hello from the user');
  }, 30_000);

  it('releases the session lock so a later send is dispatched instead of parked forever', async () => {
    const gezel = await store.createGezel(makeWriteDocFf());
    const session = await manager.ensureOrCreateSession({ gezelId: gezel.id });

    await manager.send(session.id, 'first request');

    // Fixed-function turns return before the LLM-shaped runSend cleanup.
    // The outer send boundary must still release the per-session lock;
    // otherwise this later handoff is enqueued behind a turn that no
    // longer exists and therefore can never trigger a queue drain.
    expect(manager.inflightInfo(session.id)).toBeNull();
    const second = await manager.send(session.id, 'later handoff');

    expect(second.role).toBe('assistant');
    expect(manager.inflightInfo(session.id)).toBeNull();
    expect(manager.listQueued()).toHaveLength(0);
    const disk = await store.getSession(gezel.id, session.id);
    expect(disk?.messages.map((message) => message.content)).toEqual([
      'first request',
      expect.any(String),
      'later handoff',
      expect.any(String),
    ]);
    expect(await readFile(join(home, 'documents', 'ff-out.md'), 'utf8')).toBe('later handoff');
  }, 30_000);

  it('user text overrides any colliding default on the prompt key', async () => {
    const gezel = await store.createGezel({
      name: 'Picasso',
      role: 'Image generator',
      frontmatter: {
        fixedFunction: {
          tool: 'write_document',
          promptKey: 'content',
          // `content` here is shadowed by the user's message text.
          defaults: { path: 'override-test.md', content: 'BACKGROUND' },
        },
      },
    });
    const session = await manager.ensureOrCreateSession({ gezelId: gezel.id });

    await manager.send(session.id, 'WINNING TEXT');

    const onDisk = await readFile(join(home, 'documents', 'override-test.md'), 'utf8');
    expect(onDisk).toBe('WINNING TEXT');
  }, 30_000);

  it('keeps the declared generate_image tool callable on the fixed-function surface', async () => {
    const gezel = await store.createGezel({
      name: 'Picasso',
      role: 'Image generator',
      frontmatter: {
        fixedFunction: {
          tool: 'generate_image',
          promptKey: 'prompt',
        },
      },
    });
    const session = await manager.ensureOrCreateSession({ gezelId: gezel.id });

    const reply = await manager.send(session.id, 'a tiny abstract compass');

    expect(reply.warnings).toBeUndefined();
    expect(reply.toolCalls?.map((call) => call.name)).toEqual(['generate_image']);
    expect(reply.toolCalls?.[0]?.success).toBe(true);
    expect(reply.toolCalls?.[0]?.argsFull).toBe('prompt: a tiny abstract compass');
    const generatedDir = join(home, 'projects', 'default', 'artifacts', 'generated');
    const entries = await (await import('node:fs/promises')).readdir(generatedDir);
    expect(entries.some((name) => name.endsWith('.png'))).toBe(true);
    expect(manager.inflightInfo(session.id)).toBeNull();
  }, 30_000);

  it('honors an inline image-file handoff path without polluting the image prompt', async () => {
    const gezel = await store.createGezel({
      name: 'Picasso',
      role: 'Image generator',
      frontmatter: {
        fixedFunction: {
          tool: 'generate_image',
          promptKey: 'prompt',
        },
      },
    });
    const session = await manager.ensureOrCreateSession({ gezelId: gezel.id });
    const reply = await manager.send(
      session.id,
      '[Message from Ada]: A friendly hand-drawn bakery logo with a wheat sprig and clear circular silhouette.\n\n' +
        '[Deliverable expected as an IMAGE FILE at `assets/logo.png`. Your first assistant action should be the tool call `generate_image({ prompt, saveAs: "assets/logo.png" })`; reply with the path.]',
    );

    expect(reply.toolCalls?.[0]?.success).toBe(true);
    expect(reply.toolCalls?.[0]?.argsFull).toContain('saveAs: assets/logo.png');
    expect(reply.toolCalls?.[0]?.argsFull).toContain('friendly hand-drawn bakery logo');
    expect(reply.toolCalls?.[0]?.argsFull).not.toContain('Deliverable expected');
    expect(reply.toolCalls?.[0]?.argsFull).not.toContain('generate_image');
    await expect(
      stat(join(await store.projectWorkspaceDir('default'), 'assets', 'logo.png')),
    ).resolves.toBeDefined();
  }, 30_000);

  it('uses a task image brief and writes the exact step deliverable path', async () => {
    const project = await store.createProject({
      name: 'Mountain Sunset',
      about:
        'Create a stylized sunset over layered mountain silhouettes, with warm amber light and a clean editorial illustration style.',
      missionObjectives:
        '- Render the requested mountain sunset as a real raster image.\n- Save the final asset as sunset.png in the workspace.',
      mode: 'solo',
    });
    const gezel = await store.createGezel({
      name: 'Picasso',
      role: 'Image generator',
      frontmatter: {
        fixedFunction: {
          tool: 'generate_image',
          promptKey: 'prompt',
        },
      },
    });
    const task = await new TaskManager(store).create(project.id, {
      title: 'Render the mountain sunset',
      description:
        'Produce the requested warm, stylized sunset illustration over layered mountains for the project.',
      assignee: { kind: 'gezel', gezelId: gezel.id },
      steps: [
        {
          name: 'Render image',
          suggestedRole: 'image-generator',
          deliverable: { path: 'sunset.png', kind: 'image-set', minBytes: 100 },
        },
      ],
    });
    const session = await manager.createSession({
      gezelId: gezel.id,
      projectId: project.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
    });

    const reply = await manager.send(
      session.id,
      `You've been assigned task ${task.ref}. Follow the step instructions already in your prompt.`,
    );

    expect(reply.toolCalls?.[0]?.success).toBe(true);
    expect(reply.toolCalls?.[0]?.argsFull).toContain('saveAs: sunset.png');
    expect(reply.toolCalls?.[0]?.argsFull).toContain(
      'stylized sunset over layered mountain silhouettes',
    );
    expect(reply.toolCalls?.[0]?.argsFull).not.toContain("You've been assigned task");
    await expect(
      stat(join(await store.projectWorkspaceDir(project.id), 'sunset.png')),
    ).resolves.toBeDefined();
  }, 30_000);

  it('does not write about.md for fixed-function gezels', async () => {
    const gezel = await store.createGezel(makeWriteDocFf());

    // about.md should NOT exist on disk for a fixed-function gezel.
    await expect(stat(join(home, 'gezels', gezel.id, 'about.md'))).rejects.toThrow();

    // The detail's `about` field is empty, since there's no file.
    const detail = await store.getGezel(gezel.id);
    expect(detail?.about).toBe('');
  });

  it('rejects updateGezelAbout on fixed-function gezels', async () => {
    const gezel = await store.createGezel(makeWriteDocFf());
    await expect(store.updateGezelAbout(gezel.id, '## Some about\n\nhi')).rejects.toThrow(
      /fixed-function/,
    );
  });

  it('persists an error assistant bubble when the configured tool is unknown', async () => {
    const gezel = await store.createGezel({
      name: 'Picasso',
      role: 'Image generator',
      frontmatter: {
        fixedFunction: {
          tool: 'this_tool_does_not_exist',
          promptKey: 'prompt',
        },
      },
    });
    const session = await manager.ensureOrCreateSession({ gezelId: gezel.id });

    const reply = await manager.send(session.id, 'will fail');
    expect(reply.role).toBe('assistant');
    expect(reply.content).toMatch(/this_tool_does_not_exist/);
    expect(reply.warnings?.length).toBeGreaterThan(0);

    // The user message still persisted, with a paired assistant
    // bubble explaining the failure (no orphan user bubble).
    const disk = await store.getSession(gezel.id, session.id);
    expect(disk?.messages.length).toBe(2);
    expect(manager.inflightInfo(session.id)).toBeNull();
  }, 30_000);

  it('updateGezelFixedFunctionDefaults persists new defaults to disk', async () => {
    const gezel = await store.createGezel(makeWriteDocFf());

    const updated = await store.updateGezelFixedFunctionDefaults(gezel.id, {
      path: 'ff-out-2.md',
    });
    expect(updated.fixedFunction?.defaults).toEqual({ path: 'ff-out-2.md' });

    // Reload from disk to confirm the gezel.md round-trip is clean
    // (the YAML serializer handles nested defaults objects).
    const reloaded = await store.getGezel(gezel.id);
    expect(reloaded?.fixedFunction?.defaults).toEqual({ path: 'ff-out-2.md' });
    expect(reloaded?.fixedFunction?.tool).toBe('write_document');
    expect(reloaded?.fixedFunction?.promptKey).toBe('content');
  }, 30_000);

  it('clearing fixed-function defaults via null wipes them from disk', async () => {
    const gezel = await store.createGezel(makeWriteDocFf());
    const cleared = await store.updateGezelFixedFunctionDefaults(gezel.id, null);
    expect(cleared.fixedFunction?.defaults).toBeUndefined();

    const reloaded = await store.getGezel(gezel.id);
    expect(reloaded?.fixedFunction?.defaults).toBeUndefined();
    expect(reloaded?.fixedFunction?.tool).toBe('write_document');
  });

  it('updateGezelFixedFunctionDefaults rejects a non-fixed-function gezel', async () => {
    const gezel = await store.createGezel({ name: 'Ada', role: 'Developer' });
    await expect(store.updateGezelFixedFunctionDefaults(gezel.id, { foo: 'bar' })).rejects.toThrow(
      /not a fixed-function/,
    );
  });
});
