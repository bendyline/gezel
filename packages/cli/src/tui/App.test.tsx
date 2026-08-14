import { PassThrough } from 'node:stream';
import type { ChatEventEnvelope } from '@bendyline/gezel';
import type { ConfigResponse, GezelClient } from '@bendyline/gezel-client/node';
import { type RenderOptions, render } from 'ink';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const streamHooks = vi.hoisted(() => ({
  useProjectEvents: vi.fn(),
  useTerminalEvents: vi.fn(),
}));

vi.mock('./streams.js', () => streamHooks);

type InkHarness = ReturnType<typeof renderInk>;
const mounted: InkHarness[] = [];

beforeEach(() => {
  streamHooks.useProjectEvents.mockClear();
  streamHooks.useTerminalEvents.mockClear();
});

afterEach(async () => {
  for (const harness of mounted.splice(0)) {
    const exit = harness.waitUntilExit();
    harness.unmount();
    await exit;
  }
});

describe('App interactions', () => {
  it('loads the roster and project, then creates the project voorman session', async () => {
    const client = createClient();
    const harness = mountApp(client);

    await vi.waitFor(() => {
      // The TUI pins its boring presentation mode onto the sessions it
      // creates so the daemon's prompt rendering matches its labels.
      expect(client.createChatSession).toHaveBeenCalledWith({
        gezelId: 'foreman',
        projectId: 'studio',
        roleBasedNameOnlyMode: true,
      });
    });
    await harness.waitUntilRenderFlush();

    expect(client.getConfig).toHaveBeenCalledOnce();
    expect(client.listGezels).toHaveBeenCalledOnce();
    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(client.listQuestions).toHaveBeenCalledWith({ projectId: 'studio', pending: true });
    expect(client.listProjectTasks).toHaveBeenCalledWith('studio');
    expect(client.listProjectCraftbooks).toHaveBeenCalledWith('studio');
    expect(streamHooks.useProjectEvents).toHaveBeenCalledWith(
      client,
      'studio',
      expect.any(Function),
    );
    expect(streamHooks.useTerminalEvents).toHaveBeenCalledWith(
      client,
      'studio',
      expect.any(Function),
    );
    expect(harness.text()).toContain('Studio');
    expect(harness.text()).toContain('Voorman');
    expect(harness.text()).toContain('New thread');
  });

  it('shows an edit-permission note when the initial folder is read-only', async () => {
    const client = createClient({ studioProject: { workingDir: '/tmp/studio' } });
    const harness = mountApp(client);
    await ready(client, harness);

    const bootOutput = harness.text();
    expect(bootOutput).toContain('Note: this folder is read-only to gezel');
    expect(bootOutput).toContain('analysis and writing');
    expect(bootOutput).toContain(
      "/allow edits command to permit gezel to edit this folder's contents",
    );
  });

  it('does not show the edit-permission note for an editable initial project', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    expect(harness.text()).not.toContain('Note: this folder is read-only to gezel');
  });

  it('routes chat text and switches bare input between chat and CLI modes', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, 'hello from the terminal');
    await vi.waitFor(() => {
      expect(client.sendToChatSession).toHaveBeenCalledWith(
        'session-studio-foreman',
        'hello from the terminal',
      );
    });

    await submit(harness, '/cli');
    await submit(harness, 'pwd');
    await vi.waitFor(() => {
      expect(client.runTerminalCommand).toHaveBeenCalledWith('studio', {
        workingDir: '',
        input: 'pwd',
        columns: 98,
      });
    });

    await submit(harness, '/chat');
    await submit(harness, 'back to chat');
    await vi.waitFor(() => {
      expect(client.sendToChatSession).toHaveBeenLastCalledWith(
        'session-studio-foreman',
        'back to chat',
      );
    });
    expect(client.runTerminalCommand).toHaveBeenCalledTimes(1);
  });

  it('queues input as a nudge and shows it as pending while the focused turn is busy', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    projectEventHandler()({
      sessionId: 'session-studio-foreman',
      gezelId: 'foreman',
      projectId: 'studio',
      event: {
        type: 'engine_phase',
        provider: 'llama-cpp',
        phase: 'prefill',
        progress: 0.54,
      },
    });
    await harness.waitUntilRenderFlush();

    await submit(harness, 'please also inspect the tests');
    expect(client.sendToChatSession).toHaveBeenLastCalledWith('session-studio-foreman', {
      message: 'please also inspect the tests',
      nudge: true,
    });

    projectEventHandler()({
      sessionId: 'session-studio-foreman',
      gezelId: 'foreman',
      projectId: 'studio',
      event: {
        type: 'queue_enqueued',
        queueId: 'queue-1',
        preview: 'please also inspect the tests',
        enqueuedAt: '2026-08-13T12:00:00.000Z',
        nudge: true,
      },
    });
    await harness.waitUntilRenderFlush();

    expect(harness.text()).toContain('pending: please also inspect the tests');
  });

  it('uses role-based labels for other live threads and focus targets', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    projectEventHandler()({
      sessionId: 'session-studio-builder',
      gezelId: 'builder',
      projectId: 'studio',
      event: { type: 'delta', content: 'I am checking the implementation.' },
    });
    await vi.waitFor(() => {
      expect(harness.text()).toContain('Developer: I am checking the implementation.');
    });
    expect(harness.text()).not.toContain('Bo: I am checking the implementation.');

    await submit(harness, '/focus');
    await vi.waitFor(() => {
      expect(harness.text()).toContain('Send into which chat?');
      expect(harness.text()).toContain('Developer');
    });
    expect(harness.text()).not.toContain('Bo');
  });

  it('refreshes the roster for task-recruited gezels and rewrites assignment updates', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    client.testGezels.push({
      id: 'vasile',
      name: 'Vasile',
      role: 'Security Architect',
      roleBasedName: 'security-architect',
      updatedAt: '2026-08-13T00:00:00.000Z',
    });
    projectEventHandler()({
      sessionId: '',
      gezelId: '',
      projectId: 'studio',
      event: {
        type: 'task_event',
        eventId: 'event-1',
        kind: 'task.entry.dispatched',
        summary: 'Task studio/1 entry step "model-system" handed to Vasile',
        at: '2026-08-13T12:00:00.000Z',
        taskRef: 'studio/1',
        gezelId: 'vasile',
      },
    });
    projectEventHandler()({
      sessionId: 'task-session-1',
      gezelId: 'vasile',
      projectId: 'studio',
      event: { type: 'delta', content: 'I am mapping the trust boundaries.' },
    });

    await vi.waitFor(() => {
      expect(client.listGezels).toHaveBeenCalledTimes(2);
      expect(harness.text()).toContain('handed to security-architect');
      expect(harness.text()).toContain('security-architect: I am mapping the trust boundaries.');
    });
    expect(harness.text()).not.toContain('handed to Vasile');
    expect(harness.text()).not.toContain('vasile: I am mapping');
  });

  it('changes the install-wide engagement mode by name or through the picker', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/mode reactive+tasks');
    await vi.waitFor(() => {
      expect(client.updateConfig).toHaveBeenCalledWith({ aiEngagementMode: 'scheduled' });
    });
    expect(harness.text()).toContain('AI mode → Reactive + tasks.');

    await submit(harness, '/mode full-play');
    await vi.waitFor(() => {
      expect(client.updateConfig).toHaveBeenLastCalledWith({ aiEngagementMode: 'proactive' });
    });

    await submit(harness, '/mode');
    await vi.waitFor(() => {
      expect(harness.text()).toContain('Choose AI engagement mode');
      expect(harness.text()).toContain('Read-only');
      expect(harness.text()).toContain('Full play');
    });
  });

  it('opens model downloads from the model picker, then uses the result', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/model');
    await vi.waitFor(() => {
      expect(harness.text()).toContain(
        'Choose engine + model - models are downloaded from Hugging Face (huggingface.co)',
      );
      expect(harness.text()).toContain('Download a new model…');
    });
    await pressKey(harness, '\u001B[B');
    await pressKey(harness, '\r');
    await vi.waitFor(() => {
      expect(harness.text()).toContain('Download and use an on-device model');
      expect(harness.text()).toContain('Fresh Gemma (test)');
    });
    await pressKey(harness, '\r');

    await vi.waitFor(
      () => {
        expect(client.installLlamaCppModel).toHaveBeenCalledWith(
          'fresh-gemma',
          expect.any(Function),
        );
        expect(client.updateGezelSettings).toHaveBeenCalledWith('foreman', {
          provider: 'llama-cpp',
          model: 'fresh-gemma',
          reasoningEffort: null,
        });
        expect(harness.text()).toContain('model → llama.cpp · Fresh Gemma');
      },
      { timeout: 5_000 },
    );
  });

  it('opens the same download picker directly with /model download', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/model download');

    await vi.waitFor(() => {
      expect(harness.text()).toContain('Download and use an on-device model');
      expect(harness.text()).toContain('Fresh Gemma (test)');
    });
  });

  it('allows and disallows managed project edits', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/allow edits');
    await vi.waitFor(() => {
      expect(client.updateProject).toHaveBeenCalledWith('studio', {
        managedWorkspaceWritePolicy: 'allow',
      });
    });
    expect(harness.text()).toContain(
      'Project edits allowed. Built-in tools and background work can now modify Studio.',
    );

    await submit(harness, '/disallow edits');
    await vi.waitFor(() => {
      expect(client.updateProject).toHaveBeenLastCalledWith('studio', {
        managedWorkspaceWritePolicy: 'deny',
      });
    });
    expect(harness.text()).toContain(
      'Project edits disallowed. Built-in tools and background work are now read-only in Studio.',
    );
    expect(harness.text()).toContain('read-only');
  });

  it('allows and disallows provider-native edits for Codex and Claude', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/allow codexedits');
    await vi.waitFor(() => {
      expect(client.updateProject).toHaveBeenLastCalledWith('studio', {
        codexPermissionMode: 'edit',
      });
    });
    expect(harness.text()).toContain('Codex edits allowed. Codex sessions can now modify Studio.');

    await submit(harness, '/disallow codexedits');
    await vi.waitFor(() => {
      expect(client.updateProject).toHaveBeenLastCalledWith('studio', {
        codexPermissionMode: 'plan',
      });
    });
    expect(harness.text()).toContain(
      'Codex edits disallowed. Codex sessions are now read-only in Studio.',
    );

    await submit(harness, '/allow claudeedits');
    await vi.waitFor(() => {
      expect(client.updateProject).toHaveBeenLastCalledWith('studio', {
        claudePermissionMode: 'acceptEdits',
      });
    });
    expect(harness.text()).toContain(
      'Claude edits allowed. Claude sessions can now modify Studio.',
    );

    await submit(harness, '/disallow claudeedits');
    await vi.waitFor(() => {
      expect(client.updateProject).toHaveBeenLastCalledWith('studio', {
        claudePermissionMode: 'plan',
      });
    });
    expect(harness.text()).toContain(
      'Claude edits disallowed. Claude sessions are now read-only in Studio.',
    );
  });

  it('shows permission usage without changing the project for unsupported names', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/allow');
    await vi.waitFor(() => {
      expect(harness.text()).toContain('usage: /allow edits|codexedits|claudeedits');
    });
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it('lists and invokes tools while rejecting malformed JSON before the client call', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '@tools');
    await vi.waitFor(() => {
      expect(client.listSessionTools).toHaveBeenCalledWith('session-studio-foreman');
    });

    await submit(harness, '@tool read_file {"path":"README.md"}');
    await vi.waitFor(() => {
      expect(client.invokeSessionTool).toHaveBeenCalledWith('session-studio-foreman', 'read_file', {
        path: 'README.md',
      });
    });

    await submit(harness, '@tool read_file {not-json}');
    await vi.waitFor(() => {
      expect(harness.text()).toContain('invalid JSON args for @tool read_file');
    });
    expect(client.invokeSessionTool).toHaveBeenCalledTimes(1);
    expect(harness.text()).toContain('tools (2): read_file, write_file');
    expect(harness.text()).toContain('contents of README.md');
  });

  it('switches projects through the picker and starts a correctly scoped session', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '/project');
    await vi.waitFor(() => {
      expect(harness.text()).toContain('Switch project');
    });
    harness.write('\u001B[B');
    await harness.waitUntilRenderFlush();
    harness.write('\r');

    await vi.waitFor(() => {
      expect(client.createChatSession).toHaveBeenLastCalledWith({
        gezelId: 'archive-foreman',
        projectId: 'archive',
        roleBasedNameOnlyMode: true,
      });
    });
    await harness.waitUntilRenderFlush();

    expect(client.listQuestions).toHaveBeenLastCalledWith({ projectId: 'archive', pending: true });
    expect(client.listProjectTasks).toHaveBeenCalledWith('archive');
    expect(client.listProjectCraftbooks).toHaveBeenCalledWith('archive');
    expect(harness.text()).toContain('Archive');
  });
});

