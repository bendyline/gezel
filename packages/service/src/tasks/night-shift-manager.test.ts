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

describe('NightShiftManager — ambient work', () => {
  function makeAmbientManager(work: {
    eligible: () => boolean;
    running: () => boolean;
  }): { m: NightShiftManager; eligibleCalls: () => number } {
    let calls = 0;
    const m = new NightShiftManager({
      store,
      manager: tasks,
      events,
      now: () => new Date(clock),
      ambientWork: {
        hasEligibleProject: async () => {
          calls++;
          return work.eligible();
        },
        isRunning: () => work.running(),
      },
    });
    return { m, eligibleCalls: () => calls };
  }

  it('turns ON for an eligible folder with no tasks, holds while the sweep runs, then latches off', async () => {
    clock = localMs(2026, 6, 20, 22, 5);
    let running = false;
    const { m, eligibleCalls } = makeAmbientManager({
      eligible: () => true,
      running: () => running,
    });
    let activations = 0;
    m.setOnActivated(async () => {
      activations++;
      running = true; // the sweep starts on activation
    });

    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('scheduled');

    clock = localMs(2026, 6, 20, 23, 30);
    await m.tick();
    expect(m.isActive()).toBe(true); // still sweeping

    running = false; // sweep and its hand-off finished
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(activations).toBe(1);
    expect(eligibleCalls()).toBe(1); // never asked for a second sweep

    clock = localMs(2026, 6, 21, 1, 0);
    await m.tick();
    expect(m.isActive()).toBe(false); // latched for the rest of the window
  });

  it('latches off when no project is eligible, as before', async () => {
    clock = localMs(2026, 6, 20, 23, 0);
    const { m } = makeAmbientManager({ eligible: () => false, running: () => false });
    await m.tick();
    expect(m.isActive()).toBe(false);
  });

  it('does not ask for a second sweep after a task-triggered shift drains', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    let running = false;
    const { m, eligibleCalls } = makeAmbientManager({
      eligible: () => true,
      running: () => running,
    });
    m.setOnActivated(async () => {
      running = true;
    });
    await m.tick();
    expect(m.isActive()).toBe(true);
    const callsAtActivation = eligibleCalls();

    const list = await tasks.list({ projectId: 'ns' });
    await tasks.setStatus('ns', list[0]!.num, 'paused');
    running = false;
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(eligibleCalls()).toBe(callsAtActivation);
  });

  it('runs a manual shift for ambient work alone, then reverts', async () => {
    clock = localMs(2026, 6, 20, 12, 0); // midday
    let running = false;
    const { m } = makeAmbientManager({ eligible: () => true, running: () => running });
    m.setOnActivated(async () => {
      running = true;
    });
    await m.startManual();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('manual');

    running = false;
    await m.tick();
    expect(m.isActive()).toBe(false);
  });

  it('stays off outside the window with no manual request', async () => {
    clock = localMs(2026, 6, 20, 12, 0);
    const { m, eligibleCalls } = makeAmbientManager({ eligible: () => true, running: () => false });
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(eligibleCalls()).toBe(0);
  });
});

describe('NightShiftManager — night-shift hosts', () => {
  async function addNightHost(): Promise<void> {
    await tasks.create('ns', {
      title: 'Night shift: digest',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait for schedule' }],
      spawnsSteps: [{ name: 'Digest' }],
      cron: { expression: '*/30 * * * *', overlap: 'skip' },
      nightShift: { enabled: true, onceADay: true },
    });
  }

  it('stays on early in the window for a host that has not spawned tonight', async () => {
    await addNightHost();
    clock = localMs(2026, 6, 20, 22, 0);
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(true);
  });

  it('does not hold the shift for a host that never spawns past the grace period', async () => {
    await addNightHost();
    clock = localMs(2026, 6, 20, 23, 30);
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(false);
  });

  it('does not count a host that already spawned tonight', async () => {
    await addNightHost();
    const [host] = await tasks.list({ projectId: 'ns' });
    await tasks.recordNightShiftSpawn(host!.ref, '2026-06-20');
    clock = localMs(2026, 6, 20, 22, 0);
    const m = makeManager();
    await m.tick();
    expect(m.isActive()).toBe(false);
  });
});

