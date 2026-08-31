import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortedWhileQueuedError, ProviderQueue, backgroundLaneCap, runInQueue } from './queue.js';

/**
 * Fake clock: each `advance(ms)` also flushes any microtask
 * promises waiting on the queue. Keeps tests deterministic without
 * real timers.
 */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function flush(): Promise<void> {
  // Two yields cover the typical Promise-resolve chain used inside
  // acquire()'s executor + drain(). Any more and we've got a bug.
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProviderQueue — basic gating', () => {
  it('runs up to `concurrency` in parallel and queues the rest', async () => {
    const q = new ProviderQueue({ concurrency: 2 });
    const r1 = await q.acquire({ lane: 'interactive' });
    const r2 = await q.acquire({ lane: 'interactive' });
    expect(q.snapshot().running).toBe(2);
    expect(q.snapshot().queuedInteractive).toBe(0);

    // Third immediately queues.
    const p3 = q.acquire({ lane: 'interactive' });
    await flush();
    expect(q.snapshot().running).toBe(2);
    expect(q.snapshot().queuedInteractive).toBe(1);

    r1();
    const r3 = await p3;
    expect(q.snapshot().running).toBe(2);
    expect(q.snapshot().queuedInteractive).toBe(0);
    r2();
    r3();
    expect(q.snapshot().running).toBe(0);
  });

  it('throws on invalid concurrency', () => {
    expect(() => new ProviderQueue({ concurrency: 0 })).toThrow();
  });
});

describe('ProviderQueue — priority lanes', () => {
  it('drains interactive before background', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'background' });

    // Two enqueue in order: background first, then interactive.
    const bgOrder: string[] = [];
    const pB = q.acquire({ lane: 'background' }).then((r) => {
      bgOrder.push('background');
      return r;
    });
    const pI = q.acquire({ lane: 'interactive' }).then((r) => {
      bgOrder.push('interactive');
      return r;
    });
    await flush();

    r1();
    const release = await Promise.race([pI, pB]);
    expect(bgOrder[0]).toBe('interactive');
    release();
    (await pB)();
    (await pI.catch(() => () => {}))?.();
  });

  it('snapshot counts each lane separately', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    const pI = q.acquire({ lane: 'interactive' });
    const pB1 = q.acquire({ lane: 'background' });
    const pB2 = q.acquire({ lane: 'background' });
    await flush();
    expect(q.snapshot()).toEqual({
      running: 1,
      queuedInteractive: 1,
      queuedBackground: 2,
    });
    r1();
    (await pI)();
    (await pB1)();
    (await pB2)();
  });
});

describe('ProviderQueue — cancellation', () => {
  it('drops a queued entry when its signal aborts, without taking a slot', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });

    const ctrl = new AbortController();
    const p2 = q.acquire({ lane: 'interactive', signal: ctrl.signal });
    await flush();
    expect(q.snapshot().queuedInteractive).toBe(1);

    ctrl.abort();
    await expect(p2).rejects.toBeInstanceOf(AbortedWhileQueuedError);
    expect(q.snapshot().queuedInteractive).toBe(0);
    expect(q.snapshot().running).toBe(1);

    // The slot still belongs to r1; releasing it shouldn't error.
    r1();
    expect(q.snapshot().running).toBe(0);
  });

  it('rejects immediately if signal was already aborted', async () => {
    const q = new ProviderQueue({ concurrency: 2 });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(q.acquire({ lane: 'interactive', signal: ctrl.signal })).rejects.toBeInstanceOf(
      AbortedWhileQueuedError,
    );
    expect(q.snapshot().running).toBe(0);
  });

  it('cancelPending(id) drops a queued entry without taking a slot', async () => {
    // Same shape as the QueueMeter's per-item ✕ button: the user spots
    // a turn they didn't mean to queue, the UI looks up its id from the
    // describe() snapshot, and a DELETE drops it.
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    const p2 = q.acquire({ lane: 'interactive' });
    await flush();
    const snap = q.describe();
    expect(snap.pending).toHaveLength(1);
    const id = snap.pending[0]!.id;
    expect(typeof id).toBe('number');

    expect(q.cancelPending(id)).toBe(true);
    await expect(p2).rejects.toBeInstanceOf(AbortedWhileQueuedError);
    expect(q.snapshot().queuedInteractive).toBe(0);
    expect(q.snapshot().running).toBe(1);

    // Cancelling an unknown id is a clean no-op.
    expect(q.cancelPending(9999)).toBe(false);
    r1();
  });
});