function mountApp(client: ReturnType<typeof createClient>): InkHarness {
  const harness = renderInk(
    <App
      client={client as unknown as GezelClient}
      initialProjectId="studio"
      initialProjectName="Studio"
      initialGezelId="foreman"
    />,
  );
  mounted.push(harness);
  return harness;
}

async function ready(client: ReturnType<typeof createClient>, harness: InkHarness): Promise<void> {
  await vi.waitFor(() => {
    expect(client.createChatSession).toHaveBeenCalledWith({
      gezelId: 'foreman',
      projectId: 'studio',
      roleBasedNameOnlyMode: true,
    });
  });
  await harness.waitUntilRenderFlush();
}

async function submit(harness: InkHarness, value: string): Promise<void> {
  harness.write(value);
  await harness.waitUntilRenderFlush();
  harness.write('\r');
  await harness.waitUntilRenderFlush();
}

/** Let Ink install the active overlay's input effect before sending a synthetic key. */
async function pressKey(harness: InkHarness, key: string): Promise<void> {
  await harness.waitUntilRenderFlush();
  harness.write(key);
  await harness.waitUntilRenderFlush();
}

function projectEventHandler(): (event: ChatEventEnvelope) => void {
  const call = streamHooks.useProjectEvents.mock.calls.at(-1);
  if (!call) throw new Error('project event hook was not registered');
  return call[2] as (event: ChatEventEnvelope) => void;
}