describe('NightShiftManager — window outcome', () => {
  it('reads a window it never saw open as asleep', async () => {
    clock = localMs(2026, 6, 21, 9, 0); // morning, first tick after a night asleep
    const m = makeManager();
    await m.tick();
    expect(m.windowOutcome('2026-06-20')).toEqual({
      windowKey: '2026-06-20',
      ran: false,
      reason: 'asleep',
    });
  });

  it('records when the shift ran and when it ended', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const m = makeManager();
    await m.tick();
    const list = await tasks.list({ projectId: 'ns' });
    await tasks.setStatus('ns', list[0]!.num, 'paused');
    clock = localMs(2026, 6, 20, 23, 30);
    await m.tick();
    const outcome = m.windowOutcome('2026-06-20');
    expect(outcome.ran).toBe(true);
    expect(outcome.reason).toBeUndefined();
    expect(outcome.startedAt).toBe(new Date(localMs(2026, 6, 20, 23, 0)).toISOString());
    expect(outcome.endedAt).toBe(new Date(localMs(2026, 6, 20, 23, 30)).toISOString());
  });

  it('names a night with nothing owed as no-work, and a stopped one as stopped', async () => {
    clock = localMs(2026, 6, 20, 23, 0);
    const idle = makeManager();
    await idle.tick();
    expect(idle.windowOutcome('2026-06-20').reason).toBe('no-work');

    await addNightTask();
    const stopped = makeManager();
    await stopped.stopManual();
    expect(stopped.windowOutcome('2026-06-20')).toMatchObject({ ran: false, reason: 'stopped' });
  });
});

describe('NightShiftManager — window opened', () => {
  it('runs the window-opened hook once per window, before deciding', async () => {
    clock = localMs(2026, 6, 20, 22, 1);
    const m = makeManager();
    const opened = vi.fn(async () => {
      await addNightTask(); // e.g. the oversight task, re-created
    });
    m.setOnWindowOpened(opened);
    await m.tick();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(m.isActive()).toBe(true); // the queued work counted tonight, no latch

    clock = localMs(2026, 6, 20, 23, 0);
    await m.tick();
    expect(opened).toHaveBeenCalledTimes(1);

    clock = localMs(2026, 6, 21, 12, 0);
    await m.tick();
    clock = localMs(2026, 6, 21, 22, 5);
    await m.tick();
    expect(opened).toHaveBeenCalledTimes(2);
  });
});

describe('NightShiftManager — on battery', () => {
  function onPower(onBattery: { value: boolean | null }) {
    return new NightShiftManager({
      store,
      manager: tasks,
      events,
      now: () => new Date(clock),
      power: { onBatteryPower: () => onBattery.value },
    });
  }

  it('stands down when unplugged mid-shift and resumes on mains, without latching', async () => {
    await addNightTask();
    await store.writeConfig({ nightShift: { keepAwakeWhileRunning: true } });
    clock = localMs(2026, 6, 20, 23, 0);
    const power = { value: false as boolean | null };
    const m = onPower(power);
    const deactivated = vi.fn(async () => {});
    m.setOnDeactivated(deactivated);
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.getPowerIntent().keepAwake).toBe(true);

    power.value = true;
    clock = localMs(2026, 6, 20, 23, 30);
    await m.tick();
    expect(m.isActive()).toBe(false);
    expect(m.isHeldOnBattery()).toBe(true);
    expect(m.getPowerIntent().keepAwake).toBe(false);
    expect(deactivated).toHaveBeenCalledTimes(1);

    power.value = false;
    clock = localMs(2026, 6, 21, 0, 0);
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.isHeldOnBattery()).toBe(false);
  });

  it('names a night spent on battery, and keeps a manual shift for when power returns', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const power = { value: true as boolean | null };
    const m = onPower(power);
    await m.startManual();
    expect(m.isActive()).toBe(false);
    expect(m.windowOutcome('2026-06-20')).toMatchObject({ ran: false, reason: 'on-battery' });

    power.value = false;
    await m.tick();
    expect(m.isActive()).toBe(true);
    expect(m.source()).toBe('manual');
  });

  it('runs on battery when the person turned the pause off, or the power source is unknown', async () => {
    await addNightTask();
    clock = localMs(2026, 6, 20, 23, 0);
    const unknown = onPower({ value: null });
    await unknown.tick();
    expect(unknown.isActive()).toBe(true);

    await store.writeConfig({ nightShift: { pauseOnBattery: false } });
    const optedOut = onPower({ value: true });
    await optedOut.tick();
    expect(optedOut.isActive()).toBe(true);
  });
});
