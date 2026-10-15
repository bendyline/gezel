import { describe, expect, it, vi } from 'vitest';
import { type PortableInference, PortableProductService } from './product-service.js';
import { TEST_SERVER_CODE, fakeRemoteServer } from './remote-test-server.js';
import { portableFixture } from './test-files.js';

/**
 * A phone conversation on a paired server's model: it runs there while the
 * server answers, and on the phone's own model, saying so, while it doesn't.
 */
async function fixture() {
  const { store } = portableFixture();
  const { server, http } = await fakeRemoteServer();
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'apple-foundation-models',
        name: 'System model',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          text: true,
          tools: false,
          images: false,
          structuredOutput: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: vi.fn(async () => ({ text: 'Local answer', stopReason: 'stop' as const })),
    cancel: vi.fn(async () => {}),
  };
  const service = new PortableProductService(store, inference, 'secret', {
    remote: { http, deviceName: () => 'Test Phone' },
  });
  await service.initialize();
  await store.writeConfig({ provider: 'apple-foundation-models' });
  const paired = await service.remotes.pair({ baseUrl: '192.168.1.20', code: TEST_SERVER_CODE });
  const modelId = `remote:${paired.remoteId}/llama-cpp:qwen3.6-27b`;
  await service.setRemoteModel(modelId);
  const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
  const api = async (path: string, body: unknown) => {
    const response = await service.fetch(`https://gezel.local${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  const created = await api('/api/sessions', { gezelId: gezel.id });
  const sessionId = String(created.json.id);
  let turns = 0;
  const send = async (message: string) => {
    const response = await api(`/api/sessions/${sessionId}/send`, { message });
    expect(response.status).toBe(200);
    turns += 1;
    await vi.waitFor(async () => {
      const saved = await store.getSession(gezel.id, sessionId);
      expect(saved?.messages.filter((m) => m.role === 'assistant').length).toBe(turns);
      expect(saved?.turnStartedAt).toBeUndefined();
    });
    const saved = (await store.getSession(gezel.id, sessionId))!;
    return { session: saved, reply: saved.messages.at(-1)! };
  };
  return { store, server, inference, service, modelId, created, send };
}

describe('a phone conversation on another device’s model', () => {
  it('starts on the server model the person chose', async () => {
    const f = await fixture();
    expect(f.created.json).toMatchObject({ providerName: 'remote', model: f.modelId });
  });

  it('runs its turn on the server', async () => {
    const f = await fixture();
    const { reply, session } = await f.send('Hello');
    expect(reply).toMatchObject({ content: 'Remote answer', providerId: 'remote' });
    expect(reply.warnings).toBeUndefined();
    expect(f.inference.generate).not.toHaveBeenCalled();
    expect(f.server.infers).toHaveLength(1);
    expect(f.server.infers[0]).toMatchObject({ model: 'llama-cpp:qwen3.6-27b', prompt: 'Hello' });
    expect(f.server.infers[0]!.systemMessage.length).toBeGreaterThan(0);
    expect(session.model).toBe(f.modelId);
  });

  it('answers on the phone’s own model while the server is away, and says so', async () => {
    const f = await fixture();
    f.server.online = false;
    f.service.remotes.reportUnreachable(f.server.fingerprint);
    const { reply, session } = await f.send('Hello');
    expect(reply).toMatchObject({ content: 'Local answer', providerId: 'apple-foundation-models' });
    expect(reply.warnings?.[0]).toMatch(
      /Werkbank isn't reachable right now, so this reply came from this device's own model/,
    );
    // The conversation keeps its server, to go back to once it answers.
    expect(session).toMatchObject({ providerName: 'remote', model: f.modelId });
  });

  it('goes back to the server once it answers again', async () => {
    const f = await fixture();
    f.server.online = false;
    f.service.remotes.reportUnreachable(f.server.fingerprint);
    await f.send('Hello');
    f.server.online = true;
    f.service.remotes.reportReachable(f.server.fingerprint);
    const { reply } = await f.send('Again');
    expect(reply).toMatchObject({ content: 'Remote answer', providerId: 'remote' });
  });
});
