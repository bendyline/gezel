import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LogRecord,
  getLogLevel,
  getLogSink,
  setDebugNamespaces,
  setLogLevel,
  setLogSink,
} from '@bendyline/gezel';
import { StreamingSessionBase } from '@bendyline/gezel/local-loop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningInferenceService, startService } from '../../inference-service.js';
import type { LLMProvider, LLMSession } from '../../providers/types.js';

vi.mock('../../memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/embeddings.js')>()),
  embedBatch: async (texts: string[]) => texts.map((text) => [text.length, 1]),
}));

let running: RunningInferenceService | undefined;
let home: string | undefined;
let records: LogRecord[] = [];
const previousSink = getLogSink();
const previousLevel = getLogLevel();

beforeEach(() => {
  records = [];
  // The package's test config runs at `error`; these tests read the warning.
  setLogLevel('warn');
  setDebugNamespaces('v1-chat');
});

afterEach(async () => {
  setLogSink(previousSink);
  setLogLevel(previousLevel);
  setDebugNamespaces(null);
  await running?.stop();
  running = undefined;
  if (home) await rm(home, { recursive: true, force: true });
});

async function start(createSession: () => LLMSession): Promise<RunningInferenceService> {
  home = await mkdtemp(join(tmpdir(), 'gezel-inference-'));
  const provider: LLMProvider = {
    name: 'llama-cpp',
    supportsPriorMessages: true,
    initialize: async () => {},
    shutdown: async () => {},
    listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
    createSession: async () => createSession(),
  };
  const service = await startService({ home, providers: new Map([['llama-cpp', provider]]) });
  setLogSink((record) => records.push(record));
  return service;
}

function streamChat(): Promise<Response> {
  return running!.fetch('http://gezel.local/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${running!.clientToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-cpp:fixture',
      stream: true,
      messages: [{ role: 'user', content: 'Name a pet.' }],
    }),
  });
}

/** Read the SSE body until `marker` arrives, then hang up the way an SDK does. */
async function readUntilThenHangUp(res: Response, marker: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${marker}: ${text}`);
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

const lines = (level: LogRecord['level'], fragment: string) =>
  records.filter((record) => record.level === level && record.line.includes(fragment));

describe('a streamed chat completion the client closes', () => {
  it('is not reported as an abort when the client hangs up after [DONE]', async () => {
    // The handler is still finishing (mirror, history, disconnect) when an
    // OpenAI client closes on `[DONE]`; every successful reply logged a WARN.
    let releaseDisconnect: () => void = () => {};
    const disconnected = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    class Session extends StreamingSessionBase {
      async sendAndWait(): Promise<string> {
        this.emitDelta('Rex');
        return 'Rex';
      }
      providerState() {
        return {};
      }
      async disconnect() {
        await disconnected;
      }
    }
    running = await start(() => new Session());

    const res = await streamChat();
    expect(res.status).toBe(200);
    const body = await readUntilThenHangUp(res, 'data: [DONE]');
    expect(body).toContain('Rex');
    await vi.waitFor(() =>
      expect(lines('debug', 'closed by the client after the reply')).toHaveLength(1),
    );
    releaseDisconnect();

    expect(lines('warn', 'client-aborted')).toEqual([]);
  });

  it('is still reported when the client hangs up mid-reply', async () => {
    class Session extends StreamingSessionBase {
      private stop: (() => void) | undefined;
      async sendAndWait(): Promise<string> {
        this.emitDelta('Re');
        await new Promise<void>((_resolve, reject) => {
          this.stop = () => reject(new Error('disconnected'));
        });
        return 'Re';
      }
      providerState() {
        return {};
      }
      async disconnect() {
        this.stop?.();
      }
    }
    running = await start(() => new Session());

    const res = await streamChat();
    await readUntilThenHangUp(res, '"content":"Re"');

    await vi.waitFor(() => expect(lines('warn', 'client-aborted')).toHaveLength(1));
    expect(lines('debug', 'closed by the client after the reply')).toEqual([]);
  });
});