function createClient(opts?: {
  studioProject?: {
    workingDir?: string;
    managedWorkspaceWritePolicy?: 'auto' | 'allow' | 'deny';
  };
}) {
  const config = {
    provider: 'openai',
    meesterGezelId: 'meester',
    defaultModel: { openai: 'gpt-test' },
    hasGithubToken: false,
    hasOpenaiApiKey: true,
    hasAnthropicApiKey: false,
    hasBraveSearchApiKey: false,
    hasTavilyApiKey: false,
    hasWebhookBearerToken: false,
    hasWebhookBasicAuth: false,
  } as ConfigResponse;
  const gezels = [
    {
      id: 'meester',
      name: 'Mira',
      role: 'Meester',
      roleBasedName: 'Guildmaster',
      updatedAt: '2026-08-09T00:00:00.000Z',
    },
    {
      id: 'builder',
      name: 'Bo',
      role: 'Developer',
      roleBasedName: 'Developer',
      updatedAt: '2026-08-09T00:00:00.000Z',
    },
    {
      id: 'foreman',
      name: 'Oier',
      role: 'Voorman',
      roleBasedName: 'Voorman',
      templateId: 'voorman',
      updatedAt: '2026-08-09T00:00:00.000Z',
    },
    {
      id: 'archive-foreman',
      name: 'Ada',
      role: 'Voorman',
      roleBasedName: 'Voorman',
      templateId: 'voorman',
      updatedAt: '2026-08-09T00:00:00.000Z',
    },
  ];
  const projects = [
    { id: 'studio', name: 'Studio', voormanGezelId: 'foreman', ...opts?.studioProject },
    {
      id: 'archive',
      name: 'Archive',
      workingDir: '/tmp/archive',
      voormanGezelId: 'archive-foreman',
    },
  ];

  return {
    testGezels: gezels,
    getConfig: vi.fn().mockResolvedValue(config),
    updateConfig: vi.fn(async (patch: Partial<ConfigResponse>) => ({ ...config, ...patch })),
    listGezels: vi.fn(async () => ({ gezels: [...gezels] })),
    listProjects: vi.fn().mockResolvedValue({ projects }),
    updateProject: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      ...projects.find((project) => project.id === id),
      ...patch,
    })),
    updateGezelSettings: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      ...gezels.find((gezel) => gezel.id === id),
      ...patch,
    })),
    createChatSession: vi.fn(async ({ gezelId, projectId }) => ({
      id: `session-${projectId}-${gezelId}`,
      gezelId,
      projectId,
      title: 'New session',
      providerName: 'openai',
      createdAt: '2026-08-09T00:00:00.000Z',
      lastActivityAt: '2026-08-09T00:00:00.000Z',
      archived: false,
      messages: [],
    })),
    listQuestions: vi.fn().mockResolvedValue({ questions: [] }),
    listProjectTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    listProjectCraftbooks: vi.fn().mockResolvedValue({
      items: [],
      suggestedIds: [],
      missingToolsets: {},
      projectType: null,
    }),
    sendToChatSession: vi.fn().mockResolvedValue(undefined),
    runTerminalCommand: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    listSessionTools: vi.fn().mockResolvedValue({
      tools: [{ name: 'read_file' }, { name: 'write_file' }],
    }),
    invokeSessionTool: vi.fn().mockResolvedValue({ text: 'contents of README.md' }),
    listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    getCopilotStatus: vi.fn().mockResolvedValue({ available: false }),
    getMemoryProfile: vi.fn().mockResolvedValue({
      platform: 'win32',
      totalRamBytes: 32 * 1024 ** 3,
      gpuVramBytes: 12 * 1024 ** 3,
      usableBytes: 10 * 1024 ** 3,
    }),
    listProviderModels: vi.fn(async (provider: string) => ({
      models:
        provider === 'llama-cpp'
          ? [{ id: 'installed-gemma', name: 'Installed Gemma' }]
          : provider === 'openai'
            ? [{ id: 'gpt-test', name: 'GPT Test' }]
            : [],
    })),
    listCatalogItems: vi.fn().mockResolvedValue({ items: [downloadableChatModel()] }),
    installLlamaCppModel: vi.fn(async (_id: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'done', id: 'fresh-gemma' });
    }),
    installMlxModel: vi.fn(),
    cancelLlamaCppModelInstall: vi.fn().mockResolvedValue({ aborted: true }),
    cancelMlxModelInstall: vi.fn().mockResolvedValue({ aborted: true }),
    getChatSession: vi.fn(),
    cancelChatSessionTurn: vi.fn(),
    cancelTerminalRun: vi.fn(),
    sendTerminalInput: vi.fn(),
  };
}

