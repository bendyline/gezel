import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelevanceModelSpec } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type RelevanceInstallEvent,
  installRelevanceModel,
  installedRelevanceModel,
  relevanceModelDir,
} from './install.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const FILES: Record<string, string> = {
  'config.json': '{"model_type":"bert"}',
  'tokenizer.json': '{"model":{}}',
  'onnx/model_quantized.onnx': 'graph bytes',
};

function spec(overrides: Partial<RelevanceModelSpec> = {}): RelevanceModelSpec {
  return {
    id: 'fake-model@1',
    displayName: 'Fake',
    description: 'Fake model',
    source: { repo: 'org/fake', revision: 'a'.repeat(40) },
    license: { spdx: 'Apache-2.0', url: 'https://example.com' },
    languages: ['en'],
    architecture: 'bert',
    files: Object.entries(FILES).map(([path, text]) => ({
      path,
      sha256: sha(text),
      bytes: Buffer.byteLength(text),
    })),
    graph: 'onnx/model_quantized.onnx',
    approxBytes: 100,
    maxTokens: 512,
    queryMaxTokens: 96,
    scoreActivation: 'sigmoid',
    thresholds: null,
    calibration: null,
    ...overrides,
  };
}

const fakeFetch = (async (url: string | URL) => {
  const path = String(url).split(`/resolve/${'a'.repeat(40)}/`)[1] ?? '';
  const body = FILES[path];
  return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
}) as typeof fetch;

async function drain(events: AsyncGenerator<RelevanceInstallEvent>) {
  const out: RelevanceInstallEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('relevance model install', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'relevance-install-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('downloads every pinned file, verifies it, and marks the install last', async () => {
    const model = spec();
    expect(await installedRelevanceModel(home, model)).toBe(false);
    const events = await drain(installRelevanceModel(home, model, { fetchImpl: fakeFetch }));
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(await installedRelevanceModel(home, model)).toBe(true);
    expect(
      await readFile(join(relevanceModelDir(home, model.id), 'onnx/model_quantized.onnx'), 'utf8'),
    ).toBe('graph bytes');
  });

  it('refuses bytes that do not match the pin and leaves nothing marked installed', async () => {
    const model = spec();
    model.files[0] = { ...model.files[0]!, sha256: 'f'.repeat(64) };
    const events = await drain(installRelevanceModel(home, model, { fetchImpl: fakeFetch }));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(await installedRelevanceModel(home, model)).toBe(false);
  });

  it('does not count another revision’s files as installed', async () => {
    const model = spec();
    await drain(installRelevanceModel(home, model, { fetchImpl: fakeFetch }));
    const moved = spec({ source: { repo: 'org/fake', revision: 'b'.repeat(40) } });
    expect(await installedRelevanceModel(home, moved)).toBe(false);
  });
});
