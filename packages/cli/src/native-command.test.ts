import type {
  NativeEngineName,
  NativeEngineResolveEvent,
  NativeEngineStatusResponse,
} from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import {
  type NativeCommandClient,
  formatNativeList,
  formatNativeStatus,
  installNativeToolkit,
  parseNativeVariant,
} from './native-command.js';

function status(overrides: Partial<NativeEngineStatusResponse> = {}): NativeEngineStatusResponse {
  return {
    release: '0.1.31',
    pinned: true,
    platformKey: 'linux-x64',
    llamaBackend: 'cuda',
    engines: [
      { name: 'uv', installed: true, path: '/native/uv' },
      { name: 'sd-server', installed: false },
      { name: 'whisper-server', installed: false },
      { name: 'llama-server', installed: false },
      { name: 'ds4-server', installed: false },
    ],
    ...overrides,
  };
}

function clientFor(
  initial: NativeEngineStatusResponse,
  events: Partial<Record<NativeEngineName, NativeEngineResolveEvent[]>> = {},
) {
  const ensureNativeEngine = vi.fn(
    async (
      engine: NativeEngineName,
      listener: (event: NativeEngineResolveEvent) => void,
      _variant?: string,
    ) => {
      for (const event of events[engine] ?? [
        { type: 'done' as const, binPath: `/native/${engine}`, cached: false },
      ]) {
        listener(event);
      }
    },
  );
  const getNativeEngineStatus = vi.fn().mockResolvedValue(initial);
  return {
    client: { ensureNativeEngine, getNativeEngineStatus } as unknown as NativeCommandClient,
    ensureNativeEngine,
    getNativeEngineStatus,
  };
}

describe('parseNativeVariant', () => {
  it('accepts every published llama backend and an omitted value', () => {
    expect(parseNativeVariant(undefined)).toBeUndefined();
    for (const variant of ['cuda', 'vulkan', 'metal', 'cpu']) {
      expect(parseNativeVariant(variant)).toBe(variant);
    }
  });

  it('rejects unknown variants before connecting to the daemon', () => {
    expect(() => parseNativeVariant('rocm')).toThrow(
      '--variant must be one of cuda, vulkan, metal, cpu (got "rocm")',
    );
  });
});

describe('native status formatting', () => {
  it('reports the release, trust, platform, backend, and installed count', () => {
    expect(formatNativeStatus(status())).toBe(
      [
        'release: native-v0.1.31 (verified pin)',
        'platform: linux-x64',
        'llama backend: cuda',
        'toolkit: 1/4 installed',
      ].join('\n'),
    );
  });

  it('makes unsupported and unpinned states prominent', () => {
    const output = formatNativeStatus(
      status({ pinned: false, platformKey: null, llamaBackend: undefined }),
    );
    expect(output).toContain('unpinned — downloads disabled');
    expect(output).toContain('unsupported — downloads unavailable');
    expect(output).toContain('llama backend: automatic');
  });

  it('lists every executable with its path or missing state', () => {
    const output = formatNativeList(status());
    expect(output).toContain('native-v0.1.31 · linux-x64 · verified');
    expect(output).toContain('uv                  installed   /native/uv');
    expect(output).toContain('llama-server        missing');
    expect(output).toContain('ds4-server          missing');
  });
});

describe('installNativeToolkit', () => {
  it('ensures the toolkit in archive order and passes the variant only to llama-server', async () => {
    const { client, ensureNativeEngine, getNativeEngineStatus } = clientFor(status());
    const writes: string[] = [];

    await installNativeToolkit(client, {
      variant: 'vulkan',
      output: { writeProgress: (text) => writes.push(text) },
    });

    expect(ensureNativeEngine.mock.calls.map(([engine]) => engine)).toEqual([
      'uv',
      'sd-server',
      'whisper-server',
      'llama-server',
    ]);
    expect(ensureNativeEngine.mock.calls.map((call) => call[2])).toEqual([
      undefined,
      undefined,
      undefined,
      'vulkan',
    ]);
    expect(getNativeEngineStatus).toHaveBeenCalledTimes(2);
    expect(writes.join('')).toContain('llama-server: ready');
  });

  it('uses the detected backend when no explicit variant is supplied', async () => {
    const { client, ensureNativeEngine } = clientFor(status({ llamaBackend: 'cuda' }));

    await installNativeToolkit(client, {
      output: { writeProgress: () => {} },
    });

    expect(ensureNativeEngine.mock.calls.at(-1)?.[2]).toBe('cuda');
  });

  it('surfaces progress, verification, retries, and cached completion', async () => {
    const { client } = clientFor(status(), {
      uv: [
        { type: 'progress', bytesWritten: 512, totalBytes: 1024 },
        { type: 'verifying', what: 'sha256' },
        { type: 'retrying', attempt: 2, maxAttempts: 3, delayMs: 250, reason: 'reset' },
        { type: 'done', binPath: '/native/uv', cached: true },
      ],
    });
    const writes: string[] = [];

    await installNativeToolkit(client, {
      output: { writeProgress: (text) => writes.push(text) },
    });

    const output = writes.join('');
    expect(output).toContain('uv:  50%  512 B/1.0 KiB');
    expect(output).toContain('uv: verifying sha256');
    expect(output).toContain('uv: retry 2/3 in 250ms — reset');
    expect(output).toContain('uv: ready (cached)');
  });

  it('stops at and reports a terminal SSE error', async () => {
    const { client, ensureNativeEngine } = clientFor(status(), {
      'sd-server': [{ type: 'error', error: 'checksum mismatch' }],
    });
    const writes: string[] = [];

    await expect(
      installNativeToolkit(client, {
        output: { writeProgress: (text) => writes.push(text) },
      }),
    ).rejects.toThrow('native install failed for sd-server: checksum mismatch');
    expect(ensureNativeEngine.mock.calls.map(([engine]) => engine)).toEqual(['uv', 'sd-server']);
    expect(writes.join('')).toContain('sd-server: error — checksum mismatch');
  });

  it.each([
    [status({ pinned: false }), 'no verified native release pin'],
    [status({ platformKey: null }), 'no supported build exists'],
  ])('refuses unavailable downloads before ensuring anything', async (snapshot, message) => {
    const { client, ensureNativeEngine } = clientFor(snapshot);

    await expect(
      installNativeToolkit(client, { output: { writeProgress: () => {} } }),
    ).rejects.toThrow(message);
    expect(ensureNativeEngine).not.toHaveBeenCalled();
  });
});
