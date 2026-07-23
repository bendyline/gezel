import { describe, expect, it } from 'vitest';
import { type StoreFs, ledgerStore, logStore, rosterStore } from './stores.js';

function memFs(initial: Record<string, string> = {}): StoreFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    write: async (path, content) => {
      files.set(path, content);
    },
  };
}

function tick(start: string, stepMs = 1000): () => string {
  let t = Date.parse(start);
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}

describe('logStore', () => {
  it('appends events and derives totals and byKind', async () => {
    const fs = memFs();
    const log = logStore(fs, 'log.json', { now: tick('2026-07-01T10:00:00Z') });

    await log.append({ kind: 'practice', note: 'scales' });
    await log.append({ kind: 'practice' });
    await log.append({ kind: 'lesson', data: { minutes: 30 } });

    const stats = await log.stats();
    expect(stats.total).toBe(3);
    expect(stats.byKind).toEqual({ practice: 2, lesson: 1 });
    expect(stats.firstAt).toBe('2026-07-01T10:00:00.000Z');
    expect(stats.lastAt).toBe('2026-07-01T10:00:02.000Z');
  });

  it('persists as a version-1 pretty-printed file with trailing newline', async () => {
    const fs = memFs();
    const log = logStore(fs, 'log.json', { now: tick('2026-07-01T10:00:00Z') });
    await log.append({ kind: 'practice' });

    const raw = fs.files.get('log.json')!;
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "version": 1');
    const parsed = JSON.parse(raw);
    expect(parsed.events).toHaveLength(1);
  });

  it('computes streaks over consecutive UTC days ending at the latest event', async () => {
    const fs = memFs();
    const log = logStore(fs, 'log.json');
    // Gap between the 2nd and the 5th; streak counts 5th-6th-7th only.
    for (const at of [
      '2026-07-01T09:00:00Z',
      '2026-07-02T09:00:00Z',
      '2026-07-05T09:00:00Z',
      '2026-07-06T23:59:00Z',
      '2026-07-07T00:01:00Z',
      '2026-07-07T18:00:00Z',
    ]) {
      await log.append({ kind: 'practice', at: new Date(at).toISOString() });
    }

    const stats = await log.stats();
    expect(stats.daysActive).toBe(5);
    expect(stats.streakDays).toBe(3);
  });

  it('returns zeroed stats for an empty store', async () => {
    const log = logStore(memFs(), 'log.json');
    expect(await log.stats()).toEqual({
      total: 0,
      byKind: {},
      streakDays: 0,
      daysActive: 0,
      firstAt: null,
      lastAt: null,
    });
    expect(await log.list()).toEqual([]);
  });

  it('filters by kind and since, and limit keeps the most recent matches', async () => {
    const fs = memFs();
    const log = logStore(fs, 'log.json');
    for (let i = 1; i <= 5; i += 1) {
      await log.append({
        kind: i % 2 === 0 ? 'even' : 'odd',
        note: `n${i}`,
        at: `2026-07-0${i}T00:00:00.000Z`,
      });
    }

    const odds = await log.list({ kind: 'odd' });
    expect(odds.map((e) => e.note)).toEqual(['n1', 'n3', 'n5']);

    const since = await log.list({ since: '2026-07-03T00:00:00.000Z' });
    expect(since.map((e) => e.note)).toEqual(['n3', 'n4', 'n5']);

    const limited = await log.list({ limit: 2 });
    expect(limited.map((e) => e.note)).toEqual(['n4', 'n5']);
  });

  it('throws on corrupt JSON instead of resetting the file', async () => {
    const fs = memFs({ 'log.json': '{broken' });
    const log = logStore(fs, 'log.json');
    await expect(log.stats()).rejects.toThrow(/not valid JSON/);
    expect(fs.files.get('log.json')).toBe('{broken');
  });

  it('throws on an unsupported version', async () => {
    const fs = memFs({ 'log.json': JSON.stringify({ version: 2, events: [] }) });
    await expect(logStore(fs, 'log.json').list()).rejects.toThrow(/unsupported version 2/);
  });
});

