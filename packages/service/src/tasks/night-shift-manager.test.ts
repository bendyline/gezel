import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from './manager.js';
import { NightShiftManager } from './night-shift-manager.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;
let events: ChatEventBus;
let clock: number;

// Default window is 22:00 → 06:00 local.
const localMs = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-nightshift-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'NS' });
  tasks = new TaskManager(store, history);
  events = new ChatEventBus();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function makeManager(): NightShiftManager {
  return new NightShiftManager({ store, manager: tasks, events, now: () => new Date(clock) });
}

async function addNightTask(): Promise<void> {
  await tasks.create('ns', {
    title: 'Index docs',
    assignee: { kind: 'user' },
    steps: [{ name: 'Scan' }],
    nightShift: { enabled: true },
  });
}

describe('NightShiftManager', () => {
  it('is OFF outside the window', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 12, 0);
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(m.isWindowOpen()).toBe(false);
  });

  it('turns ON inside the window when night-shift work is pending', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('scheduled');
    expect(m.isWindowOpen()).toBe(true);
  });

  it('latches OFF when the window is open but nothing is pending, then re-opens next window', async () => {
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(false); // no pending → latched off

    // Pending work appears the same window — still latched off.
    await addNightTask();
    await m.tick();
    expect(m.isActive()).toBe(false);

    // Next night's window (new key) clears the latch → ON.
    clock = localMs(2026, 6, 21, 23, 0);
    await m.tick();
    expect(m.isActive()).toBe(true);
  });

  it('manual shift ignores the window and reverts when work drains', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 12, 0); // midday, window closed
    const m = makeManager();
    await m.startManual();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('manual');

    // Drain the only pending task → next tick ends the manual shift.
    const list = await tasks.list({ projectId: 'ns' });
    await tasks.setStatus('ns', list[0]!.num, 'paused');
    await m.tick();
    expect(m.isActive()).toBe(false); // reverted; window is closed
  });

  it('stopping a scheduled shift latches it off for the rest of the window', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0); // inside the window
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('scheduled');

    // User stops it mid-window — it must not re-activate on the next tick
    // even though pending work (and the window) remain.
    await m.stopManual();
    expect(m.isActive()).toBe(false);
    await m.tick();
    expect(m.isActive()).toBe(false);

    // Later that same window: still off.
    clock = localMs(2026, 6, 21, 2, 0);
    await m.tick();
    expect(m.isActive()).toBe(false);

    // Next night's window clears the latch → back on.
    clock = localMs(2026, 6, 21, 23, 0);
    await m.tick();
    expect(m.isActive()).toBe(true);
  });

  it('a manual start overrides a prior stop-latch in the same window', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    await m.stopManual();
    expect(m.isActive()).toBe(false);

    // Explicit opt-back-in runs even though we stopped this window earlier.
    await m.startManual();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('manual');
  });

  it('broadcasts a night_shift event on each transition', async () => {
    const seen: Array<Extract<ChatEvent, { type: 'night_shift' }>> = [];
    events.subscribeAll((env) => {
      if (env.event.type === 'night_shift') seen.push(env.event);
    });
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick(); // → ON
    clock = localMs(2026, 6, 21, 12, 0);
    await m.tick(); // → OFF (outside window)
    expect(seen.map((e) => e.active)).toEqual([true, false]);
    expect(seen[0]?.source).toBe('scheduled');
  });

  it('listPendingTasks surfaces the active night-shift tasks pending now', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0); // inside the window
    const m = makeManager();
    await m.tick(); // populate the cached window + go ON
    expect((await m.listPendingTasks()).map((t) => t.title)).toEqual(['Index docs']);

    // Draining the task (pause) drops it from the pending list.
    const list = await tasks.list({ projectId: 'ns' });
    await tasks.setStatus('ns', list[0]!.num, 'paused');
    expect(await m.listPendingTasks()).toEqual([]);
  });

  it('reports keep-awake intent only when active and the flag is set', async () => {
    await store.writeConfig({ nightShift: { keepAwakeWhileRunning: true } });
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    expect(m.getPowerIntent().keepAwake).toBe(true);
  });

  it('fires onWindowSettled once per settled window, including a startup catch-up', async () => {
    const settled: string[] = [];
    const m = makeManager();
    m.setOnWindowSettled(async (key) => {
      settled.push(key);
    });

    // Startup catch-up: first tick lands mid-morning, well after the
    // window's end (machine slept through 06:00).
    clock = localMs(2026, 6, 21, 10, 0);
    await m.tick();
    expect(settled).toEqual(['2026-06-20']);

    // Same day again — deduped in-process.
    clock = localMs(2026, 6, 21, 11, 0);
    await m.tick();
    expect(settled).toEqual(['2026-06-20']);

    // Inside the next window: nothing (the window isn't settled yet)…
    clock = localMs(2026, 6, 21, 23, 0);
    await m.tick();
    expect(settled).toEqual(['2026-06-20']);

    // …then the live open→closed transition at 06:00 fires the new key.
    clock = localMs(2026, 6, 22, 6, 30);
    await m.tick();
    expect(settled).toEqual(['2026-06-20', '2026-06-21']);
  });
});
