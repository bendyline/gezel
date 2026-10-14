import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamingSessionBase } from '@bendyline/gezel/local-loop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningInferenceService, startService } from './inference-service.js';
import { embedModelId } from './memory/embed-core.js';
import type { LLMProvider } from './providers/types.js';
vi.mock('./memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memory/embeddings.js')>()),
  embedBatch: async (texts: string[]) => texts.map((text) => [text.length, 1]),
}));
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
      providerState() {
        return {};
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
    const models = (await (await request('/v1/models')).json()) as { data: { id: string }[] };
    expect(models.data.length).toBeGreaterThan(10);
    expect(models.data.some((model) => model.id === 'llama-cpp:fixture')).toBe(true);
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
    const responses = await request('/v1/responses', {
      model: 'llama-cpp:fixture',
      input: 'Hello',
      store: false,
    });
    expect(responses.status).toBe(200);
    expect(await responses.json()).toMatchObject({ output_text: 'Hello from inference' });
    expect(
      (await request('/v1/responses', { model: 'openai:any', input: 'Hello', store: false }))
        .status,
    ).toBe(403);
    const embedded = await request('/v1/embeddings', {
      model: 'gezel:embeddings',
      input: ['hi', 'there'],
    });
    expect(embedded.status).toBe(200);
    expect(await embedded.json()).toMatchObject({
      object: 'list',
      model: embedModelId(),
      data: [
        { index: 0, embedding: [2, 1] },
        { index: 1, embedding: [5, 1] },
      ],
    });
    const chatModelEmbedding = await request('/v1/embeddings', {
      model: 'llama-cpp:fixture',
      input: 'hi',
    });
    expect(chatModelEmbedding.status).toBe(400);
    expect(await chatModelEmbedding.json()).toMatchObject({
      error: { code: 'embeddings_not_supported' },
    });
    expect(
      (await request('/v1/embeddings', { model: 'gezel:embeddings', input: 'hi', dimensions: 384 }))
        .status,
    ).toBe(400);
    expect((await request('/v1/knowledge/state')).status).toBe(200);
    expect(await readdir(home)).not.toContain('gezels');
    expect(await readdir(home)).not.toContain('projects');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await running.stop();
    await running.stop();
    await expect(request('/v1/models')).rejects.toThrow('stopped');
  });
  it('answers the bare id ensureModel pins, and names the qualified form otherwise', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-inference-'));
    const models: Array<string | undefined> = [];
    class Session extends StreamingSessionBase {
      async sendAndWait() {
        return 'pinned reply';
      }
      providerState() {
        return {};
      }
      async disconnect() {}
    }
    const provider: LLMProvider = {
      name: 'llama-cpp',
      supportsPriorMessages: true,
      initialize: async () => {},
      shutdown: async () => {},
      listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
      createSession: async (opts) => {
        models.push(opts.model);
        return new Session();
      },
    };
    running = await startService({ home, providers: new Map([['llama-cpp', provider]]) });
    const request = (path: string, body: unknown, method = 'POST') =>
      running!.fetch(`http://gezel.local${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${running!.clientToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const chat = { model: 'fixture', messages: [{ role: 'user', content: 'Hello' }] };

    const unpinned = await request('/v1/chat/completions', chat);
    expect(unpinned.status).toBe(404);
    const refusal = (await unpinned.json()) as { error: { message: string } };
    expect(refusal.error.message).toContain('"llama-cpp:fixture"');

    // What ensureModel writes on a daemon the app hosts.
    expect(
      (
        await request(
          '/api/config',
          { provider: 'llama-cpp', defaultModel: { 'llama-cpp': 'fixture' } },
          'PUT',
        )
      ).status,
    ).toBe(200);
    const pinned = await request('/v1/chat/completions', chat);
    expect(pinned.status).toBe(200);
    const answer = (await pinned.json()) as { choices: { message: { content: string } }[] };
    expect(answer.choices[0]?.message.content).toBe('pinned reply');
    const responses = await request('/v1/responses', {
      model: 'fixture',
      input: 'Hello',
      store: false,
    });
    expect(responses.status).toBe(200);
    expect(models).toEqual(['fixture', 'fixture']);
  });

  it('keeps plain Node running while a request waits on unreferenced work', () => {
    // Vitest's own handles keep this process alive whatever the host does, so
    // the check runs in a child Node with nothing else on its event loop. The
    // provider waits on an unreferenced timer, as an engine cold start does.
    const entry = fileURLToPath(new URL('../dist/inference-service.js', import.meta.url));
    const script = `
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { StreamingSessionBase } from '@bendyline/gezel/local-loop';
      import { startService } from ${JSON.stringify(entry)};
      class Session extends StreamingSessionBase {
        async sendAndWait() {
          await new Promise((resolve) => setTimeout(resolve, 200).unref());
          return 'warm';
        }
        providerState() { return {}; }
        async disconnect() {}
      }
      const provider = {
        name: 'llama-cpp', supportsPriorMessages: true,
        initialize: async () => {}, shutdown: async () => {},
        listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
        createSession: async () => new Session(),
      };
      const home = await mkdtemp(join(tmpdir(), 'gezel-inference-node-'));
      const running = await startService({ home, providers: new Map([['llama-cpp', provider]]) });
      const response = await running.fetch('http://gezel.local/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + running.clientToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-cpp:fixture', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      const reply = (await response.json()).choices[0].message.content;
      await running.stop();
      await rm(home, { recursive: true, force: true });
      console.log(reply);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, VITEST: undefined, GEZEL_LOG_LEVEL: 'error' },
      timeout: 60_000,
    });
    expect({
      status: child.status,
      stdout: child.stdout.trim(),
      stderr: child.stderr,
    }).toMatchObject({ status: 0, stdout: 'warm' });
  });

  it('cancels an active stream when its host closes and releases the home lock', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-inference-stop-'));
    let disconnected = false;
    // The route cancels a turn by disconnecting its session; SendAndWaitOpts
    // carries no abort signal, so the turn ends when disconnect() runs.
    class Session extends StreamingSessionBase {
      private release?: () => void;
      async sendAndWait() {
        this.emitDelta('partial');
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
        return 'partial';
      }
      providerState() {
        return {};
      }
      async disconnect() {
        disconnected = true;
        this.release?.();
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
