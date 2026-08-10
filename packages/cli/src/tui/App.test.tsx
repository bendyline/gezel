import { PassThrough } from 'node:stream';
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
    harness.unmount();
    await harness.waitUntilExit();
  }
});

describe('App interactions', () => {
  it('loads the roster and project, then creates the Meester session', async () => {
    const client = createClient();
    const harness = mountApp(client);

    await vi.waitFor(() => {
      expect(client.createChatSession).toHaveBeenCalledWith({
        gezelId: 'meester',
        projectId: 'studio',
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
    expect(harness.text()).toContain('Guildmaster');
    expect(harness.text()).toContain('New thread');
  });

  it('routes chat text and switches bare input between chat and CLI modes', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, 'hello from the terminal');
    await vi.waitFor(() => {
      expect(client.sendToChatSession).toHaveBeenCalledWith(
        'session-studio-meester',
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
        'session-studio-meester',
        'back to chat',
      );
    });
    expect(client.runTerminalCommand).toHaveBeenCalledTimes(1);
  });

  it('lists and invokes tools while rejecting malformed JSON before the client call', async () => {
    const client = createClient();
    const harness = mountApp(client);
    await ready(client, harness);

    await submit(harness, '@tools');
    await vi.waitFor(() => {
      expect(client.listSessionTools).toHaveBeenCalledWith('session-studio-meester');
    });

    await submit(harness, '@tool read_file {"path":"README.md"}');
    await vi.waitFor(() => {
      expect(client.invokeSessionTool).toHaveBeenCalledWith('session-studio-meester', 'read_file', {
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
        gezelId: 'meester',
        projectId: 'archive',
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
    />,
  );
  mounted.push(harness);
  return harness;
}

async function ready(client: ReturnType<typeof createClient>, harness: InkHarness): Promise<void> {
  await vi.waitFor(() => {
    expect(client.createChatSession).toHaveBeenCalledWith({
      gezelId: 'meester',
      projectId: 'studio',
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

function createClient() {
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
  ];
  const projects = [
    { id: 'studio', name: 'Studio' },
    { id: 'archive', name: 'Archive', workingDir: '/tmp/archive' },
  ];

  return {
    getConfig: vi.fn().mockResolvedValue(config),
    listGezels: vi.fn().mockResolvedValue({ gezels }),
    listProjects: vi.fn().mockResolvedValue({ projects }),
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
    getChatSession: vi.fn(),
    cancelChatSessionTurn: vi.fn(),
    cancelTerminalRun: vi.fn(),
    sendTerminalInput: vi.fn(),
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
