import { PassThrough } from 'node:stream';
import type {
  CatalogItemSummary,
  NativeEngineName,
  NativeEngineStatusResponse,
} from '@bendyline/gezel';
import type { ConfigResponse, GezelClient } from '@bendyline/gezel-client/node';
import { type RenderOptions, Text, render, useInput } from 'ink';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_TOOLKIT } from '../bootstrap.js';
import { BootstrapGate } from './BootstrapGate.js';

type InkHarness = ReturnType<typeof renderInk>;
const mounted: InkHarness[] = [];

afterEach(async () => {
  for (const harness of mounted.splice(0)) {
    harness.unmount();
    await harness.waitUntilExit();
  }
});

describe('BootstrapGate interactions', () => {
  it('installs every missing engine in archive-safe order and passes the detected llama backend', async () => {
    const missing = nativeStatus(false);
    const installed = nativeStatus(true);
    const client = createClient({
      getNativeEngineStatus: vi
        .fn()
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(installed),
      ensureNativeEngine: vi.fn(async (_engine, onEvent) => {
        onEvent({ type: 'progress', bytesWritten: 5, totalBytes: 10 });
        onEvent({ type: 'done', binPath: '/native/engine', cached: false });
      }),
    });
    const harness = mountGate(client);

    await vi.waitFor(() => {
      expect(harness.text()).toContain(
        'The Gezel native toolkit -- needed to run AI models locally -- is not installed yet',
      );
      expect(harness.text()).toContain('Install the Gezel native toolkit');
      expect(harness.text()).toContain(
        'Downloaded from https://github.com/bendyline/gezel/releases/',
      );
    });
    await chooseFirst(harness, 'Install the Gezel native toolkit');

    await vi.waitFor(() => expect(harness.text()).toContain('READY'));
    expect(client.getNativeEngineStatus).toHaveBeenCalledTimes(2);
    expect(client.ensureNativeEngine.mock.calls.map(([engine]) => engine)).toEqual(NATIVE_TOOLKIT);
    for (const call of client.ensureNativeEngine.mock.calls.slice(0, -1)) {
      expect(call[2]).toBeUndefined();
    }
    expect(client.ensureNativeEngine.mock.calls.at(-1)?.[2]).toBe('cuda');
  });

  it('installs the selected llama.cpp model and persists it before entering the TUI', async () => {
    const client = createClient({
      listLlamaCppModels: vi.fn().mockResolvedValue({ models: [] }),
      listCatalogItems: vi.fn(async (kind: string) =>
        kind === 'chat-model' ? { items: [chatModel()] } : { items: [] },
      ),
      installLlamaCppModel: vi.fn(async (_id, onEvent) => {
        onEvent({ type: 'done', model: { id: 'chat-model' } });
      }),
    });
    const harness = mountGate(client);

    await chooseFirst(harness, 'Recommended workshop set');

    await vi.waitFor(() => expect(harness.text()).toContain('READY'));
    expect(client.installLlamaCppModel).toHaveBeenCalledWith('chat-model', expect.any(Function));
    expect(client.updateConfig).toHaveBeenCalledWith({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'chat-model' },
      firstRunInstallError: null,
    });
  });

  it('does not accept any shared model as proof that the pinned model exists', async () => {
    const client = createClient({
      getConfig: vi.fn().mockResolvedValue({
        provider: 'llama-cpp',
        firstRunCompleted: true,
        defaultModel: { 'llama-cpp': 'missing-gemma' },
      }),
      listLlamaCppModels: vi.fn().mockResolvedValue({
        models: [{ id: 'shared-gemma', name: 'Shared Gemma' }],
      }),
    });
    const harness = mountGate(client);

    await vi.waitFor(() => {
      expect(harness.text()).toContain('Choose a local chat model');
      expect(harness.text()).toContain('Use Shared Gemma');
      expect(harness.text()).not.toContain('READY');
    });
    await chooseFirst(harness, 'Use Shared Gemma');

    await vi.waitFor(() => expect(harness.text()).toContain('READY'));
    expect(client.updateConfig).toHaveBeenCalledWith({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'shared-gemma' },
      firstRunInstallError: null,
    });
  });

  it('hands Ctrl+C ownership to the child once setup is ready', async () => {
    const onCtrlC = vi.fn();
    const client = createClient();
    const harness = mountGate(client, <InputOwner onCtrlC={onCtrlC} />);

    await vi.waitFor(() => expect(harness.text()).toContain('READY'));
    harness.write('\x03');
    await vi.waitFor(() => expect(onCtrlC).toHaveBeenCalledOnce());

    const exited = await Promise.race([
      harness.waitUntilExit().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(exited).toBe(false);
  });
});

