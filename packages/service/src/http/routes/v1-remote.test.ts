/**
 * End-to-end test of Device B's remote-model-execution surface, against a REAL
 * service over loopback HTTPS with the mock provider. Exercises the pairing
 * handshake (/v1/identity + device-kind register/approve), the security
 * boundary (a remote-inference token is forbidden on /api/*), discovery, and a
 * streamed /v1/remote/infer completion.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockProvider } from '../../providers/mock.js';
import { CapacityDeniedError } from '../../providers/native/capacity-broker.js';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file'; // avoid OS keyring on a fresh temp home
  home = await mkdtemp(join(tmpdir(), 'gezel-remote-e2e-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  rootToken = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
}, 30_000);

/** Register a device grant, approve it via root, and return the issued token. */
async function pairDevice(appId: string): Promise<string> {
  const reg = await httpFetch(`${baseUrl}/v1/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId,
      appName: `Device ${appId}`,
      scopes: ['remote-inference'],
      kind: 'device',
      deviceIdentityPubKey: 'TEST-PUBKEY-PEM',
    }),
  });
  expect(reg.status).toBe(201);
  const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
  const approve = await httpFetch(`${baseUrl}/v1/apps/grant/${grantRequestId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rootToken}` },
  });
  expect(approve.status).toBe(200);
  const poll = await httpFetch(`${baseUrl}/v1/apps/grant/${grantRequestId}`);
  const { token } = (await poll.json()) as { token?: string };
  expect(typeof token).toBe('string');
  return token!;
}

describe('remote model execution — B-side surface (e2e)', () => {
  it('publishes a device identity + signed cert fingerprint at /v1/identity (unauth)', async () => {
    const res = await httpFetch(`${baseUrl}/v1/identity`);
    expect(res.ok).toBe(true);
    const j = (await res.json()) as {
      deviceId: string;
      fingerprint: string;
      sig?: string;
      tlsCertFingerprint?: string;
      protocolVersion: number;
    };
    expect(typeof j.deviceId).toBe('string');
    expect(j.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(j.protocolVersion).toBeGreaterThanOrEqual(1);
    if (svc.cert) {
      expect(typeof j.sig).toBe('string');
      expect(typeof j.tlsCertFingerprint).toBe('string');
    }
  });

  it('issues a remote-inference token that is forbidden on /api/* but allowed on /v1/remote/*', async () => {
    const token = await pairDevice('device-sec');
    // Least privilege: the remote token gets 403 on the privileged project surface.
    const apiRes = await httpFetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(apiRes.status).toBe(403);
    // …but reaches the inference-only remote surface.
    const modelsRes = await httpFetch(`${baseUrl}/v1/remote/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(modelsRes.ok).toBe(true);
    const body = (await modelsRes.json()) as { deviceId: string; models: unknown[] };
    expect(typeof body.deviceId).toBe('string');
    expect(Array.isArray(body.models)).toBe(true);
  });

  it('rejects /v1/remote/* without the scope (401/403)', async () => {
    const res = await httpFetch(`${baseUrl}/v1/remote/models`);
    expect([401, 403]).toContain(res.status);
  });

  it('streams a remote inference completion from the mock provider', async () => {
    const token = await pairDevice('device-infer');
    const provider = (await svc.context.chat.getProviderForModel(
      'copilot',
      'mock-fast',
    )) as MockProvider;
    provider.scriptReasoning('checking the plan');
    const res = await httpFetch(`${baseUrl}/v1/remote/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        model: 'copilot:mock-fast', // mock provider is seeded under 'copilot'
        systemMessage: 'You are a test.',
        prompt: 'hello',
        priorMessages: [],
        queue: { lane: 'interactive', affinity: true, sessionId: 's1', gezelId: 'g1' },
      }),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    // SSE frames, terminating in a `done` frame (mock emits text, no tool call).
    expect(text).toContain('data:');
    expect(text).toContain('"type":"reasoning_delta"');
    expect(text).toContain('"type":"done"');
    expect(text).not.toContain('"type":"error"');
    expect(text.indexOf('"type":"reasoning_delta"')).toBeLessThan(text.indexOf('"type":"done"'));
  });

  it('marks a trailing tool-result request as a continuation, not an empty user turn', async () => {
    const token = await pairDevice('device-tool-continuation');
    const provider = (await svc.context.chat.getProviderForModel(
      'copilot',
      'mock-fast',
    )) as MockProvider;
    const callStart = provider.calls.length;
    provider.script('continued after tool result');

    const res = await httpFetch(`${baseUrl}/v1/remote/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        model: 'copilot:mock-fast',
        systemMessage: 'You are a test.',
        prompt: '',
        priorMessages: [
          { role: 'user', content: 'Build index.html.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'note-1', name: 'write_task_note', arguments: '{"ref":"frogger/1"}' },
            ],
          },
          { role: 'tool', content: 'Appended note.', toolCallId: 'note-1' },
        ],
        queue: { lane: 'interactive', affinity: true, sessionId: 's-tool', gezelId: 'g1' },
      }),
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('"type":"done"');

    const send = provider.calls
      .slice(callStart)
      .find((call) => call.kind === 'send' && call.prompt === '');
    expect(send?.sendOpts?.continueFromToolResult).toBe(true);
  });

  it('reports the provider post-admission context before inference', async () => {
    const token = await pairDevice('device-admit');
    const provider = (await svc.context.chat.getProviderForModel(
      'copilot',
      'mock-fast',
    )) as MockProvider;
    provider.ollamaContextConfig = { numCtx: 35_840, promptChars: () => 0 };

    const res = await httpFetch(`${baseUrl}/v1/remote/admit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        model: 'copilot:mock-fast',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      model: 'copilot:mock-fast',
      contextWindow: 35_840,
    });
  });

  it('previews native admission without taking the inference bind path', async () => {
    const token = await pairDevice('device-native-admit');
    const inferenceBind = vi.spyOn(svc.context.chat, 'getProviderForModel');
    const preview = vi
      .spyOn(svc.context.chat, 'previewContextWindowForModel')
      .mockResolvedValue(24_576);

    try {
      const res = await httpFetch(`${baseUrl}/v1/remote/admit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          protocolVersion: 1,
          model: 'llama-cpp:mock-local',
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        model: 'llama-cpp:mock-local',
        contextWindow: 24_576,
      });
      expect(preview).toHaveBeenCalledWith('llama-cpp', 'mock-local');
      expect(inferenceBind).not.toHaveBeenCalled();
    } finally {
      preview.mockRestore();
      inferenceBind.mockRestore();
    }
  });

  it('returns an explicit capacity denial instead of a sub-64K native window', async () => {
    const token = await pairDevice('device-native-context-denied');
    const preview = vi
      .spyOn(svc.context.chat, 'previewContextWindowForModel')
      .mockRejectedValue(
        new CapacityDeniedError('Gemma cannot fit the required 65,536-token working window.'),
      );

    try {
      const res = await httpFetch(`${baseUrl}/v1/remote/admit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          protocolVersion: 1,
          model: 'llama-cpp:gemma',
        }),
      });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ error: 'capacity_denied' });
    } finally {
      preview.mockRestore();
    }
  });

  it('answers 503 on /api/machine-serving when no broker has been adopted', async () => {
    const res = await httpFetch(`${baseUrl}/api/machine-serving`, {
      headers: { Authorization: `Bearer ${rootToken}` },
    });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: 'machine_engine_unavailable' });
  });
});
