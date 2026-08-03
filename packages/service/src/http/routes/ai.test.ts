import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransformStreamEvent } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../../providers/mock.js';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let httpFetch: typeof fetch;
let mock: MockProvider;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'gezel-ai-transform-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  const provider = await svc.context.chat.getProvider('copilot');
  if (!(provider instanceof MockProvider)) {
    throw new Error('expected MockProvider for copilot in test env');
  }
  mock = provider;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function postTransform(body: unknown): Promise<Response> {
  return httpFetch(`${baseUrl}/api/ai/transform`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The transform stream is finite — read it to EOF and parse the events. */
async function readEvents(res: Response): Promise<TransformStreamEvent[]> {
  const raw = await res.text();
  const events: TransformStreamEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload) as TransformStreamEvent);
    } catch {
      /* skip keepalives / malformed */
    }
  }
  return events;
}

describe('POST /api/ai/transform', () => {
  it('streams status, thinking, output deltas and a done event for a rewrite', async () => {
    mock.scriptReasoning('weighing the tone');
    mock.script('Rewritten result.');
    const res = await postTransform({ mode: 'rewrite', text: 'original text' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/event-stream/);

    const events = await readEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status');
    expect(types[types.length - 1]).toBe('done');

    const thinking = events
      .filter((e) => e.type === 'thinking-delta')
      .map((e) => e.text)
      .join('');
    expect(thinking).toBe('weighing the tone');

    const output = events
      .filter((e) => e.type === 'output-delta')
      .map((e) => e.text)
      .join('');
    expect(output).toBe('Rewritten result.');

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.text : '').toBe('Rewritten result.');
  }, 20_000);

  it('runs insert mode with an instruction and no input text', async () => {
    mock.script('A fresh paragraph.');
    const res = await postTransform({
      mode: 'insert',
      instruction: 'add a summary paragraph',
      textBefore: 'End of intro.',
      textAfter: 'Next section.',
    });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.text : '').toBe('A fresh paragraph.');
  }, 20_000);

  it('rejects insert mode without an instruction', async () => {
    const res = await postTransform({ mode: 'insert', text: '' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/instruction/);
  });

  it('rejects rewrite mode with empty text', async () => {
    const res = await postTransform({ mode: 'rewrite', text: '   ' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/empty/);
  });

  it('emits an error event when the provider fails mid-stream', async () => {
    mock.scriptSendFailure('mock engine exploded');
    const res = await postTransform({ mode: 'rewrite', text: 'doomed' });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const error = events.find((e) => e.type === 'error');
    expect(error && error.type === 'error' ? error.error : '').toMatch(/mock engine exploded/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  }, 20_000);
});
