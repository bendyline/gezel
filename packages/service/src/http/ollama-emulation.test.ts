import { mkdtemp, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import type { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';
import { createOllamaEmulationController } from './ollama-emulation.js';

type ServeFetch = Parameters<typeof serve>[0]['fetch'];
const okFetch = (): (() => ServeFetch) => {
  const handler = (async () => new Response('ok')) as unknown as ServeFetch;
  return () => handler;
};

async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker: Server = createServer(() => {});
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: () => new Promise((resolve) => blocker.close(() => resolve())),
  };
}

describe('createOllamaEmulationController', () => {
  it('binds only when the master switch allows AND emulateOllama is set', async () => {
    const controller = createOllamaEmulationController({ fetch: okFetch(), port: 0 });
    expect((await controller.reconfigure(undefined)).listening).toBe(false);
    expect((await controller.reconfigure({})).listening).toBe(false);
    expect((await controller.reconfigure({ emulateOllama: false })).listening).toBe(false);
    // Facade master switch off trumps the emulation opt-in.
    expect((await controller.reconfigure({ enabled: false, emulateOllama: true })).listening).toBe(
      false,
    );

    const on = await controller.reconfigure({ emulateOllama: true });
    expect(on.listening).toBe(true);
    expect(on.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${on.port}/anything`);
    expect(await res.text()).toBe('ok');

    // Toggling back off tears the listener down.
    expect((await controller.reconfigure({})).listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${on.port}/anything`)).rejects.toThrow();
    await controller.stop();
  });

  it('refuses to bind an occupied port with an actionable message', async () => {
    const blocker = await occupyPort();
    try {
      const controller = createOllamaEmulationController({
        fetch: okFetch(),
        port: blocker.port,
      });
      await expect(controller.reconfigure({ emulateOllama: true })).rejects.toThrow(
        /already in use/,
      );
      expect(controller.status().listening).toBe(false);
    } finally {
      await blocker.close();
    }
  });

  it('names another gezel daemon when the occupant is a gezel emulation (multi-user machines)', async () => {
    // Real Ollama and gezel's emulation both answer /api/version 200; the
    // marker header is what tells them apart in the conflict message.
    const blocker: Server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-gezel-ollama-emulation': '1',
      });
      res.end('{"version":"emulated"}');
    });
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const controller = createOllamaEmulationController({
        fetch: okFetch(),
        port: address.port,
      });
      await expect(controller.reconfigure({ emulateOllama: true })).rejects.toThrow(
        /another gezel daemon/,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('ollama emulation — end to end through the service', () => {
  let svc: RunningService;
  let baseUrl: string;
  let rootToken: string;
  let home: string;
  let httpFetch: typeof fetch;

  const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

  beforeAll(async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    home = await mkdtemp(join(tmpdir(), 'gezel-ollama-emu-'));
    // Port 0 = ephemeral: parallel suites must not fight over 11434,
    // and a dev machine may be running real Ollama.
    svc = await startService({ home, ollamaEmulationPort: 0 });
    const scheme = svc.cert ? 'https' : 'http';
    baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
    rootToken = svc.context.token;
    httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  }, 30_000);

  afterAll(async () => {
    await svc.stop();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
    else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
  }, 30_000);

  async function putEndpoints(value: Record<string, unknown>): Promise<Response> {
    return httpFetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rootToken}`,
      },
      body: JSON.stringify({ openaiEndpoints: value }),
    });
  }

  it('is off by default', () => {
    expect(svc.context.ollamaEmulation.status().listening).toBe(false);
  });

  it('rejects non-loopback Host authorities on the live listener (hostGuard e2e)', async () => {
    await putEndpoints({ emulateOllama: true });
    const status = svc.context.ollamaEmulation.status();
    expect(status.listening).toBe(true);
    const port = status.port!;

    // Raw node:http because fetch/undici strips a spoofed Host header. This
    // is the same DNS-rebinding defense as the main app, proven over the
    // real unauthenticated socket.
    const { request } = await import('node:http');
    const raw = (hostHeader: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path, headers: { host: hostHeader } },
          (res) => {
            let body = '';
            res.on('data', (d) => {
              body += d;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });

    const lanHost = await raw('192.168.1.50:11434', '/api/tags');
    expect(lanHost.status).toBe(403);
    expect(lanHost.body).toContain('forbidden_host');
    const dnsHost = await raw('evil.example:11434', '/api/tags');
    expect(dnsHost.status).toBe(403);
    const loopback = await raw(`127.0.0.1:${port}`, '/api/version');
    expect(loopback.status).toBe(200);

    // The marker header rides on every response so a second daemon's
    // port-conflict probe can identify this occupant as gezel.
    const version = await fetch(`http://127.0.0.1:${port}/api/version`);
    expect(version.headers.get('x-gezel-ollama-emulation')).toBe('1');
  });

  it('starts on config enable and serves the Ollama surface without auth', async () => {
    const res = await putEndpoints({ emulateOllama: true });
    expect(res.status).toBe(200);
    const status = svc.context.ollamaEmulation.status();
    expect(status.listening).toBe(true);
    const origin = `http://127.0.0.1:${status.port}`;

    // Reachability probes stock clients use. NO Authorization header anywhere.
    const banner = await fetch(origin);
    expect(await banner.text()).toBe('Ollama is running');
    const version = (await (await fetch(`${origin}/api/version`)).json()) as {
      version: string;
    };
    expect(version.version).toBeTruthy();

    const tags = (await (await fetch(`${origin}/api/tags`)).json()) as {
      models: Array<{ name: string }>;
    };
    expect(tags.models.map((m) => m.name)).toContain('copilot:mock-fast');

    const chat = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'hallo daar' }],
        stream: false,
      }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as {
      message: { content: string };
      done: boolean;
      done_reason?: string;
    };
    expect(chatBody.message.content).toContain('hallo daar');
    expect(chatBody.done_reason).toBe('stop');

    // Ollama's OpenAI-compat surface rides along, also unauthenticated.
    const openai = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'copilot:mock-fast',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(openai.status).toBe(200);

    // The product surface must NOT exist here — inference only.
    const gezels = await fetch(`${origin}/api/gezels`);
    expect(gezels.status).toBe(404);
    const config = await fetch(`${origin}/api/config`);
    expect(config.status).toBe(404);
  });

  it('stops when the toggle turns off', async () => {
    const before = svc.context.ollamaEmulation.status();
    expect(before.listening).toBe(true);
    const res = await putEndpoints({});
    expect(res.status).toBe(200);
    expect(svc.context.ollamaEmulation.status().listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${before.port}/api/version`)).rejects.toThrow();
  });
});
