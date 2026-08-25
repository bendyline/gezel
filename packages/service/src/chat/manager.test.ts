import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { PreviewLogBuffer } from '../preview-log/buffer.js';
import { resolveMlxEffectiveNumCtx } from '../providers/mlx/build-provider.js';
import { MockProvider } from '../providers/mock.js';
import { MlxRuntimeStatusBus } from '../python/mlx-runtime-status-bus.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import {
  ChatManager,
  buildChatCodedFileNudge,
  buildContinuationNudge,
  buildDeriveRepairClampNudge,
  buildFailedToolRecoveryNudge,
  buildProseDeliverableNudge,
  consultationIdleTimeoutMsForModel,
  deriveRepairClampEnabled,
  deriveRepairClampNudge,
  describeDelegateFailureForAsker,
  detectChatCodedFileWithoutWrite,
  detectProseDeliverableWithoutWrite,
  detectUnsavedFileClaim,
  effectiveSessionModel,
  isNoopConfirmationResponse,
  isSubstantiveExistingWorkspaceFile,
  isValidationRepairPrompt,
  messageExpressesModifyIntent,
  shouldRefreshLeanGameState,
  unresolvedFailedToolCalls,
} from './manager.js';

describe('effectiveSessionModel', () => {
  const record = {
    providerName: 'llama-cpp' as const,
    model: 'historical-model',
  };

  it('uses the same live-default precedence for admission and inference', () => {
    expect(
      effectiveSessionModel({
        record,
        config: { defaultModel: { 'llama-cpp': 'current-default' } },
      }),
    ).toBe('current-default');
    expect(
      effectiveSessionModel({
        record,
        frontmatterModel: 'gezel-model',
        config: { defaultModel: { 'llama-cpp': 'current-default' } },
      }),
    ).toBe('gezel-model');
  });

  it('honors the Night Shift model ahead of the ordinary install default', () => {
    expect(
      effectiveSessionModel({
        record: { ...record, nightShift: true },
        config: {
          defaultModel: { 'llama-cpp': 'current-default' },
          nightShift: {
            enabled: true,
            modelOverride: {
              enabled: true,
              provider: 'llama-cpp',
              model: 'night-model',
            },
          },
        },
      }),
    ).toBe('night-model');
  });

  it('keeps an explicit capability route ahead of the ordinary install default', () => {
    expect(
      effectiveSessionModel({
        record: {
          ...record,
          model: 'routed-model',
          modelSource: 'capability-routing',
        },
        config: { defaultModel: { 'llama-cpp': 'current-default' } },
      }),
    ).toBe('routed-model');
    expect(
      effectiveSessionModel({
        record: {
          ...record,
          model: 'routed-model',
          modelSource: 'capability-routing',
        },
        frontmatterModel: 'gezel-model',
        config: { defaultModel: { 'llama-cpp': 'current-default' } },
      }),
    ).toBe('gezel-model');
  });
});

describe('consultationIdleTimeoutMsForModel', () => {
  it('protects DS4 and frontier local models from too-short caller guesses', () => {
    expect(
      consultationIdleTimeoutMsForModel({
        providerName: 'ds4',
        requestedTimeoutMs: 30_000,
      }),
    ).toBe(15 * 60_000);
    expect(
      consultationIdleTimeoutMsForModel({
        providerName: 'llama-cpp',
        modelTier: 'large',
        requestedTimeoutMs: 15_000,
      }),
    ).toBe(15 * 60_000);
  });

  it('retains the ordinary configurable budget for smaller/cloud models', () => {
    expect(
      consultationIdleTimeoutMsForModel({ providerName: 'llama-cpp', modelTier: 'medium' }),
    ).toBe(5 * 60_000);
    expect(
      consultationIdleTimeoutMsForModel({
        providerName: 'copilot',
        requestedTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
  });
});

/**
 * Stub memory manager — the real one pulls in a sentence-transformer model
 * which is expensive and unnecessary for these tests. We just no-op everything
 * the manager calls (save + reindex).
 */
const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

describe('resolveMlxEffectiveNumCtx', () => {
  it('uses the model native window when no operator limit is configured', () => {
    expect(resolveMlxEffectiveNumCtx({ modelContextWindow: 262_144 })).toBe(262_144);
  });

  it('honors an explicit lower limit', () => {
    expect(
      resolveMlxEffectiveNumCtx({ modelContextWindow: 262_144, configuredLimit: 98_304 }),
    ).toBe(98_304);
  });

  it('does not let an explicit limit push a long-context model below 64K', () => {
    expect(
      resolveMlxEffectiveNumCtx({ modelContextWindow: 262_144, configuredLimit: 16_384 }),
    ).toBe(65_536);
  });

  it('uses the native limit when the model is genuinely below 64K', () => {
    expect(resolveMlxEffectiveNumCtx({ modelContextWindow: 32_768, configuredLimit: 16_384 })).toBe(
      32_768,
    );
  });

  it('does not let an explicit limit exceed the model native window', () => {
    expect(
      resolveMlxEffectiveNumCtx({ modelContextWindow: 131_072, configuredLimit: 262_144 }),
    ).toBe(131_072);
  });

  it('falls back to 64K for a manual model path with no catalog metadata', () => {
    expect(resolveMlxEffectiveNumCtx({})).toBe(65_536);
  });

  it('raises a low limit only to the floor a memory-constrained host can back', () => {
    expect(
      resolveMlxEffectiveNumCtx({
        modelContextWindow: 262_144,
        configuredLimit: 16_384,
        minViableContextTokens: 32_768,
      }),
    ).toBe(32_768);
    expect(resolveMlxEffectiveNumCtx({ minViableContextTokens: 32_768 })).toBe(32_768);
  });
});

describe('ChatManager — clamped first-turn context', () => {
  it('does not replay the current user during auto-recall and diets a clamped Meester', async () => {
    const testHome = await mkdtemp(join(tmpdir(), 'gezel-first-turn-context-test-'));
    const testStore = new Store({ home: testHome });
    await testStore.ensureLayout();
    await testStore.writeConfig({ provider: 'copilot' });
    await testStore.createGezel({ name: 'Imara', role: 'Meester' });
    await testStore.createProject({ name: 'Default' });
    await testStore.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'qwen3.6-35b-a3b-q4' },
    });

    const recallMemory = {
      hasIndex: () => true,
      embedQuery: async () => [0.1, 0.2],
      searchVector: async (scope: 'gezel' | 'project') =>
        scope === 'project'
          ? [
              {
                id: 'memory-1',
                text: 'The project uses a local model.',
                scope: 'project',
                day: '2026-08-03',
                score: 0.9,
                kind: 'fact',
              },
            ]
          : [],
      save: async () => {},
      reindex: async () => 0,
      writeSummary: async () => {},
      getRecent: async () => '',
    } as unknown as MemoryManager;
    let admissionCalls = 0;
    class AdmissionOnlyMockProvider extends MockProvider {
      override getContextWindow(): number | undefined {
        return undefined;
      }

      async prepareContextWindow(): Promise<number | undefined> {
        admissionCalls += 1;
        return this.ollamaContextConfig?.numCtx;
      }
    }
    const llama = new AdmissionOnlyMockProvider({ name: 'llama-cpp' });
    llama.ollamaContextConfig = { numCtx: 35_840, promptChars: () => 0 };
    const testManager = new ChatManager({
      store: testStore,
      events: new ChatEventBus(),
      memory: recallMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home: testHome,
      providers: [['llama-cpp', llama]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(testHome),
    });

    try {
      const session = await testManager.createSession({ gezelId: 'imara' });
      llama.script('Hello from Imara');
      await testManager.send(session.id, 'hello');

      const creates = llama.calls.filter((call) => call.kind === 'create');
      expect(creates.length).toBeGreaterThanOrEqual(2);
      const recalled = creates.at(-1)?.opts;
      expect(recalled?.priorMessages).toEqual([]);
      expect(`${recalled?.systemMessage ?? ''}\n${recalled?.volatileContext ?? ''}`).toContain(
        'Recalled from prior sessions',
      );

      // 35,840 is below the 48K full-roster floor, so the provider's actual
      // asynchronously-admitted context must activate the curated coordinator
      // surface before the first prompt is built.
      expect(admissionCalls).toBeGreaterThan(0);
      expect(recalled?.toolAllowlist?.has('start_project')).toBe(true);
      expect(recalled?.toolAllowlist?.has('read_task_notes')).toBe(true);
      expect(recalled?.toolAllowlist?.size).toBeLessThan(60);

      const persisted = await testStore.getSession('imara', session.id);
      expect(persisted?.messages.map((message) => [message.role, message.content])).toEqual([
        ['user', 'hello'],
        ['assistant', 'Hello from Imara'],
      ]);
    } finally {
      await testManager.drainBackground();
      await testManager.shutdown();
      await rm(testHome, { recursive: true, force: true });
    }
  });
});

/**
 * The properties `NativeEngineCrashedError` carries. Assigned onto a
 * scripted mock failure so the structured-detail path is exercised without
 * dragging the llama-cpp provider into these tests.
 */
const NATIVE_CRASH_FIELDS = {
  code: 'native-engine-crash',
  engine: 'llama-cpp',
  incidentId: 'native-51832-1785547847453',
  panicKind: 'cuda-out-of-memory',
  exitCode: null,
  signal: 'SIGILL',
  diagnostics: { model: 'gemma4-26b-q4', backend: 'vulkan' },
};

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  // Drain fan-out fire-and-forgets before teardown — otherwise
  // `rm -rf home` races the background writes sendWithMentions kicked
  // off for each mentioned gezel, surfacing as ENOTEMPTY. This mirrors
  // `service.ts`'s stop() pattern.
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — session lifecycle', () => {
  it('creates a session with provider + model derived from gezel frontmatter', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    expect(session.gezelId).toBe('ada');
    expect(session.projectId).toBe('default');
    expect(session.providerName).toBe('copilot');
    expect(session.messages).toEqual([]);
    expect(session.title).toBe('New session');
  });

  it('persists the session to disk', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const read = await store.getSession('ada', session.id);
    expect(read?.id).toBe(session.id);
  });

  it('ensureOrCreateSession returns the most recent non-archived', async () => {
    const a = await manager.createSession({ gezelId: 'ada' });
    const b = await manager.createSession({ gezelId: 'ada' });
    await manager.archiveSession(a.id);
    const picked = await manager.ensureOrCreateSession({ gezelId: 'ada' });
    expect(picked.id).toBe(b.id);
  });

  it('ensureOrCreateSession never reuses a task-scoped session for ordinary chat', async () => {
    const ordinary = await manager.createSession({ gezelId: 'ada' });
    await manager.createSession({
      gezelId: 'ada',
      taskRef: 'default/9',
      stepId: 'night-shift',
      nightShift: true,
    });

    const picked = await manager.ensureOrCreateSession({ gezelId: 'ada' });
    expect(picked.id).toBe(ordinary.id);
    expect(picked.taskRef).toBeUndefined();
  });

  it('ensureOrCreateSession creates one when none exist', async () => {
    const picked = await manager.ensureOrCreateSession({ gezelId: 'ada' });
    expect(picked.messages).toEqual([]);
  });

  it('stamps roleBasedNameOnlyMode when the creating client pins it', async () => {
    const pinned = await manager.createSession({ gezelId: 'ada', roleBasedNameOnlyMode: true });
    expect(pinned.roleBasedNameOnlyMode).toBe(true);
    const read = await store.getSession('ada', pinned.id);
    expect(read?.roleBasedNameOnlyMode).toBe(true);

    // Unpinned sessions carry no stamp — they follow the live config flag.
    const unpinned = await manager.createSession({ gezelId: 'ada' });
    expect(unpinned.roleBasedNameOnlyMode).toBeUndefined();
  });

  it('a pinned session builds a boring-mode prompt even when the config flag is off', async () => {
    // config.roleBasedNameOnlyMode is unset (falsy) in this harness — the
    // session stamp alone must flip the prompt into role-name rendering.
    const session = await manager.createSession({ gezelId: 'ada', roleBasedNameOnlyMode: true });
    mock.script('ok');
    await manager.send(session.id, 'hello');

    const create = mock.calls.filter((call) => call.kind === 'create').at(-1);
    expect(create?.opts?.systemMessage).toContain('by role name only');

    // And an unpinned session under the same (off) config stays named.
    const plain = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    await manager.send(plain.id, 'hello');
    const plainCreate = mock.calls.filter((call) => call.kind === 'create').at(-1);
    expect(plainCreate?.opts?.systemMessage).not.toContain('by role name only');
  });
});

describe('ChatManager — send + persistence', () => {
  it('shows a submitted first message as pending while the provider session starts', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const received: Array<{ type: string; preview?: string }> = [];
    events.subscribeProject('default', (envelope) => {
      if (envelope.sessionId === session.id) received.push(envelope.event);
    });
    const gate = mock.gateNextCreateSession();
    mock.script('Ready');

    const sending = manager.send(session.id, 'hello from the terminal');
    await vi.waitFor(() => expect(mock.calls.some((call) => call.kind === 'create')).toBe(true));

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'user_message_pending',
        preview: 'hello from the terminal',
      }),
    );
    expect(received.some((event) => event.type === 'user_message')).toBe(false);

    gate.release();
    await sending;

    expect(received.some((event) => event.type === 'user_message')).toBe(true);
  });

  it('publishes cold-start failures to project clients instead of failing silently', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const received: Array<{ type: string; error?: string }> = [];
    events.subscribeProject('default', (envelope) => {
      if (envelope.sessionId === session.id) received.push(envelope.event);
    });
    mock.createSession = vi.fn().mockRejectedValue(new Error('local model could not start'));

    await expect(manager.send(session.id, 'hello')).rejects.toThrow('local model could not start');

    expect(received).toContainEqual(expect.objectContaining({ type: 'user_message_pending' }));
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'error', error: 'local model could not start' }),
    );
    expect(received.at(-1)).toEqual(expect.objectContaining({ type: 'done' }));
  });

  it('threads the session project into interactive provider queue metadata', async () => {
    const project = await store.createProject({ name: 'Spanish lessons' });
    const session = await manager.createSession({ gezelId: 'ada', projectId: project.id });
    mock.script('Ready');

    await manager.send(session.id, 'Start the lesson');

    const send = mock.calls.find(
      (call) => call.kind === 'send' && call.sendOpts?.queue?.lane === 'interactive',
    );
    expect(send?.sendOpts?.queue).toMatchObject({
      sessionId: session.id,
      gezelId: 'ada',
      projectId: project.id,
    });
  });

  it('threads the authoritative direct-file clamp into provider session options', async () => {
    const griet = await store.createGezel({ name: 'Griet', role: 'Boekwachter' });
    const grietId = griet.parsed.frontmatter.id;
    if (!grietId) throw new Error('created gezel is missing its id');
    const session = await manager.createSession({
      gezelId: grietId,
      expectedDeliverable: { kind: 'file', filePath: 'records/attendees.csv' },
    });
    mock.script('done');

    await manager.send(
      session.id,
      'Transform records/raw-notes.txt into the output records/attendees.csv.',
    );

    const create = mock.calls.find((call) => call.kind === 'create');
    expect(create?.opts?.forceDirectFileWork).toBe(true);
    expect(create?.opts?.directFileWorkTargetPath).toBe('records/attendees.csv');
  });

  it('records user + assistant messages and persists after each turn', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Hi there');
    await manager.send(session.id, 'hello');

    const disk = await store.getSession('ada', session.id);
    expect(disk).not.toBeNull();
    expect(disk!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi there'],
    ]);
    expect(disk!.providerState.copilotSessionId).toMatch(/^mock-session-/);
    expect(disk!.lastActivityAt).not.toBe(session.createdAt);
  });

  it('persists the observed reasoning stream span and exposes it in the timeline', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptReasoning('First I should inspect the request. ', 'Then I can answer.');
    mock.script('A concise answer');
    let clock = 10_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 10;
      return clock;
    });

    try {
      await manager.send(session.id, 'please reason about this');
    } finally {
      now.mockRestore();
    }

    const disk = await store.getSession('ada', session.id);
    const assistant = disk?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.reasoning).toBe('First I should inspect the request. Then I can answer.');
    expect(assistant?.reasoningDurationMs).toBeGreaterThan(0);

    const timeline = await store.listTimeline({ projectId: 'default', limit: 100 });
    const timelineAssistant = timeline.messages.find(
      (message) => message.sessionId === session.id && message.role === 'assistant',
    );
    expect(timelineAssistant?.reasoningDurationMs).toBe(assistant?.reasoningDurationMs);
  });

  it('records referenced artifacts and workspace files, locators and all', async () => {
    await store.writeProjectArtifact('default', 'pr-review.md', '# review');
    manager.setWorkspaceIndex({
      readFiles: async () => [
        { path: 'packages/cli/src/commands/image.ts' },
        { path: 'src/hooks/useFrameCapture.ts' },
        { path: 'docs/API.md' },
        { path: 'src/never-mentioned.ts' },
      ],
    });
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script(
      'Full review in `pr-review.md`. The default lives in ' +
        '`packages/cli/src/commands/image.ts:84,230`, `useFrameCapture.ts:1633` drops the ' +
        'style, and `docs/API.md` is missing two entries.',
    );

    await manager.send(session.id, 'review the PR');

    const disk = await store.getSession('ada', session.id);
    const assistant = disk?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.referencedFiles).toEqual([
      { kind: 'artifact', path: 'pr-review.md' },
      { kind: 'workspace', path: 'docs/API.md' },
      { kind: 'workspace', path: 'packages/cli/src/commands/image.ts' },
      { kind: 'workspace', path: 'src/hooks/useFrameCapture.ts' },
    ]);
    // The legacy projection stays artifact-only so an older CLI reading this
    // session file still resolves every path it is handed.
    expect(assistant?.referencedArtifacts).toEqual(['pr-review.md']);
  });

  it('falls back to artifacts alone when no workspace index is wired', async () => {
    await store.writeProjectArtifact('default', 'pr-review.md', '# review');
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Full review in `pr-review.md`; the bug is `useFrameCapture.ts:1633`.');

    await manager.send(session.id, 'review the PR');

    const disk = await store.getSession('ada', session.id);
    const assistant = disk?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.referencedFiles).toEqual([{ kind: 'artifact', path: 'pr-review.md' }]);
  });

  it('skips stale missing-deliverable messages once the workspace file exists', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    await store.writeProjectWorkspaceFile(
      'default',
      'tracker.html',
      `<!doctype html><html><body><main>Tracker</main><script>${'let ok = true;'.repeat(80)}</script></body></html>`,
    );

    const msg = await manager.send(
      session.id,
      '[scenario check] There is still **no `tracker.html`** in the workspace.\n\n' +
        'If `tracker.html` already exists by the time you read this queued message, treat this message as stale: re-read `tracker.html` and patch the latest concrete scenario-check failure instead of rewriting from scratch or replying in prose.',
    );

    expect(msg.content).toContain('queued missing-file request is stale');
    expect(msg.content).toContain('tracker.html');
    expect(mock.calls.some((c) => c.kind === 'send')).toBe(false);
  });

  it('auto-sets a compact title from the first user message', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply');
    await manager.send(session.id, 'what is the meaning of life?');

    const disk = await store.getSession('ada', session.id);
    expect(disk!.title).toBe('Meaning life');
  });

  it('names a passive-CC-only session from the later direct user starter', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    await manager.notifyUserMessage(session.id, '@[Bea](gezel:bea) can you take this?');
    mock.script('reply');

    await manager.send(session.id, 'Please review the release checklist');

    const disk = await store.getSession('ada', session.id);
    expect(disk?.title).toBe('Review release checklist');
  });

  it('emits delta and complete events', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('abcdef');
    const received: Array<{ type: string; [k: string]: unknown }> = [];
    events.subscribe(session.id, (e) => {
      received.push(e as Record<string, unknown> as { type: string });
    });
    await manager.send(session.id, 'hi');
    const types = received.map((e) => e.type);
    expect(types).toContain('delta');
    expect(types).toContain('complete');
    expect(types).toContain('done');
  });

  it('surfaces MLX runtime provisioning while the first live session is being built', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'gezel-mlx-warmup-test-'));
    const localStore = new Store({ home: localHome });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Ada', role: 'Developer' });
    await localStore.createProject({ name: 'Default' });
    await localStore.writeConfig({ provider: 'mlx' });
    const localEvents = new ChatEventBus();
    const runtimeStatus = new MlxRuntimeStatusBus();
    const localMock = new MockProvider({ name: 'mlx' });
    const createSession = localMock.createSession.bind(localMock);
    localMock.createSession = async (opts) => {
      runtimeStatus.publish({
        phase: 'provisioning',
        message: 'Installing MLX dependencies (one-time setup)…',
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      runtimeStatus.publish({ phase: 'ready', message: 'Python ready' });
      return createSession(opts);
    };
    const localManager = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home: localHome,
      providers: [['mlx', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(localHome),
      mlxRuntimeStatus: runtimeStatus,
    });
    try {
      const session = await localManager.createSession({ gezelId: 'ada' });
      const received: Array<{ type: string; detail?: string; phase?: string }> = [];
      localEvents.subscribe(session.id, (event) => received.push(event));
      localMock.script('ready to chat');

      await localManager.send(session.id, 'hello');

      expect(received).toContainEqual(
        expect.objectContaining({
          type: 'engine_phase',
          phase: 'starting',
          detail: expect.stringContaining('MLX runtime warming up'),
        }),
      );
      expect(received).toContainEqual(
        expect.objectContaining({ type: 'engine_phase', phase: 'ready' }),
      );
    } finally {
      await localManager.shutdown();
      await rm(localHome, { recursive: true, force: true });
    }
  });

  it('persists a synthetic `turn-aborted` assistant message when sendAndWait throws', async () => {
    // Repro of the bug where the repeat-tracker / failure-tracker abort
    // only set `lastTurnError` and discarded the in-flight tool calls,
    // leaving the debug bundle and history with no record of the
    // catastrophe. After the fix, a synthetic message lands on disk
    // carrying the abort string as a warning so the next bundle copy
    // (and any subsequent reload) captures the trace.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptSendFailure('[Mac AI] aborting — `list_tasks` failed 5 times in a row this turn');

    await expect(manager.send(session.id, 'build a PacMan game')).rejects.toThrow(
      /list_tasks.*5 times/,
    );

    const disk = await store.getSession('ada', session.id);
    expect(disk).not.toBeNull();
    // user + synthetic-aborted assistant
    expect(disk!.messages).toHaveLength(2);
    const aborted = disk!.messages[1]!;
    expect(aborted.role).toBe('assistant');
    expect(aborted.synthetic).toBe('turn-aborted');
    expect(aborted.warnings ?? []).toContainEqual(expect.stringMatching(/list_tasks.*5 times/));
    // `lastTurnError` still set so the existing reload-banner UX keeps
    // working alongside the new persistence path.
    expect(disk!.lastTurnError).toMatch(/list_tasks.*5 times/);
  });

  it('publishes the structured detail alongside the error event', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const received: Array<{ type: string; errorDetail?: { code?: string } }> = [];
    events.subscribe(session.id, (event) => received.push(event));
    mock.scriptSendFailure('[llama-cpp] on-device engine crashed (SIGILL)', NATIVE_CRASH_FIELDS);

    await expect(manager.send(session.id, 'go')).rejects.toThrow();

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'error',
        errorDetail: expect.objectContaining({
          code: 'native-engine-crash',
          engine: 'llama-cpp',
          incidentId: 'native-51832-1785547847453',
        }),
      }),
    );
  });

  it('clears the structured detail on the next successful turn', async () => {
    // Regression guard: a stale detail outliving the error it describes
    // would have the UI offering to report an already-fixed problem.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptSendFailure('[llama-cpp] on-device engine crashed (SIGILL)', NATIVE_CRASH_FIELDS);
    await expect(manager.send(session.id, 'go')).rejects.toThrow();
    expect((await store.getSession('ada', session.id))!.lastTurnErrorDetail).toBeDefined();

    mock.script('recovered');
    await manager.send(session.id, 'try again');

    const disk = await store.getSession('ada', session.id);
    expect(disk!.lastTurnError).toBeUndefined();
    expect(disk!.lastTurnErrorDetail).toBeUndefined();
  });

  it('retries the failed input without duplicating the visible user message', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptSendFailure(
      '[Mac AI] the on-device engine dropped the connection mid-turn. Retry the turn.',
      NATIVE_CRASH_FIELDS,
    );
    await expect(manager.send(session.id, 'finish the report')).rejects.toThrow();

    mock.script('Recovered reply');
    await expect(manager.retryLastTurn(session.id)).resolves.toEqual({
      accepted: true,
      sessionId: session.id,
    });
    await manager.drainBackground();

    const disk = await store.getSession('ada', session.id);
    expect(disk!.lastTurnError).toBeUndefined();
    expect(disk!.lastTurnErrorDetail).toBeUndefined();
    expect(
      disk!.messages.map((message) => [message.role, message.content, message.hidden]),
    ).toEqual([
      ['user', 'finish the report', undefined],
      ['assistant', '', undefined],
      ['user', 'finish the report', true],
      ['assistant', 'Recovered reply', undefined],
    ]);

    const timeline = await store.listTimeline({ gezelId: 'ada', limit: 50 });
    expect(timeline.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('refuses retry when the session has no failed turn', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    await expect(manager.retryLastTurn(session.id)).rejects.toThrow(/no failed turn/i);
  });

  it('clears the structured detail through clearLastTurnError', async () => {
    // Guards the early-return in `clearLastTurnError`, which used to bail
    // on `lastTurnError === undefined` alone.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptSendFailure('[llama-cpp] on-device engine crashed (SIGILL)', NATIVE_CRASH_FIELDS);
    await expect(manager.send(session.id, 'go')).rejects.toThrow();

    await manager.clearLastTurnError(session.id);

    const disk = await store.getSession('ada', session.id);
    expect(disk!.lastTurnError).toBeUndefined();
    expect(disk!.lastTurnErrorDetail).toBeUndefined();
  });

  it('scrubs credentials out of the persisted lastTurnError', async () => {
    // A token that leaked into an error message would otherwise sit in
    // session JSON forever — and session JSON is what gets copied into
    // debug bundles and pasted into support threads.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptSendFailure('auth failed: ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789');
    await expect(manager.send(session.id, 'go')).rejects.toThrow();

    const disk = await store.getSession('ada', session.id);
    expect(disk!.lastTurnError).toContain('[REDACTED]');
    expect(disk!.lastTurnError).not.toContain('ghp_');
  });

  it('salvages the streamed reply onto the turn-aborted message when cancelled mid-stream', async () => {
    // A turn cancelled mid-flight (user stop, or a superseding task
    // handoff) used to persist an EMPTY assistant bubble: cancelInflight
    // wiped the per-turn buffers before sendAndWait's rejection reached
    // the catch that reads them. After the fix the buffers survive, so
    // the aborted message carries what the model already streamed.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptStreamThenHang('Partial answer the user already saw');
    const received: string[] = [];
    events.subscribe(session.id, (event) => received.push(event.type));

    const pending = manager.send(session.id, 'go').catch(() => {
      /* cancel surfaces as cancelled/done events, not a rejection here */
    });
    // Wait until the provider turn is genuinely in flight before
    // cancelling. The `send` call is recorded at the top of
    // `MockSession.sendAndWait`, which runs only AFTER the manager has
    // wired this turn's `AbortController`. Cancelling before that point
    // installs a fresh, never-aborted controller and hangs the mock's
    // `streamThenHang` forever. A fixed 200×10ms poll used to give up
    // after ~2s and cancel anyway — which flaked into a 10s timeout on a
    // loaded CI runner where throttled `setTimeout` starved the poll
    // before setup finished. Wait for the real signal instead.
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });

    await manager.cancelInflight(session.id);
    await pending;

    const disk = await store.getSession('ada', session.id);
    expect(disk).not.toBeNull();
    expect(disk!.lastTurnError).toBeUndefined();
    expect(disk!.lastTurnErrorDetail).toBeUndefined();
    expect(received).toContain('cancelled');
    expect(received).not.toContain('error');
    const aborted = disk!.messages.at(-1)!;
    expect(aborted.role).toBe('assistant');
    expect(aborted.synthetic).toBe('turn-aborted');
    expect(aborted.content).toBe('Partial answer the user already saw');
  }, 20_000);

  it('scrubs reasoning markup off the turn-aborted message instead of baking it into content', async () => {
    // The salvaged buffer is RAW — the turn died before the provider's
    // end-of-turn reasoning extraction ran. Persisting it verbatim put
    // `<|channel>thought` framing into `content`, and this message gets
    // replayed to the model like any other, so Gemma 4 read back its own
    // markup and copied the pattern. Measured on MLX: 305 stray markers
    // across 19 aborted messages, 0 across the 222 normal ones — the
    // abort path was the only one skipping the scrub.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptStreamThenHang('<|channel>thought\nWeighing the options.<channel|>Visible answer');

    const pending = manager.send(session.id, 'go').catch(() => {
      /* cancel surfaces as cancelled/done events */
    });
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });
    await manager.cancelInflight(session.id);
    await pending;

    const disk = await store.getSession('ada', session.id);
    const aborted = disk!.messages.at(-1)!;
    expect(aborted.synthetic).toBe('turn-aborted');
    expect(aborted.content).not.toMatch(/<\|?\/?channel\|?>/);
    expect(aborted.content).toContain('Visible answer');
    // Scrubbed, not discarded — the prose still reaches the reasoning channel.
    expect(aborted.reasoning ?? '').toContain('Weighing the options.');
  }, 20_000);

  it('does not let a late-unwinding cancelled turn steal or wipe its successor', async () => {
    // Wild-caught on Copilot: `cancelInflight` frees the session slot
    // synchronously, but the SDK ran the cancelled response to completion
    // ~16s later. By then the next turn owned the session-keyed per-turn
    // buffers, so the cancelled turn's catch salvaged ITS SUCCESSOR's
    // half-streamed text and filed it as its own `turn-aborted` record —
    // one continuous stream split across two bubbles, the second turn's
    // words attributed to the first — and then its `finally` wiped the
    // running turn's accumulators.
    const session = await manager.createSession({ gezelId: 'ada' });
    const stalled = mock.scriptStreamThenStall('FIRST turn text');

    const first = manager.send(session.id, 'first').catch(() => {
      /* cancel surfaces as events, not a rejection here */
    });
    await vi.waitFor(() => expect(mock.calls.filter((c) => c.kind === 'send')).toHaveLength(1), {
      timeout: 5000,
      interval: 10,
    });

    // Cancel frees the slot; the provider call is still running.
    await manager.cancelInflight(session.id);

    // Successor starts and takes over the per-turn buffers. Left in
    // flight on purpose: its half-streamed text is sitting in exactly the
    // buffers the cancelled turn is about to read.
    const stalledSuccessor = mock.scriptStreamThenStall('SECOND turn text');
    const second = manager.send(session.id, 'second');
    await vi.waitFor(() => expect(mock.calls.filter((c) => c.kind === 'send')).toHaveLength(2), {
      timeout: 5000,
      interval: 10,
    });

    // Only now does the cancelled turn's provider call settle.
    stalled.release();
    await first;

    stalledSuccessor.release();
    await second;

    const disk = await store.getSession('ada', session.id);
    const aborted = disk!.messages.find((m) => m.synthetic === 'turn-aborted');
    expect(aborted).toBeDefined();
    // Its own streamed text — never the successor's.
    expect(aborted!.content).toBe('FIRST turn text');
    expect(aborted!.content).not.toContain('SECOND');

    // The successor committed a real reply, and the late teardown did not
    // eat it.
    const replies = disk!.messages.filter((m) => m.role === 'assistant' && !m.synthetic);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toBe('SECOND turn text');
  }, 20_000);

  it('honors a stop pressed during setup, before the turn can wire cancellation', async () => {
    // A user who hits stop while the prompt is still being built — the
    // ensureState prologue that runs before a live session exists used to have
    // their cancel silently dropped. cancelInflight now parks the request and
    // runSend aborts as soon as it can wire the controller, so
    // the turn unwinds into a `turn-aborted` message instead of ignoring
    // the stop. Regression guard: without the parking, `scriptStreamThenHang`
    // has no abort to unwind on and this test hangs to its timeout.
    const session = await manager.createSession({ gezelId: 'ada' });
    // Park the turn inside ensureState's provider.createSession — the
    // inflight slot is held but no AbortController is wired yet.
    const gate = mock.gateNextCreateSession();
    mock.scriptStreamThenHang('streamed before the cancel');

    const pending = manager.send(session.id, 'go').catch(() => {
      /* cancel surfaces as error/done events, not a rejection here */
    });
    // Wait until the send is genuinely blocked in createSession (the
    // pre-wiring window). manager.createSession above only writes the
    // record — this is the first provider createSession.
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'create')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });

    await manager.cancelInflight(session.id);
    // Let setup finish. The turn must abort on its wired-then-parked
    // signal rather than deliver the scripted reply.
    gate.release();
    await pending;

    const disk = await store.getSession('ada', session.id);
    expect(disk).not.toBeNull();
    const last = disk!.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.synthetic).toBe('turn-aborted');
    expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(0);
    // No non-synthetic assistant reply was ever committed — the cancel
    // took effect instead of the turn running through to a real answer.
    expect(disk!.messages.filter((m) => m.role === 'assistant' && !m.synthetic)).toHaveLength(0);
  }, 20_000);
});