describe('rosterStore', () => {
  const stages: [string, ...string[]] = ['applied', 'screening', 'interview', 'offer', 'closed'];

  it('adds records with defaults and counter-based ids', async () => {
    const fs = memFs();
    const roster = rosterStore(fs, 'pipeline.json', {
      stages,
      idPrefix: 'app',
      now: tick('2026-07-01T10:00:00Z'),
    });

    const first = await roster.add({ fields: { company: 'Acme' } });
    const second = await roster.add({ status: 'screening', fields: { company: 'Globex' } });

    expect(first.id).toBe('app-1');
    expect(first.status).toBe('applied');
    expect(first.history).toEqual([{ at: '2026-07-01T10:00:00.000Z', from: null, to: 'applied' }]);
    expect(second.id).toBe('app-2');
    expect(second.status).toBe('screening');
  });

  it('generates ids past the max numeric suffix, tolerating custom ids', async () => {
    const fs = memFs();
    const roster = rosterStore(fs, 'pipeline.json', { stages, idPrefix: 'app' });
    await roster.add({ id: 'app-7' });
    await roster.add({ id: 'custom-id' });
    const next = await roster.add({});
    expect(next.id).toBe('app-8');
  });

  it('rejects duplicate ids and unknown stages', async () => {
    const roster = rosterStore(memFs(), 'pipeline.json', { stages });
    await roster.add({ id: 'rec-1' });
    await expect(roster.add({ id: 'rec-1' })).rejects.toThrow(/already exists/);
    await expect(roster.add({ status: 'ghosted' })).rejects.toThrow(/Unknown stage 'ghosted'/);
    await expect(roster.transition('rec-1', 'ghosted')).rejects.toThrow(/Unknown stage/);
    await expect(roster.transition('rec-9', 'offer')).rejects.toThrow(/No record 'rec-9'/);
  });

  it('transitions record history and updates status', async () => {
    const roster = rosterStore(memFs(), 'pipeline.json', {
      stages,
      now: tick('2026-07-01T10:00:00Z'),
    });
    const rec = await roster.add({ fields: { company: 'Acme' } });
    await roster.transition(rec.id, 'screening', { note: 'recruiter call booked' });
    const updated = await roster.transition(rec.id, 'interview');

    expect(updated.status).toBe('interview');
    expect(updated.history.map((h) => [h.from, h.to])).toEqual([
      [null, 'applied'],
      ['applied', 'screening'],
      ['screening', 'interview'],
    ]);
    expect(updated.history[1]!.note).toBe('recruiter call booked');
    expect(updated.updatedAt > updated.createdAt).toBe(true);
  });

  it('update merges fields and records note-only touches without changing status', async () => {
    const roster = rosterStore(memFs(), 'pipeline.json', { stages });
    const rec = await roster.add({ fields: { company: 'Acme', link: 'a' } });
    const updated = await roster.update(rec.id, {
      fields: { link: 'b' },
      note: 'refreshed posting link',
    });

    expect(updated.status).toBe('applied');
    expect(updated.fields).toEqual({ company: 'Acme', link: 'b' });
    const touch = updated.history.at(-1)!;
    expect(touch.from).toBe('applied');
    expect(touch.to).toBe('applied');
    expect(touch.note).toBe('refreshed posting link');
  });

  it('counts zero-fill every declared stage', async () => {
    const roster = rosterStore(memFs(), 'pipeline.json', { stages });
    await roster.add({});
    await roster.add({});
    await roster.add({ status: 'offer' });

    expect(await roster.counts()).toEqual({
      applied: 2,
      screening: 0,
      interview: 0,
      offer: 1,
      closed: 0,
    });
  });

  it('round-trips through a second store instance over the same file', async () => {
    const fs = memFs();
    const first = rosterStore(fs, 'pipeline.json', { stages, idPrefix: 'app' });
    await first.add({ fields: { company: 'Acme' } });

    // Second instance declares a different stage vocabulary; the file's wins.
    const second = rosterStore(fs, 'pipeline.json', { stages: ['other'] });
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.fields).toEqual({ company: 'Acme' });
    await expect(second.add({ status: 'other' })).rejects.toThrow(/Unknown stage 'other'/);
    await second.transition('app-1', 'offer');
    expect((await second.get('app-1'))!.status).toBe('offer');
  });

  it('throws on corrupt files instead of resetting', async () => {
    const fs = memFs({ 'pipeline.json': 'not json at all' });
    const roster = rosterStore(fs, 'pipeline.json', { stages });
    await expect(roster.list()).rejects.toThrow(/not valid JSON/);
  });
});

