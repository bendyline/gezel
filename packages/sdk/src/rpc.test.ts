import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  writes: [] as string[],
  sockets: [] as Array<{
    handlers: Map<string, (...args: unknown[]) => void>;
    emit(event: string, ...args: unknown[]): void;
  }>,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
  writeSync: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) => {
    state.writes.push(buffer.subarray(offset, offset + length).toString('utf8'));
    return length;
  }),
}));

vi.mock('node:net', () => ({
  Socket: class FakeSocket {
    handlers = new Map<string, (...args: unknown[]) => void>();

    constructor() {
      state.sockets.push(this);
    }

    setEncoding(): void {}
    ref(): void {}
    unref(): void {}

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args);
    }
  },
}));

import { RpcClient } from './rpc.js';

beforeEach(() => {
  state.writes.length = 0;
  state.sockets.length = 0;
  delete process.env.GEZEL_SCRIPT_RUNTIME;
});

afterEach(() => {
  delete process.env.GEZEL_SCRIPT_RUNTIME;
});

describe('RpcClient framing', () => {
  it('uses a safe init object outside the sandbox runtime', () => {
    const client = new RpcClient();
    expect(client.init).toEqual({
      input: undefined,
      runId: '',
      projectId: '',
      engagementMode: 'off',
      engagementFlags: { llmAllowed: false },
    });
  });

  it('writes newline-delimited notifications without opening the read socket', () => {
    const client = new RpcClient();
    client.notify('output', { ok: true });

    expect(state.writes.join('')).toBe('{"method":"output","params":{"ok":true}}\n');
    expect(state.sockets).toHaveLength(0);
  });

  it('correlates a fragmented response with its pending call', async () => {
    const client = new RpcClient();
    const pending = client.call<{ value: number }>('fs.stat', { path: 'a.md' });
    const socket = state.sockets[0]!;

    expect(state.writes.join('')).toBe('{"id":1,"method":"fs.stat","params":{"path":"a.md"}}\n');
    socket.emit('data', '{"id":1,"result":{"val');
    socket.emit('data', 'ue":42}}\n');

    await expect(pending).resolves.toEqual({ value: 42 });
  });

  it('propagates structured RPC errors and their codes', async () => {
    const client = new RpcClient();
    const pending = client.call('fs.write', { path: 'a.md' });
    state.sockets[0]!.emit(
      'data',
      '{"id":1,"error":{"message":"denied","code":"CAPABILITY_DENIED"}}\n',
    );

    await expect(pending).rejects.toMatchObject({
      message: 'denied',
      code: 'CAPABILITY_DENIED',
    });
  });

  it('rejects outstanding calls when the channel closes', async () => {
    const client = new RpcClient();
    const pending = client.call('fs.read');
    state.sockets[0]!.emit('end');

    await expect(pending).rejects.toThrow('script RPC channel closed');
  });
});