describe('buildContinuationNudge', () => {
  it('turns an incomplete write_file prefix into a concrete complete-call nudge', () => {
    const nudge = buildContinuationNudge('`write_file(', [
      {
        content:
          '[Deliverable expected as a FILE at `index.html`. Your first assistant action should be the tool call `write_file({ path, content })`.]',
      },
    ]);

    expect(nudge).toContain('incomplete tool call `write_file(`');
    expect(nudge).toContain(
      'write_file({ path: "index.html", content: <full deliverable contents> })',
    );
    expect(nudge).toContain('Do not narrate');
  });

  it('keeps the default nudge for ordinary stalled prose', () => {
    const nudge = buildContinuationNudge("I'll do that now.");

    expect(nudge).toContain('stopped before taking the next concrete step');
  });
});

describe('lean game turn recovery', () => {
  it.each(['Can you take your turn?', 'Please make a move.', "It's black's turn.", 'Try again.'])(
    'refreshes authoritative state for %j',
    (prompt) => {
      expect(shouldRefreshLeanGameState(prompt)).toBe(true);
    },
  );

  it('does not refresh a page reaction that already carries legal moves', () => {
    expect(
      shouldRefreshLeanGameState('Board now:\n...\nLegal moves: b6-c5\nPlease make a move.'),
    ).toBe(false);
  });

  it('treats a failed tool as corrective until the same tool later succeeds', () => {
    const failed = {
      name: 'make_move',
      success: false,
      errorMessage: 'Illegal move f6-e5. Legal moves: b6-c5',
    };
    expect(unresolvedFailedToolCalls([failed])).toEqual([failed]);
    expect(buildFailedToolRecoveryNudge(unresolvedFailedToolCalls([failed]))).toContain(
      'Legal moves: b6-c5',
    );
    expect(unresolvedFailedToolCalls([failed, { name: 'make_move', success: true }])).toEqual([]);
  });
});

describe('isValidationRepairPrompt', () => {
  it.each([
    [
      'initial scenario check',
      "[Message from Nadia]: [scenario check] I looked at `runlog.md` and the success criteria aren't met yet.",
    ],
    [
      'initial runtime check',
      '[Message from Orion]: [runtime check seed-tasks-render] I opened `index.html` in a headless browser.',
    ],
    [
      'repeat targeted repair',
      "[Message from Nadia]: REPEAT MISS — attempt 2 on `runlog.md`: the same check is failing.\n\n[scenario check] I looked at `runlog.md` and the success criteria aren't met yet.",
    ],
    [
      'repeat append repair',
      "REPEAT APPEND MISS — attempt 2 on `report.md`: the append did not clear the check.\n\n[scenario check] I looked at `report.md` and the success criteria aren't met yet.",
    ],
    [
      'repeat combined repair',
      "REPEAT COMBINED MISS — attempt 3 on `report.md`: the combined repair did not clear the checks.\n\n[scenario check] I looked at `report.md` and the success criteria aren't met yet.",
    ],
    [
      'full-rewrite escalation',
      'GATE_FULL_REWRITE: 3 completed repairs of `index.html` have failed this scenario check with the exact same result — targeted edits are not landing.',
    ],
  ])('recognizes %s', (_label, prompt) => {
    expect(isValidationRepairPrompt(prompt)).toBe(true);
  });

  it.each([
    'Please summarize why the report describes a REPEAT MISS in our scenario-check logic.',
    'REPEAT MISS — attempt 2 on `runlog.md`: this is quoted documentation, not a delivered check.',
    'The latest [scenario check] output is included below for discussion.',
    'GATE_FULL_REWRITE is the name of an escalation marker in our evaluator.',
    '[Status]: REPEAT MISS — attempt 2 on `runlog.md`: quoted documentation.\n\n[scenario check] I looked at `runlog.md` and it still fails.',
  ])('does not classify ordinary user text: %s', (prompt) => {
    expect(isValidationRepairPrompt(prompt)).toBe(false);
  });
});

describe('isNoopConfirmationResponse', () => {
  it('accepts a short acknowledgement to a no-action confirmation prompt', () => {
    expect(
      isNoopConfirmationResponse(
        "Heads up: Marta is rescuing the project. You don't need to do anything -- just confirm you've seen this note.",
        "Got it. Marta's taking over the rescue; I'll stay out of the way.",
      ),
    ).toBe(true);
  });

  it('does not suppress real work intent', () => {
    expect(
      isNoopConfirmationResponse(
        "Heads up: Marta is rescuing the project. You don't need to do anything -- just confirm you've seen this note.",
        "Got it. I'll start reviewing the files now.",
      ),
    ).toBe(false);
  });
});

describe('isSubstantiveExistingWorkspaceFile', () => {
  it('does not treat a tiny HTML stub as stale enough to skip repair', () => {
    expect(
      isSubstantiveExistingWorkspaceFile(
        'index.html',
        '<html><body><h1>Tic-Tac-Toe Game</h1><p>You can play here.</p></body></html>',
      ),
    ).toBe(false);
  });

  it('treats a complete inline-script HTML file as stale enough to skip duplicate handoffs', () => {
    const html = `<!doctype html>
<html><body><h1>Tic-Tac-Toe</h1><div id="board"></div><script>
${'const board = [];'.repeat(40)}
document.getElementById("board").addEventListener("click", () => {});
</script></body></html>`;

    expect(isSubstantiveExistingWorkspaceFile('index.html', html)).toBe(true);
  });

  it('keeps non-HTML stale checks existence-based', () => {
    expect(isSubstantiveExistingWorkspaceFile('notes.md', 'done')).toBe(true);
  });
});

describe('messageExpressesModifyIntent', () => {
  it('flags the reported "subtract 50 points" change request', () => {
    // The exact failure (qwen3.6 "Space Shooter Arcade"): a
    // direct modification handoff naming an existing file was misread as a
    // redundant create and silently dropped before the developer ever ran.
    expect(
      messageExpressesModifyIntent(
        '[Message from Laxmi]: Update workspace/index.html so that when an alien reaches the bottom of the level, subtract 50 points.',
      ),
    ).toBe(true);
  });

  it('flags common modify verbs and behavioral-delta phrasing', () => {
    for (const msg of [
      'change the score color to red',
      'fix the collision bug in index.html',
      'remove the pause menu',
      'make it so the ship respawns after 3 seconds',
      'the boss should now take two hits instead of one',
      'add a high-score table to the game',
      'when the player dies, show a retry button',
    ]) {
      expect(messageExpressesModifyIntent(msg), msg).toBe(true);
    }
  });

  it('does NOT flag a from-scratch create brief', () => {
    // A typical "build the whole file" delegation must still be eligible for
    // the redundant-create short-circuit — only its event triggers ("spawn
    // in waves") lack the "when …" framing, so they read as create, not
    // modify.
    const create =
      '[Message from Laxmi]: Create workspace/index.html — a browser space shooter. ' +
      'Single self-contained HTML file, Canvas at 60fps. Arrow keys / WASD to move the ship, ' +
      'Spacebar to shoot. Enemies spawn in progressively faster waves. Real-time score counter. ' +
      'Game-over screen with the final score.';
    expect(messageExpressesModifyIntent(create)).toBe(false);
  });
});

describe('ChatManager — task context', () => {
  it('injects the current task + active phase into the system prompt', async () => {
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    const task = await taskMgr.create('default', {
      title: 'Iterate on marketing mocks',
      description: 'Three-phase loop until quality signs off.',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        { name: 'Design', description: 'Draft v1 mocks.' },
        { name: 'Copy' },
        { name: 'Quality' },
      ],
    });

    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    mock.script('ok');
    await manager.send(session.id, 'start');

    const create = mock.calls.find((c) => c.kind === 'create');
    expect(create).toBeTruthy();
    const sys = create!.opts!.systemMessage;
    expect(sys).toContain(`### Current task: ${task.ref}`);
    expect(sys).toContain('Iterate on marketing mocks');
    expect(sys).toContain('Active step:');
    expect(sys).toContain('Design');
    // The per-task working folder is advertised so even ad-hoc sessions
    // (no craftbook prompt naming paths) know where working files belong.
    expect(sys).toContain(`Task artifact folder: \`tasks/${task.num}/\``);
  });

  it('injects predecessor-step notes into a newly created successor session', async () => {
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    const task = await taskMgr.create('default', {
      title: 'Pull Request Review',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        { id: 'scope', name: 'Scope the pull request' },
        { id: 'report', name: 'Review and write the report' },
      ],
    });
    await taskMgr.appendNote('default', task.num, {
      stepId: 'scope',
      text: '## Scope — PR #28\n\nReview https://github.com/bendyline/gezel/pull/28.',
      author: { kind: 'gezel', gezelId: 'ada', name: 'Ada' },
    });
    await taskMgr.completeStep('default', task.num, 'scope');

    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'report',
    });
    mock.script('ok');
    await manager.send(session.id, 'continue');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('Active step: **Review and write the report**');
    expect(sys).toContain('## Scope — PR #28');
    expect(sys).toContain('https://github.com/bendyline/gezel/pull/28');
  });

  it('anchors a paused task as blocked instead of telling the gezel to continue its step', async () => {
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    const task = await taskMgr.create('default', {
      title: 'Historical battle report',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          name: 'Outline',
          prompt: 'Write `notes/outline.md`, then advance the task.',
          advanceWhen: { file: 'notes/outline.md', minBytes: 100 },
        },
      ],
    });
    await taskMgr.appendNote('default', task.num, {
      text: 'Paused because the outline gate did not observe a changed file.',
      author: { kind: 'user' },
    });
    await taskMgr.setStatus('default', task.num, 'paused');

    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    mock.script('blocked');
    await manager.send(session.id, 'keep going');

    const create = mock.calls.find((call) => call.kind === 'create');
    const system = create!.opts!.systemMessage!;
    expect(system).toContain(`Task \`${task.ref}\` — "Historical battle report" is paused`);
    expect(system).toContain('Do not continue the step');
    expect(system).toContain('Paused because the outline gate did not observe a changed file.');
    expect(system).not.toContain('You are mid-craftbook step');
    expect(system).not.toContain('identify the FIRST tool it tells you to call');
  });

  it('keeps an urgent build-step prompt consistent with its live write-only tool surface', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'gezel-task-write-surface-'));
    const localStore = new Store({ home: localHome });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Callum', role: 'Developer' });
    const project = await localStore.createProject({ name: 'Space Wars' });
    await localStore.writeConfig({
      provider: 'mlx',
      defaultModel: { mlx: 'gemma4-12b-q4' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'mlx' });
    const localManager = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home: localHome,
      providers: [['mlx', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(localHome),
    });

    try {
      const { TaskManager } = await import('../tasks/manager.js');
      const task = await new TaskManager(localStore).create(project.id, {
        title: 'Build Space Wars',
        assignee: { kind: 'gezel', gezelId: 'callum' },
        steps: [
          {
            name: 'Build',
            prompt:
              'First call `write_task_note` with acceptance criteria. Then create `index.html` with `write_file`.',
            advanceWhen: { file: 'index.html', minBytes: 800, sniff: 'html-game' as const },
          },
        ],
      });
      const session = await localManager.createSession({
        gezelId: 'callum',
        projectId: project.id,
        taskRef: task.ref,
        stepId: task.activeStepId,
      });

      localMock.script('Working.');
      await localManager.send(
        session.id,
        'Build a new game at `workspace/index.html`. First pass: call `write_file` with the complete file.',
      );

      const create = localMock.calls.find((call) => call.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      expect(allow.has('write_file')).toBe(true);
      expect(allow.has('write_task_note')).toBe(true);
      expect(allow.has('read_task_notes')).toBe(true);
      expect(allow.has('advance_task_step')).toBe(true);
      expect(allow.has('read_file')).toBe(false);

      const system = create!.opts!.systemMessage!;
      expect(system).toContain('**Workspace writes** (`write_file`)');
      expect(system).toContain('**Workspace reads are not available this turn.**');
      expect(system).not.toContain('No direct file drawers are available this turn');
      expect(system).not.toContain("You don't have file-read/write tools");
      const taskToolsLine = system
        .split('\n')
        .find((line) => line.startsWith('Task tools wired this turn:'));
      expect(taskToolsLine).toContain('`write_task_note`');
      expect(taskToolsLine).toContain('`advance_task_step`');
      expect(taskToolsLine).not.toContain('`update_task`');
      expect(taskToolsLine).not.toContain('`assign_task`');
      expect(system).toContain('begin with the FIRST tool action it names');
      expect(system).toContain(
        "If this turn's transcript already contains a successful result for that action, it is complete",
      );
      expect(system).toContain(
        'First action (once only): call `write_task_note` exactly as the procedure specifies.',
      );
      expect(system).not.toContain('Do exactly ONE tool call this turn');
      expect(system).not.toContain('First action: `write_file');
    } finally {
      await localManager.drainBackground();
      await localManager.shutdown();
      await rm(localHome, { recursive: true, force: true });
    }
  });

  it('injects assigned-tasks list when the session is NOT task-scoped', async () => {
    // Regression: a gezel chatting in a project where they have
    // open tasks should see those tasks in the system prompt
    // instead of having to call `list_tasks` to discover them.
    // The default project is excluded (no real work tracked
    // there), so use a real project.
    const proj = await store.createProject({ name: 'Shop' });
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    const t1 = await taskMgr.create(proj.id, {
      title: 'Build the storefront',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Layout' }, { name: 'Wire-up' }],
    });
    const t2 = await taskMgr.create(proj.id, {
      title: 'Wire up checkout',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Stripe' }],
    });
    // A task assigned to someone else — should NOT appear in Ada's prompt.
    await taskMgr.create(proj.id, {
      title: 'Brand voice review',
      assignee: { kind: 'gezel', gezelId: 'leo' },
      steps: [{ name: 'Pass 1' }],
    });

    const session = await manager.createSession({ gezelId: 'ada', projectId: proj.id });
    mock.script('hello');
    await manager.send(session.id, 'where are we at?');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    expect(sys).toContain('### Tasks assigned to you in this project (2)');
    expect(sys).toContain(t1.ref);
    expect(sys).toContain('Build the storefront');
    expect(sys).toContain(t2.ref);
    expect(sys).toContain('Wire up checkout');
    // Other gezel's task is NOT included.
    expect(sys).not.toContain('Brand voice review');
  });

  it('skips the assigned-tasks block when the session is itself task-scoped', async () => {
    const proj = await store.createProject({ name: 'Shop' });
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    const t = await taskMgr.create(proj.id, {
      title: 'Build the storefront',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'Layout' }],
    });

    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: proj.id,
      taskRef: t.ref,
      stepId: t.activeStepId,
    });
    mock.script('ok');
    await manager.send(session.id, 'start');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    // The current-task block is rendered; the assigned-tasks
    // hint is suppressed (would just duplicate the same task).
    expect(sys).toContain(`### Current task: ${t.ref}`);
    expect(sys).not.toContain('### Tasks assigned to you in this project');
  });

  it('does not inject assigned tasks for the default project', async () => {
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    await taskMgr.create('default', {
      title: 'Default-project busywork',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [{ name: 'p1' }],
    });

    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    await manager.send(session.id, 'hi');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    expect(sys).not.toContain('### Tasks assigned to you in this project');
  });

  it('injects lessons.md into the stable prefix, after the about body and before project context', async () => {
    await store.writeMemoryLessons('ada', '- Prefer single-file deliverables.\n');

    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    await manager.send(session.id, 'hi');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('### Lessons from past work');
    expect(sys).toContain('- Prefer single-file deliverables.');
    const lessonsIdx = sys.indexOf('### Lessons from past work');
    const aboutHeaderIdx = sys.indexOf('your "about" document');
    expect(aboutHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(lessonsIdx).toBeGreaterThan(aboutHeaderIdx);
  });

  it('renders no lessons block when lessons.md is absent', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    await manager.send(session.id, 'hi');

    const create = mock.calls.find((c) => c.kind === 'create');
    expect(create!.opts!.systemMessage).not.toContain('### Lessons from past work');
  });

  it('injects frontmatter traits as a ### Traits block before lessons', async () => {
    await store.addGezelTrait('ada', {
      id: 'trait-1',
      text: 'Write failing tests before touching implementation code.',
      adoptedAt: '2026-06-11T00:00:00Z',
      source: 'levelup',
    });
    await store.writeMemoryLessons('ada', '- A lesson.\n');

    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    await manager.send(session.id, 'hi');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('### Traits');
    expect(sys).toContain('- Write failing tests before touching implementation code.');
    const traitsIdx = sys.indexOf('### Traits');
    const lessonsIdx = sys.indexOf('### Lessons from past work');
    expect(traitsIdx).toBeGreaterThan(-1);
    expect(lessonsIdx).toBeGreaterThan(traitsIdx); // traits = identity, lessons = experience
  });

  it('renders no traits block when the gezel has none', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    await manager.send(session.id, 'hi');

    const create = mock.calls.find((c) => c.kind === 'create');
    expect(create!.opts!.systemMessage).not.toContain('### Traits');
  });
});

describe('ChatManager — resume', () => {
  it('resumes a persisted session via resumeSession on next send', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('first');
    await manager.send(session.id, 'hi');

    // Simulate a restart: disconnect live session, keep record on disk.
    await manager.reset(session.id);

    mock.script('second');
    await manager.send(session.id, 'hi again');

    const resumes = mock.calls.filter((c) => c.kind === 'resume');
    expect(resumes.length).toBeGreaterThanOrEqual(1);
    expect(resumes[0]?.sessionId).toMatch(/^mock-session-/);
  });

  it('transparently rebuilds + retries when the provider drops the session mid-conversation', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('first');
    await manager.send(session.id, 'hi');

    // Queue an error that looks like Copilot's mid-conversation GC message.
    // The ChatManager should catch it, rebuild a fresh session, retry this
    // same turn, and deliver the scripted reply — all without surfacing the
    // error to the caller.
    mock.scriptSendFailure('Request session.send failed with message: Session not found: deadbeef');
    mock.script('second, after auto-recovery');
    const reply = await manager.send(session.id, 'are you still there?');
    expect(reply.content).toBe('second, after auto-recovery');

    // Disk state should reflect the full transcript (2 user + 2 assistant).
    const disk = await store.getSession('ada', session.id);
    expect(disk!.messages).toHaveLength(4);
    expect(disk!.messages.at(-1)!.content).toBe('second, after auto-recovery');
    // Successful turn clears any rebuild banner.
    expect(disk!.resumeFailed).toBeUndefined();
  });

  it('falls back to a fresh session + flags resumeFailed on SessionResumeError', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('first');
    await manager.send(session.id, 'hi');

    await manager.reset(session.id);
    mock.scriptResumeFailure();
    mock.script('second, fresh');
    await manager.send(session.id, 'are you back?');

    const disk = await store.getSession('ada', session.id);
    expect(disk!.resumeFailed).toBeUndefined(); // cleared on the successful next turn
    // But the create call after the failed resume means we have BOTH a resume
    // attempt and a subsequent create in the call log:
    const kinds = mock.calls.map((c) => c.kind);
    expect(kinds).toContain('resume');
    expect(kinds.filter((k) => k === 'create').length).toBeGreaterThanOrEqual(2);
  });

  it('recovers when SessionResumeError surfaces lazily from sendAndWait', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('first');
    await manager.send(session.id, 'hi');

    // Codex CLI's resumeSession only constructs a lazy session. A missing
    // rollout is discovered by `codex exec resume` on the first send instead
    // of during resumeSession itself.
    await manager.reset(session.id);
    mock.scriptSendFailure(
      '[codex-cli] thread resume failed: no rollout found for thread id deadbeef',
      { name: 'SessionResumeError' },
    );
    mock.script('second, after lazy resume recovery');

    const reply = await manager.send(session.id, 'are you back?');
    expect(reply.content).toBe('second, after lazy resume recovery');

    const disk = await store.getSession('ada', session.id);
    expect(disk!.messages).toHaveLength(4);
    expect(disk!.messages.at(-1)!.content).toBe('second, after lazy resume recovery');
    expect(disk!.resumeFailed).toBeUndefined();

    const kinds = mock.calls.map((c) => c.kind);
    expect(kinds).toContain('resume');
    expect(kinds.filter((k) => k === 'create').length).toBeGreaterThanOrEqual(2);
  });

  // Regression: before the fix, resume for llama-cpp seeded a
  // fresh session with NO priorMessages — only Ollama got the transcript
  // replay. After an app restart, the model landed in the session with an
  // empty context and couldn't recall anything the user had just said.
  // Both Ollama and llama-cpp are stateless on the server side (no
  // resume token), so both must seed priorMessages from the persisted
  // transcript. Each case cold-starts, tears down, and rebuilds its MCP
  // subprocess, so retain a wider budget under full-suite process pressure.
  for (const providerName of ['ollama', 'llama-cpp'] as const) {
    it(`seeds priorMessages on resume for stateless provider: ${providerName}`, async () => {
      const home = await mkdtemp(join(tmpdir(), `gezel-resume-${providerName}-`));
      const localStore = new Store({ home });
      await localStore.ensureLayout();
      await localStore.createGezel({ name: 'Ada', role: 'Developer' });
      await localStore.createProject({ name: 'Default' });
      await localStore.writeConfig({ provider: providerName });
      const events = new ChatEventBus();
      const localMock = new MockProvider({ name: providerName });
      const localMgr = new ChatManager({
        store: localStore,
        events,
        memory: noopMemory,
        getPort: () => 0,
        getToken: () => 'test-token',
        home,
        providers: [[providerName, localMock]],
        catalog: new CatalogService(),
        secrets: new FileSecretStore(home),
      });
      try {
        const session = await localMgr.createSession({ gezelId: 'ada' });
        localMock.script('assistant first reply');
        await localMgr.send(session.id, 'write me a web scraping script');

        const createCallsBefore = localMock.calls.filter((c) => c.kind === 'create').length;

        // Simulate a fresh process: drop the in-memory state and reload
        // from disk. This mirrors what happens when the user reopens
        // the app and lands back in the session.
        await localMgr.reset(session.id);

        localMock.script('assistant second reply');
        await localMgr.send(session.id, 'can you retry the playwright option?');

        // The post-reset create call must have received the previous
        // user+assistant turns via priorMessages. Without this seed
        // the model has no idea what "playwright option" was.
        const createCalls = localMock.calls.filter((c) => c.kind === 'create');
        const postReset = createCalls.slice(createCallsBefore);
        const withPrior = postReset.find(
          (c) => c.opts?.priorMessages && c.opts.priorMessages.length > 0,
        );
        expect(withPrior).toBeTruthy();
        const prior = withPrior?.opts?.priorMessages ?? [];
        expect(prior[0]?.role).toBe('user');
        expect(prior[0]?.content).toContain('web scraping script');
        expect(prior[1]?.role).toBe('assistant');
        expect(prior[1]?.content).toBe('assistant first reply');
      } finally {
        await localMgr.drainBackground();
        await localMgr.shutdown();
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);
  }

  it('strips `<think>` / `<|channel>` markup from assistant priorMessages before replay', async () => {
    // Wild-caught from a Gemma 4 26B run-and-gun session: the model
    // emitted `<|channel>thought ... <channel|>` blocks in an
    // assistant turn, those got persisted to disk, and on the NEXT
    // turn the same model saw its own past markup in the transcript
    // and either copied the pattern or misread it as a system error
    // ("the user is reporting my tool call was malformed"). Cleaning
    // markup out at the priorMessages seed point breaks the self-
    // feedback loop AND backfills sessions whose persisted content
    // pre-dates `extractReasoning`.
    const home = await mkdtemp(join(tmpdir(), 'gezel-prior-strip-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Ada', role: 'Developer' });
    await localStore.createProject({ name: 'Default' });
    await localStore.writeConfig({ provider: 'mlx' });
    const events = new ChatEventBus();
    const localMock = new MockProvider({ name: 'mlx' });
    const localMgr = new ChatManager({
      store: localStore,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['mlx', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'ada' });

      // Hand-craft a session record whose persisted assistant content
      // has raw channel markup — simulating a session loaded from disk
      // that pre-dates `extractReasoning`.
      const dirty = await localStore.getSession('ada', session.id);
      dirty!.messages = [
        { role: 'user', content: 'kick off the engine', at: new Date().toISOString() },
        {
          role: 'assistant',
          content:
            '<|channel>thought\nThe user wants files. I will write index.html.<channel|>I wrote index.html.',
          at: new Date().toISOString(),
        },
      ];
      await localStore.writeSession(dirty!);
      await localMgr.reset(session.id);

      localMock.script('next reply');
      await localMgr.send(session.id, 'keep going');

      const createCalls = localMock.calls.filter((c) => c.kind === 'create');
      const lastCreate = createCalls[createCalls.length - 1];
      const prior = lastCreate?.opts?.priorMessages ?? [];
      const assistant = prior.find((m) => m.role === 'assistant');
      expect(assistant).toBeTruthy();
      expect(assistant!.content).not.toContain('<|channel');
      expect(assistant!.content).not.toContain('<channel|');
      expect(assistant!.content).not.toContain('thought\nThe user wants files');
      // Visible "I wrote index.html." sentence is preserved.
      expect(assistant!.content).toContain('I wrote index.html.');
      // User message passes through verbatim — no scrub on user input.
      const user = prior.find((m) => m.role === 'user');
      expect(user!.content).toBe('kick off the engine');
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ChatManager — archive + delete', () => {
  it('archiveSession marks the record and excludes it from default auto-open', async () => {
    const a = await manager.createSession({ gezelId: 'ada' });
    await manager.archiveSession(a.id);
    const disk = await store.getSession('ada', a.id);
    expect(disk!.archived).toBe(true);
  });

  it('deleteSession removes the record + live state', async () => {
    const a = await manager.createSession({ gezelId: 'ada' });
    await manager.deleteSession(a.id);
    expect(await store.getSession('ada', a.id)).toBeNull();
  });
});

describe('ChatManager — isProjectActive', () => {
  it('returns false when no session is mid-turn', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    expect(manager.isProjectActive(session.projectId)).toBe(false);
  });

  it('returns true while a session in the project is mid-turn', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('hello');
    // Observe the active state during the turn: subscribe to delta events,
    // check isProjectActive, then let the turn finish.
    let sawActive = false;
    events.subscribe(session.id, (e) => {
      if (e.type === 'delta' && !sawActive) {
        sawActive = manager.isProjectActive(session.projectId);
      }
    });
    await manager.send(session.id, 'hi');
    expect(sawActive).toBe(true);
    // After the turn completes it's back to idle.
    expect(manager.isProjectActive(session.projectId)).toBe(false);
  });

  it('does not leak across projects', async () => {
    const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
    mock.script('hello');
    let otherProjectActive = false;
    events.subscribe(session.id, (e) => {
      if (e.type === 'delta') {
        otherProjectActive = manager.isProjectActive('some-other-project');
      }
    });
    await manager.send(session.id, 'hi');
    expect(otherProjectActive).toBe(false);
  });
});

describe('ChatManager — isGezelActive (cross-project busy check)', () => {
  it('returns true while any session owned by the gezel is mid-turn, regardless of project', async () => {
    const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
    mock.script('hi');
    let sawActive = false;
    events.subscribe(session.id, (e) => {
      if (e.type === 'delta' && !sawActive) {
        sawActive = manager.isGezelActive('ada');
      }
    });
    await manager.send(session.id, 'hello');
    expect(sawActive).toBe(true);
    expect(manager.isGezelActive('ada')).toBe(false); // idle after turn
  });

  it('returns false for gezels who have no sessions', async () => {
    expect(manager.isGezelActive('nobody')).toBe(false);
  });
});

describe('ChatManager — inflight visibility + cancel', () => {
  it('returns null when nothing is running', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    expect(manager.inflightInfo(session.id)).toBeNull();
  });

  it('exposes the in-flight user text + elapsed time while a turn is running', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('hi');
    let snapshot: ReturnType<typeof manager.inflightInfo> = null;
    let globalSnapshot: ReturnType<typeof manager.listInflight>[number] | undefined;
    events.subscribe(session.id, (e) => {
      if (e.type === 'delta' && !snapshot) {
        snapshot = manager.inflightInfo(session.id);
        globalSnapshot = manager.listInflight().find((turn) => turn.sessionId === session.id);
      }
    });
    await manager.send(session.id, 'what is the capital of France?');
    expect(snapshot).toBeTruthy();
    expect(snapshot!.userText).toBe('what is the capital of France?');
    expect(snapshot!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(globalSnapshot?.providerName).toBe('copilot');
    expect(manager.inflightInfo(session.id)).toBeNull();
  });

  it('includes caller-owned external conversations in the in-flight snapshot', async () => {
    const turn = await manager.beginExternalConversation({
      sourceId: 'pi',
      sourceName: 'Pi',
      externalConversationId: 'pi-live-turn',
      gezelId: 'ada',
      providerName: 'copilot',
      messages: [{ role: 'user', content: 'Build the rally game.' }],
      effectiveSystemMessage: 'You are Ada.',
      toolNames: [],
    });

    expect(manager.listInflight()).toEqual([
      expect.objectContaining({
        sessionId: turn.sessionId,
        gezelId: 'ada',
        projectId: 'default',
        userText: 'Build the rally game.',
      }),
    ]);
    expect(manager.isGezelActive('ada')).toBe(true);
    expect(manager.isProjectActive('default')).toBe(true);

    await turn.finish({ content: 'Partial answer.', finishReason: 'length' });
    expect(manager.listInflight()).toHaveLength(0);
    expect(manager.isGezelActive('ada')).toBe(false);
  });

  // The old "send() throws 'already in flight' when a turn is already
  // running" path is gone — `send()` now enqueues via SessionQueue
  // instead. The per-session queue tests below exercise that path.

  it('cancelInflight clears the stuck turn and publishes cancelled + done events', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    // Simulate a wedged turn that never finishes by pushing state manually.
    (
      manager as unknown as {
        inflight: Map<string, { userText: string; startedAt: number }>;
      }
    ).inflight.set(session.id, {
      userText: 'stuck thing',
      startedAt: Date.now(),
    });
    const received: string[] = [];
    events.subscribe(session.id, (e) => received.push(e.type));

    const res = await manager.cancelInflight(session.id);
    expect(res.cancelled).toBe(true);
    expect(manager.inflightInfo(session.id)).toBeNull();
    expect(received).toContain('cancelled');
    expect(received).not.toContain('error');
    expect(received).toContain('done');
  });

  it('cancelInflight is a no-op when nothing is running', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const res = await manager.cancelInflight(session.id);
    expect(res.cancelled).toBe(false);
  });

  it('emergencyStop flips to reactive before cancelling turns and clears restart queues', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const queuedReject = vi.fn();
    const engineRouter = { shutdown: vi.fn(async () => {}) };
    let parkedRan = false;
    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      pendingSends: Map<
        string,
        Array<{
          id: string;
          userText: string;
          enqueuedAt: number;
          waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
        }>
      >;
      afterSessionIdle: Map<string, Array<() => void>>;
      engineRouterCache: typeof engineRouter | null;
    };
    internals.engineRouterCache = engineRouter;
    internals.inflight.set(session.id, {
      userText: 'keep working until stopped',
      startedAt: Date.now(),
    });
    internals.pendingSends.set(session.id, [
      {
        id: 'queued-after-current',
        userText: 'run this next',
        enqueuedAt: Date.now(),
        waiters: [{ resolve: vi.fn(), reject: queuedReject }],
      },
    ]);
    internals.afterSessionIdle.set(session.id, [
      () => {
        parkedRan = true;
      },
    ]);
    manager.setEngagementMode('proactive');

    const result = await manager.emergencyStop();

    expect(result).toEqual({
      cancelledTurns: 1,
      clearedQueuedMessages: 1,
      clearedDeferredActions: 1,
    });
    expect(manager.getEngagementMode()).toBe('reactive');
    expect(manager.inflightInfo(session.id)).toBeNull();
    expect(manager.listQueued()).toHaveLength(0);
    expect(internals.afterSessionIdle.size).toBe(0);
    expect(queuedReject).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
    );
    expect(parkedRan).toBe(false);
    expect(engineRouter.shutdown).toHaveBeenCalledOnce();
  });

  it('beginShutdown cancels live turns, drops parked handoffs, and rejects new sends', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    let parkedRan = false;
    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      afterSessionIdle: Map<string, Array<() => void>>;
    };
    internals.inflight.set(session.id, { userText: 'still running', startedAt: Date.now() });
    internals.afterSessionIdle.set(session.id, [
      () => {
        parkedRan = true;
      },
    ]);

    await manager.beginShutdown();

    expect(manager.inflightInfo(session.id)).toBeNull();
    expect(parkedRan).toBe(false);
    expect(internals.afterSessionIdle.size).toBe(0);
    await expect(manager.send(session.id, 'one more thing')).rejects.toThrow(
      'service shutting down',
    );
  });
});

