import { describe, expect, it } from 'vitest';
import { readSseFrames } from './session.js';

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('readSseFrames watchdog', () => {
  it('gives up on a server that sent keep-alives and then went silent', async () => {
    const { stream, push } = controlledStream();
    const frames: unknown[] = [];
    push(': keepalive\n\n');
    push('data: {"type":"delta","text":"Hel"}\n\n');
    const outcome = await readSseFrames(stream, (f) => frames.push(f), {
      idleMs: 60,
      pollMs: 10,
    });
    expect(outcome).toBe('stalled');
    expect(frames).toEqual([{ type: 'delta', text: 'Hel' }]);
  });

  it('keeps waiting while keep-alives arrive', async () => {
    const { stream, push, close } = controlledStream();
    push(': keepalive\n\n');
    const reading = readSseFrames(stream, () => {}, { idleMs: 60, pollMs: 10 });
    for (let i = 0; i < 5; i++) {
      await sleep(30);
      push(': keepalive\n\n');
    }
    close();
    await expect(reading).resolves.toBe('complete');
  });

  it('never cuts off a server from before heartbeats, however long it is quiet', async () => {
    const { stream, push, close } = controlledStream();
    push('data: {"type":"phase","phase":"prefill"}\n\n');
    const reading = readSseFrames(stream, () => {}, { idleMs: 30, pollMs: 10 });
    await sleep(120);
    push('data: {"type":"done"}\n\n');
    close();
    await expect(reading).resolves.toBe('complete');
  });
});