describe('ledgerStore', () => {
  it('adds validated entries and rolls up totals by category and month', async () => {
    const fs = memFs();
    const ledger = ledgerStore(fs, 'budget.json', { now: tick('2026-07-01T10:00:00Z') });

    await ledger.add({ amountCents: 500_00, kind: 'in', category: 'salary' });
    await ledger.add({ amountCents: 120_50, kind: 'out', category: 'groceries' });
    await ledger.add({
      amountCents: 80_00,
      kind: 'out',
      category: 'groceries',
      at: '2026-06-15T00:00:00.000Z',
    });

    const totals = await ledger.totals();
    expect(totals.count).toBe(3);
    expect(totals.inCents).toBe(500_00);
    expect(totals.outCents).toBe(200_50);
    expect(totals.netCents).toBe(299_50);
    expect(totals.byCategory.groceries).toEqual({
      inCents: 0,
      outCents: 200_50,
      netCents: -200_50,
    });
    expect(Object.keys(totals.byMonth).sort()).toEqual(['2026-06', '2026-07']);

    const july = await ledger.totals({ month: '2026-07' });
    expect(july.count).toBe(2);
    expect(july.netCents).toBe(379_50);
  });

  it('filters lists by kind, category, and month with counter ids', async () => {
    const fs = memFs();
    const ledger = ledgerStore(fs, 'budget.json', { now: tick('2026-07-01T10:00:00Z') });
    await ledger.add({ amountCents: 100, kind: 'in', category: 'a' });
    await ledger.add({ amountCents: 200, kind: 'out', category: 'b' });

    const outs = await ledger.list({ kind: 'out' });
    expect(outs).toHaveLength(1);
    expect(outs[0]?.id).toBe('ledger-2');
    expect(await ledger.list({ month: '2026-07' })).toHaveLength(2);
  });

  it('rejects float amounts, non-positive amounts, bad kinds, and missing categories', async () => {
    const ledger = ledgerStore(memFs(), 'budget.json');
    await expect(ledger.add({ amountCents: 10.5, kind: 'in', category: 'x' })).rejects.toThrow(
      /positive integer/,
    );
    await expect(ledger.add({ amountCents: 0, kind: 'in', category: 'x' })).rejects.toThrow();
    await expect(
      ledger.add({ amountCents: 100, kind: 'sideways' as never, category: 'x' }),
    ).rejects.toThrow(/kind/);
    await expect(ledger.add({ amountCents: 100, kind: 'in', category: '' })).rejects.toThrow(
      /category/,
    );
  });

  it('persists currency and survives a second instance', async () => {
    const fs = memFs();
    await ledgerStore(fs, 'budget.json', { currency: 'EUR' }).add({
      amountCents: 100,
      kind: 'in',
      category: 'a',
    });
    const parsed = JSON.parse(fs.files.get('budget.json')!);
    expect(parsed.currency).toBe('EUR');
    expect((await ledgerStore(fs, 'budget.json').list()).length).toBe(1);
  });
});
