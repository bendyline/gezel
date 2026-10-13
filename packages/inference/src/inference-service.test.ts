import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingSessionBase } from '@bendyline/gezel/local-loop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningInferenceService, startService } from './inference-service.js';
import type { LLMProvider, SendAndWaitOpts } from './providers/types.js';
let running: RunningInferenceService | undefined;
let home: string | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (home) await rm(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
describe('in-process inference host', () => {
  it('serves authenticated local inference without product state or network access', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-inference-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected network access');
      }),
    );
    let disconnected = 0;
    class Session extends StreamingSessionBase {
      async sendAndWait() {
        this.emitDelta('Hello from inference');
        return 'Hello from inference';
      }
      async disconnect() {
        disconnected++;
      }
    }
    const provider: LLMProvider = {
      name: 'llama-cpp',
      supportsPriorMessages: true,
      initialize: async () => {},
      shutdown: async () => {},
      listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
      createSession: async () => new Session(),
    };
    running = await startService({ home, providers: new Map([['llama-cpp', provider]]) });
    const request = (path: string, body?: unknown, token = running!.clientToken) =>
      running!.fetch(`http://gezel.local${path}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });
    expect(running.profile).toBe('embedded-inference');
    expect(running.port).toBe(0);
    expect((await request('/v1/models', undefined, 'invalid')).status).toBe(401);
    const models = await (await request('/v1/models')).json();
    expect(models.data.length).toBeGreaterThan(10);
    expect(models.data.some((model: { id: string }) => model.id === 'llama-cpp:fixture')).toBe(
      true,
    );
    const response = await request('/v1/chat/completions', {
      model: 'llama-cpp:fixture',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello from inference');
    expect(disconnected).toBe(1);
    expect(
      (
        await request('/v1/chat/completions', {
          model: 'openai:any',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).status,
    ).toBe(403);
    expect((await request('/api/projects')).status).toBe(404);
    expect((await request('/v1/knowledge/state')).status).toBe(200);
    expect(await readdir(home)).not.toContain('gezels');
    expect(await readdir(home)).not.toContain('projects');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await running.stop();
    await running.stop();
    await expect(request('/v1/models')).rejects.toThrow('stopped');
  });
  it('cancels an active stream when its host closes and releases the home lock', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-inference-stop-'));
    let disconnected = false;
    class Session extends StreamingSessionBase {
      async sendAndWait(_prompt: string, opts?: SendAndWaitOpts) {
        this.emitDelta('partial');
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) resolve();
          else opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'partial';
      }
      async disconnect() {
        disconnected = true;
      }
    }
    const provider: LLMProvider = {
      name: 'llama-cpp',
      initialize: async () => {},
      shutdown: async () => {},
      listModels: async () => [],
      createSession: async () => new Session(),
    };
    running = await startService({ home, providers: new Map([['llama-cpp', provider]]) });
    const response = await running.fetch('http://gezel.local/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${running.clientToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-cpp:fixture',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await running.stop();
    await reader.cancel();
    await vi.waitFor(() => expect(disconnected).toBe(true));
    running = await startService({ home });
  });
});