function downloadableChatModel() {
  const bytes = 2 * 1024 ** 3;
  return {
    sourceId: 'test',
    kind: 'chat-model',
    manifest: {
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'fresh-gemma',
      name: 'Fresh Gemma',
      description: '',
      tags: [],
      maintainer: { name: 'test' },
      licenseClass: 'open',
      recoScore: 100,
      version: '1.0.0',
      releasedAt: '2026-01-01',
      parameterSize: '2B',
      approxSizeBytes: bytes,
      supportsTools: true,
      llamaCpp: {
        huggingfaceRepo: 'test/model',
        filename: 'model.gguf',
        sha256: '0'.repeat(64),
        approxSizeBytes: bytes,
        residentBytes: bytes,
      },
      availableVersions: [],
    },
  };
}

type TestInput = PassThrough & NodeJS.ReadStream & { isTTY: true };
type TestOutput = PassThrough &
  NodeJS.WriteStream & {
    isTTY: true;
    columns: number;
    rows: number;
  };

/** Exercise Ink's real input parser without depending on the process TTY. */
function renderInk(node: ReactNode, options: Pick<RenderOptions, 'exitOnCtrlC'> = {}) {
  const stdin = new PassThrough() as TestInput;
  Object.defineProperty(stdin, 'isTTY', { value: true });
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough() as TestOutput;
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 100, writable: true },
    rows: { value: 30, writable: true },
  });
  const stderr = new PassThrough() as TestOutput;
  Object.defineProperties(stderr, {
    isTTY: { value: true },
    columns: { value: 100, writable: true },
    rows: { value: 30, writable: true },
  });

  let output = '';
  stdout.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const instance = render(node, {
    stdin,
    stdout,
    stderr,
    debug: true,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: options.exitOnCtrlC ?? false,
    maxFps: 1_000,
  });

  return {
    ...instance,
    stdin,
    stdout,
    stderr,
    write(input: string): void {
      stdin.write(input);
    },
    text(): string {
      return stripAnsi(output);
    },
  };
}

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI terminal output
  return value.replace(/\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
}
