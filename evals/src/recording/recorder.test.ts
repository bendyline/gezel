import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RecordedChatEventLine, startChatEventRecorder } from './recorder.ts';

/**
 * Stub SSE endpoint speaking the same wire shape as `/events/chat/all`:
 * one `data: <envelope JSON>` frame per event. The recorder's client is
 * structural, so pointing it here exercises the real sseStream reader,
 * coalescer, ordering flush, and file writer end to end.
 */
function startStubSse(): Promise<{
  server: Server;
  url: string;
  push: (envelope: unknown) => void;
  closeClients: () => void;
}> {
  const clients = new Set<import('node:http').ServerResponse>();
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    res.write(': hello\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/events/chat/all`,
        push: (envelope) => {
          for (const res of clients) res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        },
        closeClients: () => {
          for (const res of clients) res.end();
          clients.clear();
        },
      });
    });
  });
}

function envelope(sessionId: string, event: Record<string, unknown>): Record<string, unknown> {
  return { sessionId, gezelId: 'ada', projectId: 'default', event };
}

async function readLines(runDir: string): Promise<RecordedChatEventLine[]> {
  const raw = await readFile(join(runDir, 'recording', 'chat-events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedChatEventLine);
}

const flushOf = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startChatEventRecorder', () => {
  let runDir: string;
  let stub: Awaited<ReturnType<typeof startStubSse>>;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'gezel-recorder-'));
    stub = await startStubSse();
  });

  afterEach(async () => {
    stub.closeClients();
    await new Promise((resolve) => stub.server.close(resolve));
    await rm(runDir, { recursive: true, force: true });
  });

  const stubClient = () => ({
    allEventsUrl: () => stub.url,
    authHeader: () => ({}),
    getFetch: () => fetch,
  });

  it('coalesces delta runs and flushes them before the non-delta event that follows', async () => {
    const recorder = startChatEventRecorder({ client: stubClient(), runDir, log: () => {} });
    await flushOf(150);
    for (let i = 0; i < 5; i++) {
      stub.push(envelope('s1', { type: 'delta', content: `chunk${i} ` }));
    }
    await flushOf(50);
    stub.push(
      envelope('s1', {
        type: 'complete',
        message: { role: 'assistant', content: 'done', at: new Date().toISOString() },
      }),
    );
    await flushOf(150);
    const stats = await recorder.stop();

    const lines = await readLines(runDir);
    expect(lines).toHaveLength(2);
    const [coalesced, complete] = lines;
    expect((coalesced!.event as { type: string }).type).toBe('delta');
    expect(coalesced!.count).toBe(5);
    expect((coalesced!.event as { content: string }).content).toBe(
      'chunk0 chunk1 chunk2 chunk3 chunk4 ',
    );
    expect(coalesced!.rxLast).toBeDefined();
    expect((complete!.event as { type: string }).type).toBe('complete');
    // Ordering: the coalesced deltas land BEFORE the complete they fed.
    expect(Date.parse(coalesced!.rx)).toBeLessThanOrEqual(Date.parse(complete!.rx));
    expect(stats.coalescedDeltas).toBe(5);
    expect(stats.lines).toBe(2);
    expect(stats.truncated).toBe(false);
  });

  it('keeps tool_args_delta streams separate per tool name', async () => {
    const recorder = startChatEventRecorder({ client: stubClient(), runDir, log: () => {} });
    await flushOf(150);
    stub.push(envelope('s1', { type: 'tool_args_delta', name: 'write_file', content: '{"pa' }));
    stub.push(envelope('s1', { type: 'tool_args_delta', name: 'read_file', content: '{"x"' }));
    stub.push(envelope('s1', { type: 'tool_args_delta', name: 'write_file', content: 'th":' }));
    await flushOf(400);
    await recorder.stop();

    const lines = await readLines(runDir);
    const byTool = new Map(
      lines.map((line) => [(line.event as { name?: string }).name, line] as const),
    );
    expect((byTool.get('write_file')?.event as { content: string }).content).toBe('{"path":');
    expect(byTool.get('write_file')?.count).toBe(2);
    expect((byTool.get('read_file')?.event as { content: string }).content).toBe('{"x"');
  });

  it('records a gap when the stream drops, then keeps recording after reconnect', async () => {
    const recorder = startChatEventRecorder({ client: stubClient(), runDir, log: () => {} });
    await flushOf(150);
    stub.push(envelope('s1', { type: 'queued', aheadOf: 1 }));
    await flushOf(300);
    stub.closeClients();
    // Reconnect backoff starts at 500ms; give it room, then emit again.
    await flushOf(900);
    stub.push(envelope('s1', { type: 'queued', aheadOf: 0 }));
    await flushOf(300);
    const stats = await recorder.stop();

    const lines = await readLines(runDir);
    expect(lines.length).toBe(2);
    expect(stats.gaps.length).toBeGreaterThanOrEqual(1);
    expect(Date.parse(stats.gaps[0]!.to)).toBeGreaterThanOrEqual(Date.parse(stats.gaps[0]!.from));
  });
});