function InputOwner({ onCtrlC }: { onCtrlC: () => void }) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onCtrlC();
  });
  return <Text>READY</Text>;
}

function mountGate(
  client: ReturnType<typeof createClient>,
  child: ReactNode = <Text>READY</Text>,
): InkHarness {
  const harness = renderInk(
    <BootstrapGate client={client as unknown as GezelClient}>{child}</BootstrapGate>,
  );
  mounted.push(harness);
  return harness;
}

async function chooseFirst(harness: InkHarness, marker: string): Promise<void> {
  await vi.waitFor(() => expect(harness.text()).toContain(marker));
  // Ink can paint the choice list just before React commits useInput's
  // subscription. Under a fully parallel workspace run, writing in that tiny
  // gap drops the synthetic keypress and leaves this test on the selector.
  // Give the effect one event-loop turn, then use the explicit quick-select
  // key so this tests the same public interaction without racing the commit.
  await new Promise((resolve) => setTimeout(resolve, 10));
  harness.write('1');
}

function nativeStatus(installed: boolean): NativeEngineStatusResponse {
  return {
    release: '9.9.9',
    pinned: true,
    platformKey: 'linux-x64',
    llamaBackend: 'cuda',
    engines: NATIVE_TOOLKIT.map((name) => ({ name, installed })),
  };
}

function createClient(overrides: Record<string, unknown> = {}) {
  const config = {
    provider: 'llama-cpp',
    firstRunCompleted: true,
    defaultModel: { 'llama-cpp': 'installed' },
  } as ConfigResponse;
  return {
    getMemoryProfile: vi.fn().mockResolvedValue({
      platform: 'linux',
      gpuVramBytes: 12 * 1024 ** 3,
      totalRamBytes: 32 * 1024 ** 3,
      usableBytes: 20 * 1024 ** 3,
    }),
    getConfig: vi.fn().mockResolvedValue(config),
    listCatalogItems: vi.fn().mockResolvedValue({ items: [] }),
    getNativeEngineStatus: vi.fn().mockResolvedValue(nativeStatus(true)),
    listLlamaCppModels: vi.fn().mockResolvedValue({ models: [{ id: 'installed' }] }),
    listMlxModels: vi.fn().mockResolvedValue({ models: [] }),
    listAudioCatalog: vi.fn().mockResolvedValue({ stt: [], tts: [] }),
    listRecognitionCatalog: vi.fn().mockResolvedValue({ models: [] }),
    listInstalledImageModels: vi.fn().mockResolvedValue({ models: [] }),
    listInstalledVideoModels: vi.fn().mockResolvedValue({ models: [] }),
    listInstalledSttModels: vi.fn().mockResolvedValue({ models: [] }),
    listInstalledTtsModels: vi.fn().mockResolvedValue({ models: [] }),
    listInstalledRecognitionModels: vi.fn().mockResolvedValue({ models: [] }),
    ensureNativeEngine: vi.fn(),
    installLlamaCppModel: vi.fn(),
    installMlxModel: vi.fn(),
    updateConfig: vi.fn().mockResolvedValue(config),
    ...overrides,
  };
}

function chatModel(): CatalogItemSummary {
  const bytes = 2 * 1024 ** 3;
  return {
    sourceId: 'test',
    kind: 'chat-model',
    manifest: {
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'chat-model',
      name: 'Chat Model',
      description: '',
      tags: [],
      maintainer: { name: 'test' },
      licenseClass: 'open',
      recoScore: 100,
      version: '1.0.0',
      releasedAt: '2026-01-01',
      parameterSize: '1B',
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
  } as unknown as CatalogItemSummary;
}

type TestInput = PassThrough & NodeJS.ReadStream & { isTTY: true };
type TestOutput = PassThrough & NodeJS.WriteStream & { isTTY: true; columns: number; rows: number };

function renderInk(node: ReactNode, options: Pick<RenderOptions, 'exitOnCtrlC'> = {}) {
  const stdin = new PassThrough() as TestInput;
  Object.defineProperty(stdin, 'isTTY', { value: true });
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const output = () => {
    const stream = new PassThrough() as TestOutput;
    Object.defineProperties(stream, {
      isTTY: { value: true },
      columns: { value: 100, writable: true },
      rows: { value: 30, writable: true },
    });
    return stream;
  };
  const stdout = output();
  const stderr = output();
  let rendered = '';
  stdout.on('data', (chunk: Buffer | string) => {
    rendered += chunk.toString();
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
    write(input: string) {
      stdin.write(input);
    },
    text() {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal output
      return rendered.replace(/\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
    },
  };
}