describe('ProviderQueue — manual reorder', () => {
  it('movePending up makes the entry sort earlier than its predecessor', async () => {
    // The dispatcher picks the lane-oldest pending entry on tie, so the
    // useful invariant is "after movePending('up'), this entry has an
    // older effective enqueuedAt than the neighbour above it." We
    // assert that via the `waitedMs` field describe() returns rather
    // than racing the dispatcher (which would also pick the oldest
    // peer that wasn't moved).
    const clock = fakeClock(1000);
    const q = new ProviderQueue({ concurrency: 1, now: clock.now });
    const r1 = await q.acquire({ lane: 'interactive' });

    clock.advance(10);
    void q.acquire({ lane: 'interactive' });
    clock.advance(10);
    void q.acquire({ lane: 'interactive' });
    clock.advance(10);
    void q.acquire({ lane: 'interactive' });
    await flush();

    let snap = q.describe();
    expect(snap.pending).toHaveLength(3);
    const [a, b, c] = snap.pending;
    expect(c!.waitedMs).toBeLessThan(b!.waitedMs); // C is youngest

    expect(q.movePending(c!.id, 'up')).toBe(true);
    snap = q.describe();
    const cAfter = snap.pending.find((p) => p.id === c!.id)!;
    const bAfter = snap.pending.find((p) => p.id === b!.id)!;
    const aAfter = snap.pending.find((p) => p.id === a!.id)!;
    // C now sorts before B (older effective enqueuedAt) but still
    // after A (the move only swapped C with its immediate neighbour).
    expect(cAfter.waitedMs).toBeGreaterThan(bAfter.waitedMs);
    expect(cAfter.waitedMs).toBeLessThan(aAfter.waitedMs);
    r1();
  });

  it('movePending down makes the entry sort later than its successor', async () => {
    const clock = fakeClock(1000);
    const q = new ProviderQueue({ concurrency: 1, now: clock.now });
    const r1 = await q.acquire({ lane: 'interactive' });

    clock.advance(10);
    void q.acquire({ lane: 'interactive' });
    clock.advance(10);
    void q.acquire({ lane: 'interactive' });
    clock.advance(10);
    void q.acquire({ lane: 'interactive' });
    await flush();

    const snap = q.describe();
    const [a, b] = snap.pending;
    expect(q.movePending(a!.id, 'down')).toBe(true);
    const after = q.describe();
    const aAfter = after.pending.find((p) => p.id === a!.id)!;
    const bAfter = after.pending.find((p) => p.id === b!.id)!;
    // A is now younger (smaller waitedMs) than B.
    expect(aAfter.waitedMs).toBeLessThan(bAfter.waitedMs);
    r1();
  });

  it('movePending returns false at the lane edge', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    void q.acquire({ lane: 'interactive' });
    void q.acquire({ lane: 'interactive' });
    await flush();
    const snap = q.describe();
    const first = snap.pending[0]!.id;
    const last = snap.pending[1]!.id;
    expect(q.movePending(first, 'up')).toBe(false);
    expect(q.movePending(last, 'down')).toBe(false);
    r1();
  });

  it('movePending refuses to cross lane boundaries', async () => {
    // Even if the user clicks ↓ on an interactive item that's the last
    // interactive entry, we don't demote it past background items —
    // the dispatcher's lane invariant (interactive always wins) would
    // make the move pointless.
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    void q.acquire({ lane: 'interactive' });
    void q.acquire({ lane: 'background' });
    await flush();
    const snap = q.describe();
    const interactiveId = snap.pending.find((p) => p.lane === 'interactive')!.id;
    expect(q.movePending(interactiveId, 'down')).toBe(false);
    r1();
  });
});

