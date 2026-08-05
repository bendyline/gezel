import { describe, expect, it } from 'vitest';
import { serializeSseWrites } from './chat-events.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('serializeSseWrites', () => {
  it('keeps rapid event frames ordered with only one write in flight', async () => {
    const firstGate = deferred();
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let maxActive = 0;
    const write = serializeSseWrites(async (frame: number) => {
      started.push(frame);
      active++;
      maxActive = Math.max(maxActive, active);
      if (frame === 1) await firstGate.promise;
      finished.push(frame);
      active--;
    });

    const writes = [write(1), write(2), write(3)];
    await Promise.resolve();
    expect(started).toEqual([1]);
    firstGate.resolve();
    await Promise.all(writes);

    expect(started).toEqual([1, 2, 3]);
    expect(finished).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it('reports a failed write without poisoning the lane', async () => {
    const seen: number[] = [];
    const write = serializeSseWrites(async (frame: number) => {
      seen.push(frame);
      if (frame === 1) throw new Error('closed');
    });

    await expect(write(1)).rejects.toThrow('closed');
    await expect(write(2)).resolves.toBeUndefined();
    expect(seen).toEqual([1, 2]);
  });
});
