import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { ProviderName } from '../providers/types.js';
import { TaskManager } from './manager.js';
import type { QuotaReserveHold } from './night-quota-gate.js';
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

  it('reconciles work exactly once when a shift transitions on', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 12, 0);
    const m = makeManager();
    let activations = 0;
    m.setOnActivated(async () => {
      activations++;
    });

    await m.startManual();
    expect(activations).toBe(1);

    await m.tick();
    expect(activations).toBe(1);

    await m.stopManual();
    await m.startManual();
    expect(activations).toBe(2);
  });

  // Queue-admission consumers re-read `isActive()` and need no signal. Work
  // the ACTIVATION callback started does — the index catch-up sweep ran 40
  // minutes past `endHour` on 2026-08-21 because nothing told it to stop.
  it('signals stand-down exactly once when a shift transitions off', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    let deactivations = 0;
    m.setOnDeactivated(async () => {
      deactivations++;
    });

    await m.tick(); // → ON (inside window, work pending)
    expect(deactivations).toBe(0);

    clock = localMs(2026, 6, 21, 12, 0);
    await m.tick(); // → OFF (window closed)
    expect(deactivations).toBe(1);

    // Still off: no second signal for a shift that never restarted.
    await m.tick();
    expect(deactivations).toBe(1);
  });

  it('fires stand-down on a manual stop too', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 12, 0); // daytime — manual shift only
    const m = makeManager();
    let deactivations = 0;
    m.setOnDeactivated(async () => {
      deactivations++;
    });

    await m.startManual();
    expect(deactivations).toBe(0);
    await m.stopManual();
    expect(deactivations).toBe(1);
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

  it('stamps the period start at the ON edge and keeps it across a source change', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 21, 0); // manual, before the window opens
    const m = makeManager();
    await m.startManual();
    const startedAt = m.startedAtIso();
    expect(startedAt).toBe(new Date(clock).toISOString());

    // The window opens and takes the running shift over — same period.
    clock = localMs(2026, 6, 20, 23, 0);
    await m.stopManual();
    await m.startManual();
    expect(m.source()).toBe('manual');
    clock = localMs(2026, 6, 21, 0, 0);
    await m.tick();
    expect(m.startedAtIso()).not.toBeNull();

    // Draining it ends the period.
    const list = await tasks.list({ projectId: 'ns' });
    await tasks.setStatus('ns', list[0]!.num, 'paused');
    clock = localMs(2026, 6, 21, 12, 0);
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(m.startedAtIso()).toBeNull();
  });

  it('names the open window, else the next one due', async () => {
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    const open = m.windowBounds();
    expect(open?.open).toBe(true);
    expect(open?.start).toBe(new Date(localMs(2026, 6, 20, 22, 0)).toISOString());
    expect(open?.end).toBe(new Date(localMs(2026, 6, 21, 6, 0)).toISOString());

    clock = localMs(2026, 6, 21, 12, 0);
    await m.tick();
    const next = m.windowBounds();
    expect(next?.open).toBe(false);
    expect(next?.start).toBe(new Date(localMs(2026, 6, 21, 22, 0)).toISOString());
    expect(next?.end).toBe(new Date(localMs(2026, 6, 22, 6, 0)).toISOString());
  });

  it('has no window to name while the feature is switched off', async () => {
    await store.writeConfig({ nightShift: { enabled: false } });
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    expect(m.windowBounds()).toBeNull();
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

describe('NightShiftManager — quota reserve holds', () => {
  const HOLD: QuotaReserveHold = {
    provider: 'copilot',
    bucket: 'premium_interactions',
    remainingPercent: 12,
    floorPercent: 20,
    rule: 'overall',
  };

  function makeQuotaManager(opts: {
    holdFor: (provider: ProviderName) => Promise<QuotaReserveHold | null>;
    resolve?: (gezelId: string) => Promise<ProviderName>;
  }): NightShiftManager {
    return new NightShiftManager({
      store,
      manager: tasks,
      events,
      now: () => new Date(clock),
      quotaGate: { holdFor: opts.holdFor },
      resolveProviderName: opts.resolve ?? (async () => 'copilot'),
    });
  }

  async function addGezelNightTask(gezelId: string): Promise<string> {
    const task = await tasks.create('ns', {
      title: `Night work for ${gezelId}`,
      assignee: { kind: 'gezel', gezelId },
      steps: [{ name: 'Scan' }],
      nightShift: { enabled: true },
    });
    return task.ref;
  }

  it('parks a fully-held shift without latching, then resumes when quota frees', async () => {
    await store.createGezel({ name: 'Bea' });
    const ref = await addGezelNightTask('bea');
    clock = localMs(2026, 6, 20, 23, 0); // inside the window

    let holding = true;
    const m = makeQuotaManager({ holdFor: async () => (holding ? HOLD : null) });
    let activations = 0;
    m.setOnActivated(async () => {
      activations++;
    });

    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(m.quotaHoldStatus()).toEqual({ heldTaskCount: 1, reasons: [HOLD] });
    expect([...m.quotaHeldTaskRefs()]).toEqual([ref]);
    expect(activations).toBe(0);

    // Quota frees mid-window (e.g. a five_hour reset) — the load-bearing
    // assertion: no latch was set, so the very next tick re-activates.
    holding = false;
    clock = localMs(2026, 6, 20, 23, 30); // same window
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('scheduled');
    expect(m.quotaHoldStatus()).toBeNull();
    expect(m.quotaHeldTaskRefs().size).toBe(0);
    expect(activations).toBe(1);
  });

  it('stays active for dispatchable work while holding only the gated provider', async () => {
    await store.createGezel({ name: 'Bea' });
    await store.createGezel({ name: 'Cas' });
    const heldRef = await addGezelNightTask('bea');
    await addGezelNightTask('cas');
    clock = localMs(2026, 6, 20, 23, 0);

    const m = makeQuotaManager({
      holdFor: async (provider) => (provider === 'copilot' ? HOLD : null),
      resolve: async (gezelId) => (gezelId === 'bea' ? 'copilot' : 'llama-cpp'),
    });
    await m.tick();

    expect(m.isActive()).toBe(true);
    expect(m.quotaHoldStatus()).toEqual({ heldTaskCount: 1, reasons: [HOLD] });
    expect([...m.quotaHeldTaskRefs()]).toEqual([heldRef]);
  });

  it('releases keep-awake while fully quota-held despite the config flag', async () => {
    await store.writeConfig({ nightShift: { keepAwakeWhileRunning: true } });
    await store.createGezel({ name: 'Bea' });
    await addGezelNightTask('bea');
    clock = localMs(2026, 6, 20, 23, 0);

    const m = makeQuotaManager({ holdFor: async () => HOLD });
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(m.getPowerIntent().keepAwake).toBe(false);
  });

  it('keeps a manual request alive through a full hold and resumes as manual', async () => {
    await store.createGezel({ name: 'Bea' });
    await addGezelNightTask('bea');
    clock = localMs(2026, 6, 20, 12, 0); // midday — manual ignores the window

    let holding = true;
    const m = makeQuotaManager({ holdFor: async () => (holding ? HOLD : null) });
    let activations = 0;
    m.setOnActivated(async () => {
      activations++;
    });

    await m.startManual();
    expect(m.isActive()).toBe(false); // asked, but everything is held
    expect(m.quotaHoldStatus()).not.toBeNull();

    // No second startManual: the surviving request resumes by itself.
    holding = false;
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('manual');
    expect(activations).toBe(1);
  });

  it('never probes the gate outside a window that could activate', async () => {
    await store.createGezel({ name: 'Bea' });
    await addGezelNightTask('bea');
    clock = localMs(2026, 6, 20, 12, 0); // midday, no manual request

    const gate = vi.fn(async () => HOLD);
    const m = makeQuotaManager({ holdFor: gate });
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
});