describe('ProviderQueue — lane-aware interactiveConcurrency', () => {
  it('reports interactiveConcurrency in describe(), defaulting to total concurrency', async () => {
    const def = new ProviderQueue({ concurrency: 3 });
    expect(def.describe().interactiveConcurrency).toBe(3);
    const split = new ProviderQueue({ concurrency: 2, interactiveConcurrency: 1 });
    expect(split.describe().interactiveConcurrency).toBe(1);
  });

  it('clamps interactiveConcurrency into [1, concurrency]', () => {
    expect(
      new ProviderQueue({ concurrency: 2, interactiveConcurrency: 0 }).describe()
        .interactiveConcurrency,
    ).toBe(1);
    expect(
      new ProviderQueue({ concurrency: 2, interactiveConcurrency: 99 }).describe()
        .interactiveConcurrency,
    ).toBe(2);
  });

  it('lets a background turn fill the 2nd slot while an interactive turn is running', async () => {
    // The whole point of the cap: foreground at 1, background fills
    // the 2nd slot. Without the cap a 2nd interactive would race ahead
    // of the background.
    const q = new ProviderQueue({ concurrency: 2, interactiveConcurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    const r2 = await q.acquire({ lane: 'background' });
    expect(q.snapshot().running).toBe(2);
    r1();
    r2();
  });

  it('does NOT let a 2nd interactive jump in alongside the 1st (cap holds)', async () => {
    const q = new ProviderQueue({ concurrency: 2, interactiveConcurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });

    let resolved = false;
    const p2 = q.acquire({ lane: 'interactive' }).then((release) => {
      resolved = true;
      return release;
    });
    await flush();
    // Even though a 2nd slot is free, the interactive cap blocks p2.
    expect(resolved).toBe(false);
    expect(q.snapshot().running).toBe(1);
    expect(q.snapshot().queuedInteractive).toBe(1);

    r1();
    const r2 = await p2;
    expect(resolved).toBe(true);
    r2();
  });

  it('background fills the cap-blocked slot rather than waiting behind the interactive queue', async () => {
    const q = new ProviderQueue({ concurrency: 2, interactiveConcurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });

    // Queue order: [interactive#2, background]. With strict lane priority
    // the background would wait forever for the interactive cap to
    // open. The split lets background run *now* in the 2nd slot.
    let interactive2Resolved = false;
    let backgroundResolved = false;
    const pInteractive2 = q.acquire({ lane: 'interactive' }).then((r) => {
      interactive2Resolved = true;
      return r;
    });
    const pBackground = q.acquire({ lane: 'background' }).then((r) => {
      backgroundResolved = true;
      return r;
    });
    await flush();
    expect(interactive2Resolved).toBe(false);
    expect(backgroundResolved).toBe(true);

    // Releasing the running background frees the 2nd slot, but
    // interactive#2 still waits because the 1st slot's interactive is
    // still running.
    const rBg = await pBackground;
    rBg();
    await flush();
    expect(interactive2Resolved).toBe(false);

    // Now release the 1st-slot interactive; the cap drops, interactive#2 runs.
    r1();
    const rI2 = await pInteractive2;
    expect(interactive2Resolved).toBe(true);
    rI2();
  });

  it('interactiveConcurrency=concurrency preserves pre-split behavior (cloud providers)', async () => {
    // Cloud providers default to concurrency:10 with no cap. Two
    // interactive turns should run in parallel, same as before.
    const q = new ProviderQueue({ concurrency: 10 });
    const r1 = await q.acquire({ lane: 'interactive' });
    const r2 = await q.acquire({ lane: 'interactive' });
    expect(q.snapshot().running).toBe(2);
    r1();
    r2();
  });

  it('decrements runningInteractive on release so the next interactive can run', async () => {
    // Regression guard for the lane-tracking counter — if release
    // doesn't drop the count, subsequent interactive turns get stuck
    // even after their predecessor finishes.
    const q = new ProviderQueue({ concurrency: 2, interactiveConcurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    r1();
    const r2 = await q.acquire({ lane: 'interactive' });
    r2();
    const r3 = await q.acquire({ lane: 'interactive' });
    r3();
    expect(q.snapshot().running).toBe(0);
  });
});

describe('ProviderQueue — affinity', () => {
  it('prefers same-session over same-gezel over unrelated when slot frees', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    // R1 has (gezel A, session 1). When it releases, we want the
    // queue to prefer items sharing session 1, then items sharing
    // gezel A, then FIFO.
    const r1 = await q.acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' });

    const order: string[] = [];
    const pUnrelated = q
      .acquire({ lane: 'interactive', gezelId: 'B', sessionId: '99' })
      .then((r) => {
        order.push('unrelated');
        return r;
      });
    const pSameGezel = q
      .acquire({ lane: 'interactive', gezelId: 'A', sessionId: '2' })
      .then((r) => {
        order.push('same-gezel');
        return r;
      });
    const pSameSession = q
      .acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' })
      .then((r) => {
        order.push('same-session');
        return r;
      });
    await flush();

    r1();
    const rA = await pSameSession;
    expect(order).toEqual(['same-session']);
    rA();
    const rB = await pSameGezel;
    expect(order).toEqual(['same-session', 'same-gezel']);
    rB();
    const rC = await pUnrelated;
    expect(order).toEqual(['same-session', 'same-gezel', 'unrelated']);
    rC();
  });

  it('per-request affinity: false drops scoring for just that entry', async () => {
    // Two pending items both share session '1' with the running
    // slot. Without the opt-out, either would beat an unrelated
    // peer; with `affinity: false` on one of them, the FIFO tie
    // with a competing peer resolves by enqueue order instead.
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' });

    const order: string[] = [];
    // Unrelated, enqueued first — has no affinity boost.
    const pUnrelated = q
      .acquire({ lane: 'interactive', gezelId: 'B', sessionId: '99' })
      .then((r) => {
        order.push('unrelated');
        return r;
      });
    // Same-session but opted out of scoring — also no boost.
    const pOptedOut = q
      .acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1', affinity: false })
      .then((r) => {
        order.push('opted-out');
        return r;
      });
    await flush();

    r1();
    const a = await pUnrelated;
    expect(order).toEqual(['unrelated']); // FIFO wins, not the same-session peer
    a();
    const b = await pOptedOut;
    b();
  });

  it('never violates lane priority — unrelated interactive beats same-session background', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' });

    const order: string[] = [];
    const pBgAffine = q.acquire({ lane: 'background', gezelId: 'A', sessionId: '1' }).then((r) => {
      order.push('bg-affine');
      return r;
    });
    const pFgUnrelated = q
      .acquire({ lane: 'interactive', gezelId: 'Z', sessionId: '99' })
      .then((r) => {
        order.push('fg-unrelated');
        return r;
      });
    await flush();

    r1();
    const a = await pFgUnrelated;
    expect(order).toEqual(['fg-unrelated']);
    a();
    const b = await pBgAffine;
    b();
  });

  it('strict FIFO when affinity disabled', async () => {
    const q = new ProviderQueue({ concurrency: 1, affinity: false });
    const r1 = await q.acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' });

    const order: string[] = [];
    const pOld = q.acquire({ lane: 'interactive', gezelId: 'B', sessionId: '99' }).then((r) => {
      order.push('old-unrelated');
      return r;
    });
    const pNewAffine = q
      .acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' })
      .then((r) => {
        order.push('new-affine');
        return r;
      });
    await flush();

    r1();
    const a = await pOld;
    expect(order).toEqual(['old-unrelated']);
    a();
    const b = await pNewAffine;
    b();
  });

  it('does not starve: old unrelated item eventually dispatches past affine arrivals', async () => {
    const clock = fakeClock();
    const q = new ProviderQueue({
      concurrency: 1,
      maxWaitMs: 60_000,
      affinityWindowMs: 30_000,
      now: clock.now,
    });
    const r1 = await q.acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' });

    const order: string[] = [];
    // Old, unrelated — enqueued at t=0.
    const pOld = q.acquire({ lane: 'interactive', gezelId: 'X', sessionId: '42' }).then((r) => {
      order.push('old');
      return r;
    });
    await flush();

    // Time passes past the maxWaitMs threshold.
    clock.advance(61_000);

    // Now a same-session item arrives. Affinity would normally prefer
    // it, but `old` has waited past the starvation bound.
    const pNewAffine = q
      .acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' })
      .then((r) => {
        order.push('new-affine');
        return r;
      });
    await flush();

    r1();
    const a = await pOld;
    expect(order).toEqual(['old']);
    a();
    const b = await pNewAffine;
    b();
  });
});

describe('ProviderQueue — snapshot accuracy', () => {
  it('carries explicit non-gezel actor labels through pending and active snapshots', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const releaseActive = await q.acquire({
      lane: 'background',
      projectId: 'library',
      actorLabel: 'Boekwachter',
      job: 'index enrichment',
    });
    const pending = q.acquire({
      lane: 'background',
      projectId: 'maintenance',
      actorLabel: 'System',
      job: 'maintenance',
    });
    await flush();

    expect(q.describe().active[0]).toMatchObject({
      projectId: 'library',
      actorLabel: 'Boekwachter',
      job: 'index enrichment',
    });
    expect(q.describe().pending[0]).toMatchObject({
      projectId: 'maintenance',
      actorLabel: 'System',
      job: 'maintenance',
    });

    releaseActive();
    const releasePending = await pending;
    releasePending();
  });

  it('counts are consistent across acquire/release waves', async () => {
    const q = new ProviderQueue({ concurrency: 3 });
    // Fill every slot (interactive) + queue 2 more (background).
    const r1 = await q.acquire({ lane: 'interactive' });
    const r2 = await q.acquire({ lane: 'interactive' });
    const r3 = await q.acquire({ lane: 'interactive' });
    const p4 = q.acquire({ lane: 'background' });
    const p5 = q.acquire({ lane: 'background' });
    await flush();
    expect(q.snapshot()).toEqual({
      running: 3,
      queuedInteractive: 0,
      queuedBackground: 2,
    });

    r1();
    const r4 = await p4;
    expect(q.snapshot()).toEqual({
      running: 3,
      queuedInteractive: 0,
      queuedBackground: 1,
    });

    r2();
    const r5 = await p5;
    expect(q.snapshot()).toEqual({
      running: 3,
      queuedInteractive: 0,
      queuedBackground: 0,
    });

    r3();
    r4();
    r5();
    expect(q.snapshot()).toEqual({
      running: 0,
      queuedInteractive: 0,
      queuedBackground: 0,
    });
  });
});

describe('ProviderQueue — backgroundConcurrency reservation (adaptive batching)', () => {
  it('reports backgroundConcurrency in describe(), defaulting to total concurrency', () => {
    expect(new ProviderQueue({ concurrency: 3 }).describe().backgroundConcurrency).toBe(3);
    expect(
      new ProviderQueue({ concurrency: 3, backgroundConcurrency: 2 }).describe()
        .backgroundConcurrency,
    ).toBe(2);
  });

  it('clamps backgroundConcurrency into [1, concurrency]', () => {
    expect(
      new ProviderQueue({ concurrency: 2, backgroundConcurrency: 0 }).describe()
        .backgroundConcurrency,
    ).toBe(1);
    expect(
      new ProviderQueue({ concurrency: 2, backgroundConcurrency: 99 }).describe()
        .backgroundConcurrency,
    ).toBe(2);
  });

  it('reports lane-aware capacity without consuming a slot', async () => {
    const q = new ProviderQueue({ concurrency: 4, backgroundConcurrency: 3 });
    expect(q.hasCapacity('background')).toBe(true);
    expect(q.hasCapacity('background', 2)).toBe(true);
    expect(q.hasCapacity('background', 3)).toBe(false);

    const release = await q.acquire({ lane: 'background' });
    expect(q.hasCapacity('background', 1)).toBe(true);
    expect(q.hasCapacity('background', 2)).toBe(false);
    expect(q.hasCapacity('interactive', 2)).toBe(true);
    expect(q.snapshot()).toEqual({
      running: 1,
      queuedInteractive: 0,
      queuedBackground: 0,
    });
    release();
  });

  it('reserves a slot for interactive: a background cohort cannot fill the last slot', async () => {
    // Adaptive policy shape: concurrency 2, interactive may use both,
    // but background is capped at 1 — so one slot is always free for an
    // arriving live turn (reservation, not preemption).
    const q = new ProviderQueue({
      concurrency: 2,
      interactiveConcurrency: 2,
      backgroundConcurrency: 1,
    });
    const rb1 = await q.acquire({ lane: 'background' });

    let bg2Resolved = false;
    const pBg2 = q.acquire({ lane: 'background' }).then((r) => {
      bg2Resolved = true;
      return r;
    });
    await flush();
    // The 2nd background can't take the reserved slot.
    expect(q.snapshot().running).toBe(1);
    expect(bg2Resolved).toBe(false);
    expect(q.snapshot().queuedBackground).toBe(1);

    // An interactive turn arrives and immediately takes the reserved slot.
    const ri1 = await q.acquire({ lane: 'interactive' });
    expect(q.snapshot().running).toBe(2);
    expect(bg2Resolved).toBe(false);
    ri1();

    // bg2 still waits — the single background slot is held by bg1.
    await flush();
    expect(bg2Resolved).toBe(false);

    // Releasing bg1 frees the background slot for bg2.
    rb1();
    const rb2 = await pBg2;
    expect(bg2Resolved).toBe(true);
    rb2();
  });

  it('lets two concurrent interactive turns co-occupy all slots (adaptive)', async () => {
    // The dual of today's interactiveConcurrency=1 cap: when batching is
    // on, two genuinely-concurrent interactive turns batch across slots.
    const q = new ProviderQueue({
      concurrency: 2,
      interactiveConcurrency: 2,
      backgroundConcurrency: 1,
    });
    const r1 = await q.acquire({ lane: 'interactive' });
    const r2 = await q.acquire({ lane: 'interactive' });
    expect(q.snapshot().running).toBe(2);
    r1();
    r2();
  });

  it('decrements runningBackground on release so a deferred background runs', async () => {
    // Regression guard for the background lane counter — symmetric with
    // the interactive one. If release doesn't drop runningBackground, the
    // reserved-slot logic wedges every subsequent background turn.
    const q = new ProviderQueue({
      concurrency: 2,
      interactiveConcurrency: 2,
      backgroundConcurrency: 1,
    });
    const rb1 = await q.acquire({ lane: 'background' });
    const pBg2 = q.acquire({ lane: 'background' });
    await flush();
    expect(q.snapshot().queuedBackground).toBe(1);
    rb1();
    const rb2 = await pBg2;
    expect(q.snapshot().running).toBe(1);
    rb2();
    expect(q.snapshot().running).toBe(0);
  });

  it('packs a same-gezel peer into a freed slot ahead of unrelated FIFO (cohort)', async () => {
    // Both slots full (gezel A in slot 1, an unrelated turn in slot 2) so
    // the two pending items genuinely compete when a slot frees — a free
    // slot would otherwise be taken greedily by whoever enqueued first.
    // Pending in FIFO order: unrelated gezel-B (older), gezel-A peer
    // (newer). When one slot frees, affinity fills it with the gezel-A
    // peer — not the FIFO-older unrelated — so the shared prefix stays
    // warm and the cohort co-batches onto the engine.
    const q = new ProviderQueue({ concurrency: 2, interactiveConcurrency: 2 });
    const rA = await q.acquire({ lane: 'interactive', gezelId: 'A', sessionId: '1' });
    const rFill = await q.acquire({ lane: 'interactive', gezelId: 'C', sessionId: '7' });
    expect(q.snapshot().running).toBe(2);

    const order: string[] = [];
    const pUnrelated = q
      .acquire({ lane: 'interactive', gezelId: 'B', sessionId: '9' })
      .then((r) => {
        order.push('unrelated');
        return r;
      });
    const pSameGezel = q
      .acquire({ lane: 'interactive', gezelId: 'A', sessionId: '2' })
      .then((r) => {
        order.push('same-gezel');
        return r;
      });
    await flush();
    expect(order).toEqual([]); // both wait — all slots full

    // Free one slot; affinity packs the gezel-A peer in first.
    rFill();
    const rSame = await pSameGezel;
    expect(order).toEqual(['same-gezel']);
    expect(q.snapshot().running).toBe(2);

    // Free the original slot; the unrelated turn finally drains.
    rA();
    const rU = await pUnrelated;
    expect(order).toEqual(['same-gezel', 'unrelated']);
    rSame();
    rU();
  });
});

describe('ProviderQueue — background reservation (mid-turn one-shot deadlock)', () => {
  // Regression: a local-engine turn runs its whole `runSend` inside ONE
  // interactive queue slot; mid-turn it fires a SYNCHRONOUS background one-shot
  // (in-flight compaction / memory extraction) on the SAME provider queue and
  // awaits it. If the queue has only one slot — the pre-fix MLX serial config,
  // reached once the memory ceiling clamped a big model to width 1 — that
  // one-shot can never dispatch, so the turn awaits a job that can't start and
  // the session wedges "mid-turn" forever.
  it('dispatches a background one-shot while a foreground turn holds its slot', async () => {
    // The serial-mode config both providers now build: 1 interactive + 1
    // reserved background slot.
    const q = new ProviderQueue({
      concurrency: 2,
      interactiveConcurrency: 1,
      backgroundConcurrency: 1,
    });
    const fg = await q.acquire({ lane: 'interactive' }); // held for the whole turn

    let bgDispatched = false;
    const bg = q.acquire({ lane: 'background' }).then((release) => {
      bgDispatched = true;
      return release;
    });
    await flush();
    expect(bgDispatched).toBe(true); // the deadlock would leave this false

    // The reservation did NOT loosen foreground serialization: a 2nd
    // interactive turn is still held back by the interactive cap of 1.
    let secondInteractive = false;
    const p2 = q.acquire({ lane: 'interactive' }).then((r) => {
      secondInteractive = true;
      return r;
    });
    await flush();
    expect(secondInteractive).toBe(false);

    (await bg)();
    fg();
    (await p2)();
  });

  it('pre-fix single-slot config starves the background one-shot (the bug)', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const fg = await q.acquire({ lane: 'interactive' });

    let bgDispatched = false;
    void q.acquire({ lane: 'background' }).then(() => {
      bgDispatched = true;
    });
    await flush();
    // Foreground holds the only slot; the background one-shot the turn would
    // await never dispatches — the deadlock the reserved slot fixes.
    expect(bgDispatched).toBe(false);
    fg();
  });
});