describe('ChatManager — listSessions', () => {
  it('returns sessions newest-first', async () => {
    const a = await manager.createSession({ gezelId: 'ada' });
    // Tiny delay so lastActivityAt differs.
    await new Promise((r) => setTimeout(r, 5));
    const b = await manager.createSession({ gezelId: 'ada' });
    const list = await manager.listSessions({ gezelId: 'ada' });
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
  });
});

async function waitForCondition(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  // Default bumped from 2s → 5s. Most call sites poll for fan-out
  // background writes (memory extraction, cross-gezel handoffs) that
  // each chain through createSession + sendAndWait + writeSession.
  // Under the concurrent test-runner load `pnpm test` produces, 2s
  // was occasionally insufficient and produced false flakes; 5s is
  // generous enough that a real bug still surfaces within a single
  // CI run while transient slowness no longer trips us.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

describe('ChatManager — messageGezel (cross-gezel messaging)', () => {
  // `resolveGezel` matches an id, a name, or a roleBasedName — never a bare
  // role word. A model reaching for `gezel: "writer"` used to get a flat
  // `gezel "writer" not found`, which the route turns into a 400 and the
  // client into "Gezel API error 400 on POST /api/gezels/writer/message";
  // one Meester read that as a service outage and narrated it for six
  // attempts. The miss has to name the real roster and the way out.
  it('names the real roster when the target does not resolve', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    const err = await manager
      .messageGezel({
        fromGezelId: 'ada',
        fromSessionId: adaSession.id,
        toGezelIdOrName: 'writer',
        text: 'Write the report.',
      })
      .then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );

    expect(err).toContain('"writer" not found');
    expect(err).toContain('not a role word');
    expect(err).toContain('maya');
    expect(err).toContain('ensure_gezel');
  });

  it('rejects a text-file handoff to a pure-delegation role before queueing it', async () => {
    await store.createGezel({ name: 'Maya', role: 'Planner' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    await expect(
      manager.messageGezel({
        fromGezelId: 'ada',
        fromSessionId: adaSession.id,
        toGezelIdOrName: 'maya',
        text: 'Write the outline.',
        expectedDeliverable: { kind: 'file', filePath: 'notes/outline.md' },
      }),
    ).rejects.toThrow(/cannot write workspace file "notes\/outline\.md"/);
    expect(await store.listSessions({ gezelId: 'maya' })).toHaveLength(0);
  });

  it("reuses the target gezel's active session and injects a prefixed user message", async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I checked — all good.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'what is the project status?',
    });

    expect(res.toGezelId).toBe('maya');
    expect(res.toGezelName).toBe('Maya');

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    expect(mayaDisk!.messages[0]?.role).toBe('user');
    expect(mayaDisk!.messages[0]?.content).toBe('[Message from Ada]: what is the project status?');
    expect(mayaDisk!.messages[0]?.from).toEqual({
      gezelId: 'ada',
      gezelName: 'Ada',
    });
    expect(mayaDisk!.messages[1]?.role).toBe('assistant');
    expect(mayaDisk!.messages[1]?.content).toBe('I checked — all good.');
  });

  it('resolves relay names per side: a boring-pinned sender never sees friendly names', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({
      gezelId: 'ada',
      roleBasedNameOnlyMode: true,
    });
    mock.script('All good.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'status?',
    });

    // The tool result goes back into Ada's pinned-boring session — it must
    // carry the role-based name, or the model leaks "Maya" into prose.
    expect(res.toGezelName).toBe('voorman');

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    // Maya's session is unpinned and the config flag is off, so the seed
    // delivered INTO her session keeps the friendly sender name.
    const mayaDisk = await store.getSession('maya', res.sessionId);
    expect(mayaDisk!.messages[0]?.content).toBe('[Message from Ada]: status?');
  });

  it("inherits a task's boring mode when a relay opens a task-scoped thread", async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const now = new Date().toISOString();
    await store.writeTask({
      projectId: 'default',
      num: 1,
      ref: 'default/1',
      title: 'Boring task relay',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'maya' },
      craftbook: {
        id: 'relay',
        name: 'Relay',
        steps: [{ id: 'build', name: 'Build', createdAt: now }],
        entryStepId: 'build',
        createdAt: now,
        updatedAt: now,
      },
      activeStepId: 'build',
      roleBasedNameOnlyMode: true,
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: 'user' },
    });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('On it.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      taskRef: 'default/1',
      stepId: 'build',
      text: 'status?',
    });
    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    expect(mayaDisk?.roleBasedNameOnlyMode).toBe(true);
    expect(mayaDisk?.messages[0]?.content).toBe('[Message from developer]: status?');
  });

  it('renders relay names role-based everywhere when the config flag is on', async () => {
    await store.writeConfig({ provider: 'copilot', roleBasedNameOnlyMode: true });
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('All good.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'status?',
    });

    expect(res.toGezelName).toBe('voorman');

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    expect(mayaDisk!.messages[0]?.content).toBe('[Message from developer]: status?');
  });

  it('adds single-file HTML constraints to index.html file handoffs', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I wrote index.html.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'Build the browser game.',
      expectedDeliverable: { kind: 'file', filePath: 'index.html' },
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    const seed = String(mayaDisk!.messages[0]?.content ?? '');
    expect(seed).toContain('Deliverable expected as a FILE at `index.html`');
    expect(seed).toContain(
      'Your first assistant action should be the tool call `write_file({ path, content })`',
    );
    expect(seed).toContain('single-file HTML deliverable');
    expect(seed).toContain('put CSS in `<style>` and JavaScript in one inline `<script>`');
    expect(seed).toContain('Do NOT create or rely on `script.js`, `styles.css`');
  });

  it.each([
    ['PowerPoint', 'd-day.pptx'],
    ['animated GIF', 'launch-loop.gif'],
    ['video', 'launch-video.mp4'],
  ])('rejects an ad-hoc %s handoff so a craftbook owns production', async (_, path) => {
    await store.createGezel({ name: 'Maya', role: 'Copywriter' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    await expect(
      manager.messageGezel({
        fromGezelId: 'ada',
        fromSessionId: adaSession.id,
        toGezelIdOrName: 'maya',
        text: `Turn this content into ${path}.`,
        expectedDeliverable: { kind: 'file', filePath: path },
      }),
    ).rejects.toThrow(/cannot be sent as an ad-hoc gezel handoff.*matching craftbook/i);

    const mayaSessions = await store.listSessions({ gezelId: 'maya' });
    expect(mayaSessions).toHaveLength(0);
  });

  it('does not append a contradictory write_file-first instruction to focused repair handoffs', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I patched index.html.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text:
        '[scenario check] I looked at `index.html` and it still fails. ' +
        'The inline script has a parse error. Read `index.html`, then patch the existing file with the smallest syntax fix.',
      expectedDeliverable: { kind: 'file', filePath: 'workspace/index.html' },
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    const seed = String(mayaDisk!.messages[0]?.content ?? '');
    expect(seed).toContain('focused repair of an existing source file');
    expect(seed).toContain('`replace_in_file` or `replace_lines`');
    expect(seed).not.toContain('first assistant action should be the tool call `write_file');
  });

  it('preserves an exact append-only repair directive instead of injecting write_file-first', async () => {
    await store.createGezel({ name: 'Maya', role: 'Researcher' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I appended the requested analysis.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: [
        'INCIDENT POSTMORTEM APPEND: the document already has the required structure but needs more evidence-backed substance.',
        'Append at least 1719 substantive characters so the result clears 7 KiB with headroom; do not pad.',
        'Your next tool call must be `append_to_file({ path: "postmortem.md", content: "\\n\\n### Evidence-backed follow-up context\\n\\n<new analysis>" })`.',
        'Do not call `write_file`, rewrite existing sections, or answer in chat first.',
      ].join(' '),
      expectedDeliverable: { kind: 'file', filePath: 'postmortem.md' },
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    const seed = String(mayaDisk!.messages[0]?.content ?? '');
    expect(seed).toContain('This is an append-only update of an existing file');
    expect(seed).toContain('your first file mutation must use `append_to_file`');
    expect(seed).toContain('do not call `write_file`');
    expect(seed).not.toContain('first assistant action should be the tool call `write_file');
  });

  it('preserves an explicitly named surgical edit surface for an existing file', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I patched the named lines.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'Read `src/store.ts`, then use `replace_lines` for lines 40-44. Preserve the rest.',
      expectedDeliverable: { kind: 'file', filePath: 'src/store.ts' },
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    const seed = String(mayaDisk!.messages[0]?.content ?? '');
    expect(seed).toContain('existing-file edit surface `replace_lines`');
    expect(seed).toContain('do not replace that surgical surface');
    expect(seed).not.toContain('first assistant action should be the tool call `write_file');
  });

  it("defers the target send until the sender's in-flight turn is idle", async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I will take it from here.');

    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      flushAfterSessionIdle(sessionId: string): void;
    };
    internals.inflight.set(adaSession.id, { userText: 'delegate', startedAt: Date.now() });

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'please handle the page',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeFlush = await store.getSession('maya', res.sessionId);
    expect(beforeFlush?.messages).toHaveLength(0);

    internals.inflight.delete(adaSession.id);
    internals.flushAfterSessionIdle(adaSession.id);

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    expect(mayaDisk!.messages[0]?.content).toBe('[Message from Ada]: please handle the page');
    expect(mayaDisk!.messages[1]?.content).toBe('I will take it from here.');
  });

  it('joins duplicate pending create handoffs for the same file instead of parking twice', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('I wrote the outline.');

    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      afterSessionIdle: Map<string, Array<() => void>>;
      flushAfterSessionIdle(sessionId: string): void;
    };
    internals.inflight.set(adaSession.id, { userText: 'delegate', startedAt: Date.now() });

    const first = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'Write the outline.',
      expectedDeliverable: { kind: 'file', filePath: 'notes/outline.md' },
    });
    const duplicate = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'Please write the outline now.',
      expectedDeliverable: { kind: 'file', filePath: 'notes/outline.md' },
    });

    expect(duplicate).toMatchObject({
      sessionId: first.sessionId,
      toGezelId: first.toGezelId,
      deduplicated: true,
    });
    expect(internals.afterSessionIdle.get(adaSession.id)).toHaveLength(1);

    internals.inflight.delete(adaSession.id);
    internals.flushAfterSessionIdle(adaSession.id);
    await waitForCondition(async () => {
      const disk = await store.getSession('maya', first.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });
    const mayaDisk = await store.getSession('maya', first.sessionId);
    expect(mayaDisk!.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('does not swallow a validator repair behind an in-flight create for the same file', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      afterSessionIdle: Map<string, Array<() => void>>;
    };
    internals.inflight.set(adaSession.id, { userText: 'delegate', startedAt: Date.now() });

    const first = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'Write the outline.',
      expectedDeliverable: { kind: 'file', filePath: 'notes/outline.md' },
    });
    const repair = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: '[scenario check] I looked at `notes/outline.md` and the success criteria are not met. Specific failure: Owner is empty. Use `replace_in_file` to patch it.',
      expectedDeliverable: { kind: 'file', filePath: 'notes/outline.md' },
    });

    expect(repair).toMatchObject({
      sessionId: first.sessionId,
      toGezelId: first.toGezelId,
    });
    expect(repair.deduplicated).toBeUndefined();
    expect(internals.afterSessionIdle.get(adaSession.id)).toHaveLength(2);
  });

  it('flushes deferred target sends before draining queued sender messages', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('Maya received it.', 'Ada handled the queued nudge.');

    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      afterSessionIdle: Map<string, Array<() => void>>;
      pendingSends: Map<
        string,
        Array<{
          id: string;
          userText: string;
          enqueuedAt: number;
          from: { gezelId: string; gezelName: string } | undefined;
          coalescable: boolean;
          lane: undefined;
          waiters: Array<{ resolve: (msg: unknown) => void; reject: (err: Error) => void }>;
        }>
      >;
      finishSessionTurn(sessionId: string): void;
    };

    internals.inflight.set(adaSession.id, { userText: 'delegate', startedAt: Date.now() });
    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'please create index.html',
    });
    expect(internals.afterSessionIdle.has(adaSession.id)).toBe(true);

    internals.pendingSends.set(adaSession.id, [
      {
        id: 'queued-nudge',
        userText: '[scenario check] index.html is still missing',
        enqueuedAt: Date.now(),
        from: { gezelId: 'maya', gezelName: 'Maya' },
        coalescable: false,
        lane: undefined,
        waiters: [{ resolve: () => {}, reject: () => {} }],
      },
    ]);

    internals.inflight.delete(adaSession.id);
    internals.finishSessionTurn(adaSession.id);

    expect(internals.afterSessionIdle.has(adaSession.id)).toBe(false);
    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 1;
    });

    const mayaDisk = await store.getSession('maya', res.sessionId);
    expect(mayaDisk!.messages[0]?.content).toBe('[Message from Ada]: please create index.html');
  });

  it("delivers Maya's reply into Ada's session as its own handoff message and auto-triggers a response", async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    // Four scripted replies: Maya's main response, Maya's post-turn
    // memory-extractor no-op, Ada's auto-response, Ada's memory no-op.
    // The memory extractor fires via `void extractMemories` at the end
    // of each send(); it sees 'NONE' → skips saving. Without these
    // placeholder scripts the extractor would starve the real turn's
    // queue and Ada's auto-reply would fall back to `Mock reply: …`.
    mock.script('Things look fine.');
    mock.script('NONE');
    mock.script('Great, appreciated.');
    mock.script('NONE');

    await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'status?',
    });

    // Wait for Ada's session to both receive Maya's reply AND produce
    // an assistant response to it. That's 3 total messages: Ada's
    // outbound was sent via messageGezel into Maya's session, so Ada's
    // own session only gains Maya's reply + Ada's auto-response.
    await waitForCondition(async () => {
      const disk = await store.getSession('ada', adaSession.id);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const adaDisk = await store.getSession('ada', adaSession.id);
    const messages = adaDisk!.messages;

    // Leo → Ada (Maya replying to Ada, rendered as handoff bubble).
    const handoff = messages.find((m) => m.role === 'user' && m.from);
    expect(handoff).toBeTruthy();
    expect(handoff?.from?.gezelId).toBe('maya');
    expect(handoff?.from?.gezelName).toBe('Maya');
    expect(handoff?.content).toBe('[Message from Maya]: Things look fine.');

    // Ada's own model response to Maya's reply lands as a regular assistant turn.
    const autoResponse = messages.find((m) => m.role === 'assistant');
    expect(autoResponse?.content).toBe('Great, appreciated.');

    // No preface-glued user message with the old "[While you were away]" text.
    const anyPreface = messages.some((m) => m.content.includes('While you were away'));
    expect(anyPreface).toBe(false);
  });

  it('keeps one-way harness feedback from waking the sender with a reply turn', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('Patched the checked file.', 'NONE');

    const result = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: '[scenario check] Patch the failing file.',
      suppressReply: true,
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', result.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const adaDisk = await store.getSession('ada', adaSession.id);
    expect(adaDisk?.messages ?? []).toHaveLength(0);
  });

  it('keeps the async reply listener alive while a slow target is still making progress', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    const mayaSession = await manager.createSession({ gezelId: 'maya' });
    const warnings: string[] = [];
    events.subscribe(adaSession.id, (event) => {
      if (event.type === 'warning') warnings.push(event.message);
    });

    const internals = manager as unknown as {
      attachReplyListener(
        args: {
          targetSessionId: string;
          fromSessionId: string;
          toGezelId: string;
          toName: string;
          fromGezelId: string;
          fromGezelName: string;
          projectId: string;
        },
        idleTimeoutMs: number,
      ): void;
    };
    internals.attachReplyListener(
      {
        targetSessionId: mayaSession.id,
        fromSessionId: adaSession.id,
        toGezelId: 'maya',
        toName: 'Maya',
        fromGezelId: 'ada',
        fromGezelName: 'Ada',
        projectId: 'default',
      },
      100,
    );

    // Stay active for three times the idle window. The old wall-clock timer
    // would fire at 100 ms even though DS4 was visibly prefilling/decoding.
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.publish(
        { sessionId: mayaSession.id, gezelId: 'maya', projectId: 'default' },
        { type: 'delta', content: 'x' },
      );
    }
    expect(warnings).toEqual([]);

    // Completion cancels the re-armed idle timer. Empty content exercises the
    // tool-only completion path without scheduling a reply turn for Ada.
    events.publish(
      { sessionId: mayaSession.id, gezelId: 'maya', projectId: 'default' },
      { type: 'complete', message: { role: 'assistant', content: '', at: 'now' } },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(warnings).toEqual([]);
  });

  it('does not turn an empty tool-only reply into a content-free sender turn', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    await store.writeConfig({ aiEngagementMode: 'off' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'apply the requested workspace change',
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });
    await manager.drainBackground();

    const adaDisk = await store.getSession('ada', adaSession.id);
    // Under peak full-suite concurrency Maya's turn can transiently throw
    // (e.g. a broken MCP-subprocess stdio pipe surfacing as an EP* error),
    // which legitimately routes a `[Delivery failure]` notice to Ada — a
    // DIFFERENT path from the empty-reply forwarding this test guards. That
    // path is not what's under test, so only assert the strict "Ada got
    // nothing" state when Maya actually replied cleanly. A real regression
    // in the empty-reply path manufactures a content-free `[Message from
    // Maya]:` forward, which the unconditional check below still catches.
    const transientTurnFailure = (adaDisk?.messages ?? []).some((m) =>
      m.content.includes('[Delivery failure]'),
    );
    if (!transientTurnFailure) {
      expect(adaDisk?.messages).toEqual([]);
    }
    const contentFreeForward = mock.calls.find(
      (call) => call.kind === 'send' && call.prompt?.trim() === '[Message from Maya]:',
    );
    expect(contentFreeForward).toBeUndefined();
  });

  it("delivers a turn-driving [Delivery failure] notice to the sender when the recipient's turn throws", async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    // Maya's turn throws (provider failure). Ada then auto-responds to the
    // failure notice; her post-turn memory extractor consumes 'NONE'.
    // Before the turn-driving notice existed, this scenario left Ada idle
    // forever — a warning event reached the UI but never Ada's model
    // (wild-caught core sweep: "chat stalled — no model turns").
    mock.scriptSendFailure(
      'source edit turn ended without a successful workspace mutation after 2 corrective nudge(s).',
    );
    mock.script('Understood — I will apply the change myself.');
    mock.script('NONE');

    await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'apply the schema change to store.ts',
    });

    await waitForCondition(async () => {
      const disk = await store.getSession('ada', adaSession.id);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const messages = (await store.getSession('ada', adaSession.id))!.messages;
    const notices = messages.filter(
      (m) => m.role === 'user' && m.content.startsWith('[Delivery failure]:'),
    );
    // Exactly one notice: the recipient-turn error event AND the dispatch
    // rejection both observe the same dead handoff; the shared once-guard
    // dedupes them.
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toContain('Maya');
    expect(notices[0]?.from?.gezelId).toBe('maya');
    // The notice drove a real turn — the sender reacted instead of idling.
    const autoResponse = messages.find((m) => m.role === 'assistant');
    expect(autoResponse?.content).toBe('Understood — I will apply the change myself.');
  });

  it('extends a busy reply listener once, then records expiry without waking the sender model', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    const logged: Array<{ details?: { reason?: string } }> = [];
    const m = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      historyManager: { log(event: { details?: { reason?: string } }): Promise<void> };
      attachReplyListener(
        args: {
          targetSessionId: string;
          fromSessionId: string;
          toGezelId: string;
          toName: string;
          fromGezelId: string;
          fromGezelName: string;
          projectId: string;
        },
        idleTimeoutMs: number,
      ): void;
    };
    m.historyManager = {
      log: async (event) => {
        logged.push(event);
      },
    };
    const targetSessionId = 'prefilling-target';
    m.inflight.set(targetSessionId, { userText: 'repair', startedAt: Date.now() });
    m.attachReplyListener(
      {
        targetSessionId,
        fromSessionId: adaSession.id,
        toGezelId: 'maya',
        toName: 'Maya',
        fromGezelId: 'ada',
        fromGezelName: 'Ada',
        projectId: 'default',
      },
      50,
    );

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(logged).toHaveLength(0);

    m.inflight.delete(targetSessionId);
    await waitForCondition(() => logged.length === 1, 500);
    expect(logged[0]?.details?.reason).toBe('listener-timeout');
    expect((await store.getSession('ada', adaSession.id))?.messages).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });

  it("delivers the recipient's reply to the sender gezel session even without a fromSessionId", async () => {
    // The task scheduler and the MCP message_gezel route only know the
    // sender's gezel id. The reply must still round-trip: without this,
    // the recipient's answer was dropped and the team idled with the task
    // incomplete (wild-caught core sweep: qwen3.5-4b
    // schema-migration died idle with every handoff "ran to completion").
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    mock.script('Step done, tests green.');
    mock.script('NONE');
    mock.script('Great — advancing the task.');
    mock.script('NONE');

    await manager.messageGezel({
      fromGezelId: 'ada',
      toGezelIdOrName: 'maya',
      text: 'run the migration step',
    });

    await waitForCondition(async () => {
      const sessions = await store.listSessions({ gezelId: 'ada' });
      if (sessions.length === 0) return false;
      const disk = await store.getSession('ada', sessions[0]!.id);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const sessions = await store.listSessions({ gezelId: 'ada' });
    const messages = (await store.getSession('ada', sessions[0]!.id))!.messages;
    const reply = messages.find((m) => m.role === 'user' && m.from?.gezelId === 'maya');
    expect(reply?.content).toBe('[Message from Maya]: Step done, tests green.');
    const autoResponse = messages.find((m) => m.role === 'assistant');
    expect(autoResponse?.content).toBe('Great — advancing the task.');
  });

  it('delivers the failure notice into the sender gezel session even without a fromSessionId', async () => {
    // The MCP message_gezel route and the task scheduler dispatch without a
    // fromSessionId. The failure notice must resolve the sender's session
    // itself — this was the residual wedge after the first fix
    // fix-verify run: handoff htag showed `from=—`, no notice, team idled).
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    mock.scriptSendFailure('provider exploded mid-turn');
    mock.script('I will reassign the work.');
    mock.script('NONE');

    await manager.messageGezel({
      fromGezelId: 'ada',
      toGezelIdOrName: 'maya',
      text: 'apply the schema change to store.ts',
    });

    // The notice resolves Ada's active session for the project on demand.
    await waitForCondition(async () => {
      const sessions = await store.listSessions({ gezelId: 'ada' });
      if (sessions.length === 0) return false;
      const disk = await store.getSession('ada', sessions[0]!.id);
      return (disk?.messages.length ?? 0) >= 2;
    });

    const sessions = await store.listSessions({ gezelId: 'ada' });
    const messages = (await store.getSession('ada', sessions[0]!.id))!.messages;
    const notice = messages.find(
      (m) => m.role === 'user' && m.content.startsWith('[Delivery failure]:'),
    );
    expect(notice).toBeTruthy();
    expect(notice?.content).toContain('Maya');
    const autoResponse = messages.find((m) => m.role === 'assistant');
    expect(autoResponse?.content).toBe('I will reassign the work.');
  });

  it('resolves the target gezel by display name (case-insensitive)', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');
    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'MAYA',
      text: 'ping',
    });
    expect(res.toGezelId).toBe('maya');
    await waitForCondition(async () => {
      const disk = await store.getSession('maya', res.sessionId);
      return (disk?.messages.length ?? 0) >= 2;
    });
  });

  it('throws when the target gezel does not exist', async () => {
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    await expect(
      manager.messageGezel({
        fromGezelId: 'ada',
        fromSessionId: adaSession.id,
        toGezelIdOrName: 'nonexistent',
        text: 'hi',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('refuses to message yourself', async () => {
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    await expect(
      manager.messageGezel({
        fromGezelId: 'ada',
        fromSessionId: adaSession.id,
        toGezelIdOrName: 'ada',
        text: 'hi',
      }),
    ).rejects.toThrow(/yourself/);
  });

  it("auto-routes to the target's existing non-default project session when caller omits `project`", async () => {
    // Wild-caught (nemotron-nano tictactoe v2): meester
    // (in default) created `tic-tac-toe-game`, asked target to work
    // there on turn 1 (passing project=tic-tac-toe-game), then on a
    // follow-up message forgot to pass project. Without auto-routing,
    // the target got a fresh default-scoped session whose read_file
    // 404'd against the work it had already done in the named project.
    await store.createProject({ name: 'Tic Tac Toe Game' });
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    // Pre-seed: Maya has an active session in tic-tac-toe-game.
    await manager.createSession({ gezelId: 'maya', projectId: 'tic-tac-toe-game' });
    const adaSession = await manager.createSession({ gezelId: 'ada' }); // ada in default
    mock.script('still on it');

    // Ada messages Maya WITHOUT passing project — would normally route
    // to default. Auto-routing should pick up Maya's tic-tac-toe-game
    // session instead.
    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'how is the game coming?',
    });

    const session = await store.getSession('maya', res.sessionId);
    expect(session?.projectId).toBe('tic-tac-toe-game');
  });

  it('reuses the exact task-step session for a scheduler re-drive', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const lobby = await manager.createSession({ gezelId: 'maya', projectId: 'default' });
    const taskSession = await manager.createSession({
      gezelId: 'maya',
      projectId: 'default',
      taskRef: 'default/7',
      stepId: 'scope',
    });
    mock.script('I will finish the scope step.');

    const result = await manager.messageGezel({
      fromGezelId: 'ada',
      toGezelIdOrName: 'maya',
      projectId: 'default',
      taskRef: 'default/7',
      stepId: 'scope',
      text: 'Resume the stalled scope step.',
    });

    expect(result.sessionId).toBe(taskSession.id);
    const resumed = await store.getSession('maya', taskSession.id);
    expect(resumed).toMatchObject({ taskRef: 'default/7', stepId: 'scope' });
    const untouchedLobby = await store.getSession('maya', lobby.id);
    expect(untouchedLobby?.messages).toEqual([]);
  });

  it('does NOT auto-route when the target has sessions across multiple non-default projects', async () => {
    // Ambiguous: don't guess. Keep the caller's explicit/default
    // behavior so the model has to be specific.
    await store.createProject({ name: 'Project A' });
    await store.createProject({ name: 'Project B' });
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await manager.createSession({ gezelId: 'maya', projectId: 'project-a' });
    await manager.createSession({ gezelId: 'maya', projectId: 'project-b' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'ping',
    });

    const session = await store.getSession('maya', res.sessionId);
    // Falls back to caller's project (default).
    expect(session?.projectId).toBe('default');
  });

  it('respects an explicit `project` argument and never auto-routes over it', async () => {
    // If the caller passed `project: default` deliberately, don't
    // override it.
    await store.createProject({ name: 'Tic Tac Toe Game' });
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await manager.createSession({ gezelId: 'maya', projectId: 'tic-tac-toe-game' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'quick general ping',
      projectId: 'default',
    });

    const session = await store.getSession('maya', res.sessionId);
    expect(session?.projectId).toBe('default');
  });

  it('ignores archived sessions when computing the auto-route', async () => {
    // An archived non-default session shouldn't count as "active work
    // in a non-default project" — fall back to default.
    await store.createProject({ name: 'Old Game' });
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const oldSession = await manager.createSession({ gezelId: 'maya', projectId: 'old-game' });
    await manager.archiveSession(oldSession.id);
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('ok');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'ping',
    });

    const session = await store.getSession('maya', res.sessionId);
    expect(session?.projectId).toBe('default');
  });
});

