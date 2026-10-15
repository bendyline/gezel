/**
 * A gezel server in one process, for tests of the phone's remote client: an
 * identity that signs its certificate, a connect code, and the routes a phone
 * uses. `rotate()` restarts its certificate the way a server reboot does.
 */

import {
  PAIRING_PROTOCOL,
  type RemoteFetch,
  type RemoteHttp,
  type RemoteInferRequest,
  base64ToBytes,
  bytesToBase64,
  certFingerprintFromPem,
  derToPem,
  fingerprintOfPublicKeyPem,
  pairingPasswordScalar,
  spake2Finish,
  spake2Start,
} from '../remote/index.js';
import { REMOTE_CERTIFICATE_REFUSED } from './remote-servers.js';
import type { PortableRemotes } from './remotes-file.js';

export const TEST_SERVER_BASE = 'https://192.168.1.20:6229';
export const TEST_SERVER_CODE = '48210937';

type SigningKey = Parameters<typeof globalThis.crypto.subtle.sign>[1];

export async function fakeRemoteServer() {
  const subtle = globalThis.crypto.subtle;
  const keys = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as { publicKey: SigningKey; privateKey: SigningKey };
  const publicKeyPem = derToPem(
    new Uint8Array(await subtle.exportKey('spki', keys.publicKey)),
    'PUBLIC KEY',
  );
  const fingerprint = await fingerprintOfPublicKeyPem(publicKeyPem);
  const server = {
    fingerprint,
    online: true,
    certPem: '',
    identity: {} as Record<string, unknown>,
    deletes: [] as string[],
    infers: [] as RemoteInferRequest[],
    contextWindow: 32_768,
    reply: 'Remote answer',
    models: [{ id: 'llama-cpp:qwen3.6-27b', name: 'Qwen 3.6 27B', modality: 'chat' as const }],
    async rotate(signer: SigningKey = keys.privateKey) {
      const der = globalThis.crypto.getRandomValues(new Uint8Array(64));
      server.certPem = derToPem(der, 'CERTIFICATE');
      const tlsCertFingerprint = await certFingerprintFromPem(server.certPem);
      const sig = new Uint8Array(
        await subtle.sign(
          { name: 'Ed25519' },
          signer,
          new TextEncoder().encode(tlsCertFingerprint),
        ),
      );
      server.identity = {
        deviceId: 'server',
        publicKeyPem,
        fingerprint,
        tlsCertPem: server.certPem,
        tlsCertFingerprint,
        sig: bytesToBase64(sig),
        protocolVersion: 2,
        pairingMethods: ['code', 'approval'],
      };
    },
  };
  await server.rotate();

  const pending = new Map<string, { confirmA: Uint8Array; confirmB: Uint8Array }>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const sse = (...frames: unknown[]) =>
    new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    if (!server.online)
      throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === '/v1/identity') return json(200, server.identity);
    if (path === '/v1/apps/pair/start') {
      const state = spake2Start('B', await pairingPasswordScalar(TEST_SERVER_CODE));
      try {
        const done = await spake2Finish(state, {
          idA: await fingerprintOfPublicKeyPem(body.deviceIdentityPubKey),
          idB: fingerprint,
          peerShare: base64ToBytes(body.share),
          aad: PAIRING_PROTOCOL,
        });
        pending.set('s1', { confirmA: done.confirmA, confirmB: done.confirmB });
      } catch {
        return json(403, { error: 'pairing_rejected' });
      }
      return json(200, { sessionId: 's1', share: bytesToBase64(state.share) });
    }
    if (path === '/v1/apps/pair/finish') {
      const session = pending.get(body.sessionId);
      if (!session || bytesToBase64(session.confirmA) !== body.confirm)
        return json(403, { error: 'pairing_rejected' });
      return json(200, {
        confirm: bytesToBase64(session.confirmB),
        token: 'device-token',
        name: 'Werkbank',
      });
    }
    if (path === '/v1/remote/models')
      return json(200, { deviceId: 'server', models: server.models });
    if (path === '/v1/remote/admit')
      return json(200, { model: body.model, contextWindow: server.contextWindow });
    if (path === '/v1/remote/infer') {
      server.infers.push(body as RemoteInferRequest);
      return sse(
        { type: 'delta', text: server.reply },
        { type: 'usage', model: body.model, inputTokens: 10, outputTokens: 2 },
        { type: 'done' },
      );
    }
    if (init?.method === 'DELETE') {
      server.deletes.push(path);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not_found' });
  }

  const http: RemoteHttp = {
    bootstrap: () => ((input: string) => handle(String(input))) as unknown as RemoteFetch,
    pinned: (certPem: string) =>
      (async (input: string, init?: RequestInit) => {
        if (server.online && certPem !== server.certPem) {
          throw Object.assign(new Error('certificate refused'), {
            code: REMOTE_CERTIFICATE_REFUSED,
          });
        }
        return await handle(String(input), init);
      }) as unknown as RemoteFetch,
  };
  return { server, http, sign: (key: SigningKey) => server.rotate(key) };
}

/** `remotes.json` held in memory. */
export function memoryRemotesStore() {
  let value: PortableRemotes = { version: 1, servers: [] };
  return {
    readRemotes: async () => structuredClone(value),
    writeRemotes: async (next: PortableRemotes) => {
      value = structuredClone(next);
    },
    get value() {
      return value;
    },
  };
}
