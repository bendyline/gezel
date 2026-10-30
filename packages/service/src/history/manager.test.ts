import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatSession, HistoryEvent } from '@bendyline/gezel';
import { gezelSessionsDir, globalHistoryFile, projectHistoryFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_ORDER_SLACK_MS, HistoryManager } from './manager.js';

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

  it('reads every project when Finder left a .DS_Store among them', async () => {
    await history.log({ kind: 'project.created', projectId: 'pics', summary: 'Created' });
    await writeFile(join(home, 'projects', '.DS_Store'), 'finder');
    await writeFile(join(home, 'projects', 'notes.txt'), 'stray');

    const events = await history.listEvents();
    expect(events.map((e) => e.projectId)).toEqual(['pics']);
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
    const file = projectHistoryFile(home, 'fake');
    await mkdir(join(home, 'projects', 'fake'), { recursive: true });
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

  it('the person audience keeps their work and threads, not the machine room', async () => {
    await history.log({
      kind: 'task.created',
      projectId: 'shop',
      summary: 'Invoices for October',
      at: '2026-04-01T00:00:00Z',
    });
    await history.log({
      kind: 'tool.called',
      projectId: 'shop',
      summary: 'write_file invoices.json',
      at: '2026-04-01T00:01:00Z',
    });
    await history.log({
      kind: 'prompt.compiled',
      projectId: 'shop',
      summary: 'Prompt compiled',
      at: '2026-04-01T00:02:00Z',
    });
    const sessDir = gezelSessionsDir(home, 'ada');
    await mkdir(sessDir, { recursive: true });
    const base = {
      version: 1 as const,
      gezelId: 'ada',
      projectId: 'shop',
      providerName: 'copilot' as const,
      createdAt: '2026-04-05T10:00:00Z',
      lastActivityAt: '2026-04-05T10:22:00Z',
      messages: [],
      providerState: {},
    };
    const sessions: ChatSession[] = [
      { ...base, id: 'thread', title: 'Make my invoices' },
      {
        ...base,
        id: 'step',
        title: 'Draft the invoices',
        taskRef: 'shop/1',
        stepId: 'draft',
        parentSession: { sessionId: 'thread', gezelId: 'ada', kind: 'task-entry' },
      },
      { ...base, id: 'legacy-step', title: 'Check them', taskRef: 'shop/1', stepId: 'check' },
    ];
    for (const s of sessions) {
      await writeFile(join(sessDir, `${s.id}.json`), JSON.stringify(s), 'utf8');
    }

    const person = await history.listEntries({ projectId: 'shop', audience: 'person' });
    expect(
      person.map((e) => (e.entryType === 'event' ? e.kind : `session:${e.id}`)).sort(),
    ).toEqual(['session:thread', 'task.created']);

    const all = await history.listEntries({ projectId: 'shop' });
    expect(all).toHaveLength(6);
  });

  it('the person audience filters what the query backend returns', async () => {
    history.setQueryBackend(async () => [
      { id: 'a', at: '2026-05-02T00:00:00Z', kind: 'tool.called', summary: 'Ada wrote it' },
      { id: 'b', at: '2026-05-01T00:00:00Z', kind: 'document.created', summary: 'Ada notes' },
    ]);
    const events = await history.listEvents({ q: 'Ada', audience: 'person' });
    expect(events.map((e) => e.id)).toEqual(['b']);
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

  describe('bounded reads', () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 26, 12, 0) + n * 60_000).toISOString();

    async function writeProjectEvents(
      projectId: string,
      events: Array<Partial<HistoryEvent> & { at: string }>,
    ): Promise<void> {
      const file = projectHistoryFile(home, projectId);
      await mkdir(dirname(file), { recursive: true });
      const lines = events.map((event, i) =>
        JSON.stringify({
          id: `e${i}`,
          kind: 'tool.called',
          summary: `event ${i}`,
          projectId,
          ...event,
        }),
      );
      await writeFile(file, `${lines.join('\n')}\n`);
    }

    it('a from-bounded read returns exactly what a full scan filtered by time would', async () => {
      const events = Array.from({ length: 600 }, (_, i) => ({
        at: minute(i),
        kind: (i % 3 === 0 ? 'task.step.gated' : 'tool.called') as HistoryEvent['kind'],
        details: { taskRef: `p/${i % 7}` },
      }));
      await writeProjectEvents('p', events);
      const everything = await history.listEvents({ projectId: 'p' });
      const toolCalls: HistoryEvent['kind'][] = ['tool.called'];
      for (const from of [minute(0), minute(250), minute(599), minute(700)]) {
        for (const kinds of [undefined, toolCalls]) {
          const bounded = await history.listEvents({
            projectId: 'p',
            from,
            ...(kinds ? { kinds } : {}),
          });
          const expected = everything.filter(
            (event) => event.at >= from && (!kinds || kinds.includes(event.kind)),
          );
          expect(bounded.map((event) => event.id)).toEqual(expected.map((event) => event.id));
        }
      }
    });

    it('still finds an event appended out of order within the slack', async () => {
      await writeProjectEvents('p', [
        { at: minute(0) },
        { at: minute(100), summary: 'late stamp' },
        { at: minute(60) },
        { at: minute(130) },
      ]);
      const events = await history.listEvents({ projectId: 'p', from: minute(95) });
      expect(events.map((event) => event.summary)).toEqual(['event 3', 'late stamp']);
    });

    it('stops at the first event older than the slack, by contract', async () => {
      // An event stamped far ahead of its position is past the documented
      // bound: a bounded read never reaches it.
      await writeProjectEvents('p', [
        { at: minute(300), summary: 'misplaced' },
        { at: minute(0) },
        { at: minute(200) },
      ]);
      const bounded = await history.listEvents({ projectId: 'p', from: minute(150) });
      expect(bounded.map((event) => event.summary)).toEqual(['event 2']);
      expect(HISTORY_ORDER_SLACK_MS).toBe(60 * 60_000);
    });

    it('a limit returns the newest events across the global and project logs', async () => {
      await writeProjectEvents(
        'p',
        Array.from({ length: 50 }, (_, i) => ({ at: minute(i * 10) })),
      );
      await mkdir(home, { recursive: true });
      await writeFile(
        globalHistoryFile(home),
        `${[5, 245, 495].map((m) => JSON.stringify({ id: `g${m}`, kind: 'gezel.created', summary: 'global', at: minute(m) })).join('\n')}\n`,
      );
      const events = await history.listEvents({ limit: 4 });
      expect(events.map((event) => event.id)).toEqual(['g495', 'e49', 'e48', 'e47']);
      const recent = await history.listEvents({ limit: 3, from: minute(240) });
      expect(recent.map((event) => event.id)).toEqual(['g495', 'e49', 'e48']);
      const projectOnly = await history.listEvents({ projectId: 'p', limit: 2 });
      expect(projectOnly.map((event) => event.id)).toEqual(['e49', 'e48']);
    });

    it('an unbounded kinds query skips lines that only mention the kind elsewhere', async () => {
      await writeProjectEvents('p', [
        { at: minute(0), kind: 'task.step.gated', details: { note: 'tool.called' } },
        { at: minute(1), kind: 'tool.called' },
      ]);
      const events = await history.listEvents({ projectId: 'p', kinds: ['tool.called'] });
      expect(events.map((event) => event.id)).toEqual(['e1']);
    });

    // Lines as `log` writes them: `id`, then `at`, then the rest. Gate
    // evidence read back an hour of every task's tool calls on each step
    // completion, parsing all of them (2026-10-27).
    async function writeLoggedEvents(
      projectId: string,
      events: Array<Partial<HistoryEvent> & { at: string }>,
    ): Promise<void> {
      const file = projectHistoryFile(home, projectId);
      await mkdir(dirname(file), { recursive: true });
      const lines = events.map(({ at, ...event }, i) =>
        JSON.stringify({
          id: `e${i}`,
          at,
          kind: 'tool.called',
          summary: `event ${i}`,
          projectId,
          ...event,
        }),
      );
      await writeFile(file, `${lines.join('\n')}\n`);
    }

    const calls = (i: number) => ({
      at: minute(i),
      kind: (i % 3 === 0 ? 'task.step.gated' : 'tool.called') as HistoryEvent['kind'],
      details: { taskRef: `p/${i % 7}`, stepId: 'work' },
    });

    it('a task-scoped bounded read parses only that task’s lines and returns the same events', async () => {
      await writeLoggedEvents(
        'p',
        Array.from({ length: 2100 }, (_, i) => calls(i)),
      );
      const from = minute(1400);
      const everything = await history.listEvents({ projectId: 'p' });
      const expected = everything.filter(
        (event) =>
          event.at >= from && event.kind === 'tool.called' && event.details?.taskRef === 'p/3',
      );
      const parse = vi.spyOn(JSON, 'parse');
      const scoped = await history.listEvents(
        { projectId: 'p', kinds: ['tool.called'], from },
        { taskRef: 'p/3' },
      );
      const parsed = parse.mock.calls.length;
      parse.mockRestore();
      expect(scoped.map((event) => event.id)).toEqual(expected.map((event) => event.id));
      // The window holds 760 lines (700 after `from` plus the 60-minute slack).
      expect(parsed).toBeLessThanOrEqual(Math.ceil(760 / 7));
    });

    it('a bounded kinds read stops and skips by the logged time without parsing', async () => {
      await writeLoggedEvents(
        'p',
        Array.from({ length: 2100 }, (_, i) => calls(i)),
      );
      const from = minute(2000);
      const parse = vi.spyOn(JSON, 'parse');
      const gated = await history.listEvents({ projectId: 'p', kinds: ['task.step.gated'], from });
      const parsed = parse.mock.calls.length;
      parse.mockRestore();
      expect(gated.map((event) => event.at)).toEqual(
        Array.from({ length: 100 }, (_, i) => minute(2099 - i)).filter((at) => {
          const n = (Date.parse(at) - Date.parse(minute(0))) / 60_000;
          return n % 3 === 0;
        }),
      );
      expect(parsed).toBeLessThanOrEqual(Math.ceil(160 / 3));
    });

    it('still reads a line in another shape inside the window', async () => {
      await writeLoggedEvents(
        'p',
        Array.from({ length: 200 }, (_, i) => calls(i)),
      );
      const file = projectHistoryFile(home, 'p');
      const odd = JSON.stringify({
        kind: 'tool.called',
        summary: 'odd shape',
        id: 'odd',
        at: minute(199),
        projectId: 'p',
        details: { taskRef: 'p/3' },
      });
      await writeFile(file, `${odd}\n`, { flag: 'a' });
      const scoped = await history.listEvents(
        { projectId: 'p', kinds: ['tool.called'], from: minute(150) },
        { taskRef: 'p/3' },
      );
      expect(scoped[0]?.id).toBe('odd');
      expect(scoped.every((event) => event.details?.taskRef === 'p/3')).toBe(true);
    });
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
