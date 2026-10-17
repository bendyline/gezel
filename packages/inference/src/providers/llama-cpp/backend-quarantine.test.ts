import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordLlamaQuarantine } from '@bendyline/gezel/native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptLlamaFallback,
  liftLlamaQuarantine,
  llamaQuarantineView,
} from './backend-quarantine.js';

const ENV = [
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_LLAMA_SERVER_BACKEND',
  'GEZEL_LLAMA_DETECTED_BACKEND',
  'GEZEL_LLAMA_QUARANTINED',
] as const;

let root: string;
let home: string;
let saved: Partial<Record<(typeof ENV)[number], string>>;
const build = (backend: string) =>
  join(root, 'native', `win32-x64-${backend}`, 'gezel-llama-server.exe');

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  root = await mkdtemp(join(tmpdir(), 'gezel-backend-quarantine-'));
  home = join(root, 'home');
  for (const backend of ['vulkan', 'cpu']) {
    await mkdir(join(root, 'native', `win32-x64-${backend}`), { recursive: true });
    await writeFile(build(backend), `${backend} build`);
  }
  process.env.GEZEL_LLAMA_SERVER_BIN = build('vulkan');
  process.env.GEZEL_LLAMA_SERVER_BACKEND = 'vulkan';
  process.env.GEZEL_LLAMA_DETECTED_BACKEND = 'vulkan';
  delete process.env.GEZEL_LLAMA_QUARANTINED;
});

afterEach(async () => {
  for (const name of ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function quarantineVulkan(): void {
  recordLlamaQuarantine(home, {
    backend: 'vulkan',
    binaryPath: build('vulkan'),
    signal: 'exit:0xc0000005',
    reason: 'access violation before ready',
    crashes: 3,
  });
}

describe('llama backend quarantine in the engine process', () => {
  it('moves the process to the build beside a quarantined one', () => {
    quarantineVulkan();

    const fallback = adoptLlamaFallback(home, build('vulkan'), 'vulkan');

    expect(fallback).toMatchObject({ backend: 'cpu', path: build('cpu') });
    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(build('cpu'));
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cpu');
    expect(process.env.GEZEL_LLAMA_QUARANTINED).toBe('vulkan');
    expect(llamaQuarantineView(home)).toMatchObject({
      entries: [{ backend: 'vulkan', signal: 'exit:0xc0000005', crashes: 3 }],
      strikeThreshold: 3,
      running: 'cpu',
    });
  });

  it('lifting a quarantine moves the process back to the build the hardware supports', () => {
    quarantineVulkan();
    adoptLlamaFallback(home, build('vulkan'), 'vulkan');

    const { cleared, restored } = liftLlamaQuarantine(home, 'vulkan', { pinned: false });

    expect(cleared).toBe(true);
    expect(restored).toMatchObject({ backend: 'vulkan', path: build('vulkan') });
    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(build('vulkan'));
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('vulkan');
    expect(process.env.GEZEL_LLAMA_QUARANTINED).toBeUndefined();
    expect(llamaQuarantineView(home).entries).toEqual([]);
  });

  it('leaves a pinned backend where the person put it', () => {
    quarantineVulkan();
    adoptLlamaFallback(home, build('vulkan'), 'vulkan');

    const { cleared, restored } = liftLlamaQuarantine(home, 'vulkan', { pinned: true });

    expect(cleared).toBe(true);
    expect(restored).toBeNull();
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cpu');
  });

  it('stops listing a quarantine once an update replaced the build', async () => {
    quarantineVulkan();
    adoptLlamaFallback(home, build('vulkan'), 'vulkan');

    await writeFile(build('vulkan'), 'a newer vulkan build, with different bytes');

    expect(llamaQuarantineView(home).entries).toEqual([]);
  });
});