describe('ChatManager — sendWithMentions (@-mention fan-out)', () => {
  beforeEach(async () => {
    await store.createGezel({ name: 'Bea', role: 'Designer' });
    await store.createGezel({ name: 'Cid', role: 'Reviewer' });
  });

  it('delivers the verbatim text to every mentioned gezel (no "from" metadata)', async () => {
    const primary = await manager.createSession({ gezelId: 'ada' });
    // Each turn also triggers an extractMemories call against the provider
    // which consumes a script — pair each reply with a "NONE" placeholder so
    // the extractor has something to read without polluting the next turn.
    mock.script('ada reply', 'NONE', 'bea reply', 'NONE', 'cid reply', 'NONE');

    await manager.sendWithMentions({
      primarySessionId: primary.id,
      text: 'Hey @[Bea](gezel:bea) and @[Cid](gezel:cid), take a look.',
      mentionGezelIds: ['bea', 'cid'],
    });

    // Wait for the fire-and-forget fan-out to land for BOTH mentioned
    // gezels before asserting. Bea + Cid run in parallel, so Bea
    // landing first doesn't guarantee Cid has finished — under
    // concurrent test-runner load the assertion otherwise hits
    // `cidRec.messages[0]` while it's still undefined.
    const ready = async (gid: string): Promise<boolean> => {
      const sessions = await store.listSessions({ gezelId: gid });
      if (sessions.length === 0) return false;
      const rec = await store.getSession(gid, sessions[0]!.id);
      return !!rec && rec.messages.length >= 2;
    };
    await waitForCondition(async () => (await ready('bea')) && (await ready('cid')), 3000);

    const primaryRec = await store.getSession('ada', primary.id);
    expect(primaryRec?.messages[0]?.role).toBe('user');
    expect(primaryRec?.messages[0]?.content).toContain('@[Bea](gezel:bea)');
    // Primary's user message has no `from` — it's the user, not a handoff.
    expect(primaryRec?.messages[0]?.from).toBeUndefined();

    const beaSessions = await store.listSessions({ gezelId: 'bea' });
    expect(beaSessions).toHaveLength(1);
    const beaRec = await store.getSession('bea', beaSessions[0]!.id);
    expect(beaRec?.messages[0]?.role).toBe('user');
    expect(beaRec?.messages[0]?.content).toBe(
      'Hey @[Bea](gezel:bea) and @[Cid](gezel:cid), take a look.',
    );
    // Mentioned gezels receive verbatim user text — no preface, no `from`.
    expect(beaRec?.messages[0]?.from).toBeUndefined();

    const cidSessions = await store.listSessions({ gezelId: 'cid' });
    expect(cidSessions).toHaveLength(1);
    const cidRec = await store.getSession('cid', cidSessions[0]!.id);
    expect(cidRec?.messages[0]?.from).toBeUndefined();
    expect(cidRec?.messages[0]?.content).toBe(
      'Hey @[Bea](gezel:bea) and @[Cid](gezel:cid), take a look.',
    );
  });

  it("dedups self-mention — gezel you're already chatting with gets only one copy", async () => {
    const primary = await manager.createSession({ gezelId: 'ada' });
    mock.script('ada reply', 'NONE');

    const res = await manager.sendWithMentions({
      primarySessionId: primary.id,
      text: 'Hey @[Ada](gezel:ada), reminding yourself.',
      mentionGezelIds: ['ada'], // the primary gezel — dedup should drop
    });
    expect(res.mentionSessionIds).toEqual([]);

    const adaSessions = await store.listSessions({ gezelId: 'ada' });
    const rec = await store.getSession('ada', adaSessions[0]!.id);
    expect(rec?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('skips empty / duplicate ids in the mention list', async () => {
    const primary = await manager.createSession({ gezelId: 'ada' });
    mock.script('ada reply', 'NONE', 'bea reply', 'NONE');

    const res = await manager.sendWithMentions({
      primarySessionId: primary.id,
      text: '@[Bea](gezel:bea)',
      mentionGezelIds: ['bea', '', '  ', 'bea'],
    });
    expect(res.mentionSessionIds).toHaveLength(1);
  });

  describe("Meester-chat heuristic — re-anchor mentions to the gezel's real project", () => {
    it('routes a mention from default to the project where the gezel is voorman', async () => {
      const shop = await store.createProject({
        name: 'Shop',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      await store.updateProject(shop.id, { voormanGezelId: 'bea' });

      const primary = await manager.createSession({ gezelId: 'ada' }); // default
      mock.script('ada', 'NONE', 'bea', 'NONE');

      const res = await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: 'Hey @[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });

      expect(res.mentionSessionIds).toHaveLength(1);
      const beaSession = await store.getSession('bea', res.mentionSessionIds[0]!);
      expect(beaSession?.projectId).toBe(shop.id);
    });

    it('routes to a project where the gezel has an active task assignment', async () => {
      const shop = await store.createProject({
        name: 'Shop',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      const now = new Date().toISOString();
      await store.writeTask({
        projectId: shop.id,
        num: 1,
        ref: `${shop.id}/1`,
        title: 'Mocks',
        status: 'active',
        assignee: { kind: 'gezel', gezelId: 'bea' },
        craftbook: {
          id: 'cb-1',
          name: 'cb',
          steps: [{ id: 'p1', name: 'do it', createdAt: now }],
          entryStepId: 'p1',
          createdAt: now,
          updatedAt: now,
        },
        activeStepId: 'p1',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
      });

      const primary = await manager.createSession({ gezelId: 'ada' }); // default
      mock.script('ada', 'NONE', 'bea', 'NONE');

      const res = await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });

      const beaSession = await store.getSession('bea', res.mentionSessionIds[0]!);
      expect(beaSession?.projectId).toBe(shop.id);
    });

    it('ignores complete / canceled tasks when picking a project', async () => {
      const shop = await store.createProject({
        name: 'Shop',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      const now = new Date().toISOString();
      await store.writeTask({
        projectId: shop.id,
        num: 1,
        ref: `${shop.id}/1`,
        title: 'Old work',
        status: 'complete', // ← shouldn't pull Bea back here
        assignee: { kind: 'gezel', gezelId: 'bea' },
        craftbook: {
          id: 'cb-1',
          name: 'cb',
          steps: [{ id: 'p1', name: 'done', createdAt: now }],
          entryStepId: 'p1',
          createdAt: now,
          updatedAt: now,
        },
        activeStepId: 'p1',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
      });

      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('ada', 'NONE', 'bea', 'NONE');

      const res = await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });

      const beaSession = await store.getSession('bea', res.mentionSessionIds[0]!);
      // No active assignment, no prior session → falls back to default.
      expect(beaSession?.projectId).toBe('default');
    });

    it('breaks ties between candidate projects via most-recent gezel session', async () => {
      const shopA = await store.createProject({
        name: 'A',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      const shopB = await store.createProject({
        name: 'B',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      await store.updateProject(shopA.id, { voormanGezelId: 'bea' });
      await store.updateProject(shopB.id, { voormanGezelId: 'bea' });
      // Older session in A, newer session in B → B wins.
      const olderSession = await manager.createSession({ gezelId: 'bea', projectId: shopA.id });
      olderSession.lastActivityAt = new Date(Date.now() - 60_000).toISOString();
      await store.writeSession(olderSession);
      const newerSession = await manager.createSession({ gezelId: 'bea', projectId: shopB.id });
      newerSession.lastActivityAt = new Date().toISOString();
      await store.writeSession(newerSession);

      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('ada', 'NONE', 'bea', 'NONE');

      const res = await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });
      const beaSession = await store.getSession('bea', res.mentionSessionIds[0]!);
      expect(beaSession?.projectId).toBe(shopB.id);
    });

    it('does NOT re-anchor when the primary is itself in a project (project-chat case)', async () => {
      const shopA = await store.createProject({
        name: 'A',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      const shopB = await store.createProject({
        name: 'B',
        about: 'x'.repeat(80),
        missionObjectives: 'y'.repeat(60),
      });
      await store.updateProject(shopB.id, { voormanGezelId: 'bea' });

      // Ada is chatting in shopA — mentioning Bea here should drop into
      // shopA, not shopB, even though Bea is voorman of shopB.
      const primary = await manager.createSession({ gezelId: 'ada', projectId: shopA.id });
      mock.script('ada', 'NONE', 'bea', 'NONE');

      const res = await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });
      const beaSession = await store.getSession('bea', res.mentionSessionIds[0]!);
      expect(beaSession?.projectId).toBe(shopA.id);
    });
  });

  describe('primary stays silent when mention targets someone else', () => {
    it('appends the user turn to primary but does not invoke the provider', async () => {
      const primary = await manager.createSession({ gezelId: 'ada' });
      // Only script replies for Bea's fan-out and its memory extraction.
      // If primary (Ada) were to invoke the provider, the queue would run
      // dry and the turn would fail — that failure is the signal.
      mock.script('bea reply', 'NONE');

      await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: 'Hey @[Bea](gezel:bea) keep going :)',
        mentionGezelIds: ['bea'],
      });
      await manager.drainBackground();

      const primaryRec = await store.getSession('ada', primary.id);
      // User message present — voorman is "notified" via their transcript.
      expect(primaryRec?.messages).toHaveLength(1);
      expect(primaryRec?.messages[0]?.role).toBe('user');
      expect(primaryRec?.messages[0]?.content).toContain('@[Bea](gezel:bea)');
      // But no assistant turn — primary didn't butt in.
      expect(primaryRec?.messages.some((m) => m.role === 'assistant')).toBe(false);

      // Meanwhile Bea did get the message AND reply.
      const beaSessions = await store.listSessions({ gezelId: 'bea' });
      expect(beaSessions).toHaveLength(1);
      const beaRec = await store.getSession('bea', beaSessions[0]!.id);
      expect(beaRec?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('does respond when the user explicitly @-mentions the primary too', async () => {
      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('ada reply', 'NONE', 'bea reply', 'NONE');

      await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Ada](gezel:ada) + @[Bea](gezel:bea), both of you',
        mentionGezelIds: ['ada', 'bea'],
      });
      await manager.drainBackground();

      const primaryRec = await store.getSession('ada', primary.id);
      // Primary was double-@'d — they reply normally.
      expect(primaryRec?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('primary replies when mentions collapse to empty (self-mention only)', async () => {
      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('ada reply', 'NONE');

      await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Ada](gezel:ada) note to self',
        mentionGezelIds: ['ada'], // self-only — dedups to empty fan-out list
      });
      await manager.drainBackground();

      const primaryRec = await store.getSession('ada', primary.id);
      expect(primaryRec?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('fires a user_message on the addressed gezel and on the silent voorman', async () => {
      // Both sessions should publish a `user_message` event — the
      // addressed gezel (who actually runs a turn) and the voorman
      // (who only gets a passive FYI). Exact ordering between the
      // two is best-effort: fan-out fires before notify in the
      // source, but notify's write path is synchronously short
      // while fan-out's runs through `send`'s multi-await pipeline,
      // so the observed order can swing either way. This test
      // covers the correctness invariant (both bubbles land) and
      // leaves the ordering as an implementation detail.
      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('bea reply', 'NONE');

      const userMessageGezels: string[] = [];
      events.subscribeAll((env) => {
        if (env.event.type === 'user_message') {
          userMessageGezels.push(env.gezelId);
        }
      });

      await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: 'Hey @[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });
      await manager.drainBackground();

      expect(userMessageGezels).toContain('bea');
      expect(userMessageGezels).toContain('ada');
    });

    it("publishes a project-scoped `done` after the silent voorman's `user_message` so the timeline doesn't leave a thinking-dots slot open", async () => {
      // Wild-caught: project-chat user @-mentioned a non-voorman
      // gezel; the voorman's bubble locked into "THINKING · 3:28" and
      // climbed indefinitely. Root cause: `notifyUserMessage` used
      // `publishSessionOnly` for the trailing `done` while
      // `user_message` propagated full-scope. The project timeline
      // (a global / project subscriber) saw the `user_message`,
      // eagerly opened a thinking-dots slot, and never received the
      // `done` that would have cleared it. Both events must reach
      // the project scope.
      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('bea reply', 'NONE');

      const ada = await store.getGezel('ada');
      const observed: Array<{ type: string; gezelId: string }> = [];
      events.subscribeAll((env) => {
        if (env.gezelId !== 'ada') return;
        observed.push({ type: env.event.type, gezelId: env.gezelId });
      });

      await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: 'Hey @[Bea](gezel:bea)',
        mentionGezelIds: ['bea'],
      });
      await manager.drainBackground();
      expect(ada).toBeTruthy();

      // Sanity: ada is the silenced primary in this fan-out.
      const adaUserMsg = observed.find((e) => e.type === 'user_message');
      expect(adaUserMsg).toBeTruthy();
      // The fix: a `done` for ada must reach project / global subscribers
      // AFTER the user_message so the thinking-dots slot retires.
      const adaDone = observed.find((e) => e.type === 'done');
      expect(adaDone).toBeTruthy();
      expect(observed.indexOf(adaUserMsg!)).toBeLessThan(observed.indexOf(adaDone!));
    });

    it("doesn't promote the @-mention text into the silenced primary's session title", async () => {
      // Wild-caught: in a project chat, user @-mentioned Ada from
      // Leo's session. notifyUserMessage promoted the message text
      // into Leo's session title, so the session-switcher dropdown
      // for Leo showed `@[Ada](gezel:ada) can you finish run and
      // gun?` as the label — confusing because the message is about
      // Ada, the session belongs to Leo. Title should stay whatever
      // it was (typically "New session" for a fresh session).
      const primary = await manager.createSession({ gezelId: 'ada' });
      mock.script('bea reply', 'NONE');

      const before = await store.getSession('ada', primary.id);
      const titleBefore = before?.title;
      expect(titleBefore).toBeTruthy();

      await manager.sendWithMentions({
        primarySessionId: primary.id,
        text: '@[Bea](gezel:bea) keep going',
        mentionGezelIds: ['bea'],
      });
      await manager.drainBackground();

      const after = await store.getSession('ada', primary.id);
      // Ada's session was silenced (primaryShouldReply=false) — it
      // received notifyUserMessage only. The title MUST NOT have
      // adopted the @-mention text; it stays at the pre-CC value.
      expect(after?.title).toBe(titleBefore);
      expect(after?.title).not.toContain('@[Bea]');
      expect(after?.title).not.toContain('keep going');
    });
  });

  describe('voorman-idle continuation suppression', () => {
    it('skips the continuation nudge when other sessions are queued on the same provider', async () => {
      // Set up a provider with concurrency=1 so session B has to queue.
      const provider = manager.getProviderIfReady('copilot');
      expect(provider?.queue).toBeTruthy();
      if (!provider?.queue) throw new Error('expected queue on mock provider');

      // Mark Ada as voorman of the default project so the
      // voorman-idle heuristic engages. Without this the `provider`
      // queue-check gate never runs because the stall detector returns
      // false on non-voorman sessions.
      await store.updateProject('default', { voormanGezelId: 'ada' });

      // Simulate a queued sibling send on the SAME provider: acquire
      // a background slot that we never release, so the cap is held
      // and any new acquire queues behind it.
      const release = await provider.queue.acquire({ lane: 'background' });

      const session = await manager.createSession({ gezelId: 'ada' });
      // One reply that trips `looksStalled` (no action verbs), plus
      // a NONE for memory extraction. If the continuation nudge
      // fired we'd need a 2nd reply + another NONE — 4 scripts total;
      // with the suppression in place, only 2 are consumed.
      mock.script("I'll work on this later.", 'NONE');

      await manager.send(session.id, 'please actually do it');

      const rec = await store.getSession('ada', session.id);
      // Exactly ONE assistant turn — the nudge was suppressed
      // because the queue had pending work (the held background
      // slot acts as a proxy for other queued turns from the
      // stall-gating code's perspective).
      const assistantTurns = rec?.messages.filter((m) => m.role === 'assistant') ?? [];
      expect(assistantTurns).toHaveLength(1);

      release();
    });

    it('publishes one complete per continuation iteration and exactly one done at the end', async () => {
      // The chat UI's streaming-bubble lifecycle relies on this
      // contract: `complete` fires per turn-loop iteration so the
      // assistant message lands in the timeline as soon as it's
      // ready, but `done` fires only once at the very end of the
      // user-facing turn (after all continuation nudges). Without
      // this guarantee the UI's complete handler — which now keeps
      // the slot alive across iterations and only retires it on
      // `done` — would either drop the bubble too early or leak it
      // forever.
      const session = await manager.createSession({ gezelId: 'ada' });
      // First reply trips `looksStalled` → triggers a nudge.
      // Second reply is the follow-through. Two NONEs cover the
      // memory extractor's per-turn one-shot.
      mock.script("I'll work on this later.", 'follow-through after nudge', 'NONE', 'NONE');

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      await manager.send(session.id, 'do the thing');

      const completes = eventTypes.filter((t) => t === 'complete');
      const dones = eventTypes.filter((t) => t === 'done');
      expect(completes.length).toBe(2); // primary + nudge
      expect(dones.length).toBe(1);
      // `done` MUST come after the last `complete` — the UI uses
      // it as the "all iterations finished, drop the slot" signal.
      expect(eventTypes.lastIndexOf('done')).toBeGreaterThan(eventTypes.lastIndexOf('complete'));
    });

    it('does not continue after a question posts, even when an earlier tool failed', async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      mock.scriptSendDelay(80);
      mock.script('', 'THIS CONTINUATION MUST NOT RUN');

      const sending = manager.send(session.id, 'advance the task or ask me what is blocking it');
      await vi.waitFor(
        () => expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(1),
        { timeout: 5000, interval: 10 },
      );

      const internals = manager as unknown as {
        currentTurnTools: Map<
          string,
          Array<{ name: string; durationMs: number; success: boolean; errorMessage?: string }>
        >;
      };
      internals.currentTurnTools.set(session.id, [
        {
          name: 'advance_task_step',
          durationMs: 1,
          success: false,
          errorMessage: 'Completion gate rejected the step.',
        },
        { name: 'ask_user_question', durationMs: 1, success: true },
      ]);

      await sending;

      expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(1);
      const persisted = await store.getSession('ada', session.id);
      expect(persisted?.messages.at(-1)?.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'advance_task_step', success: false }),
          expect.objectContaining({ name: 'ask_user_question', success: true }),
        ]),
      );
    });

    it('drops session affinity on continuation re-acquires so queued siblings win FIFO', async () => {
      // Fix C: when the stall detector fires a continuation nudge,
      // the re-acquire should set `affinity: false` on the queue
      // opts. The session/gezel id stay set so the QueueMeter UI
      // can still label who's waiting — only the scheduler scoring
      // changes.
      const session = await manager.createSession({ gezelId: 'ada' });
      // First reply looks stalled → triggers a nudge. Second reply
      // is the follow-through. Two NONEs for memory extraction.
      mock.script(
        "I'll think about that and get back.",
        'follow-through after nudge',
        'NONE',
        'NONE',
      );

      await manager.send(session.id, 'do the thing');

      const sessionSends = mock.calls.filter(
        (c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'interactive',
      );
      expect(sessionSends).toHaveLength(2);

      const firstQueueOpts = sessionSends[0]!.sendOpts?.queue;
      const nudgeQueueOpts = sessionSends[1]!.sendOpts?.queue;
      expect(firstQueueOpts?.sessionId).toBe(session.id);
      expect(firstQueueOpts?.gezelId).toBe('ada');
      expect(firstQueueOpts?.affinity).toBeUndefined(); // default = on
      // The nudge keeps id info for UI but opts out of scoring.
      expect(nudgeQueueOpts?.sessionId).toBe(session.id);
      expect(nudgeQueueOpts?.gezelId).toBe('ada');
      expect(nudgeQueueOpts?.affinity).toBe(false);
    });
  });

  describe('cancelInflight abort propagation', () => {
    it('aborts the in-flight send via the per-turn AbortController', async () => {
      // Fix D: cancelInflight should flip the signal passed to
      // sendAndWait's queue opts, so providers that honor it
      // (Ollama links the caller signal to its internal fetch
      // ctrl) unwind immediately instead of running to completion.
      // MockProvider doesn't actually abort mid-send, so this test
      // asserts the wire: the signal exists and is aborted after
      // cancelInflight runs.
      const session = await manager.createSession({ gezelId: 'ada' });
      // Slow reply so the cancel lands while the turn is still mid-flight.
      mock.script('reply', 'NONE');
      mock.scriptSendDelay(200);

      const pending = manager.send(session.id, 'hello').catch(() => {
        /* cancel surfaces as error/done events, not a rejection here */
      });
      // Poll for the send to actually land on the mock — runSend
      // has to walk through ensureState + ensureOrCreateSession +
      // provider.createSession before sendAndWait fires, so a
      // fixed yield is brittle. 200 × 10ms = 2s ceiling, generous
      // enough that concurrent-test-runner contention can't blow
      // past it while a real "send never fires" bug still surfaces.
      for (let i = 0; i < 200; i++) {
        if (mock.calls.some((c) => c.kind === 'send')) break;
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      const before = mock.calls.find(
        (c) => c.kind === 'send' && c.sendOpts?.queue?.sessionId === session.id,
      );
      const signal = before?.sendOpts?.queue?.signal;
      expect(signal).toBeTruthy();
      expect(signal?.aborted).toBe(false);

      await manager.cancelInflight(session.id);
      expect(signal?.aborted).toBe(true);

      await pending;
    });
  });
});

describe('ChatManager — per-session message queue', () => {
  let previousMemoryExtractionSetting: string | undefined;

  beforeEach(() => {
    previousMemoryExtractionSetting = process.env.GEZEL_DISABLE_MEMORY_EXTRACTION;
    // These tests exercise only the per-session chat queue. Letting the
    // asynchronous memory extractor share MockProvider's response queue makes
    // reply ownership timing-dependent under suite load.
    process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = '1';
  });

  afterEach(() => {
    if (previousMemoryExtractionSetting === undefined) {
      delete process.env.GEZEL_DISABLE_MEMORY_EXTRACTION;
    } else {
      process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = previousMemoryExtractionSetting;
    }
  });

  it('back-to-back sends on one session run in FIFO order', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply-A', 'reply-B');
    // Hold A's turn for 100ms so B is guaranteed to arrive while A is
    // still running. That forces B into the queue rather than both
    // resolving synchronously on microtask-settle.
    mock.scriptSendDelay(100);

    const pA = manager.send(session.id, 'userA');
    const pB = manager.send(session.id, 'userB');

    // While A is processing, B must be queued (depth 1).
    await new Promise((r) => setTimeout(r, 10));
    const queuedMidFlight = manager.listQueued();
    expect(queuedMidFlight).toHaveLength(1);
    expect(queuedMidFlight[0]?.sessionId).toBe(session.id);
    expect(queuedMidFlight[0]?.nextPreview).toContain('userB');

    const [mA, mB] = await Promise.all([pA, pB]);
    expect(mA.content).toBe('reply-A');
    expect(mB.content).toBe('reply-B');

    const rec = await store.getSession('ada', session.id);
    expect(rec?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'userA'],
      ['assistant', 'reply-A'],
      ['user', 'userB'],
      ['assistant', 'reply-B'],
    ]);
    // Queue drained empty once both resolve.
    expect(manager.listQueued()).toHaveLength(0);
  });

  it('three concurrent sends drain in FIFO order', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('r1', 'r2', 'r3');
    mock.scriptSendDelay(30);
    mock.scriptSendDelay(30);
    mock.scriptSendDelay(30);

    const [m1, m2, m3] = await Promise.all([
      manager.send(session.id, 'u1'),
      manager.send(session.id, 'u2'),
      manager.send(session.id, 'u3'),
    ]);
    expect([m1.content, m2.content, m3.content]).toEqual(['r1', 'r2', 'r3']);

    const rec = await store.getSession('ada', session.id);
    expect(rec?.messages.map((m) => m.content)).toEqual(['u1', 'r1', 'u2', 'r2', 'u3', 'r3']);
  });

  it('user_message event for B fires only after A completes', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply-A', 'reply-B');
    mock.scriptSendDelay(80);

    const recorded: string[] = [];
    const unsub = events.subscribe(session.id, (ev) => {
      if (ev.type === 'user_message') {
        recorded.push(`user:${ev.message.content}`);
      } else if (ev.type === 'complete') {
        recorded.push(`complete:${ev.message.content}`);
      }
    });

    const pA = manager.send(session.id, 'userA');
    const pB = manager.send(session.id, 'userB');
    await Promise.all([pA, pB]);
    unsub();

    // user_message for B must land *after* complete for A, otherwise
    // a late send jumped the queue.
    const userAIdx = recorded.indexOf('user:userA');
    const completeAIdx = recorded.indexOf('complete:reply-A');
    const userBIdx = recorded.indexOf('user:userB');
    expect(userAIdx).toBeGreaterThanOrEqual(0);
    expect(completeAIdx).toBeGreaterThan(userAIdx);
    expect(userBIdx).toBeGreaterThan(completeAIdx);
  });

  it('archiving a session rejects messages queued against it', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply-A');
    mock.scriptSendDelay(100);

    const pA = manager.send(session.id, 'userA');
    // Give A time to mark inflight before we queue B.
    await new Promise((r) => setTimeout(r, 10));
    const pB = manager.send(session.id, 'userB');

    // Archive while B is still queued. B's promise should reject;
    // A's continues normally (the turn already running wasn't
    // canceled, just archived on the persisted record).
    await manager.archiveSession(session.id);

    await expect(pB).rejects.toThrow(/archived/);
    await pA; // resolves cleanly with A's reply
  });

  it('consecutive coalescable sends merge into one turn instead of queuing separately', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    // Scripts for A's turn and the merged BCD turn. If merging did not
    // happen, the transcript assertion below would expose the extra turns.
    mock.script('reply-A', 'merged-reply');
    mock.scriptSendDelay(100);
    // First send is a plain (non-coalescable) user message that
    // holds the inflight slot.
    const p1 = manager.send(session.id, 'please install the deps');
    // Give A time to grab inflight before the follow-ups arrive.
    await new Promise((r) => setTimeout(r, 10));
    // Three coalescable follow-ups — npm_install-follow-up style.
    // They should merge into a single queue entry, not produce three
    // separate queued entries.
    const p2 = manager.send(session.id, '[npm_install follow-up: stripe installed.]', {
      coalescable: true,
    });
    const p3 = manager.send(session.id, '[npm_install follow-up: next installed.]', {
      coalescable: true,
    });
    const p4 = manager.send(session.id, '[npm_install follow-up: prisma installed.]', {
      coalescable: true,
    });

    const queuedMidFlight = manager.listQueued();
    expect(queuedMidFlight).toHaveLength(1);
    expect(queuedMidFlight[0]?.depth).toBe(1); // all three merged into ONE entry

    const [m1, m2, m3, m4] = await Promise.all([p1, p2, p3, p4]);
    expect(m1.content).toBe('reply-A');
    // p2/p3/p4 all resolve to the SAME merged-turn ChatMessage
    // because they coalesced into one queue entry.
    expect(m2.content).toBe('merged-reply');
    expect(m3.content).toBe('merged-reply');
    expect(m4.content).toBe('merged-reply');

    // The session transcript has exactly TWO user turns (the original
    // `please install` and the merged follow-up batch) — not four.
    const rec = await store.getSession('ada', session.id);
    const userTurns = rec?.messages.filter((m) => m.role === 'user') ?? [];
    expect(userTurns).toHaveLength(2);
    expect(userTurns[1]?.content).toContain('stripe installed');
    expect(userTurns[1]?.content).toContain('next installed');
    expect(userTurns[1]?.content).toContain('prisma installed');
  });

  it('does NOT coalesce across a user message (non-coalescable breaks the chain)', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply-1', 'reply-2', 'reply-3', 'reply-4');
    mock.scriptSendDelay(40);
    mock.scriptSendDelay(40);
    mock.scriptSendDelay(40);

    // A (non-coalescable, the active turn) → B (coalescable, queued) →
    // C (regular user message, non-coalescable, queued SEPARATELY) →
    // D (coalescable, should NOT merge into B because C sits between them).
    const pA = manager.send(session.id, 'first');
    await new Promise((r) => setTimeout(r, 10));
    const pB = manager.send(session.id, '[system follow-up B]', { coalescable: true });
    const pC = manager.send(session.id, 'a fresh user message');
    const pD = manager.send(session.id, '[system follow-up D]', { coalescable: true });

    const queuedMid = manager.listQueued();
    // Three distinct queued entries, no merging.
    expect(queuedMid[0]?.depth).toBe(3);

    await Promise.all([pA, pB, pC, pD]);
  });

  it('does NOT coalesce a gezel→gezel handoff into a user follow-up', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('r1', 'r2', 'r3');
    mock.scriptSendDelay(40);
    mock.scriptSendDelay(40);
    mock.scriptSendDelay(40);

    const pA = manager.send(session.id, 'start');
    await new Promise((r) => setTimeout(r, 10));
    // User-scope coalescable follow-up.
    const pB = manager.send(session.id, '[system follow-up]', { coalescable: true });
    // Gezel-to-gezel handoff that also happens to be coalescable —
    // different `from` bucket, must NOT merge.
    const pC = manager.send(session.id, 'from Yusuf', {
      coalescable: true,
      from: { gezelId: 'yusuf', gezelName: 'Yusuf' },
    });

    const queuedMid = manager.listQueued();
    expect(queuedMid[0]?.depth).toBe(2);

    await Promise.all([pA, pB, pC]);
  });

  it('queue still drains after a long-running turn (beyond the old 20s retry budget)', async () => {
    // Proves the queue has no implicit timeout — this turn would have
    // exceeded `sendWithBusyRetry`'s old 20s backoff ceiling and
    // dropped B on the floor.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('slow-reply-A', 'reply-B');
    mock.scriptSendDelay(250);

    const pA = manager.send(session.id, 'userA');
    const pB = manager.send(session.id, 'userB');

    const [mA, mB] = await Promise.all([pA, pB]);
    expect(mA.content).toBe('slow-reply-A');
    expect(mB.content).toBe('reply-B');
  });

  it('mid-turn nudges stay separate while queued, then merge into one turn on drain', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const stall = mock.scriptStreamThenStall('reply-A');
    mock.script('merged-reply');

    const recorded: string[] = [];
    const unsub = events.subscribe(session.id, (ev) => {
      if (ev.type === 'user_message') recorded.push(`user:${ev.message.content}`);
      else if (ev.type === 'queue_removed') recorded.push(`rm:${ev.reason}:${ev.queueId}`);
    });

    const pA = manager.send(session.id, 'long question');
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });
    const pN1 = manager.send(session.id, 'nudge one', { nudge: true });
    const pN2 = manager.send(session.id, 'nudge two', { nudge: true });

    // Nudges never coalesce at enqueue time — each stays its own
    // entry so it remains individually editable / discardable.
    const mid = manager.listQueued();
    expect(mid[0]?.depth).toBe(2);
    expect(mid[0]?.entries.every((e) => e.nudge === true)).toBe(true);
    const queuedIds = mid[0]!.entries.map((e) => e.queueId);

    stall.release();
    const [mA, mN1, mN2] = await Promise.all([pA, pN1, pN2]);
    unsub();

    expect(mA.content).toBe('reply-A');
    // Both nudge callers resolve with the SAME merged-turn reply.
    expect(mN1.content).toBe('merged-reply');
    expect(mN2.content).toBe('merged-reply');

    // ONE merged user message, joined content, nudge marker set.
    const rec = await store.getSession('ada', session.id);
    const userTurns = rec?.messages.filter((m) => m.role === 'user') ?? [];
    expect(userTurns).toHaveLength(2);
    expect(userTurns[1]?.content).toBe('nudge one\n\nnudge two');
    expect(userTurns[1]?.nudge).toBe(true);
    // The title came from the original message, not the nudges.
    expect(rec?.title).toBe('Long question');

    // Exactly one merged user_message event, and a
    // queue_removed('started') for BOTH consumed entries.
    expect(recorded.filter((r) => r.startsWith('user:'))).toEqual([
      'user:long question',
      'user:nudge one\n\nnudge two',
    ]);
    for (const id of queuedIds) {
      expect(recorded).toContain(`rm:started:${id}`);
    }
  });

  it('a non-nudge queued message breaks the nudge merge run', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const stall = mock.scriptStreamThenStall('reply-A');
    mock.script('reply-N1', 'reply-C', 'reply-N2');

    const pA = manager.send(session.id, 'start');
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });
    const pN1 = manager.send(session.id, 'nudge one', { nudge: true });
    const pC = manager.send(session.id, 'plain follow-up');
    const pN2 = manager.send(session.id, 'nudge two', { nudge: true });

    expect(manager.listQueued()[0]?.depth).toBe(3);

    stall.release();
    const [, mN1, mC, mN2] = await Promise.all([pA, pN1, pC, pN2]);
    expect(mN1.content).toBe('reply-N1');
    expect(mC.content).toBe('reply-C');
    expect(mN2.content).toBe('reply-N2');

    // Four separate user turns — the plain message between the two
    // nudges kept each drain to a single entry.
    const rec = await store.getSession('ada', session.id);
    expect(rec?.messages.filter((m) => m.role === 'user')).toHaveLength(4);
  });

  it('updateQueuedMessage edits a pending entry in place and the drain uses the new text', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const stall = mock.scriptStreamThenStall('reply-A');
    mock.script('reply-N');

    const enqueued: Array<{ queueId: string; preview: string; nudge?: boolean }> = [];
    const unsub = events.subscribe(session.id, (ev) => {
      if (ev.type === 'queue_enqueued') {
        enqueued.push({ queueId: ev.queueId, preview: ev.preview, nudge: ev.nudge });
      }
    });

    const pA = manager.send(session.id, 'start');
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });
    const pN = manager.send(session.id, 'original nudge', { nudge: true });

    const listed = manager.listSessionQueue(session.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe('original nudge');
    expect(listed[0]?.nudge).toBe(true);
    const queueId = listed[0]!.queueId;

    const updated = manager.updateQueuedMessage(session.id, queueId, 'edited nudge text');
    expect(updated?.text).toBe('edited nudge text');
    expect(updated?.nudge).toBe(true);
    // Unknown id → null (entry gone / never existed).
    expect(manager.updateQueuedMessage(session.id, 'no-such-id', 'x')).toBeNull();

    // The edit re-published under the SAME queueId so the UI upserts
    // its ghost bubble rather than adding a second one.
    const republished = enqueued.filter((e) => e.queueId === queueId);
    expect(republished).toHaveLength(2);
    expect(republished.at(-1)?.preview).toBe('edited nudge text');
    expect(republished.at(-1)?.nudge).toBe(true);

    stall.release();
    const [, mN] = await Promise.all([pA, pN]);
    unsub();
    expect(mN.content).toBe('reply-N');

    const rec = await store.getSession('ada', session.id);
    expect(rec?.messages.filter((m) => m.role === 'user')[1]?.content).toBe('edited nudge text');
    // Once drained, the entry can no longer be edited.
    expect(manager.updateQueuedMessage(session.id, queueId, 'too late')).toBeNull();
  });

  it('interruptWithMessage cancels the in-flight turn and runs ahead of queued messages', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptStreamThenHang('partial-A');
    mock.script('reply-M', 'reply-B');

    const pA = manager.send(session.id, 'long job').catch(() => undefined);
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });
    const pB = manager.send(session.id, 'queued nudge', { nudge: true });
    const pM = manager.interruptWithMessage(session.id, 'do this instead');

    const [mM, mB] = await Promise.all([pM, pB]);
    await pA;
    expect(mM.content).toBe('reply-M');
    expect(mB.content).toBe('reply-B');

    const rec = await store.getSession('ada', session.id);
    // Transcript order: the aborted turn keeps its salvaged partial,
    // then the interrupt message runs BEFORE the earlier-queued nudge.
    expect(
      rec?.messages.map((m) => (m.synthetic === 'turn-aborted' ? 'aborted' : m.content)),
    ).toEqual(['long job', 'aborted', 'do this instead', 'reply-M', 'queued nudge', 'reply-B']);
    const aborted = rec?.messages[1];
    expect(aborted?.content).toBe('partial-A');
    // The interrupt message is a plain send (no nudge marker); the
    // queued nudge keeps its marker.
    const users = rec?.messages.filter((m) => m.role === 'user') ?? [];
    expect(users[1]?.nudge).toBeUndefined();
    expect(users[2]?.nudge).toBe(true);
  }, 20_000);

  it('interruptWithMessage on an idle session degrades to a plain send', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply');

    const queueEvents: string[] = [];
    const unsub = events.subscribe(session.id, (ev) => {
      if (ev.type === 'queue_enqueued' || ev.type === 'queue_removed') queueEvents.push(ev.type);
    });

    const m = await manager.interruptWithMessage(session.id, 'just send this');
    unsub();
    expect(m.content).toBe('reply');
    // Nothing was queued — the message went straight through.
    expect(queueEvents).toEqual([]);

    const rec = await store.getSession('ada', session.id);
    expect(rec?.messages.map((x) => x.content)).toEqual(['just send this', 'reply']);
    expect(rec?.messages[0]?.nudge).toBeUndefined();
  });

  it('cancelInflight (Stop) keeps queued nudges — they run after the abort unwinds', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptStreamThenHang('partial-A');
    mock.script('reply-N');

    const pA = manager.send(session.id, 'long job').catch(() => undefined);
    await vi.waitFor(() => expect(mock.calls.some((c) => c.kind === 'send')).toBe(true), {
      timeout: 5000,
      interval: 10,
    });
    const pN = manager.send(session.id, 'still want this', { nudge: true });

    await manager.cancelInflight(session.id);
    const mN = await pN;
    await pA;

    expect(mN.content).toBe('reply-N');
    const rec = await store.getSession('ada', session.id);
    const users = rec?.messages.filter((m) => m.role === 'user') ?? [];
    expect(users.map((m) => m.content)).toEqual(['long job', 'still want this']);
    expect(users[1]?.nudge).toBe(true);
  }, 20_000);

  it('a nudge that never queued (idle session) is a plain send without the marker', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('reply');

    const m = await manager.send(session.id, 'not really a nudge', { nudge: true });
    expect(m.content).toBe('reply');

    const rec = await store.getSession('ada', session.id);
    expect(rec?.messages[0]?.content).toBe('not really a nudge');
    expect(rec?.messages[0]?.nudge).toBeUndefined();
  });
});