describe('ProviderQueue — ambient admission control', () => {
  it('gate off by default: ambient behaves like plain background', async () => {
    const q = new ProviderQueue({ concurrency: 1 });
    const r1 = await q.acquire({ lane: 'interactive' });
    let ambientRan = false;
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      ambientRan = true;
      return rel;
    });
    await flush();
    expect(ambientRan).toBe(false);
    r1();
    (await pAmbient)();
    expect(ambientRan).toBe(true);
  });

  it('holds ambient inside the quiet window; dispatches once the window elapses', async () => {
    const clock = fakeClock();
    const q = new ProviderQueue({ concurrency: 1, ambientQuietMs: 1000, now: clock.now });
    // User activity: an interactive turn runs and completes.
    const r1 = await q.acquire({ lane: 'interactive' });
    clock.advance(50);
    r1();

    let ambientRan = false;
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      ambientRan = true;
      return rel;
    });
    await flush();
    // Only 50ms into reading time — held.
    expect(ambientRan).toBe(false);
    expect(q.describe().ambientHeld).toBe(1);

    // Not yet: 999ms after the release.
    clock.advance(998);
    // Trigger a drain via a second ambient arrival (fake clock ⇒ the
    // real-time recheck timer is not what we're testing here).
    const pAmbient2 = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(ambientRan).toBe(false);

    clock.advance(2);
    const pAmbient3 = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(ambientRan).toBe(true);
    (await pAmbient)();
    (await pAmbient2)();
    (await pAmbient3)();
  });

  it('holds ambient while only one foreground slot remains, then uses capacity when it opens', async () => {
    const clock = fakeClock();
    const q = new ProviderQueue({ concurrency: 2, ambientQuietMs: 1000, now: clock.now });
    const fg = await q.acquire({ lane: 'interactive' });
    let ambientRan = false;
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      ambientRan = true;
      return rel;
    });
    await flush();
    // A slot is free (concurrency 2) and hours pass — but a real turn is
    // running, so ambient stays held.
    clock.advance(60 * 60_000);
    const poke = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(ambientRan).toBe(false);
    fg();
    // Releasing the foreground turn opens two physical slots. Ambient may
    // use one immediately while the other remains protected for chat.
    await flush();
    expect(ambientRan).toBe(true);
    (await pAmbient)();
    (await poke)();
  });

  it('runs ambient work in spare multi-slot capacity while preserving one foreground slot', async () => {
    const clock = fakeClock();
    // Four physical interactive slots plus the provider's one logical
    // deadlock-breaking queue lane. Ambient work may bring total running
    // leases to three, leaving one physical slot ready for another chat.
    const q = new ProviderQueue({
      concurrency: 5,
      interactiveConcurrency: 4,
      backgroundConcurrency: 3,
      ambientQuietMs: 1000,
      now: clock.now,
    });
    const foreground = await q.acquire({ lane: 'interactive' });
    const firstAmbient = q.acquire({ lane: 'background', ambient: true });
    const secondAmbient = q.acquire({ lane: 'background', ambient: true });
    let thirdAmbientRan = false;
    const thirdAmbient = q.acquire({ lane: 'background', ambient: true }).then((release) => {
      thirdAmbientRan = true;
      return release;
    });
    await flush();

    expect(q.snapshot().running).toBe(3);
    expect(q.describe().ambientHeld).toBe(1);
    expect(thirdAmbientRan).toBe(false);

    // Freeing one physical lease admits the held ambient item immediately;
    // it does not wait for the quiet clock because protected headroom exists.
    foreground();
    await flush();
    expect(thirdAmbientRan).toBe(true);
    (await firstAmbient)();
    (await secondAmbient)();
    (await thirdAmbient)();
  });

  it('non-ambient background (mid-turn compaction) is never gated', async () => {
    const clock = fakeClock();
    const q = new ProviderQueue({ concurrency: 2, ambientQuietMs: 1000, now: clock.now });
    const fg = await q.acquire({ lane: 'interactive' });
    // The foreground turn awaits its own compaction one-shot — plain
    // background, no ambient mark. Must dispatch into the free slot
    // immediately, exactly as before the gate existed.
    const rCompact = await q.acquire({ lane: 'background' });
    expect(q.snapshot().running).toBe(2);
    rCompact();
    fg();
  });

  it('anti-starvation does NOT lift the gate: held ambient outwaits maxWaitMs during activity', async () => {
    const clock = fakeClock();
    const q = new ProviderQueue({
      concurrency: 1,
      ambientQuietMs: 10_000,
      maxWaitMs: 500,
      now: clock.now,
    });
    const r1 = await q.acquire({ lane: 'interactive' });
    let ambientRan = false;
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      ambientRan = true;
      return rel;
    });
    await flush();
    clock.advance(100);
    r1();
    // Ambient has now waited well past maxWaitMs, but the quiet window
    // (10s) hasn't elapsed since the interactive release.
    clock.advance(5000);
    const poke = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(ambientRan).toBe(false);
    clock.advance(5001);
    const poke2 = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(ambientRan).toBe(true);
    (await pAmbient)();
    (await poke)();
    (await poke2)();
  });

  it('pending non-ambient work keeps the gate closed and dispatches first', async () => {
    const clock = fakeClock();
    const q = new ProviderQueue({ concurrency: 1, ambientQuietMs: 100, now: clock.now });
    const r1 = await q.acquire({ lane: 'interactive' });
    // Ambient queued first, then a non-ambient background item.
    const order: string[] = [];
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      order.push('ambient');
      return rel;
    });
    const pCompact = q.acquire({ lane: 'background' }).then((rel) => {
      order.push('compact');
      return rel;
    });
    await flush();
    clock.advance(100_000);
    r1();
    await flush();
    // Non-ambient dispatched despite ambient's earlier enqueue time.
    expect(order).toEqual(['compact']);
    (await pCompact)();
    clock.advance(100_000);
    const poke = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(order).toEqual(['compact', 'ambient']);
    (await pAmbient)();
    (await poke)();
  });

  it('recheck timer wakes a purely-time-held ambient entry (real clock)', async () => {
    const q = new ProviderQueue({ concurrency: 1, ambientQuietMs: 120 });
    const r1 = await q.acquire({ lane: 'interactive' });
    r1();
    let ambientRan = false;
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      ambientRan = true;
      return rel;
    });
    await flush();
    expect(ambientRan).toBe(false);
    // No further queue traffic — only the internal recheck timer can
    // open the gate.
    await new Promise((r) => setTimeout(r, 300));
    expect(ambientRan).toBe(true);
    (await pAmbient)();
  });

  it('a fresh queue holds ambient for one quiet window from construction', async () => {
    const clock = fakeClock(50_000);
    const q = new ProviderQueue({ concurrency: 1, ambientQuietMs: 1000, now: clock.now });
    let ambientRan = false;
    const pAmbient = q.acquire({ lane: 'background', ambient: true }).then((rel) => {
      ambientRan = true;
      return rel;
    });
    await flush();
    // The provider was just built — almost always because a user acted.
    expect(ambientRan).toBe(false);
    clock.advance(1001);
    const poke = q.acquire({ lane: 'background', ambient: true });
    await flush();
    expect(ambientRan).toBe(true);
    (await pAmbient)();
    (await poke)();
  });
});

