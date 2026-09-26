import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AppleFmError, AppleFmHelper } from './helper.js';

/** A stand-in for the gezel-apple-fm process: records requests, scripts replies. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(
    private readonly respond: (message: Record<string, unknown>, child: FakeChild) => void,
  ) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
        buffer = buffer.slice(index + 1);
        this.sent.push(message);
        this.respond(message, this);
      }
    });
    this.stdin.on('finish', () => this.exit(0));
  }
  reply(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
  kill(): boolean {
    this.exit(1);
    return true;
  }
}

const HELLO = {
  type: 'hello',
  version: '1',
  os: 'Version 26.6',
  available: true,
  contextTokens: 4096,
  maxOutputTokens: 1024,
};

function helperWith(respond: (message: Record<string, unknown>, child: FakeChild) => void) {
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn(() => {
    const child = new FakeChild((message, self) => {
      if (message.type === 'hello') self.reply(HELLO);
      else respond(message, self);
    });
    children.push(child);
    return child;
  });
  const helper = new AppleFmHelper({
    binaryPath: '/bin/gezel-apple-fm',
    spawnImpl: spawnImpl as never,
  });
  return { helper, children, spawnImpl };
}

describe('gezel-apple-fm client', () => {
  it('streams a generation, answers its tool call, and resolves with the stop reason', async () => {
    const { helper, children } = helperWith((message, child) => {
      if (message.type === 'generate') {
        child.reply({ type: 'delta', id: message.id, text: 'Reading. ' });
        child.reply({
          type: 'tool_call',
          id: message.id,
          callId: 'k1',
          name: 'read_file',
          arguments: '{"path":"brief.md"}',
        });
      }
      if (message.type === 'tool_result') {
        child.reply({ type: 'delta', id: message.id, text: 'Done.' });
        child.reply({ type: 'done', id: message.id, stopReason: 'stop' });
      }
    });
    const deltas: string[] = [];
    const onToolCall = vi.fn(async () => ({ output: '# Brief', endTurn: false }));
    const reason = await helper.generate(
      { messages: [{ role: 'user', content: 'Read brief.md' }], maxTokens: 512, contextSize: 4096 },
      { onDelta: (text) => deltas.push(text), onToolCall },
    );
    expect(reason).toBe('stop');
    expect(deltas.join('')).toBe('Reading. Done.');
    expect(onToolCall).toHaveBeenCalledWith({
      callId: 'k1',
      name: 'read_file',
      arguments: '{"path":"brief.md"}',
    });
    expect(children[0]!.sent.find((m) => m.type === 'tool_result')).toMatchObject({
      callId: 'k1',
      output: '# Brief',
      endTurn: false,
    });
    await helper.shutdown();
  });

  it('returns a failed tool call to the helper as an error, not a rejection', async () => {
    const { helper, children } = helperWith((message, child) => {
      if (message.type === 'generate')
        child.reply({
          type: 'tool_call',
          id: message.id,
          callId: 'k1',
          name: 'x',
          arguments: '{}',
        });
      if (message.type === 'tool_result')
        child.reply({ type: 'done', id: message.id, stopReason: 'stop' });
    });
    await helper.generate(
      { messages: [{ role: 'user', content: 'Go' }], maxTokens: 512, contextSize: 4096 },
      {
        onDelta: () => {},
        onToolCall: async () => {
          throw new Error('Disk unavailable');
        },
      },
    );
    expect(children[0]!.sent.find((m) => m.type === 'tool_result')).toMatchObject({
      callId: 'k1',
      error: 'Disk unavailable',
    });
    await helper.shutdown();
  });

  it('surfaces coded failures and sends cancel on abort', async () => {
    const { helper, children } = helperWith((message, child) => {
      if (message.type === 'generate' && message.messages)
        child.reply({ type: 'error', id: message.id, code: 'CONTEXT_LIMIT', message: 'Too long' });
      if (message.type === 'cancel')
        child.reply({ type: 'done', id: message.id, stopReason: 'cancelled' });
    });
    const failed = helper.generate(
      { messages: [{ role: 'user', content: 'Go' }], maxTokens: 512, contextSize: 4096 },
      { onDelta: () => {}, onToolCall: async () => ({ output: '' }) },
    );
    await expect(failed).rejects.toMatchObject({ code: 'CONTEXT_LIMIT', message: 'Too long' });
    await expect(failed).rejects.toBeInstanceOf(AppleFmError);
    await helper.shutdown();

    const { helper: second, children: kids } = helperWith((message, child) => {
      if (message.type === 'cancel')
        child.reply({ type: 'done', id: message.id, stopReason: 'cancelled' });
    });
    const controller = new AbortController();
    const running = second.generate(
      { messages: [{ role: 'user', content: 'Go' }], maxTokens: 512, contextSize: 4096 },
      { onDelta: () => {}, onToolCall: async () => ({ output: '' }) },
      controller.signal,
    );
    await vi.waitFor(() => expect(kids[0]!.sent.some((m) => m.type === 'generate')).toBe(true));
    controller.abort();
    await expect(running).resolves.toBe('cancelled');
    expect(children).toHaveLength(1);
    await second.shutdown();
  });

  it('fails pending work when the helper dies and starts a fresh one next time', async () => {
    const { helper, children, spawnImpl } = helperWith(() => {});
    const running = helper.generate(
      { messages: [{ role: 'user', content: 'Go' }], maxTokens: 512, contextSize: 4096 },
      { onDelta: () => {}, onToolCall: async () => ({ output: '' }) },
    );
    await vi.waitFor(() => expect(children[0]!.sent.some((m) => m.type === 'generate')).toBe(true));
    children[0]!.exit(9);
    await expect(running).rejects.toMatchObject({ code: 'HELPER_EXITED' });
    await expect(helper.ready()).resolves.toMatchObject({ available: true });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await helper.shutdown();
  });
});