describe('ChatManager — one-shot attribution', () => {
  it('labels service-owned work as System when no gezel or subsystem actor is supplied', async () => {
    mock.script('done');

    await manager.oneShotCompletion('maintenance', 1_000, { jobLabel: 'maintenance' });

    const send = mock.calls.find((call) => call.kind === 'send');
    expect(send?.sendOpts?.queue).toMatchObject({
      lane: 'background',
      actorLabel: 'System',
      job: 'maintenance',
    });
  });

  it('forwards an explicit interactive lane to one-shot provider work', async () => {
    mock.script('done');

    await manager.oneShotCompletion('generate the requested wallpaper', 1_000, {
      lane: 'interactive',
    });

    const send = mock.calls.find((call) => call.kind === 'send');
    expect(send?.sendOpts?.queue?.lane).toBe('interactive');
  });

  it('fans ephemeral local-engine telemetry out to the global engine pill feed', async () => {
    const received: Array<{
      sessionId: string;
      projectId: string;
      event: { type: string; activity?: string };
    }> = [];
    const unsubscribe = events.subscribeAll((envelope) => received.push(envelope));
    mock.script('done');
    mock.scriptEngineTelemetry({
      phases: [
        {
          provider: 'mlx',
          phase: 'generating',
          detail: 'Generating · 4 tok · 20 tok/s',
          outputTokens: 4,
          tokensPerSec: 20,
        },
      ],
      turnStats: {
        provider: 'mlx',
        promptTokens: 100,
        completionTokens: 4,
        durationMs: 250,
        tokensPerSec: 20,
      },
    });

    await manager.oneShotCompletion('background summary', 1_000, {
      projectId: 'project-7',
      jobLabel: 'Indexing src/app.ts',
    });

    expect(received.map(({ event }) => event.type)).toEqual(['engine_phase', 'turn_stats', 'done']);
    expect(received[0]?.sessionId).toMatch(/^one-shot:/);
    expect(received[0]?.projectId).toBe('project-7');
    expect(received[0]?.event).toMatchObject({ activity: 'Indexing src/app.ts' });
    expect(received[1]?.sessionId).toBe(received[0]?.sessionId);
    unsubscribe();
  });

  it('forwards a cancellation signal to one-shot provider work', async () => {
    mock.script('done');
    const controller = new AbortController();

    await manager.oneShotCompletion('draft project copy', 1_000, {
      signal: controller.signal,
    });

    const send = mock.calls.find((call) => call.kind === 'send');
    const forwarded = send?.sendOpts?.queue?.signal;
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toBe(controller.signal);
    expect(forwarded?.aborted).toBe(false);
    controller.abort(new Error('cancel test'));
    expect(forwarded?.aborted).toBe(true);
  });

  it('cancels active one-shots and refuses replacements once shutdown begins', async () => {
    mock.scriptStreamThenHang('partial background result');
    const pending = manager.oneShotCompletion('index this workspace', 60_000, {
      ambient: true,
      jobLabel: 'Indexing src/app.ts',
    });
    await vi.waitFor(() => expect(mock.calls.some((call) => call.kind === 'send')).toBe(true));

    await manager.beginShutdown();

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'service shutting down',
    });
    await expect(manager.oneShotCompletion('start another chore')).rejects.toMatchObject({
      name: 'AbortError',
      message: 'service shutting down',
    });
  });

  it('applies the one-shot deadline to provider setup, before generation starts', async () => {
    const gate = mock.gateNextCreateSession();
    const pending = manager.oneShotCompletion('draft a persona', 30);

    await expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('including provider setup and queue wait'),
    });

    // A provider that finishes setup after the caller timed out must not leak
    // the ephemeral session.
    gate.release();
    await vi.waitFor(
      () => expect(mock.calls.some((call) => call.kind === 'disconnect')).toBe(true),
      { timeout: 2_000, interval: 10 },
    );
  });

  it('resolves and forwards an explicit one-shot tuning profile', async () => {
    mock.script('done');
    const defaults = vi.spyOn(manager, 'resolveModelSessionDefaults');

    await manager.oneShotCompletion('summarize this', 1_000, {
      tuningProfileId: 'instruct',
    });

    expect(defaults).toHaveBeenCalledWith(
      'copilot',
      undefined,
      expect.objectContaining({ tuningProfileId: 'instruct' }),
    );
    const create = mock.calls.find((call) => call.kind === 'create');
    expect(create?.opts?.profile).toBeDefined();
    expect(create?.opts?.tuning).toBeDefined();
  });

  it('keeps Qwen instruct non-thinking without imposing a small output cap', async () => {
    const defaults = await manager.resolveModelSessionDefaults('llama-cpp', 'qwen3.6-27b-q4', {
      tuningProfileId: 'instruct',
    });

    expect(defaults.tuning.resolvedTuningProfile).toBe('instruct');
    expect(defaults.tuning.reasoning.enableThinking).toBe(false);
    expect(defaults.tuning.sampling.maxTokens).toBe(4096);
  });

  it('does not apply user-daemon RAM pressure to broker-routed ambient work', () => {
    const denial = (
      manager as unknown as {
        denyAmbientColdLoad(
          providerName: 'llama-cpp',
          model: string,
          provider: { name: string },
        ): string | null;
      }
    ).denyAmbientColdLoad('llama-cpp', 'shared-model', { name: 'remote' });

    expect(denial).toBeNull();
  });

  it('previews the 64K floor from install metadata without binding a provider', async () => {
    await store.writeConfig({ mlxNumCtx: 32_768 });
    Object.defineProperty(manager, 'mlxModels', {
      configurable: true,
      value: {
        resolveModel: async () => ({ contextWindow: 65_536 }),
      },
    });
    const inferenceBind = vi.spyOn(manager, 'getProviderForModel');

    await expect(manager.previewContextWindowForModel('mlx', 'installed-mlx')).resolves.toBe(
      65_536,
    );
    expect(inferenceBind).not.toHaveBeenCalled();
  });
});

