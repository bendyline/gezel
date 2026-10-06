import { describe, expect, it } from 'vitest';
import { MlxEngineGate } from './engine-gate.js';

async function settled<T>(promise: Promise<T>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe('MlxEngineGate priorities', () => {
  it('hands a freed slot to a waiting interactive request before earlier background ones', async () => {
    const gate = new MlxEngineGate(1);
    const order: string[] = [];
    const first = await gate.acquire('chat-1', undefined, undefined, 'interactive');
    const bg = gate.acquire('task', undefined, undefined, 'background').then((release) => {
      order.push('task');
      return release;
    });
    const chat = gate.acquire('chat-2', undefined, undefined, 'interactive').then((release) => {
      order.push('chat-2');
      return release;
    });
    first();
    (await chat)();
    (await bg)();
    expect(order).toEqual(['chat-2', 'task']);
  });

  it('lets one interactive request past the width when every slot is background work', async () => {
    // The sidecar parks background work for a waiting person, but only for a
    // request that reached it. With every slot held by task steps, a
    // person's message used to wait here, invisible to the engine.
    const gate = new MlxEngineGate(2);
    const bg1 = await gate.acquire('task-1', undefined, undefined, 'background');
    const bg2 = await gate.acquire('task-2', undefined, undefined, 'background');
    const chat = gate.acquire('chat', undefined, undefined, 'interactive');
    expect(await settled(chat)).toBe(true);
    // Only one: a second person waits for a real slot.
    const chat2 = gate.acquire('chat-2', undefined, undefined, 'interactive');
    expect(await settled(chat2)).toBe(false);
    // And background work never uses the overflow.
    const bg3 = gate.acquire('task-3', undefined, undefined, 'background');
    expect(await settled(bg3)).toBe(false);
    bg1();
    expect(await settled(chat2)).toBe(true);
    (await chat)();
    (await chat2)();
    bg2();
    expect(await settled(bg3)).toBe(true);
    (await bg3)();
    expect(gate.busy).toBe(false);
  });

  it('does not open the overflow while an interactive request already holds a slot', async () => {
    const gate = new MlxEngineGate(1);
    const chat = await gate.acquire('chat', undefined, undefined, 'interactive');
    const chat2 = gate.acquire('chat-2', undefined, undefined, 'interactive');
    expect(await settled(chat2)).toBe(false);
    chat();
    (await chat2)();
  });

  it('closes the overflow for an exclusive claim and waits for it to drain', async () => {
    const gate = new MlxEngineGate(1);
    const bg = await gate.acquire('task', undefined, undefined, 'background');
    const chat = await gate.acquire('chat', undefined, undefined, 'interactive');
    const all = gate.acquireAll('reload');
    bg();
    // The reload has every normal slot, but the overflow request is still
    // running on the engine, so the reload must not start yet.
    expect(await settled(all)).toBe(false);
    chat();
    const releaseAll = await all;
    // No overflow while the reload holds the engine.
    const late = gate.acquire('chat-late', undefined, undefined, 'interactive');
    expect(await settled(late)).toBe(false);
    releaseAll();
    (await late)();
    expect(gate.busy).toBe(false);
  });

  it('drops an aborted waiter without granting it', async () => {
    const gate = new MlxEngineGate(1);
    const hold = await gate.acquire('a', undefined, undefined, 'background');
    const ctrl = new AbortController();
    const waiting = gate.acquire('b', ctrl.signal, undefined, 'background');
    ctrl.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    hold();
    expect(gate.busy).toBe(false);
  });
});
