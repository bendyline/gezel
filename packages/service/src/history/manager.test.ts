import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { gezelSessionsDir, projectHistoryFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryManager } from './manager.js';

let home: string;
let history: HistoryManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-history-test-'));
  history = new HistoryManager(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('HistoryManager', () => {
  it('logs and reads events round-trip (global scope)', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'ada',
      summary: 'Created "Ada"',
      details: { name: 'Ada' },
    });
    const events = await history.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('gezel.created');
    expect(events[0]?.summary).toBe('Created "Ada"');
    expect(events[0]?.id).toBeTruthy();
    expect(events[0]?.at).toBeTruthy();
  });

  it('logs project-scoped events to the project file', async () => {
    await history.log({
      kind: 'project.created',
      projectId: 'myproj',
      summary: 'Created project',
    });
    const events = await history.listEvents({ projectId: 'myproj' });
    expect(events).toHaveLength(1);
    expect(events[0]?.projectId).toBe('myproj');
  });

  it('filters by kind, gezelId, and free-text query', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'ada',
      summary: 'Created "Ada"',
    });
    await history.log({
      kind: 'gezel.renamed',
      gezelId: 'ada',
      summary: 'Renamed to "Ada 2"',
    });
    await history.log({
      kind: 'gezel.created',
      gezelId: 'bob',
      summary: 'Created "Bob"',
    });

    const created = await history.listEvents({ kinds: ['gezel.created'] });
    expect(created).toHaveLength(2);

    const adaOnly = await history.listEvents({ gezelId: 'ada' });
    expect(adaOnly).toHaveLength(2);

    const qBob = await history.listEvents({ q: 'Bob' });
    expect(qBob).toHaveLength(1);
    expect(qBob[0]?.gezelId).toBe('bob');
  });

  it('sorts newest-first', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'older',
      at: '2026-01-01T00:00:00Z',
      summary: 'first',
    });
    await history.log({
      kind: 'gezel.created',
      gezelId: 'newer',
      at: '2026-04-01T00:00:00Z',
      summary: 'second',
    });
    const events = await history.listEvents();
    expect(events[0]?.gezelId).toBe('newer');
    expect(events[1]?.gezelId).toBe('older');
  });

  it('skips malformed JSONL lines', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'ada',
      summary: 'ok',
    });
    const file = projectHistoryFile(home, '__fake');
    await mkdir(join(home, 'projects', '__fake'), { recursive: true });
    await writeFile(file, 'not-json\n{"bad":\n', 'utf8');
    const events = await history.listEvents();
    expect(events).toHaveLength(1);
  });

  it('listEntries merges derived session entries with events', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'ada',
      summary: 'Created',
      at: '2026-04-01T00:00:00Z',
    });
    const sess: ChatSession = {
      version: 1,
      id: 'sess-1',
      gezelId: 'ada',
      projectId: 'default',
      providerName: 'copilot',
      title: 'Chat about widgets',
      createdAt: '2026-04-05T10:00:00Z',
      lastActivityAt: '2026-04-05T10:22:00Z',
      messages: [
        { role: 'user', content: 'hi', at: '2026-04-05T10:00:00Z' },
        { role: 'assistant', content: 'yo', at: '2026-04-05T10:22:00Z' },
      ],
      providerState: {},
    };
    const sessDir = gezelSessionsDir(home, 'ada');
    await mkdir(sessDir, { recursive: true });
    await writeFile(join(sessDir, 'sess-1.json'), JSON.stringify(sess), 'utf8');

    const entries = await history.listEntries();
    expect(entries).toHaveLength(2);
    // Session is newer -> first.
    expect(entries[0]?.entryType).toBe('session');
    if (entries[0]?.entryType === 'session') {
      expect(entries[0].messageCount).toBe(2);
      expect(entries[0].durationMs).toBe(22 * 60_000);
    }
    expect(entries[1]?.entryType).toBe('event');
  });

  it('uses the query backend only for q queries, falling back on null', async () => {
    await history.log({ kind: 'gezel.created', gezelId: 'ada', summary: 'Created "Ada"' });
    const calls: string[] = [];
    history.setQueryBackend(async (filter) => {
      calls.push(filter.q ?? '');
      return [
        {
          id: 'from-backend',
          at: '2026-05-01T00:00:00Z',
          kind: 'gezel.created',
          summary: 'indexed hit',
        },
      ];
    });

    const nonQ = await history.listEvents();
    expect(nonQ[0]?.summary).toBe('Created "Ada"');
    expect(calls).toHaveLength(0);

    const q = await history.listEvents({ q: 'Ada' });
    expect(q[0]?.id).toBe('from-backend');
    expect(calls).toEqual(['Ada']);

    history.setQueryBackend(async () => null);
    const fallback = await history.listEvents({ q: 'Ada' });
    expect(fallback[0]?.summary).toBe('Created "Ada"');
  });

  it('limit truncates after sort', async () => {
    for (let i = 0; i < 5; i++) {
      await history.log({
        kind: 'gezel.created',
        gezelId: `g${i}`,
        at: `2026-04-0${i + 1}T00:00:00Z`,
        summary: `#${i}`,
      });
    }
    const events = await history.listEvents({ limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0]?.gezelId).toBe('g4');
  });

  it('does not notify listeners when the append fails', async () => {
    const brokenHome = join(home, 'not-a-directory');
    await writeFile(brokenHome, 'file blocks mkdir');
    const broken = new HistoryManager(brokenHome);
    let notified = false;
    broken.subscribe(() => {
      notified = true;
    });
    await expect(
      broken.log({ kind: 'gezel.created', gezelId: 'ada', summary: 'must persist' }),
    ).rejects.toThrow();
    expect(notified).toBe(false);
  });

  it('contains rejected async listener work', async () => {
    history.subscribe(async () => {
      throw new Error('listener failed');
    });
    await expect(
      history.log({ kind: 'gezel.created', gezelId: 'ada', summary: 'persisted' }),
    ).resolves.toBeUndefined();
    expect(await history.listEvents()).toHaveLength(1);
  });

  it('deletes and redacts audit events without touching chat sessions', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'old',
      at: '2026-01-01T00:00:00Z',
      summary: 'private old summary',
      details: { path: 'C:/private/customer' },
    });
    await history.log({
      kind: 'gezel.created',
      gezelId: 'new',
      at: '2026-06-01T00:00:00Z',
      summary: 'private new summary',
      details: { input: 'secret' },
    });
    let rebuilds = 0;
    history.setRewriteBackend(async () => {
      rebuilds++;
    });

    expect(await history.deleteEvents({ before: '2026-03-01T00:00:00Z' })).toBe(1);
    expect(await history.redactEvents({ fields: ['summary', 'details', 'identifiers'] })).toBe(1);
    const events = await history.listEvents();
    expect(events).toEqual([expect.objectContaining({ summary: '[redacted]' })]);
    expect(events[0]).not.toHaveProperty('details');
    expect(events[0]).not.toHaveProperty('gezelId');
    expect(rebuilds).toBe(2);
  });

  it('serializes privacy rewrites with concurrent appends', async () => {
    await history.log({
      kind: 'gezel.created',
      gezelId: 'old',
      summary: 'delete me',
    });

    const deleting = history.deleteEvents();
    const appending = history.log({
      kind: 'gezel.created',
      gezelId: 'new',
      summary: 'retain me',
    });
    await Promise.all([deleting, appending]);

    const events = await history.listEvents();
    expect(events.map((event) => event.gezelId)).toEqual(['new']);
  });
});