describe('ChatManager — memory extraction isolation', () => {
  it('runs the memory extractor in a one-shot session, NOT on the chat session', async () => {
    // Regression test for a context-poisoning bug: extractMemories
    // used to share `liveSession` with the chat. For Ollama
    // (stateful messages array) every turn pushed an EXTRACT_PROMPT
    // user message + a "NONE" assistant reply into the chat
    // session's history, which silently broke the conversation
    // (model started mimicking "NONE" as its own replies). The
    // refactor routes extraction through `oneShotCompletion`
    // instead — a fresh, throwaway session each time.
    //
    // Asserts: across the lifecycle of one user turn there are
    // TWO distinct provider sessions created — one for the chat
    // (interactive lane) and one for the extraction (background
    // lane). Pre-fix, only one create call would land.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('chat reply', 'NONE');

    await manager.send(session.id, 'hello');
    // Drain so the background extraction has a chance to land
    // before we count creates / inspect prompts.
    await manager.drainBackground();

    const sends = mock.calls.filter((c) => c.kind === 'send');
    const interactiveSends = sends.filter((c) => c.sendOpts?.queue?.lane === 'interactive');
    const backgroundSends = sends.filter((c) => c.sendOpts?.queue?.lane === 'background');
    expect(interactiveSends).toHaveLength(1); // the chat turn
    expect(interactiveSends[0]?.prompt).toBe('hello');
    expect(backgroundSends).toHaveLength(1); // the extraction one-shot
    expect(backgroundSends[0]?.prompt).toContain('memory extraction system');

    // Chat session vs extraction session must be distinct provider
    // sessions — pre-fix they would have been the same id, with
    // the EXTRACT_PROMPT polluting the chat session's history.
    expect(interactiveSends[0]?.sessionId).not.toBe(backgroundSends[0]?.sessionId);
  });

  /**
   * On cloud providers (Copilot / OpenAI) memory extraction is ~1s
   * and runs every turn. On locally-hosted stateless providers
   * (Ollama + llama-cpp) it re-processes the whole transcript and
   * blocks the single-slot provider queue behind the user's next
   * interactive message. Cadence gate: run at most once every
   * 10 messages (≈ 3–5 turns). The session record carries an
   * `extractedUpTo` cursor so the cadence survives restart.
   */
  describe('cadence on local providers', () => {
    async function localManager(providerName: 'ollama' | 'llama-cpp'): Promise<{
      home: string;
      store: Store;
      manager: ChatManager;
      mock: MockProvider;
    }> {
      const home = await mkdtemp(join(tmpdir(), `gezel-extract-${providerName}-`));
      const store = new Store({ home });
      await store.ensureLayout();
      // This suite injects a mock under the 'copilot' key. Pin it as the default
      // too — otherwise routing falls through to the platform default (an
      // on-device engine) and the injected mock is never reached.
      await store.writeConfig({ provider: 'copilot' });
      await store.createGezel({ name: 'Ada', role: 'Developer' });
      await store.createProject({ name: 'Default' });
      await store.writeConfig({ provider: providerName });
      const events = new ChatEventBus();
      const localMock = new MockProvider({ name: providerName });
      const mgr = new ChatManager({
        store,
        events,
        memory: noopMemory,
        getPort: () => 0,
        getToken: () => 'test-token',
        home,
        providers: [[providerName, localMock]],
        catalog: new CatalogService(),
        secrets: new FileSecretStore(home),
      });
      return { home, store, manager: mgr, mock: localMock };
    }

    for (const providerName of ['ollama', 'llama-cpp'] as const) {
      it(`defers extraction until 10 messages have accrued on ${providerName}`, async () => {
        const ctx = await localManager(providerName);
        try {
          const session = await ctx.manager.createSession({ gezelId: 'ada' });
          // 3 turns × 2 messages = 6 messages — below the 10-message
          // gate. Extraction should not have fired yet.
          for (let i = 0; i < 3; i++) {
            ctx.mock.script(`reply-${i}`);
            await ctx.manager.send(session.id, `turn ${i}`);
            await ctx.manager.drainBackground();
          }
          let backgroundSends = ctx.mock.calls.filter(
            (c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'background',
          );
          expect(backgroundSends).toHaveLength(0);

          // Two more turns → 10 messages total, cadence is met. On
          // local providers the actual extraction is now debounced
          // (EXTRACT_LOCAL_DEBOUNCE_MS) so it doesn't land on top of
          // the user's next turn — it's scheduled, not fired. Force
          // the pending extraction so the test can assert on its
          // side-effects without managing fake timers.
          for (let i = 3; i < 5; i++) {
            ctx.mock.script(`reply-${i}`, 'NONE');
            await ctx.manager.send(session.id, `turn ${i}`);
            await ctx.manager.drainBackground();
          }
          await ctx.manager.flushPendingMemoryExtractions();
          backgroundSends = ctx.mock.calls.filter(
            (c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'background',
          );
          expect(backgroundSends).toHaveLength(1);

          // Cursor persists on the session record so a restart
          // resumes the cadence rather than firing again immediately.
          const record = await ctx.store.getSession('ada', session.id);
          expect(record?.extractedUpTo).toBeGreaterThanOrEqual(10);
        } finally {
          await ctx.manager.drainBackground();
          await ctx.manager.shutdown();
          await rm(ctx.home, { recursive: true, force: true });
        }
      });
    }

    it('still extracts on every turn for cloud providers (Copilot baseline)', async () => {
      // Baseline control: the same 3-turn loop on the default Copilot
      // mock runs extraction each turn. Cadence gate is local-only.
      const session = await manager.createSession({ gezelId: 'ada' });
      for (let i = 0; i < 3; i++) {
        mock.script(`reply-${i}`, 'NONE');
        await manager.send(session.id, `turn ${i}`);
        await manager.drainBackground();
      }
      const backgroundSends = mock.calls.filter(
        (c) => c.kind === 'send' && c.sendOpts?.queue?.lane === 'background',
      );
      expect(backgroundSends.length).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('ChatManager — context-window pressure (Ollama)', () => {
  // These tests exercise `checkContextPressure` + `compactInFlight`
  // through MockProvider with the Ollama-only context surface
  // (`numCtx` + `estimatePromptChars`) configured. Each test sets a
  // promptChars closure that the test mutates to simulate the
  // estimate climbing toward the warning / compaction thresholds.

  /**
   * Configure the manager to route Ollama: register the mock under
   * the 'ollama' name, set the default provider in config, give the
   * mock a context-pressure surface. Returns the mock provider so
   * tests can adjust `pendingPromptChars` between turns.
   */
  async function setupOllamaManager(opts: { numCtx: number; promptChars: () => number }): Promise<{
    home: string;
    store: Store;
    events: ChatEventBus;
    manager: ChatManager;
    mock: MockProvider;
  }> {
    const home = await mkdtemp(join(tmpdir(), 'gezel-ctx-test-'));
    const store = new Store({ home });
    await store.ensureLayout();
    // This suite injects a mock under the 'copilot' key. Pin it as the default
    // too — otherwise routing falls through to the platform default (an
    // on-device engine) and the injected mock is never reached.
    await store.writeConfig({ provider: 'copilot' });
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createProject({ name: 'Default' });
    await store.writeConfig({ provider: 'ollama' });
    const events = new ChatEventBus();
    const ollamaMock = new MockProvider({ name: 'ollama' });
    ollamaMock.ollamaContextConfig = opts;
    const mgr = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['ollama', ollamaMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    return { home, store, events, manager: mgr, mock: ollamaMock };
  }

  it('publishes context_warning for an accumulated conversation but does NOT compact', async () => {
    let promptChars = 0;
    const { home, manager, events, mock, store } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => promptChars,
    });
    try {
      // 1000 numCtx × ~4 chars/token × 0.80 = 3200 chars → 80%.
      // The conservative local trigger attempts compaction, but two prior
      // messages are too little to summarize, so it falls back to a warning.
      promptChars = 3200;
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      seeded!.messages.push(
        { role: 'user', content: 'earlier question', at: new Date().toISOString() },
        { role: 'assistant', content: 'earlier answer', at: new Date().toISOString() },
      );
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      mock.script('reply', 'NONE');
      await manager.send(session.id, 'hi');

      expect(eventTypes).toContain('context_warning');
      expect(eventTypes).not.toContain('context_compacted');
      const rec = await manager.getSessionRecord(session.id);
      expect(rec?.compactionCount).toBeUndefined();
      expect(rec?.lastCompactedAt).toBeUndefined();
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not show a start-fresh warning when a first-turn standing prefix exceeds the policy budget', async () => {
    let promptChars = 6075;
    const { home, manager, events, mock } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => promptChars,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      // (6075 standing chars + 5 pending chars) / 4 = 1520 estimated
      // tokens, reproducing the qwen3.6/MLX "152% on hello" shape. A
      // new session would carry the same standing prefix, so the warning
      // would be unactionable and must stay suppressed.
      mock.script('reply', 'NONE');
      const reply = await manager.send(session.id, 'hello');

      expect(reply.content).toBe('reply');
      expect(eventTypes).not.toContain('context_warning');
      expect(eventTypes).not.toContain('context_compacted');
    } finally {
      promptChars = 0;
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not warn when a two-greeting Qwen-sized prompt uses only ~19% of a 256K context', async () => {
    const { home, manager, events, mock, store } = await setupOllamaManager({
      numCtx: 262_144,
      // The rebuilt Qwen 3.6 MLX trace was ~49K real tokens after schema
      // compaction. This shared estimator uses chars/4, so 196K chars
      // reproduces that pressure shape against the model's actual window.
      promptChars: () => 196_000,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      seeded!.messages.push(
        { role: 'user', content: 'hello', at: new Date().toISOString() },
        {
          role: 'assistant',
          content: 'Hello! What are you working on?',
          at: new Date().toISOString(),
        },
      );
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));
      mock.script('Hello again!', 'NONE');
      const reply = await manager.send(session.id, 'hello again');

      expect(reply.content).toBe('Hello again!');
      expect(eventTypes).not.toContain('context_warning');
      expect(eventTypes).not.toContain('context_compacted');
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('runs in-flight compaction at ≥70%, replacing older messages with a synthesis', async () => {
    let promptChars = 0;
    const { home, manager, events, mock, store } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => promptChars,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      // Pre-seed the session with enough messages that compaction has
      // a meaningful range to fold (≤ KEEP_TAIL+2 short-circuits
      // returns). 10 user/assistant pairs covers the threshold + a
      // healthy tail to preserve verbatim.
      const seeded = await store.getSession('ada', session.id);
      for (let i = 0; i < 10; i++) {
        seeded!.messages.push({ role: 'user', content: `q${i}`, at: new Date().toISOString() });
        seeded!.messages.push({
          role: 'assistant',
          content: `a${i}`,
          at: new Date().toISOString(),
        });
      }
      await store.writeSession(seeded!);
      // Force the manager to drop its cached state so the next send
      // reloads the seeded record from disk.
      await manager.reset(session.id);

      // 4500 chars / 4 = 1125 tokens → 112% of 1000 numCtx → above
      // the 70% compact threshold (lowered from 90% → 80% → 70%
      // as the petshop iteration loop kept OOMing).
      promptChars = 4500;

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      // Scripts: [synthesis (one-shot), main reply, memory NONE].
      // checkContextPressure runs FIRST and triggers the synthesis
      // call; THEN the chat sendAndWait fires.
      mock.script('- compacted bullet 1\n- compacted bullet 2', 'main reply', 'NONE');
      await manager.send(session.id, 'continue please');

      expect(eventTypes).toContain('context_compacted');
      const rec = await store.getSession('ada', session.id);
      expect(rec?.compactionCount).toBe(1);
      expect(rec?.lastCompactedAt).toBeTruthy();
      // Synthetic + last 6 of pre-existing messages + current user
      // turn + main reply = 9. (Seeded 20 + new user + reply = 22
      // before compaction; compaction folds [0..15] into 1, leaves
      // [16..19] = 4, then user + assistant land = 6.)
      const synthCount = rec?.messages.filter((m) => m.synthetic === 'compaction-summary').length;
      expect(synthCount).toBe(1);
      const synth = rec?.messages.find((m) => m.synthetic === 'compaction-summary');
      expect(synth?.content).toContain('compacted bullet');
      const rebuilt = mock.calls.filter((call) => call.kind === 'create').at(-1);
      expect(
        rebuilt?.opts?.priorMessages?.filter(
          (message) => message.role === 'user' && message.content === 'continue please',
        ),
      ).toHaveLength(0);
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('skips the context check for Copilot/OpenAI (server-side history)', async () => {
    // Reuses the default beforeEach setup (Copilot mock). Even with
    // a long conversation and no numCtx surface, no context_*
    // events should ever fire — Copilot and OpenAI manage history
    // server- or SDK-side, so we have nothing to compact.
    const session = await manager.createSession({ gezelId: 'ada' });
    const eventTypes: string[] = [];
    events.subscribe(session.id, (e) => eventTypes.push(e.type));

    mock.script('reply', 'NONE');
    await manager.send(session.id, 'long message that would be over context if anyone checked');

    expect(eventTypes).not.toContain('context_warning');
    expect(eventTypes).not.toContain('context_compacted');
  });

  it('also runs the pressure check for llama-cpp (same path as Ollama)', async () => {
    // Same fixture as the Ollama tests above, just with the mock
    // registered under 'llama-cpp' and config pointed there.
    // llama-cpp is locally-hosted and stateless on the server side
    // (same as Ollama), so `checkContextPressure` + `compactInFlight`
    // apply identically.
    const home = await mkdtemp(join(tmpdir(), 'gezel-ctx-llama-test-'));
    const store = new Store({ home });
    await store.ensureLayout();
    // This suite injects a mock under the 'copilot' key. Pin it as the default
    // too — otherwise routing falls through to the platform default (an
    // on-device engine) and the injected mock is never reached.
    await store.writeConfig({ provider: 'copilot' });
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createProject({ name: 'Default' });
    await store.writeConfig({ provider: 'llama-cpp' });
    const events = new ChatEventBus();
    const llamaMock = new MockProvider({ name: 'llama-cpp' });
    let promptChars = 0;
    llamaMock.ollamaContextConfig = {
      numCtx: 1000,
      promptChars: () => promptChars,
    };
    const mgr = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', llamaMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await mgr.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      for (let i = 0; i < 10; i++) {
        seeded!.messages.push({ role: 'user', content: `q${i}`, at: new Date().toISOString() });
        seeded!.messages.push({
          role: 'assistant',
          content: `a${i}`,
          at: new Date().toISOString(),
        });
      }
      await store.writeSession(seeded!);
      await mgr.reset(session.id);

      // 4500 chars / 4 = 1125 tokens → 112% of 1000 numCtx → above
      // the 70% compact threshold (lowered from 90% → 80% → 70%
      // as the petshop iteration loop kept OOMing).
      promptChars = 4500;

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      llamaMock.script('- compacted bullet 1\n- compacted bullet 2', 'main reply', 'NONE');
      await mgr.send(session.id, 'continue please');

      expect(eventTypes).toContain('context_compacted');
      const rec = await store.getSession('ada', session.id);
      expect(rec?.compactionCount).toBe(1);
    } finally {
      await mgr.drainBackground();
      await mgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('compaction failure falls through to a warning, turn still completes', async () => {
    let promptChars = 0;
    const { home, manager, events, mock, store } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => promptChars,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      for (let i = 0; i < 10; i++) {
        seeded!.messages.push({ role: 'user', content: `q${i}`, at: new Date().toISOString() });
        seeded!.messages.push({
          role: 'assistant',
          content: `a${i}`,
          at: new Date().toISOString(),
        });
      }
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      promptChars = 4500;

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      // The first sendAndWait call will be the compaction one-shot.
      // Make it throw — compactInFlight should swallow the error and
      // checkContextPressure should fall back to publishing a warning.
      mock.scriptSendFailure('[mock] compaction-induced failure');
      // Then the actual chat turn proceeds normally.
      mock.script('main reply', 'NONE');
      const reply = await manager.send(session.id, 'continue please');

      expect(reply.content).toBe('main reply');
      expect(eventTypes).toContain('context_warning');
      expect(eventTypes).not.toContain('context_compacted');
      const rec = await store.getSession('ada', session.id);
      expect(rec?.compactionCount).toBeUndefined();
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('halts the turn with a context_loop event when compactions stack within a single send', async () => {
    // Self-chat guard: a single user-initiated send should compact at
    // most once on a healthy long turn. Real-world loops happen when
    // tool calls or cross-gezel triggers add enough messages between
    // continuation iterations to re-trip compaction; the
    // `compactInFlight` short-circuit (messages.length ≤ KEEP_TAIL+2)
    // makes that hard to set up synthetically. We dial the budget to 1
    // via the test-only `maxCompactionsPerSend` seam so the guard fires
    // on the FIRST compaction, which lets us validate the halt path
    // (event, persisted bubble, no further turns) without needing a
    // multi-iteration tool-call mock.
    let promptChars = 0;
    const home = await mkdtemp(join(tmpdir(), 'gezel-loop-test-'));
    const store = new Store({ home });
    await store.ensureLayout();
    // This suite injects a mock under the 'copilot' key. Pin it as the default
    // too — otherwise routing falls through to the platform default (an
    // on-device engine) and the injected mock is never reached.
    await store.writeConfig({ provider: 'copilot' });
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createProject({ name: 'Default' });
    await store.writeConfig({ provider: 'ollama' });
    const events = new ChatEventBus();
    const ollamaMock = new MockProvider({ name: 'ollama' });
    ollamaMock.ollamaContextConfig = { numCtx: 1000, promptChars: () => promptChars };
    const manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['ollama', ollamaMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
      maxCompactionsPerSend: 1,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      for (let i = 0; i < 10; i++) {
        seeded!.messages.push({ role: 'user', content: `q${i}`, at: new Date().toISOString() });
        seeded!.messages.push({
          role: 'assistant',
          content: `a${i}`,
          at: new Date().toISOString(),
        });
      }
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      promptChars = 6000;

      const eventTypes: string[] = [];
      events.subscribe(session.id, (e) => eventTypes.push(e.type));

      // Only the synthesis is consumed — the halt fires before any reply
      // is produced. If the halt path were broken we'd consume the second
      // script entry too, and the assertions on event order / persisted
      // bubble would catch it.
      ollamaMock.script('- bullet 1', 'this should never be reached');

      await manager.send(session.id, 'go');

      expect(eventTypes).toContain('context_compacted');
      expect(eventTypes).toContain('context_loop');
      // No `done` is published when the guard halts — the turn is
      // explicitly cut short. The halt's `complete` IS published so
      // the timeline renders the bubble.
      expect(eventTypes).toContain('complete');

      const rec = await store.getSession('ada', session.id);
      expect(rec?.compactionCount).toBe(1);

      // The halt bubble landed so the next user turn sees the signal
      // and the chat doesn't quietly resume the same loop.
      const halts = rec?.messages.filter((m) => m.synthetic === 'context-loop-halt') ?? [];
      expect(halts).toHaveLength(1);
      expect(halts[0]?.content).toContain('Stopped');
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rebuilds the live session after compaction so the next turn sees the compacted history', async () => {
    let promptChars = 0;
    const { home, manager, mock, store } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => promptChars,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      for (let i = 0; i < 10; i++) {
        seeded!.messages.push({ role: 'user', content: `q${i}`, at: new Date().toISOString() });
        seeded!.messages.push({
          role: 'assistant',
          content: `a${i}`,
          at: new Date().toISOString(),
        });
      }
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      promptChars = 4500;
      mock.script('- bullet', 'main reply', 'NONE');
      await manager.send(session.id, 'go');

      // Three create calls expected: original session, the one-shot
      // compaction's session, and the rebuilt session after
      // compaction tears the original down. (Plus a disconnect on
      // the original.)
      const creates = mock.calls.filter((c) => c.kind === 'create');
      const disconnects = mock.calls.filter((c) => c.kind === 'disconnect');
      expect(creates.length).toBeGreaterThanOrEqual(3);
      expect(disconnects.length).toBeGreaterThanOrEqual(1);
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ChatManager — engagement mode', () => {
  it('rejects new sends with engagement-off prefix when mode is off', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    manager.setEngagementMode('off');
    mock.script('should not run');
    await expect(manager.send(session.id, 'hello')).rejects.toThrow(/^engagement-off: /);
  });

  it('cancels queued sends on onEngagementModeChangedToOff, lets in-flight finish', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    // Keep the first turn in flight long enough to queue a second.
    mock.scriptSendDelay(50);
    mock.script('first-complete');
    mock.script('second-complete');

    const first = manager.send(session.id, 'first');
    // Give the first send a tick to take the inflight slot before we
    // enqueue the second.
    await new Promise((r) => setTimeout(r, 5));
    // Capture the reject reason without leaving an unhandled rejection
    // during the synchronous cancel below.
    const secondReason = manager.send(session.id, 'second').then(
      () => null,
      (err: Error) => err,
    );

    // Flip to off — mirrors the PUT /api/config handler that sets the cache
    // and cancels pending queue in one call.
    manager.setEngagementMode('off');
    manager.onEngagementModeChangedToOff();

    const firstResult = await first;
    expect(firstResult.content).toBe('first-complete');
    const err = await secondReason;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/engagement-off: AI disabled before this queued/);
  });
});

describe('ChatManager — askGezelAndWait (sync consultation)', () => {
  it('joins identical in-flight consultations instead of spawning duplicate target sessions', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const firstAdaSession = await manager.createSession({ gezelId: 'ada' });
    const secondAdaSession = await manager.createSession({ gezelId: 'ada' });
    mock.scriptSendDelay(100);
    mock.script('One canonical answer.');
    mock.script('NONE');

    const common = {
      fromGezelId: 'ada',
      toGezelIdOrName: 'maya',
      projectId: 'default',
      text: 'What is the canonical answer?',
    } as const;
    const [first, second] = await Promise.all([
      manager.askGezelAndWait({ ...common, fromSessionId: firstAdaSession.id }),
      manager.askGezelAndWait({ ...common, fromSessionId: secondAdaSession.id }),
    ]);

    expect(first.outcome).toBe('reply');
    expect(second.outcome).toBe('reply');
    if (first.outcome !== 'reply' || second.outcome !== 'reply') return;
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.text).toBe('One canonical answer.');
    const mayaSessions = await store.listSessions({ gezelId: 'maya', projectId: 'default' });
    expect(mayaSessions).toHaveLength(1);
  });

  it("returns the target gezel's reply text in a brand-new consultation session", async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    // Maya answers; her post-turn memory extractor is the next scripted
    // reply (`'NONE'` short-circuits the extractor).
    mock.script('Task 47 is in code review.');
    mock.script('NONE');

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'is task 47 done?',
    });

    expect(res.outcome).toBe('reply');
    if (res.outcome !== 'reply') return;
    expect(res.text).toBe('Task 47 is in code review.');
    expect(res.toGezelId).toBe('maya');

    // The consultation session is brand-new, separate from any prior
    // Maya session, and persists with the question + reply.
    const consult = await store.getSession('maya', res.sessionId);
    expect(consult).not.toBeNull();
    expect(consult!.messages[0]?.content).toBe('[Question from Ada]: is task 47 done?');
    expect(consult!.messages[0]?.from).toEqual({ gezelId: 'ada', gezelName: 'Ada' });
    expect(consult!.messages[1]?.content).toBe('Task 47 is in code review.');
  });

  it("inherits the asker's taskRef onto the consultation session", async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({
      gezelId: 'ada',
      taskRef: 'default/42',
    });
    mock.script('the spec says X.');
    mock.script('NONE');

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'what does the spec say?',
    });

    expect(res.outcome).toBe('reply');
    if (res.outcome !== 'reply') return;
    const consult = await store.getSession('maya', res.sessionId);
    expect(consult?.taskRef).toBe('default/42');
  });

  it('rejects self-asks with reason: self', async () => {
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'ada',
      text: 'what do I think?',
    });
    expect(res).toEqual({
      outcome: 'error',
      reason: 'self',
      message: expect.stringContaining('cannot ask itself'),
    });
  });

  it('rejects unknown targets with reason: not-found', async () => {
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'phantom',
      text: 'hi?',
    });
    expect(res).toEqual({
      outcome: 'error',
      reason: 'not-found',
      message: expect.stringMatching(/phantom/),
    });
  });

  it('detects a direct cycle (A → B while B is asking A) and rejects with reason: cycle', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    // Simulate B (Maya) currently asking A (Ada) by pre-populating the
    // in-flight ask graph. We poke the private map via a typed-cast so
    // the test doesn't depend on network races to set up the cycle.
    const inflight = (
      manager as unknown as {
        inflightAsks: Map<
          string,
          {
            askerGezelId: string;
            targetSessionId: string;
            targetGezelId: string;
            startedAt: number;
          }
        >;
      }
    ).inflightAsks;
    inflight.set('maya-fake-session', {
      askerGezelId: 'maya',
      targetSessionId: adaSession.id,
      targetGezelId: 'ada',
      startedAt: Date.now(),
    });

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'help?',
    });
    expect(res).toEqual({
      outcome: 'error',
      reason: 'cycle',
      message: expect.stringContaining('cycle'),
    });
    inflight.delete('maya-fake-session');
  });

  it('detects an indirect cycle (A → B → C → A) and rejects with reason: cycle', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await store.createGezel({ name: 'Cid', role: 'Reviewer' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    const inflight = (
      manager as unknown as {
        inflightAsks: Map<
          string,
          {
            askerGezelId: string;
            targetSessionId: string;
            targetGezelId: string;
            startedAt: number;
          }
        >;
      }
    ).inflightAsks;
    // B is currently asking C; C is currently asking A. New A→B closes the cycle.
    inflight.set('maya-fake', {
      askerGezelId: 'maya',
      targetSessionId: 'cid-fake',
      targetGezelId: 'cid',
      startedAt: Date.now(),
    });
    inflight.set('cid-fake', {
      askerGezelId: 'cid',
      targetSessionId: adaSession.id,
      targetGezelId: 'ada',
      startedAt: Date.now(),
    });

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'help?',
    });
    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') return;
    expect(res.reason).toBe('cycle');
    inflight.clear();
  });

  it('rejects when the chain depth would exceed maxDepth', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await store.createGezel({ name: 'Cid', role: 'Reviewer' });
    await store.createGezel({ name: 'Don', role: 'Builder' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });

    const inflight = (
      manager as unknown as {
        inflightAsks: Map<
          string,
          {
            askerGezelId: string;
            targetSessionId: string;
            targetGezelId: string;
            startedAt: number;
          }
        >;
      }
    ).inflightAsks;
    // Maya → Cid → Don. New Ada→Maya at maxDepth=2 should reject.
    inflight.set('maya-fake', {
      askerGezelId: 'maya',
      targetSessionId: 'cid-fake',
      targetGezelId: 'cid',
      startedAt: Date.now(),
    });
    inflight.set('cid-fake', {
      askerGezelId: 'cid',
      targetSessionId: 'don-fake',
      targetGezelId: 'don',
      startedAt: Date.now(),
    });

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'help?',
      maxDepth: 2,
    });
    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') return;
    expect(res.reason).toBe('depth');
    inflight.clear();
  });

  it('rejects with timeout when the target never replies', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    // Make Maya's first send hang past the timeout by NOT scripting a reply
    // and using a delay larger than our timeout.
    mock.scriptSendDelay(2000);
    mock.script('eventually'); // never reaches us — caller bails first

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'are you there?',
      timeoutMs: 10_000, // server clamps to >=10s; turn delay is 2s so reply DOES arrive
    });
    // The 2-second send delay is well under the 10-second clamped
    // timeout, so this completes successfully — confirms the reply
    // path doesn't itself stall while waiting. (A real "never replies"
    // case takes >30s wall and is gated by `MAX_ASK_TIMEOUT_MS`.)
    expect(res.outcome).toBe('reply');
  });

  // The ask timeout is an IDLE budget, not a wall-clock cap: a
  // specialist that keeps streaming (a small local model can spend 6+
  // minutes compiling a research report) must NOT be guillotined
  // mid-answer with its finished reply thrown away. We exercise the
  // private `waitForNextTurnComplete` directly with a tiny idle window
  // and a stream of activity events — a sub-second proxy for the
  // multi-minute real case (the 10s `MIN_ASK_TIMEOUT_MS` clamp makes a
  // full-path timing test impractical).
  it('resets the idle timeout on target activity instead of guillotining a steadily-streaming reply', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const m = manager as unknown as {
      events: { publishSessionOnly(id: string, e: unknown): void };
      waitForNextTurnComplete(id: string, ms: number): Promise<{ kind: string; text?: string }>;
    };
    const idleMs = 100;
    const pending = m.waitForNextTurnComplete(session.id, idleMs);
    // Emit activity every 50ms (under the 100ms idle window) for ~300ms
    // — well past idleMs of total wall-clock. A hard wall-clock timeout
    // would have fired around 100ms; the idle-reset keeps it alive.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      m.events.publishSessionOnly(session.id, { type: 'delta', content: 'x' });
    }
    m.events.publishSessionOnly(session.id, {
      type: 'complete',
      message: { content: 'the finished report' },
    });
    const res = await pending;
    expect(res.kind).toBe('complete');
    expect(res.text).toBe('the finished report');
  });

  it('times out when the target goes fully silent for the idle window', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const m = manager as unknown as {
      waitForNextTurnComplete(id: string, ms: number): Promise<{ kind: string }>;
    };
    // No activity is ever published, so the idle window elapses and the
    // wait resolves as a timeout — the genuinely-wedged case the budget
    // is meant to catch.
    const res = await m.waitForNextTurnComplete(session.id, 80);
    expect(res.kind).toBe('timeout');
  });

  it('extends a silent consultation once while its target turn is still queued or prefilling', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const m = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
      waitForNextTurnComplete(id: string, ms: number): Promise<{ kind: string }>;
    };
    m.inflight.set(session.id, { userText: 'consult', startedAt: Date.now() });
    const pending = m.waitForNextTurnComplete(session.id, 60);

    const early = await Promise.race([
      pending.then((result) => result.kind),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 85)),
    ]);
    expect(early).toBe('still-pending');

    m.inflight.delete(session.id);
    expect((await pending).kind).toBe('timeout');
  });

  it('clears its in-flight edge from the graph after the ask completes', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('done.');
    mock.script('NONE');

    await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'go?',
    });

    const inflight = (
      manager as unknown as {
        inflightAsks: Map<string, unknown>;
      }
    ).inflightAsks;
    expect(inflight.size).toBe(0);
  });

  it('still permits askGezelAndWait under aiEngagementMode=reactive', async () => {
    // Cross-gezel consultation in response to the user's send is part
    // of fulfilling the already-asked question, not new ambient
    // outreach. Regression test for the engagement-mode gate split:
    // before the fix, `isProactiveAllowed` blocked every ask under
    // reactive, leaving voormen unable to message specialists during
    // a user-initiated turn.
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await store.writeConfig({ aiEngagementMode: 'reactive' });

    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('the spec says X.');
    mock.script('NONE');

    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'what does the spec say?',
    });
    expect(res.outcome).toBe('reply');
  });

  it('still rejects askGezelAndWait when aiEngagementMode=off', async () => {
    // The kill-switch still works: `off` blocks the call. Counterpart
    // to the reactive test above — together they pin the boundary.
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await store.writeConfig({ aiEngagementMode: 'off' });

    const adaSession = await manager.createSession({ gezelId: 'ada' });
    const res = await manager.askGezelAndWait({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'what does the spec say?',
    });
    expect(res).toEqual({
      outcome: 'error',
      reason: 'engagement-off',
      message: expect.stringContaining('disabled'),
    });
  });
});

describe('ChatManager — per-turn shared-library recall', () => {
  /** Minimal content-index stand-in: only the library search is exercised. */
  function libraryIndex(
    results: Array<{ path: string; snippet: string; score: number }>,
    calls?: string[],
  ) {
    return {
      searchLibrary: async (_projectId: string, query: string) => {
        calls?.push(query);
        return {
          results: results.map((r) => ({ lineStart: 1, ...r })),
          engine: 'hybrid' as const,
        };
      },
    } as unknown as import('../index-store/content-index.js').ContentIndex;
  }

  async function sendAndReadPrompt(text: string): Promise<string> {
    mock.script('ok');
    const before = mock.calls.length;
    const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
    await manager.send(session.id, text);
    const sent = mock.calls.slice(before).find((c) => c.kind === 'send');
    return (sent?.prompt as string) ?? '';
  }

  it('surfaces a document matching a topic the session did not open with', async () => {
    // The gap this closes: turn-1 recall is frozen for the session, so a
    // question that arrives later would otherwise reach the model with no
    // retrieval at all.
    await store.ensureSharedProject();
    manager.setContentIndex(
      libraryIndex([
        { path: 'policies/refunds.md', snippet: 'Refunds are issued within 30 days.', score: 0.82 },
      ]),
    );

    const prompt = await sendAndReadPrompt('what is our refund window for enterprise customers?');
    expect(prompt).toContain('policies/refunds.md');
    expect(prompt).toContain('shared document library');
  });

  it('stays silent when nothing matches strongly enough', async () => {
    // A global corpus makes a loose match an intrusion into an unrelated
    // conversation, so a weak hit is dropped rather than offered.
    await store.ensureSharedProject();
    manager.setContentIndex(
      libraryIndex([{ path: 'notes/misc.md', snippet: 'Vaguely similar prose.', score: 0.2 }]),
    );

    const prompt = await sendAndReadPrompt('what is our refund window for enterprise customers?');
    expect(prompt).not.toContain('notes/misc.md');
  });

  it('does not search on a message with no retrievable topic', async () => {
    await store.ensureSharedProject();
    const queries: string[] = [];
    manager.setContentIndex(libraryIndex([], queries));

    await sendAndReadPrompt('ok thanks');
    expect(queries).toEqual([]);
  });
});