/**
 * The wild-caught case: an MLX engine launched at `--max-concurrency 3`
 * ran index enrichment strictly one-at-a-time with three more queued and
 * zero chats in flight. The background cap had been derived from
 * `concurrency - interactiveConcurrency`, which is the size of the
 * deadlock reserve (always 1), not the room the engine actually had.
 */
describe('backgroundLaneCap', () => {
  it('leaves exactly one engine slot for an arriving chat', () => {
    expect(backgroundLaneCap(3)).toBe(2);
    expect(backgroundLaneCap(4)).toBe(3);
  });

  it('still admits the deadlock-breaking chore on a single-slot engine', () => {
    expect(backgroundLaneCap(1)).toBe(1);
    expect(backgroundLaneCap(0)).toBe(1);
  });

  it('is unchanged from the old expression on a serial interactive lane', () => {
    // llama-cpp unbatched: interactive 1, queue max(slots, 2). The old
    // `queueConcurrency - interactiveConcurrency` and the new width-keyed
    // cap agree everywhere here — only the batched path moves.
    for (const slots of [1, 2, 4, 8]) {
      const interactive = 1;
      const queueConcurrency = Math.max(slots, interactive + 1);
      expect(backgroundLaneCap(slots)).toBe(Math.max(1, queueConcurrency - interactive));
    }
  });

  it('lets background work fill the widened lane', async () => {
    // Width 3 → 2 concurrent chores, third waits. Before the fix the
    // second and third both waited behind the first.
    const q = new ProviderQueue({
      concurrency: 4,
      interactiveConcurrency: 3,
      backgroundConcurrency: backgroundLaneCap(3),
      ambientQuietMs: 0,
    });
    const releases: Array<() => void> = [];
    let started = 0;
    for (let i = 0; i < 3; i++) {
      void q.acquire({ lane: 'background' }).then((rel) => {
        started++;
        releases.push(rel);
      });
    }
    await flush();
    expect(started).toBe(2);
    expect(q.describe().runningBackground).toBe(2);
    releases.pop()?.();
    await flush();
    expect(started).toBe(3);
    for (const rel of releases) rel();
  });

  it('keeps a slot free for a chat while background work saturates its lane', async () => {
    const q = new ProviderQueue({
      concurrency: 4,
      interactiveConcurrency: 3,
      backgroundConcurrency: backgroundLaneCap(3),
      ambientQuietMs: 0,
    });
    const bg = await Promise.all([
      q.acquire({ lane: 'background' }),
      q.acquire({ lane: 'background' }),
    ]);
    let chatStarted = false;
    void q.acquire({ lane: 'interactive' }).then(() => {
      chatStarted = true;
    });
    await flush();
    // Two chores hold two of the engine's three slots; the chat takes the
    // third without waiting for either to finish.
    expect(chatStarted).toBe(true);
    for (const rel of bg) rel();
  });
});