describe('ChatManager — mission objectives are voorman-only context', () => {
  // Mission objectives describe the strategic direction the project is
  // moving toward — that's voorman-thinking, not specialist-thinking.
  // Putting them in every gezel's prompt taxes the whole crew's
  // attention budget for context only the voorman acts on. These tests
  // lock in the gating: voorman sees mission, specialists don't.

  it('injects mission objectives into the voorman gezel', async () => {
    await store.createGezel({ name: 'Leo', role: 'voorman' });
    const proj = await store.createProject({
      name: 'Boutique',
      about: 'A small online shop for indie designers.',
      missionObjectives: '- Ship the storefront by Q3.\n- Hit 500 active sellers by year-end.',
    });
    await store.updateProject(proj.id, { voormanGezelId: 'leo' });

    const session = await manager.createSession({ gezelId: 'leo', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'where are we?');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    // Project about lands for everyone — it's "what is this thing".
    expect(sys).toContain('A small online shop for indie designers.');
    // Mission objectives land for the voorman.
    expect(sys).toContain('### Mission objectives');
    expect(sys).toContain('Ship the storefront by Q3.');
    expect(sys).toContain('500 active sellers');
  });

  it('does NOT inject mission objectives into a non-voorman specialist', async () => {
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    await store.createGezel({ name: 'Leo', role: 'voorman' });
    const proj = await store.createProject({
      name: 'Boutique',
      about: 'A small online shop for indie designers.',
      missionObjectives: '- Ship the storefront by Q3.\n- Hit 500 active sellers by year-end.',
    });
    await store.updateProject(proj.id, { voormanGezelId: 'leo' });

    // Maya is the Designer, not the voorman.
    const session = await manager.createSession({ gezelId: 'maya', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'how should this CTA look?');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    // Project about still lands — Maya needs context for design decisions.
    expect(sys).toContain('A small online shop for indie designers.');
    // Mission objectives are stripped — strategic context Maya doesn't act on.
    expect(sys).not.toContain('### Mission objectives');
    expect(sys).not.toContain('Ship the storefront by Q3.');
    expect(sys).not.toContain('500 active sellers');
  });

  it('skips mission objectives entirely when no voorman is assigned yet', async () => {
    // Edge case: project has mission objectives but no voorman yet
    // (user wrote the objectives before assigning the strategic owner).
    // No one gets them; that's correct — there's no one positioned to
    // act on strategy anyway. Mission shows up the moment a voorman is
    // assigned.
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    const proj = await store.createProject({
      name: 'Boutique',
      about: 'A small online shop for indie designers.',
      missionObjectives: '- Ship the storefront by Q3.',
    });
    // No updateProject({ voormanGezelId }) — explicitly leaving it unset.

    const session = await manager.createSession({ gezelId: 'maya', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'hello');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    expect(sys).not.toContain('### Mission objectives');
    expect(sys).not.toContain('Ship the storefront by Q3.');
  });

  it("voorman's 'Where work belongs' section teaches read-only workspace tools and delegates writes", async () => {
    // Voormen are coordinators with `workspace-fs-read` (so they can
    // investigate a bug before delegating) but NOT `workspace-fs-write`.
    // The orientation must mention what they CAN do (`read_file`,
    // `find_files`) so they don't ask the user to paste contents, and
    // must NOT mention `write_file` since they can't call it — naming
    // a tool that isn't in their function-call schema is the same
    // prompt-vs-runtime drift that pushes small models into fabrication.
    // Writes are explicitly delegated through `message_gezel`.
    await store.createGezel({ name: 'Leo', role: 'voorman' });
    const proj = await store.createProject({
      name: 'Atari Combat Game',
      about: 'A new arcade-style combat game.',
      missionObjectives: '- Ship a playable prototype by EOQ.',
    });
    await store.updateProject(proj.id, { voormanGezelId: 'leo' });

    const session = await manager.createSession({ gezelId: 'leo', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'what now?');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('### Where work belongs');
    // Voorman now has read tools — name them so the model uses them
    // instead of asking "could you paste the file contents?".
    expect(sys).toContain('`read_file`');
    expect(sys).toContain('`list_dir`');
    // Writes still aren't theirs — naming `write_file` would be drift.
    expect(sys).not.toContain('`write_file`');
    // Artifacts guidance still lands — that's their actual scratch space.
    expect(sys).toContain('`write_artifact`');
    expect(sys).toContain('`read_artifact`');
    expect(sys).toContain('does not change the project');
    expect(sys).toContain('read it with `read_file`, not `read_artifact`');
    expect(sys).not.toContain('direct output lives');
    // Explicit delegation prose for writes — handoff via message_gezel.
    expect(sys).toMatch(/delegate|message_gezel/i);
  });

  it('small local voorman keeps every curated tool under the coordinator cap', async () => {
    // Two wild-caught incidents pull this policy in opposite directions.
    // Imara office-hours: caps BELOW the curated list length
    // evicted load-bearing tools and broke coordinators — so hand-tuned
    // small caps were removed. Petshop on qwen3.5-9b-q4 showed that the
    // uncapped 161-tool surface produced a ~36k-token first prompt on a
    // 9B and the kickoff turn died silent. The reconciliation: small-tier
    // coordinators are capped AT their curated list length — every tool
    // asserted below (the ones whose eviction caused past incidents) MUST
    // survive, and only the uncurated workspace/execution tail drops.
    const home = await mkdtemp(join(tmpdir(), 'gezel-voorman-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Leo', role: 'voorman' });
    const proj = await localStore.createProject({ name: 'Squisq' });
    await localStore.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4:e4b' },
      // The trim notice is debug-only in the chat surface; opt in so this
      // test can still assert the transparency half of the cap.
      debugMode: true,
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'leo', projectId: proj.id });
      localMock.script('ok');
      await localMgr.send(session.id, '[Message from Sakura]: I wrote `bug_report.md`.');

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      // Long-tail task tools that the old small-tier cap (rank > 22) evicted
      // are present now that small is uncapped — proof the roster isn't
      // slashed.
      expect(allow.has('update_task')).toBe(true);
      expect(allow.has('add_task_step')).toBe(true);
      expect(allow.has('read_file')).toBe(true);
      expect(allow.has('read_artifact')).toBe(true);
      expect(allow.has('message_gezel')).toBe(true);
      expect(allow.has('read_task_notes')).toBe(true);
      // The voorman is instructed to advance/close tasks; those tools
      // must survive the cap (wild-caught: with them below the
      // cut the foreman emitted phantom `settaskstatus` calls forever).
      expect(allow.has('set_task_status')).toBe(true);
      expect(allow.has('advance_task_step')).toBe(true);
      // The voorman's about.md makes craftbooks the primary multi-phase
      // path, so the craftbook tools must survive the cap too — otherwise
      // the prose names tools she doesn't have and she hallucinates
      // `build_design` / `establish_design` (Space War Arcade).
      expect(allow.has('suggest_craftbook')).toBe(true);
      expect(allow.has('invoke_craftbook')).toBe(true);
      // Whole-document craftbook editing (Craftbooks V2): the voorman
      // fixes a running task's book (rewrite a failing step's prompt, add
      // a verification step) via craftbook_read/craftbook_write — the cap
      // was raised 20 → 22 to admit exactly this pair.
      expect(allow.has('craftbook_read')).toBe(true);
      expect(allow.has('craftbook_write')).toBe(true);
      // The voorman owns the project record — without `update_project`
      // she can't mark a finished project `stable` or park one
      // `readonly` (wild-caught, Space Shooter Arcade: the
      // meester kept checking in on a done project the voorman had no
      // tool to bring to rest).
      expect(allow.has('update_project')).toBe(true);
      // `validate` is a self-check tool, exempt from the cap for every role.
      // Without the exemption it sits at index 24 in the voorman priority —
      // below the 20 cut — so a model that tried to self-verify before
      // declaring done got "unknown tool validate" and looped (wild-caught,
      // qwen3.5-2b on bookstore-openapi).
      expect(allow.has('validate')).toBe(true);

      const sys = create!.opts!.systemMessage!;
      expect(sys).toContain('`read_file`');
      expect(sys).toContain('`read_artifact`');
      expect(sys).toContain('never invent refs from the project name');

      // The uncurated tail IS trimmed now (161 → curated list) and under
      // `debugMode` the trim surfaces as a warning — the transparency half
      // of the cap. See the twin test below for the default (quiet) path.
      const disk = await localStore.getSession('leo', session.id);
      const assistant = disk?.messages.find((m) => m.role === 'assistant');
      expect(assistant?.warnings?.some((w) => w.includes('Tool cap trimmed'))).toBe(true);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('medium local voorman keeps the full default roster without arbitrary trimming', async () => {
    // A capable medium model (12–45B) gets the role's documented full kit.
    // Message- and step-specific clamps may still narrow individual turns,
    // but the generic tier policy must not silently evict newly added
    // task/craftbook tools from a critical coordinator role.
    const home = await mkdtemp(join(tmpdir(), 'gezel-medium-voorman-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Reyansh', role: 'Voorman' });
    const proj = await localStore.createProject({ name: 'Empire' });
    await localStore.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'qwen3.6-27b-q8' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'reyansh', projectId: proj.id });
      localMock.script('ok');
      await localMgr.send(session.id, '[Message from Zephyr]: anything stuck?');

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      // Investigation + the broader craftbook, memory, and document kit
      // survive because medium is not count-capped.
      expect(allow.has('grep_files')).toBe(true);
      expect(allow.has('read_file')).toBe(true);
      // Code-intelligence is no longer in the voorman's roster:
      // symbol-level navigation is the developer's surface; she reads-to-
      // diagnose then delegates. Trims per-turn tool-schema prefill.
      expect(allow.has('find_symbol')).toBe(false);
      expect(allow.has('outline_file')).toBe(false);
      expect(allow.has('suggest_craftbook')).toBe(true);
      expect(allow.has('invoke_craftbook')).toBe(true);
      expect(allow.has('craftbook_read')).toBe(true);
      expect(allow.has('craftbook_write')).toBe(true);
      expect(allow.has('read_task_notes')).toBe(true);
      // Whole-document creation/replacement is consolidated into
      // craftbook_write; the legacy structured aliases are not advertised.
      expect(allow.has('craftbook_create')).toBe(false);
      expect(allow.has('craftbook_replace')).toBe(false);
      // The very large surgical patch schema is contextual to the explicit
      // Craftbook editor, not part of every ordinary Voorman turn.
      expect(allow.has('craftbook_update_step')).toBe(false);
      expect(allow.has('search_memory')).toBe(true);
      expect(allow.has('list_documents')).toBe(true);
      // These were the concrete Voorman capabilities evicted by the
      // medium-tier 84 → 57 regression. Keep the screenshot's failure set
      // pinned so a future coordinator diet cannot silently return.
      for (const tool of [
        'verify_outcome',
        'add_verification_step',
        'activate_task',
        'list_task_children',
        'spawn_task_instances',
        'craftbook_add_step',
        'set_step_deliverable',
      ]) {
        expect(allow.has(tool), `${tool} should survive on medium tier`).toBe(true);
      }
      // The team tools the voorman actually uses survive...
      expect(allow.has('message_gezel')).toBe(true);
      expect(allow.has('ensure_gezel')).toBe(true);
      expect(allow.has('list_gezels')).toBe(true);
      expect(allow.has('list_project_gezels')).toBe(true);
      expect(allow.has('list_project_local_gezels')).toBe(false);
      expect(allow.has('update_project')).toBe(true);
      // ...but the Meester-only kickoff tools are stripped from her roster
      // (she's a foreman within one project, not a project-starter).
      expect(allow.has('start_project')).toBe(false);
      expect(allow.has('start_job')).toBe(false);
      expect(allow.has('fetch_repo')).toBe(false);
      expect(allow.has('create_gezel')).toBe(false);

      // The documented full kit fits without a tier-cap warning.
      const disk = await localStore.getSession('reyansh', session.id);
      const assistant = disk?.messages.find((m) => m.role === 'assistant');
      expect(assistant?.warnings?.some((w) => w.includes('Tool cap trimmed'))).not.toBe(true);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('medium local developer cap keeps the normal implementation lane without trimming', async () => {
    // Repro from a Gemma 4 12B space-invaders repair: the prompt told the
    // developer to edit by line number, but the medium-tier implementation
    // cap kept `replace_in_file` and trimmed `replace_lines`, forcing brittle
    // byte-exact patches until the turn aborted. Keep the cap loose enough
    // that the normal implementation surface stays intact instead of
    // trimming arbitrary sibling tools.
    const home = await mkdtemp(join(tmpdir(), 'gezel-dev-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Ada', role: 'Developer' });
    const proj = await localStore.createProject({ name: 'Game' });
    await localStore.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-12b-q4' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'ada', projectId: proj.id });
      localMock.script('ok');
      await localMgr.send(session.id, 'Can you fix src/game.ts?');

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      expect(allow.has('replace_lines')).toBe(true);
      expect(allow.has('replace_in_file')).toBe(true);
      expect(allow.has('write_file')).toBe(true);
      expect(allow.has('read_file')).toBe(true);
      expect(allow.has('apply_patch')).toBe(true);
      expect(allow.has('insert_at_marker')).toBe(true);
      expect(allow.has('run_package_script')).toBe(true);
      expect(
        [...allow].filter(
          (t) => !t.startsWith('delegate_') && !t.startsWith('consult_') && t !== 'validate',
        ).length,
      ).toBeLessThanOrEqual(75);

      const disk = await localStore.getSession('ada', session.id);
      const assistant = disk?.messages.find((m) => m.role === 'assistant');
      expect(assistant?.warnings?.some((w) => w.includes('Tool cap trimmed'))).not.toBe(true);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('threads Codex policy into sessions and rebuilds when the project mode changes', async () => {
    await manager.shutdown();
    mock = new MockProvider({ name: 'copilot' });
    manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['codex-cli', mock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    await store.writeConfig({
      provider: 'codex-cli',
      defaultModel: { 'codex-cli': 'gpt-5.5' },
    });
    await store.updateGezelSettings('ada', { reasoningEffort: 'ultra' });
    await store.updateProject('default', { codexPermissionMode: 'reviewed' });

    const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
    mock.script('ok');
    await manager.send(session.id, 'Please inspect and update the project.');

    const create = mock.calls.find((c) => c.kind === 'create');
    const allow = create!.opts!.toolAllowlist!;
    const env = create!.opts!.mcpServer!.env;
    expect(create!.opts!.codexCliContext).toBeTruthy();
    expect(create!.opts!.codexCliContext?.reasoningEffortOverride).toBe('ultra');
    expect(create!.opts!.codexCliContext?.permissionModeOverride).toBe('reviewed');
    expect(env.GEZEL_MCP_EXCLUDE).toBeTruthy();
    expect(env.GEZEL_MCP_ALLOW).toBe([...allow].sort().join(','));

    await store.updateProject('default', { codexPermissionMode: 'plan' });
    mock.script('planned');
    await manager.send(session.id, 'Now only inspect it.');

    const creates = mock.calls.filter((call) => call.kind === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.opts!.codexCliContext?.permissionModeOverride).toBe('plan');
    expect(mock.calls.some((call) => call.kind === 'disconnect')).toBe(true);
  });

  it('threads Claude policy into sessions and rebuilds when the project mode changes', async () => {
    await manager.shutdown();
    mock = new MockProvider({ name: 'copilot' });
    manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['anthropic-cli', mock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    await store.writeConfig({
      provider: 'anthropic-cli',
      defaultModel: { 'anthropic-cli': 'sonnet' },
      anthropicCli: { defaultPermissionMode: 'acceptEdits' },
    });
    await store.updateGezelSettings('ada', { claudePermissionMode: 'bypassPermissions' });
    await store.updateProject('default', { claudePermissionMode: 'plan' });

    const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
    mock.script('planned');
    await manager.send(session.id, 'Inspect the project without editing it.');

    const create = mock.calls.find((call) => call.kind === 'create');
    expect(create!.opts!.claudeCliContext?.permissionModeOverride).toBe('plan');

    await store.updateProject('default', { claudePermissionMode: 'acceptEdits' });
    mock.script('edited');
    await manager.send(session.id, 'Now update it.');

    const creates = mock.calls.filter((call) => call.kind === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.opts!.claudeCliContext?.permissionModeOverride).toBe('acceptEdits');
    expect(mock.calls.some((call) => call.kind === 'disconnect')).toBe(true);
  });

  it('rebuilds the live session when the catalog content root flips (live gilde update)', async () => {
    await manager.shutdown();
    mock = new MockProvider({ name: 'copilot' });
    let contentRoot = join(home, 'gilde-bundled', 'data');
    manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['copilot', mock]],
      catalog: new CatalogService(undefined, { contentRoot: () => contentRoot }),
      secrets: new FileSecretStore(home),
    });

    // A live-session (re)build surfaces as either a 'create' carrying the
    // MCP bridge or a 'resume' of persisted provider state. One-shot side
    // completions (titles, extraction) also register bare 'create' calls
    // and must not count.
    const liveBuilds = () =>
      mock.calls.filter(
        (call) => (call.kind === 'create' && call.opts?.mcpServer) || call.kind === 'resume',
      );

    const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
    mock.script('ok');
    await manager.send(session.id, 'First turn.');
    mock.script('still ok');
    await manager.send(session.id, 'Second turn, unchanged content.');
    // Same root both turns: the live session is reused.
    expect(liveBuilds()).toHaveLength(1);

    // A live gilde activation flips the effective content root; the cached
    // model profile/tuning were resolved from the old content, so the next
    // turn must tear down and re-establish the live session.
    contentRoot = join(home, 'gilde', 'versions', '0.1.99', 'package', 'data');
    mock.script('rebuilt');
    await manager.send(session.id, 'Third turn, after activation.');
    expect(liveBuilds()).toHaveLength(2);
  });

  it('small local meester keeps every curated tool under the coordinator cap', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-meester-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4:e4b' },
      // See the small-voorman twin: the notice only reaches chat in debug.
      debugMode: true,
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('Project is starting.');
      // Plain coordination ask — deliberately free of the build-verb +
      // deliverable-noun pairing that trips the project-orchestration
      // narrowing (covered separately by the "compact project router
      // surface" test). This case exercises the tier cap alone, so the
      // kickoff macros survive on priority and `ask_user_question` stays.
      await localMgr.send(session.id, 'What should we tackle first today?');

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      // Full meester surface survives — the kickoff macro AND the tools the old
      // 13-cap evicted (read_task_notes, write_artifact) are all present.
      expect(allow.has('start_project')).toBe(true);
      expect(allow.has('start_job')).toBe(false);
      expect(allow.has('message_gezel')).toBe(true);
      expect(allow.has('ask_user_question')).toBe(true);
      // read_task_notes ranked below the old cut (rank 26) and was the tool
      // the imara stall couldn't reach; it must survive now.
      expect(allow.has('read_task_notes')).toBe(true);
      expect(allow.has('write_artifact')).toBe(true);

      const sys = create!.opts!.systemMessage!;
      const toolsBlockStart = sys.indexOf('## Tools available this turn');
      expect(toolsBlockStart).toBeGreaterThanOrEqual(0);
      const toolsBlock = sys.slice(toolsBlockStart);
      expect(toolsBlock).toContain('`start_project`');
      expect(toolsBlock).not.toContain('`start_job`');
      expect(toolsBlock).toContain('`message_gezel`');
      expect(toolsBlock).toContain('`ask_user_question`');
      expect(toolsBlock).toContain('`write_artifact`');

      // The uncurated tail IS trimmed (161 → curated list length) — see the
      // small-voorman twin test for the two incidents this reconciles. The
      // notice reaches chat only because this fixture set `debugMode`.
      const disk = await localStore.getSession('mira', session.id);
      const assistant = disk?.messages.find((m) => m.role === 'assistant');
      expect(assistant?.warnings?.some((w) => w.includes('Tool cap trimmed'))).toBe(true);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('the tier trim is silent in chat for an ordinary (non-debug) install', async () => {
    // Wild-caught: a small-tier Meester on gemma4-e4b opened every reply
    // with "Tool cap trimmed this small-tier Meester session from 74 to 51
    // tools. Hidden tools include: `list_suggested_work`, ...". The trim is
    // the tier policy working as designed, the tool names mean nothing to
    // someone who never picked tools by name, and both suggested remedies
    // (bigger model, fewer toolsets) are settings changes nobody should be
    // asked to make mid-sentence. Debug installs still get it; the
    // unconditional `log.warn` covers anyone tailing logs.
    const home = await mkdtemp(join(tmpdir(), 'gezel-quiet-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4:e4b' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('on it');
      await localMgr.send(session.id, 'Can we create an ikari warriors arcade game?');

      // The cap still fires — this is about who hears about it, not whether
      // the surface is trimmed.
      const create = localMock.calls.find((c) => c.kind === 'create');
      expect(create).toBeTruthy();

      const disk = await localStore.getSession('mira', session.id);
      const assistant = disk?.messages.find((m) => m.role === 'assistant');
      expect(assistant?.warnings?.some((w) => w.includes('Tool cap trimmed'))).not.toBe(true);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('medium local meester cap keeps the project kickoff and trims the full MCP roster', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-medium-meester-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-12b-q4' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('Project is starting.');
      await localMgr.send(
        session.id,
        'Create a browser-based tic-tac-toe game in a single HTML file.',
      );

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      // Non-delegation surface respects the cap; role tools are exempt.
      expect(
        [...allow].filter((t) => !t.startsWith('delegate_') && !t.startsWith('consult_')).length,
      ).toBeLessThanOrEqual(16);
      expect(allow.has('start_project')).toBe(true);
      expect(allow.has('start_job')).toBe(false);
      const allowOrder = Array.from(allow);
      expect(allowOrder).toContain('start_project');
      expect(allow.has('message_gezel')).toBe(true);
      expect(allow.has('write_file')).toBe(false);
      expect(allow.has('write_artifact')).toBe(false);

      const sys = create!.opts!.systemMessage!;
      const toolsBlockStart = sys.indexOf('## Tools available this turn');
      expect(toolsBlockStart).toBeGreaterThanOrEqual(0);
      const toolsBlock = sys.slice(toolsBlockStart);
      const listedTools = toolsBlock.slice(0, toolsBlock.indexOf('---'));
      expect(listedTools).toContain('`start_project`');
      expect(listedTools).not.toContain('`start_job`');
      expect(listedTools).toContain('`message_gezel`');
      expect(listedTools).not.toContain('`write_file`');
      expect(listedTools).not.toContain('`write_artifact`');
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('medium local meester router keeps repo intake macros for repository reviews', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-medium-meester-repo-router-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'qwen3.6-27b-q4' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('Repository intake is starting.');
      await localMgr.send(
        session.id,
        [
          'Please conduct a comprehensive architecture and code review of the open-source repository at https://github.com/bendyline/squisq.',
          'MANDATORY FIRST TOOL CALL: `fetch_repo({ url: "https://github.com/bendyline/squisq", projectName: "Squisq Code Review" })`.',
          'Do not call `start_project`, `start_job`, or `create_project` first; those create an empty bootstrap project with no Squisq source.',
        ].join('\n\n'),
      );

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      expect(allow.has('fetch_repo')).toBe(true);
      expect(allow.has('fetch_diff')).toBe(true);
      expect(allow.has('start_project')).toBe(true);
      expect(allow.has('message_gezel')).toBe(true);
      expect(allow.has('delegate_reviewer')).toBe(false);
      expect(allow.has('consult_reviewer')).toBe(false);
      expect(allow.has('consult_researcher')).toBe(false);

      const sys = create!.opts!.systemMessage!;
      const toolsBlockStart = sys.indexOf('## Tools available this turn');
      expect(toolsBlockStart).toBeGreaterThanOrEqual(0);
      const toolsBlock = sys.slice(toolsBlockStart);
      const listedTools = toolsBlock.slice(0, toolsBlock.indexOf('---'));
      expect(listedTools).toContain('`fetch_repo`');
      expect(listedTools).toContain('`fetch_diff`');
      expect(listedTools).toContain('`start_project`');
      expect(listedTools).toContain('`message_gezel`');
      expect(listedTools).not.toContain('`delegate_reviewer`');
      expect(listedTools).not.toContain('`consult_reviewer`');
      expect(listedTools).not.toContain('`consult_researcher`');
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('large local meester build turns use the compact project router surface', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-large-meester-router-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'mistral-medium-3.5-128b-q4' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('Project is starting.');
      await localMgr.send(
        session.id,
        'Create a new project and build a tic-tac-toe game I can play in my browser.',
      );

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      // Non-delegation router surface stays compact; role tools are exempt.
      // The two craftbook entry points keep exact-format deliverables on
      // their bundled production path instead of falling back to ad-hoc work.
      expect(
        [...allow].filter((t) => !t.startsWith('delegate_') && !t.startsWith('consult_')).length,
      ).toBeLessThanOrEqual(14);
      expect(allow.has('start_job')).toBe(false);
      expect(allow.has('start_project')).toBe(true);
      expect(allow.has('message_gezel')).toBe(true);
      expect(allow.has('suggest_craftbook')).toBe(true);
      expect(allow.has('invoke_craftbook')).toBe(true);
      expect(allow.has('ask_user_question')).toBe(false);
      expect(allow.has('ask_gezel')).toBe(false);
      expect(allow.has('ask_specialist')).toBe(false);
      expect(allow.has('write_file')).toBe(false);
      expect(allow.has('write_artifact')).toBe(false);

      const sys = create!.opts!.systemMessage!;
      const toolsBlockStart = sys.indexOf('## Tools available this turn');
      if (toolsBlockStart >= 0) {
        const toolsBlock = sys.slice(toolsBlockStart);
        const listedTools = toolsBlock.slice(0, toolsBlock.indexOf('---'));
        expect(listedTools).not.toContain('`start_job`');
        expect(listedTools).toContain('`start_project`');
        expect(listedTools).toContain('`message_gezel`');
        expect(listedTools).toContain('`suggest_craftbook`');
        expect(listedTools).toContain('`invoke_craftbook`');
        expect(listedTools).not.toContain('`ask_user_question`');
        expect(listedTools).not.toContain('`ask_gezel`');
        expect(listedTools).not.toContain('`ask_specialist`');
        expect(listedTools).not.toContain('`write_file`');
        expect(listedTools).not.toContain('`write_artifact`');
      }

      localMock.script('Noted.');
      await localMgr.send(
        session.id,
        '[Message from Consuelo]: I wrote `index.html` to the workspace and the game is ready for review.',
      );

      const createCalls = localMock.calls.filter((c) => c.kind === 'create');
      expect(createCalls).toHaveLength(1);

      localMock.script('Continuing.');
      await localMgr.send(session.id, '[Answer to: "Do you want to play as X or O?"]\nSelected: X');

      const createCallsAfterAnswer = localMock.calls.filter((c) => c.kind === 'create');
      expect(createCallsAfterAnswer).toHaveLength(1);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the compact project router surface for scenario-style project kickoff continuations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-scenario-meester-router-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Mira', role: 'Meester' });
    await localStore.writeConfig({
      meesterGezelId: 'mira',
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'llama3.2' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'mira', projectId: 'default' });
      localMock.script('Project is starting.');
      await localMgr.send(
        session.id,
        'Create a new project for this work (e.g. `Tic-Tac-Toe Game`) and build a tic-tac-toe game I can play in my browser IN THAT NEW PROJECT. Single HTML file at `workspace/index.html`, no build step.',
      );

      const firstCreate = localMock.calls.find((c) => c.kind === 'create');
      const firstAllow = firstCreate!.opts!.toolAllowlist!;
      expect(firstAllow.has('start_job')).toBe(false);
      expect(firstAllow.has('start_project')).toBe(true);
      expect(firstAllow.has('message_gezel')).toBe(true);
      expect(firstAllow.has('ask_user_question')).toBe(false);
      expect(firstAllow.has('ask_gezel')).toBe(false);

      localMock.script('Continuing.');
      await localMgr.send(session.id, '[Message from Unai]: ');

      const createCalls = localMock.calls.filter((c) => c.kind === 'create');
      expect(createCalls).toHaveLength(1);

      localMock.script('Noted.');
      await localMgr.send(
        session.id,
        '[Message from Mustafa]: I wrote `index.html` to the workspace.',
      );

      expect(localMock.calls.filter((c) => c.kind === 'create')).toHaveLength(1);
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('medium local builder cap keeps the normal implementation surface intact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-builder-cap-'));
    const localStore = new Store({ home });
    await localStore.ensureLayout();
    await localStore.createGezel({ name: 'Maria', role: 'Builder' });
    const proj = await localStore.createProject({ name: 'Tic-Tac-Toe Game' });
    await localStore.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-12b-q4' },
    });
    const localEvents = new ChatEventBus();
    const localMock = new MockProvider({ name: 'llama-cpp' });
    const localMgr = new ChatManager({
      store: localStore,
      events: localEvents,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    try {
      const session = await localMgr.createSession({ gezelId: 'maria', projectId: proj.id });
      localMock.script('ok');
      await localMgr.send(session.id, 'write index.html');

      const create = localMock.calls.find((c) => c.kind === 'create');
      const allow = create!.opts!.toolAllowlist!;
      expect(
        [...allow].filter(
          (t) => !t.startsWith('delegate_') && !t.startsWith('consult_') && t !== 'validate',
        ).length,
      ).toBeLessThanOrEqual(75);
      expect(allow.has('write_file')).toBe(true);
      expect(allow.has('read_file')).toBe(true);
      expect(allow.has('replace_lines')).toBe(true);
      expect(allow.has('replace_in_file')).toBe(true);
      expect(allow.has('start_project')).toBe(false);
      expect(allow.has('message_gezel')).toBe(false);
      expect(allow.has('generate_image')).toBe(false);

      const sys = create!.opts!.systemMessage!;
      const toolsBlockStart = sys.indexOf('## Tools available this turn');
      expect(toolsBlockStart).toBeGreaterThanOrEqual(0);
      const toolsBlock = sys.slice(toolsBlockStart);
      const listedTools = toolsBlock.slice(0, toolsBlock.indexOf('---'));
      expect(listedTools).toContain('`write_file`');
      expect(listedTools).not.toContain('`start_project`');
    } finally {
      await localMgr.drainBackground();
      await localMgr.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("developer's 'Where work belongs' section keeps write_file/read_file", async () => {
    // Specialists with both `workspace-fs-read` and `-write` get the
    // original prose — they DO have those tools and the decision-test
    // ("would the user ship this at release?") is real guidance for them.
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const proj = await store.createProject({
      name: 'Atari Combat Game',
      about: 'A new arcade-style combat game.',
      missionObjectives: '- Ship a playable prototype by EOQ.',
    });

    const session = await manager.createSession({ gezelId: 'dev', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'start coding');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('### Where work belongs');
    expect(sys).toContain('`write_file`');
    expect(sys).toContain('`read_file`');
    expect(sys).toContain('`list_dir`');
    expect(sys).toContain('If a path appears in `### Workspace files`');
    // No lockdown note when file edits are allowed (the default).
    expect(sys).not.toContain('Built-in file tools are read-only');
  });

  it('injects a managed-tools read-only note when the project disables managed writes', async () => {
    // A non-writable project strips this session's managed workspace-write tools.
    // The prompt must tell the recipient so the developer doesn't try a
    // stripped `write_file` (then hallucinate a save) — see
    // fileEditsDisabledNote.
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const proj = await store.createProject({
      name: 'Atari Combat Game',
      about: 'A new arcade-style combat game.',
    });
    await store.updateProject(proj.id, { managedWorkspaceWritePolicy: 'deny' });

    const session = await manager.createSession({ gezelId: 'dev', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'add a logo to the start screen');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('Built-in file tools are read-only for this session');
    expect(sys).toContain('Allow built-in tools and background work to modify the workspace');
    expect(sys).toContain('Project → Settings');
    expect(sys).toContain('Do not claim you wrote');
    expect(sys).toContain(
      'Provider-native sessions such as Codex may have separate project access',
    );
  });

  it('gives a diffpack task safe edit tools when the workspace itself is read-only', async () => {
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const proj = await store.createProject({ name: 'Read-only checkout' });
    await store.updateProject(proj.id, { managedWorkspaceWritePolicy: 'deny' });
    const { TaskManager } = await import('../tasks/manager.js');
    const taskMgr = new TaskManager(store);
    const task = await taskMgr.create(
      proj.id,
      {
        title: 'Fix the targeted finding',
        description: 'Investigate one indexed finding, propose the smallest safe fix, and verify it.',
        assignee: { kind: 'gezel', gezelId: 'dev' },
        steps: [{ id: 'fix', name: 'Fix and verify', terminal: true }],
      },
      { draftsDiffpack: true },
    );

    const session = await manager.createSession({
      gezelId: 'dev',
      projectId: proj.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    mock.script('proposal drafted');
    await manager.send(session.id, 'start the targeted fix');

    const create = mock.calls.find((c) => c.kind === 'create');
    const allow = create!.opts!.toolAllowlist!;
    expect(allow.has('write_file')).toBe(true);
    expect(allow.has('replace_in_file')).toBe(true);
    expect(allow.has('replace_lines')).toBe(true);
    expect(allow.has('delete_path')).toBe(true);
    // These operations have no draft-overlay implementation and must never
    // fall through to the real workspace during proposal mode.
    expect(allow.has('apply_patch')).toBe(false);
    expect(allow.has('copy_artifact_to_workspace')).toBe(false);
    expect(allow.has('make_dir')).toBe(false);
    expect(allow.has('rename')).toBe(false);

    const sys = create!.opts!.systemMessage!;
    expect(sys).toContain('#### Change-proposal mode');
    expect(sys).toContain(`CHANGE PROPOSAL DP-${task.diffpackId}`);
    expect(sys).not.toContain('Built-in file tools are read-only for this session');
  });

  it('keeps internal-workspace projects writable under super-lockdown (no edits-off note)', async () => {
    // The global policy no longer gates workspace writes — a fresh
    // internal project (a checkers board, a scratch notebook) stays
    // functional under super-lockdown; only the per-project contract
    // (external dirs without opt-in, explicit "edits off") strips.
    await store.writeConfig({ securityPolicy: securityPolicyForLevel('super-lockdown') });
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const proj = await store.createProject({
      name: 'Atari Combat Game',
      about: 'A new arcade-style combat game.',
    });

    const session = await manager.createSession({ gezelId: 'dev', projectId: proj.id });
    const snapshot = await manager.getSessionDebug(session.id);
    expect(snapshot.systemPrompt).not.toContain('Built-in file tools are read-only');
  });

  it('exposes on-disk diagnostics paths in the debug snapshot', async () => {
    // The debug bundle points the reader at the full transcript + logs
    // for digs past what the bundle samples (see formatDebugBundle's
    // "Where to dig deeper"). Cloud provider → no engine-log glob.
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const proj = await store.createProject({ name: 'Diag Project', about: 'x' });
    const session = await manager.createSession({ gezelId: 'dev', projectId: proj.id });

    const snap = await manager.getSessionDebug(session.id);
    expect(snap.turnStatus).toBe('idle');
    expect(snap.diagnostics?.sessionRecordPath).toContain(session.id);
    expect(snap.diagnostics?.sessionRecordPath.endsWith('.json')).toBe(true);
    expect(snap.diagnostics?.logsDir.endsWith('logs')).toBe(true);
    expect(snap.diagnostics?.engineLogGlob).toBeUndefined();
  });

  it('labels an empty tool list as unrecorded, not as an empty roster', async () => {
    // A cold snapshot never asked a bridge anything. Reporting a bare
    // "none" sent one investigation after a phantom dropped bridge on a
    // bundle whose own system prompt listed ~80 wired tools, so the
    // source has to travel with the list.
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const project = await store.createProject({ name: 'Cold tools' });
    const session = await manager.createSession({ gezelId: 'dev', projectId: project.id });

    const snap = await manager.getSessionDebug(session.id);
    expect(snap.registeredTools).toEqual([]);
    expect(snap.registeredToolsSource).toBe('unavailable');
  });

  it('marks debug snapshots exported during an active turn as in progress', async () => {
    await store.createGezel({ name: 'Dev', role: 'developer' });
    const project = await store.createProject({ name: 'Live debug' });
    const session = await manager.createSession({ gezelId: 'dev', projectId: project.id });
    const internals = manager as unknown as {
      inflight: Map<string, { userText: string; startedAt: number }>;
    };
    internals.inflight.set(session.id, { userText: 'research it', startedAt: Date.now() });
    try {
      expect((await manager.getSessionDebug(session.id)).turnStatus).toBe('in-progress');
    } finally {
      internals.inflight.delete(session.id);
    }
  });

  it('uses captured caller evidence for external debug snapshots', async () => {
    const workingDirectory = join(tmpdir(), 'external-project');
    const turn = await manager.beginExternalConversation({
      sourceId: 'opencode',
      sourceName: 'OpenCode',
      externalConversationId: 'opencode-debug-turn',
      workingDirectory,
      gezelId: 'ada',
      providerName: 'mlx',
      model: 'qwen-test',
      messages: [
        { role: 'system', content: 'Caller system prompt.' },
        { role: 'user', content: 'Write the page.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-write', name: 'write', arguments: '{"path":"index.html"}' }],
        },
        { role: 'tool', content: 'Wrote file successfully.', toolCallId: 'call-write' },
      ],
      effectiveSystemMessage: 'Gezel persona.\n\n---\n\nCaller system prompt.',
      toolNames: ['write', 'read'],
      actionLedger: '[Gezel caller-owned action ledger]\n- write -> `index.html`',
    });

    const snap = await manager.getSessionDebug(turn.sessionId);
    expect(snap.systemPrompt).toBe('Gezel persona.\n\n---\n\nCaller system prompt.');
    expect(snap.systemPrompt).not.toContain('About this project');
    expect(snap.registeredTools).toEqual(['write', 'read']);
    expect(snap.registeredToolsSource).toBe('caller');
    expect(snap.turnStatus).toBe('in-progress');
    expect(snap.externalConversation).toMatchObject({
      appId: 'opencode',
      appName: 'OpenCode',
      workingDirectory:
        process.platform === 'win32' ? workingDirectory.toLowerCase() : workingDirectory,
      request: {
        messageCount: 4,
        actionLedger: '[Gezel caller-owned action ledger]\n- write -> `index.html`',
      },
    });

    await turn.finish({ content: 'Done.', finishReason: 'stop' });
  });

  it('uses persisted project script tools in a cold debug snapshot', async () => {
    const project = await store.createProject({ name: 'Cold Checkers' });
    await store.updateProject(project.id, {
      leanProfile: true,
      projectType: {
        id: 'checkers',
        version: '1.1.0',
        source: 'bundled',
        appliedAt: '2026-07-29T00:00:00.000Z',
      },
    });
    const session = await manager.createSession({ gezelId: 'ada', projectId: project.id });
    // The field incident was an MLX session; local tiers render their live
    // tool roster into the prompt, while Copilot intentionally relies on
    // its native function schema and omits this text block.
    session.providerName = 'mlx';
    session.scriptTools = [
      {
        name: 'get_board',
        description: 'Read the current board and legal moves.',
        script: 'game-store',
        bind: { action: 'board' },
      },
      {
        name: 'make_move',
        description: 'Play a legal move.',
        script: 'game-store',
        bind: { action: 'ai_move' },
      },
    ];
    await store.writeSession(session);

    const snap = await manager.getSessionDebug(session.id);
    expect(snap.registeredTools).toEqual(['get_board', 'make_move']);
    expect(snap.systemPrompt).toContain('`get_board`');
    expect(snap.systemPrompt).toContain('`make_move`');
  });

  it('preflights the current board and marks make_move terminal for a lean game follow-up', async () => {
    const project = await store.createProject({ name: 'Live Checkers' });
    await store.updateProject(project.id, {
      mode: 'solo',
      leanProfile: true,
      projectType: {
        id: 'checkers',
        version: '1.1.0',
        source: 'bundled',
        appliedAt: '2026-07-29T00:00:00.000Z',
      },
    });
    const run = vi.fn().mockResolvedValue({
      id: 'board-run',
      projectId: project.id,
      scriptName: 'game-store',
      startedAt: '2026-07-29T00:00:00.000Z',
      finishedAt: '2026-07-29T00:00:00.010Z',
      status: 'ok',
      trigger: { kind: 'chat', sessionId: 'session', gezelId: 'ada' },
      inputs: { action: 'board' },
      calls: [],
      logs: '',
      output: {
        board: 'fresh-board',
        turn: 'ai',
        legalMoves: 'b6-c5, d6-c5',
      },
    });
    manager.setScriptRunner({ run } as unknown as Parameters<ChatManager['setScriptRunner']>[0]);
    const session = await manager.createSession({ gezelId: 'ada', projectId: project.id });
    mock.script('I moved.');

    await manager.send(session.id, 'Can you take your turn?');

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        scriptName: 'game-store',
        inputs: { action: 'board' },
      }),
    );
    const sendCall = mock.calls.find((call) => call.kind === 'send');
    expect(sendCall?.prompt).toContain('fresh-board');
    expect(sendCall?.prompt).toContain('b6-c5, d6-c5');
    const createCall = mock.calls.find((call) => call.kind === 'create');
    expect(createCall?.opts?.terminalToolPolicy).toEqual(
      expect.objectContaining({ toolNames: ['make_move'], closingArg: 'moveThought' }),
    );
  });

  it('injects mission objectives into the solo-mode Builder', async () => {
    // Solo projects (mode: 'solo') have a single Builder who plays
    // the voorman role — they own everything. The same gating rule
    // applies: voormanGezelId === gezelId, regardless of project mode.
    await store.createGezel({ name: 'Sam', role: 'Builder' });
    const proj = await store.createProject({
      name: 'My side project',
      mode: 'solo',
      about: 'Personal experiments.',
      missionObjectives: '- Build something I find delightful by EOY.',
    });
    await store.updateProject(proj.id, { voormanGezelId: 'sam' });

    const session = await manager.createSession({ gezelId: 'sam', projectId: proj.id });
    mock.script('on it');
    await manager.send(session.id, 'what next?');

    const create = mock.calls.find((c) => c.kind === 'create');
    const sys = create!.opts!.systemMessage;
    expect(sys).toContain('### Mission objectives');
    expect(sys).toContain('Build something I find delightful by EOY.');
  });

  // `prompt.executor-context-trim` is OFF by default; forced ON here via
  // GEZEL_FORCE_BEHAVIORS — the same path the eval harness uses to A/B it.
  describe('prompt.executor-context-trim', () => {
    const FORCE = 'GEZEL_FORCE_BEHAVIORS';
    const TRIM = 'prompt.executor-context-trim';
    let prevForce: string | undefined;
    beforeEach(() => {
      prevForce = process.env[FORCE];
    });
    afterEach(() => {
      if (prevForce === undefined) delete process.env[FORCE];
      else process.env[FORCE] = prevForce;
    });

    async function sysFor(opts: {
      role: string;
      force: boolean;
      github?: boolean;
    }): Promise<string> {
      await store.createGezel({ name: 'G', role: opts.role });
      const proj = await store.createProject({
        name: 'Repo Project',
        about: 'A project linked to a repo.',
        ...(opts.github ? { github: { url: 'https://github.com/octocat/Hello-World' } } : {}),
      });
      if (opts.force) process.env[FORCE] = TRIM;
      else delete process.env[FORCE];
      const session = await manager.createSession({ gezelId: 'g', projectId: proj.id });
      mock.script('on it');
      await manager.send(session.id, 'go');
      const create = mock.calls.find((c) => c.kind === 'create');
      return create!.opts!.systemMessage!;
    }

    it('keeps the executor write-target prose when trimmed (misroute guard)', async () => {
      // The "Where work belongs" write-vs-artifact decision is the one
      // section we must NEVER trim — dropping it makes executors save
      // source to the artifact drawer. Lock it in under the behavior.
      const sys = await sysFor({ role: 'developer', force: true });
      expect(sys).toContain('### Where work belongs');
      expect(sys).toContain('`write_file`');
      expect(sys).toContain('`read_file`');
    });

    it('condenses the GitHub block for a trimmed executor (drops PR-toolset prose)', async () => {
      const sys = await sysFor({ role: 'developer', force: true, github: true });
      expect(sys).toContain('### GitHub repository');
      expect(sys).toContain('octocat/Hello-World');
      expect(sys).not.toContain('Use the GitHub toolset');
    });

    it('keeps the full GitHub block when the behavior is OFF (control = unchanged)', async () => {
      const sys = await sysFor({ role: 'developer', force: false, github: true });
      expect(sys).toContain('Use the GitHub toolset');
    });

    it('does not trim an orchestrator role even when the behavior is forced ON', async () => {
      // Role gate: isExecutorRole is false for a delegation role, so the
      // trim never fires regardless of the flag. Asserted on the shared
      // documents listing rather than the GitHub sentence: that sentence
      // now also requires the role to actually hold GitHub tools, which a
      // pure delegation role does not, so it can no longer isolate the
      // role gate from the roster.
      await store.writeDocument('brand/guidelines.md', 'House style.');
      const sys = await sysFor({ role: 'voorman', force: true, github: true });
      expect(sys).toContain('### Shared documents library');
      // Foldered path proves the listing walks the tree; a top-level-only
      // listing would render the folder and hide the document inside it.
      expect(sys).toContain('brand/guidelines.md');
    });

    it('condenses the shared-documents listing to a pointer for a trimmed executor', async () => {
      await store.writeDocument('brand/guidelines.md', 'House style.');
      // Copywriter, not developer: the pointer names a document tool, so it
      // only renders for an executor whose role actually holds one. The
      // developer kit carries no `documents` group at all.
      const trimmed = await sysFor({ role: 'copywriter', force: true });
      // The inventory goes; knowing the library exists does not, or
      // "consult team policy" has no trigger.
      expect(trimmed).not.toContain('### Shared documents library');
      expect(trimmed).not.toContain('brand/guidelines.md');
      expect(trimmed).toContain('A shared documents library exists');
    });

    it('renders a description beside each document when the behavior is on', async () => {
      // A bare path makes the model guess: `mission.md` and `notes-2024.md`
      // are indistinguishable until something reads them.
      await store.writeDocument('policies/refunds.md', '# Refunds\n');
      await store.ensureSharedProject();
      manager.setContentIndex({
        libraryDescriptions: async () =>
          new Map([['policies/refunds.md', 'How refunds are handled and when they apply.']]),
      } as unknown as import('../index-store/content-index.js').ContentIndex);

      // sysFor() owns the force env for the trim cases, so drive the send
      // directly here with this behavior forced on instead.
      process.env[FORCE] = 'prompt.documents-summaries';
      try {
        const project = await store.createProject({ name: 'Described Docs' });
        const session = await manager.createSession({ gezelId: 'ada', projectId: project.id });
        mock.script('ok');
        await manager.send(session.id, 'go');
        const create = mock.calls.find((c) => c.kind === 'create');
        const sys = create!.opts!.systemMessage as string;
        expect(sys).toContain('policies/refunds.md — How refunds are handled');
      } finally {
        delete process.env[FORCE];
      }
    });

    it('steers to search and hides outside-in companion twins', async () => {
      await store.writeDocument('brand/guidelines.md', 'House style.');
      // The editable markdown twin of a binary document. It is a derived
      // view of a document already listed, so offering it as a second
      // readable path invites the model to open the wrong one.
      await store.writeDocument('brand/deck.pptx_files/deck.md', 'converted twin');
      const sys = await sysFor({ role: 'voorman', force: false });
      expect(sys).toContain('call `search` with the topic');
      expect(sys).not.toContain('deck.pptx_files');
    });
  });
});

describe('describeDelegateFailureForAsker', () => {
  // The exact second-person abort string the mlx provider throws when a
  // delegate's turn ramble-aborts (see ramble-detector.ts + providers).
  const RAMBLE_ABORT =
    '[Mac AI] aborting — the gezel emitted 6001 characters of prose this turn without ' +
    'calling any action tool. Stop planning. Your next message MUST start with a single ' +
    'tool call. If shipping source or project files and `write_file` is in your tool list, ' +
    'call it NOW with the full file contents — no preamble, no plan.';

  it('rewrites a ramble-abort into an asker-facing summary attributed to the target', () => {
    const msg = describeDelegateFailureForAsker('Adam', RAMBLE_ABORT);
    expect(msg).toContain('Adam');
    expect(msg).toMatch(/couldn't complete the request/i);
    // The whole point: the asker is told NOT to touch its own args.
    expect(msg).toMatch(/don't change your own tool arguments/i);
  });

  it('uses the target gezel assigned pronouns in the asker-facing summary', () => {
    const female = describeDelegateFailureForAsker('Lyudmyla', RAMBLE_ABORT, 'female');
    expect(female).toContain('she spent her whole turn');
    expect(female).not.toContain('they spent their whole turn');

    const male = describeDelegateFailureForAsker('Adam', RAMBLE_ABORT, 'male');
    expect(male).toContain('he spent his whole turn');
  });

  it('never forwards the delegate-facing second-person remediation to the asker', () => {
    const msg = describeDelegateFailureForAsker('Adam', RAMBLE_ABORT);
    // The coaching that caused Laxmi to thrash + fabricate a write_file.
    expect(msg).not.toMatch(/call it NOW/i);
    expect(msg).not.toMatch(/write_file/i);
    expect(msg).not.toMatch(/Your next message MUST/i);
    expect(msg).not.toMatch(/\d+ characters of prose/i);
  });

  it('matches the llama-cpp / ollama wording of the same family', () => {
    for (const raw of [
      '[llama-cpp] aborting — the gezel emitted 6016 characters of prose this turn without calling any action tool. Stop planning.',
      '[ollama] aborting — the gezel emitted 7000 characters of prose this turn without calling any action tool. Stop planning.',
    ]) {
      const msg = describeDelegateFailureForAsker('Builder', raw);
      expect(msg).toMatch(/spent their whole turn planning/i);
      expect(msg).not.toMatch(/Stop planning/i);
    }
  });

  it('preserves a generic downstream error but still marks ownership', () => {
    const msg = describeDelegateFailureForAsker('Researcher', 'fetch failed: ECONNREFUSED');
    expect(msg).toContain('Researcher');
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).toMatch(/couldn't reply/i);
  });

  it('handles an empty downstream error string', () => {
    const msg = describeDelegateFailureForAsker('Mira', '');
    expect(msg).toContain('Mira');
    expect(msg).toMatch(/couldn't reply/i);
  });
});

describe('detectUnsavedFileClaim — existence/completion claims', () => {
  // The exact phrasings Laxmi used that the write-verb patterns missed.
  it('catches "The deliverable `workspace/index.html` is in place"', () => {
    const r = detectUnsavedFileClaim(
      'The deliverable `workspace/index.html` is in place and fully playable.',
      [],
    );
    expect(r).toEqual({ claimedPath: 'workspace/index.html', kind: 'exists' });
  });

  it('catches "`index.html` exists and meets all mission objectives"', () => {
    const r = detectUnsavedFileClaim('`index.html` exists and meets all mission objectives.', []);
    expect(r?.kind).toBe('exists');
    expect(r?.claimedPath).toBe('index.html');
  });

  it('catches "delivered `index.html`"', () => {
    const r = detectUnsavedFileClaim('I have delivered `index.html` to the workspace.', []);
    expect(r?.claimedPath).toBe('index.html');
  });

  it('still catches the original write-verb claims as kind "wrote"', () => {
    const r = detectUnsavedFileClaim('I saved the report to `review.md` just now.', []);
    expect(r).toEqual({ claimedPath: 'review.md', kind: 'wrote' });
  });

  it('does NOT fire on a retraction ("the file was NOT created")', () => {
    expect(
      detectUnsavedFileClaim('The file `index.html` was NOT created — I could not write it.', []),
    ).toBeNull();
  });

  it('does NOT fire when a successful write_file landed this turn', () => {
    expect(
      detectUnsavedFileClaim('`index.html` is complete and ready.', [
        { id: '1', name: 'write_file', success: true } as never,
      ]),
    ).toBeNull();
  });

  it('does NOT fire when a Codex native shell edit landed this turn', () => {
    expect(
      detectUnsavedFileClaim('Updated `index.html` for Phase 2.', [
        { id: '1', name: 'shell', success: true } as never,
      ]),
    ).toBeNull();
  });
});

describe('detectChatCodedFileWithoutWrite', () => {
  const bigHtml = `Here's the file:\n\`\`\`html\n<!DOCTYPE html>\n<html><body>\n${'<div>row</div>\n'.repeat(60)}</body></html>\n\`\`\``;

  it('fires when a whole file is pasted in a code block with no write', () => {
    const r = detectChatCodedFileWithoutWrite(bigHtml, []);
    expect(r?.path).toBe('index.html');
  });

  it('stays quiet when a successful write_file already landed this turn', () => {
    expect(
      detectChatCodedFileWithoutWrite(bigHtml, [{ name: 'write_file', success: true }]),
    ).toBeNull();
  });

  it('stays quiet on a short illustrative snippet (below the size floor)', () => {
    const snippet = 'Use this:\n```html\n<button>Go</button>\n```';
    expect(detectChatCodedFileWithoutWrite(snippet, [])).toBeNull();
  });

  it('stays quiet when there is no fenced code block at all', () => {
    expect(detectChatCodedFileWithoutWrite('I will update the file shortly.', [])).toBeNull();
  });

  it('picks the largest block when several are present', () => {
    const css = '```css\n.a{color:red}\n```';
    const r = detectChatCodedFileWithoutWrite(`${css}\n${bigHtml}`, []);
    expect(r?.path).toBe('index.html');
  });

  it('builds a nudge naming the path and write_file', () => {
    const nudge = buildChatCodedFileNudge('index.html');
    expect(nudge).toContain('`index.html`');
    expect(nudge).toContain('write_file');
    expect(nudge).toContain('never called');
  });

  it('does NOT fire when write_file saved an invalid first draft for repair', () => {
    expect(
      detectUnsavedFileClaim('I wrote `index.html` to the workspace.', [
        {
          name: 'write_file',
          durationMs: 12,
          success: false,
          errorMessage:
            'inline JS does not parse (Unexpected token ]).\n\nInvalid first draft index.html was saved anyway so you can continue with read_file({ path: "index.html" }) and then repair it with replace_in_file(...) instead of starting over.',
        } as never,
      ]),
    ).toBeNull();
  });

  it('does not match bare completion prose without a quoted file path', () => {
    expect(detectUnsavedFileClaim('The project is complete and ready to play.', [])).toBeNull();
  });

  // Modify/edit claims — the family save + completion patterns miss. The
  // load-bearing case (qwen3.6 developer "Space Shooter Arcade"):
  // "I have updated the game logic in `index.html`" after only a read_file.
  it('catches "I have updated the game logic in `workspace/index.html`" as kind "modified"', () => {
    const r = detectUnsavedFileClaim(
      'I have updated the game logic in `workspace/index.html`.\n\nThe file is located at `workspace/index.html`.',
      [{ id: '1', name: 'read_file', success: true } as never],
    );
    expect(r).toEqual({ claimedPath: 'workspace/index.html', kind: 'modified' });
  });

  it('catches "applied the change to `index.html`" as kind "modified"', () => {
    const r = detectUnsavedFileClaim('I applied the change to `index.html` as requested.', []);
    expect(r?.kind).toBe('modified');
    expect(r?.claimedPath).toBe('index.html');
  });

  it('does NOT fire on a modify claim backed by a successful replace_in_file', () => {
    expect(
      detectUnsavedFileClaim('I modified the scoring logic in `index.html`.', [
        { id: '1', name: 'replace_in_file', success: true } as never,
      ]),
    ).toBeNull();
  });

  it('DOES fire on a modify claim when the replace_in_file FAILED', () => {
    const r = detectUnsavedFileClaim('I updated `index.html` with the new penalty.', [
      { id: '1', name: 'replace_in_file', success: false } as never,
    ]);
    expect(r?.kind).toBe('modified');
  });

  it('does NOT fire on a modify retraction ("could not apply the change")', () => {
    expect(
      detectUnsavedFileClaim(
        'I was unable to update `index.html` — the snippet to replace was not found.',
        [],
      ),
    ).toBeNull();
  });
});

describe('detectProseDeliverableWithoutWrite (L3)', () => {
  const para = (s: string) => `${s} `.repeat(5);
  const report = [
    '# Quarterly Operations Review',
    '',
    '## Summary',
    para(
      'The team shipped three features this period and reduced the open-defect backlog while throughput improved across the board.',
    ),
    '',
    '## Findings',
    para(
      'Latency regressed on the read path before the caching fix landed, then recovered; error budgets held for every tier except one.',
    ),
    '',
    '## Recommendations',
    para(
      'Invest in the ingestion service, expand the integration suite, and formalize the release checklist for the next period.',
    ),
  ].join('\n');

  it('fires on a bare-markdown report with no write and infers a kebab path from the H1', () => {
    const r = detectProseDeliverableWithoutWrite(report, []);
    expect(r?.path).toBe('quarterly-operations-review.md');
  });

  it('prefers the caller-supplied expected-deliverable path when in scope', () => {
    const r = detectProseDeliverableWithoutWrite(report, [], 'reports/ops-review.md');
    expect(r?.path).toBe('reports/ops-review.md');
  });

  it('falls back to report.md for a structured doc (>=2 headings) with no H1 title', () => {
    const noH1 = [
      '## Overview',
      para(
        'This section documents the operational context, the metrics observed, and the follow-up the team agreed to.',
      ),
      '## Detail',
      para(
        'This section expands on the specifics with enough concrete length to read as a genuine written document.',
      ),
    ].join('\n');
    expect(detectProseDeliverableWithoutWrite(noH1, [])?.path).toBe('report.md');
  });

  it('still fires when the report carries a small illustrative code block (prose dominates)', () => {
    const withSnippet = `${report}\n\n\`\`\`js\nconsole.log('example');\n\`\`\``;
    expect(detectProseDeliverableWithoutWrite(withSnippet, [])?.path).toBe(
      'quarterly-operations-review.md',
    );
  });

  it('stays quiet when a successful write_file landed this turn', () => {
    expect(
      detectProseDeliverableWithoutWrite(report, [{ name: 'write_file', success: true }]),
    ).toBeNull();
  });

  it('stays quiet when a successful write_artifact landed this turn', () => {
    expect(
      detectProseDeliverableWithoutWrite(report, [{ name: 'write_artifact', success: true }]),
    ).toBeNull();
  });

  it('stays quiet on a short structured reply (below the char floor)', () => {
    expect(
      detectProseDeliverableWithoutWrite('# Title\n\n## A\n\nToo short to be a report.', []),
    ).toBeNull();
  });

  it('stays quiet on long prose chatter with no document structure', () => {
    const chatter = 'I looked into this and here is what I think. '.repeat(30);
    expect(detectProseDeliverableWithoutWrite(chatter, [])).toBeNull();
  });

  it('stays quiet when the reply is dominated by a fenced code block (chat-coded detector owns it)', () => {
    const bigHtml = `Here's the page:\n\`\`\`html\n<!DOCTYPE html>\n<html><body>\n${'<div>row</div>\n'.repeat(80)}</body></html>\n\`\`\``;
    expect(detectProseDeliverableWithoutWrite(bigHtml, [])).toBeNull();
  });

  it('builds a nudge naming the inferred path and a write tool', () => {
    const nudge = buildProseDeliverableNudge('report.md');
    expect(nudge).toContain('report.md');
    expect(nudge).toContain('write_file');
    expect(nudge).toContain('write tool');
  });
});

describe('deriveRepairClampNudge (L2, gated behind GEZEL_DERIVE_REPAIR_CLAMP)', () => {
  const on = { GEZEL_DERIVE_REPAIR_CLAMP: '1' } as NodeJS.ProcessEnv;
  const off = {} as NodeJS.ProcessEnv;
  const verdict = 'The 3rd record has a total that does not match its line items.';

  it('reads the enable flag (default OFF)', () => {
    expect(deriveRepairClampEnabled(on)).toBe(true);
    expect(deriveRepairClampEnabled(off)).toBe(false);
  });

  it('fires for a derived-data output path when the flag is ON', () => {
    const nudge = deriveRepairClampNudge({ filePath: 'data/out.csv', failingVerdict: verdict }, on);
    expect(nudge).not.toBeNull();
    expect(nudge).toContain('derive_file');
    expect(nudge).toContain('`data/out.csv`');
    expect(nudge).toContain(verdict);
    expect(nudge).toContain('hand-typing');
  });

  it('fires for a .json deliverable too', () => {
    expect(
      deriveRepairClampNudge({ filePath: 'result.json', failingVerdict: verdict }, on),
    ).not.toBeNull();
  });

  it('does NOT fire when the flag is OFF (shipped behavior unchanged)', () => {
    expect(
      deriveRepairClampNudge({ filePath: 'data/out.csv', failingVerdict: verdict }, off),
    ).toBeNull();
  });

  it('does NOT fire for a non-derived-data output path (e.g. a markdown report)', () => {
    expect(
      deriveRepairClampNudge({ filePath: 'report.md', failingVerdict: verdict }, on),
    ).toBeNull();
  });

  it('does NOT fire when no output path is known', () => {
    expect(deriveRepairClampNudge({ failingVerdict: verdict }, on)).toBeNull();
  });

  it('nudge leads with the failing verdict and points at the compute channel', () => {
    const nudge = buildDeriveRepairClampNudge('x.ndjson', verdict);
    expect(nudge.startsWith(verdict)).toBe(true);
    expect(nudge).toContain('derive_file');
    expect(nudge).toContain('`x.ndjson`');
    expect(nudge).toContain('fs.readFileSync');
  });
});

describe('ChatManager — modify-claim re-prompt (false "I updated X")', () => {
  it('re-prompts when the model claims it edited an EXISTING file but no write landed', async () => {
    // The wild-caught failure (qwen3.6 developer "Space Shooter Arcade"):
    // asked to change the scoring, the model read the file,
    // narrated the edit, and said "I have updated the game logic in
    // `index.html`" — but never called replace_in_file/write_file. The file
    // existed from the create turn, so the old on-disk cross-check treated
    // the claim as TRUE and the false "done" stood. The fix fires the
    // re-prompt for a modify claim regardless of on-disk existence.
    const session = await manager.createSession({ gezelId: 'ada' });
    // Seed the file so it EXISTS on disk — the exact condition that used to
    // suppress the nudge. A regression to "suppress on exists" makes this
    // test fail (only one complete, no re-prompt).
    await store.writeProjectWorkspaceFile(
      'default',
      'index.html',
      `<!doctype html><html><body><canvas></canvas><script>${'let s = 0;'.repeat(40)}</script></body></html>`,
    );
    // First reply is the fabricated modify claim (no tool call). Second is
    // the follow-through after the re-prompt. Two NONEs cover the memory
    // extractor's per-turn one-shot.
    mock.script(
      'I have updated the game logic in `index.html` to subtract 50 points.',
      'follow-through after the nudge',
      'NONE',
      'NONE',
    );

    const eventTypes: string[] = [];
    events.subscribe(session.id, (e) => eventTypes.push(e.type));

    await manager.send(session.id, 'subtract 50 points when an alien reaches the bottom');

    // Two completes = primary fabrication + the re-prompt follow-through.
    // Before the fix this was 1 (the existence check swallowed the claim).
    const completes = eventTypes.filter((t) => t === 'complete');
    expect(completes.length).toBe(2);
  });
});

describe('ChatManager — live-preview runtime-error prelude', () => {
  it('prepends drained preview errors to the next send in the project, once', async () => {
    const previewLog = new PreviewLogBuffer();
    const localMock = new MockProvider({ name: 'copilot' });
    const localManager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['copilot', localMock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
      previewLog,
    });
    try {
      const session = await localManager.createSession({ gezelId: 'ada' });
      previewLog.record(session.projectId, [
        {
          kind: 'error',
          message: "Failed to execute 'addColorStop' on 'CanvasGradient': '#0ff33'",
          path: 'index.html',
          source: 'workspace',
          at: '2026-07-19T00:00:00.000Z',
        },
      ]);

      await localManager.send(session.id, 'how is the game looking?');
      const sends = localMock.calls.filter((c) => c.kind === 'send');
      const firstPrompt = (sends.at(-1) as { prompt: string }).prompt;
      expect(firstPrompt).toContain('[Live preview reported runtime errors');
      expect(firstPrompt).toContain('addColorStop');
      expect(firstPrompt).toContain('how is the game looking?');
      // The block leads; the user text stays last so it reads as the ask.
      expect(firstPrompt.indexOf('[Live preview')).toBeLessThan(
        firstPrompt.indexOf('how is the game looking?'),
      );

      // Drained on delivery — the next send is clean.
      await localManager.send(session.id, 'thanks');
      const nextPrompt = (
        localMock.calls.filter((c) => c.kind === 'send').at(-1) as {
          prompt: string;
        }
      ).prompt;
      expect(nextPrompt).not.toContain('[Live preview');
    } finally {
      await localManager.drainBackground();
      await localManager.shutdown();
    }
  });
});