describe('runInQueue — queue-wait notices', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-asserts an ongoing wait, and stops the moment the slot is acquired', async () => {
    vi.useFakeTimers();
    const q = new ProviderQueue({ concurrency: 1 });
    // Occupy the only slot, the way another gezel's long agentic turn does.
    const holder = await q.acquire({ lane: 'interactive' });

    const seen: number[] = [];
    const ran = runInQueue(
      q,
      { lane: 'interactive', onQueueWait: ({ aheadOf }) => seen.push(aheadOf) },
      async () => 'done',
    );

    // Nothing below the threshold — an uncontended acquire must not flash.
    await vi.advanceTimersByTimeAsync(150);
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toHaveLength(1);

    // The wait is the part that used to go dark: one edge-triggered notice
    // could be cleared by any later liveness event, leaving a turn with no
    // queue badge and no output for the rest of a multi-minute wait.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seen.length).toBeGreaterThanOrEqual(3);

    holder();
    await expect(ran).resolves.toBe('done');

    // Acquired — the notices stop, which is what lets the UI's freshness
    // window expire the badge without needing an explicit "acquired" event.
    const atAcquire = seen.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(atAcquire);
  });

  it('stays silent when the queue is empty', async () => {
    vi.useFakeTimers();
    const q = new ProviderQueue({ concurrency: 1 });
    const seen: number[] = [];
    await expect(
      runInQueue(
        q,
        { lane: 'interactive', onQueueWait: ({ aheadOf }) => seen.push(aheadOf) },
        async () => 'immediate',
      ),
    ).resolves.toBe('immediate');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual([]);
  });
});
