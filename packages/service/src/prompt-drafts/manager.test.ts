import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { PromptDraftManager, PromptDraftNotFoundError } from './manager.js';

let home: string;
let store: Store;
let events: Array<{ projectId: string; event: ChatEvent }>;
let clock: Date;

function makeManager(): PromptDraftManager {
  return new PromptDraftManager({
    store,
    events: {
      publishProjectEvent: (projectId, event) => {
        events.push({ projectId, event });
      },
    },
    now: () => clock,
  });
}

const PROJECT = 'default';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-prompt-drafts-'));
  store = new Store({ home });
  await store.ensureLayout();
  events = [];
  clock = new Date(2026, 8, 3, 12, 0, 0);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

function draftEvents() {
  return events.filter((e) => e.event.type === 'prompt_draft_changed');
}

describe('id allocation', () => {
  it('starts at one and reads like a date', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas' });
    expect(created.id).toBe('2026-09-03-0001');
  });

  it('keeps the sequence climbing across days, so an older draft never wins a sort', async () => {
    const drafts = makeManager();
    const first = await drafts.create(PROJECT, { gezelId: 'tomas' });
    clock = new Date(2026, 8, 4, 9, 0, 0);
    const second = await drafts.create(PROJECT, { gezelId: 'tomas' });
    expect(first.id).toBe('2026-09-03-0001');
    expect(second.id).toBe('2026-09-04-0002');
  });

  it('hands out unique ids under concurrent creates', async () => {
    const drafts = makeManager();
    const created = await Promise.all(
      Array.from({ length: 10 }, () => drafts.create(PROJECT, { gezelId: 'tomas' })),
    );
    expect(new Set(created.map((d) => d.id)).size).toBe(10);
  });

  it('ignores folders that are not drafts', async () => {
    const drafts = makeManager();
    await mkdir(drafts.rootDir(PROJECT), { recursive: true });
    await writeFile(join(drafts.rootDir(PROJECT), 'README.md'), 'not a draft');
    await mkdir(join(drafts.rootDir(PROJECT), '2026-09-03-0001-copy'), { recursive: true });
    const created = await drafts.create(PROJECT, { gezelId: 'tomas' });
    expect(created.id).toBe('2026-09-03-0001');
    expect(await drafts.list(PROJECT)).toHaveLength(1);
  });
});

describe('reading and listing', () => {
  it('derives a title and file state at read time', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, {
      gezelId: 'tomas',
      content: '# Rework onboarding\n\nbody',
    });
    const read = await drafts.get(PROJECT, created.id);
    expect(read?.title).toBe('Rework onboarding');
    expect(read?.hasFiles).toBe(false);
    expect(read?.content).toContain('body');
  });

  it('separates new-thread drafts from a thread\u2019s own', async () => {
    const drafts = makeManager();
    const fresh = await drafts.create(PROJECT, { gezelId: 'tomas', sessionId: null });
    const onThread = await drafts.create(PROJECT, { gezelId: 'tomas', sessionId: 's1' });
    const other = await drafts.create(PROJECT, { gezelId: 'mira', sessionId: 's2' });

    const newThread = await drafts.list(PROJECT, { sessionId: null });
    expect(newThread.map((d) => d.id)).toEqual([fresh.id]);

    const forS1 = await drafts.list(PROJECT, { sessionId: 's1' });
    expect(forS1.map((d) => d.id)).toEqual([onThread.id]);

    const forMira = await drafts.list(PROJECT, { gezelId: 'mira' });
    expect(forMira.map((d) => d.id)).toEqual([other.id]);

    // No session filter means every thread, which is a different question
    // from "not addressed to a thread yet".
    expect(await drafts.list(PROJECT)).toHaveLength(3);
  });

  it('lists the most recently touched first', async () => {
    const drafts = makeManager();
    const first = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'one' });
    const second = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'two' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await drafts.writeContent(PROJECT, first.id, 'one, edited');
    const listed = await drafts.list(PROJECT);
    expect(listed.map((d) => d.id)).toEqual([first.id, second.id]);
  });

  it('filters by status so sent drafts stay out of the open pickers', async () => {
    const drafts = makeManager();
    const open = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'still writing' });
    const sent = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'gone' });
    await drafts.markSent(PROJECT, sent.id, { sessionId: 's1' });
    expect((await drafts.list(PROJECT, { status: 'draft' })).map((d) => d.id)).toEqual([open.id]);
    expect((await drafts.list(PROJECT, { status: 'sent' })).map((d) => d.id)).toEqual([sent.id]);
  });
});

describe('saving', () => {
  it('deletes a draft emptied of both text and files', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'something' });
    const result = await drafts.writeContent(PROJECT, created.id, '   \n\t ');
    expect(result).toEqual({ draft: null, deleted: true });
    expect(await drafts.get(PROJECT, created.id)).toBeNull();
    const last = draftEvents().at(-1);
    expect(last?.event).toMatchObject({ draftId: created.id, deleted: true });
  });

  it('keeps an emptied draft that still holds a file', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'look at this' });
    await writeFile(join(drafts.draftDir(PROJECT, created.id), 'message_files', 'a.png'), 'bytes');
    const result = await drafts.writeContent(PROJECT, created.id, '');
    expect(result.deleted).toBe(false);
    expect(result.draft?.hasFiles).toBe(true);
  });

  it('does not let sync junk keep an empty draft alive', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'x' });
    await writeFile(
      join(drafts.draftDir(PROJECT, created.id), 'message_files', '.DS_Store'),
      'junk',
    );
    expect((await drafts.writeContent(PROJECT, created.id, '')).deleted).toBe(true);
  });

  it('refuses to write a draft that is gone', async () => {
    const drafts = makeManager();
    await expect(drafts.writeContent(PROJECT, '2026-09-03-0009', 'x')).rejects.toBeInstanceOf(
      PromptDraftNotFoundError,
    );
  });
});

describe('re-filing and sending', () => {
  it('moves a draft to another thread and gezel', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', sessionId: null });
    const moved = await drafts.patchMeta(PROJECT, created.id, {
      gezelId: 'mira',
      sessionId: 's9',
    });
    expect(moved).toMatchObject({ gezelId: 'mira', sessionId: 's9' });
  });

  it('clears an optional ref with an explicit null', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', taskRef: 'default#3' });
    const patched = await drafts.patchMeta(PROJECT, created.id, { taskRef: null });
    expect(patched.taskRef).toBeUndefined();
  });

  it('records the send and adopts the thread it started', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', sessionId: null });
    const sent = await drafts.markSent(PROJECT, created.id, {
      sessionId: 's-new',
      content: 'the message as written',
    });
    expect(sent).toMatchObject({
      status: 'sent',
      sessionId: 's-new',
      sentSessionId: 's-new',
    });
    expect(sent.sentAt).toBeTruthy();
    // The draft keeps the text the user wrote, not the rewritten transcript
    // form — it stays an editable document.
    expect((await drafts.get(PROJECT, created.id))?.content).toBe('the message as written');
  });

  it('stamps the message time after the turn persists it', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'x' });
    await drafts.markSent(PROJECT, created.id, { sessionId: 's1' });
    await drafts.noteSentMessageAt(PROJECT, created.id, '2026-09-03T12:00:00.000Z');
    expect((await drafts.get(PROJECT, created.id))?.sentMessageAt).toBe('2026-09-03T12:00:00.000Z');
  });
});

describe('use again', () => {
  it('copies the text and the files into a fresh open draft', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, {
      gezelId: 'tomas',
      sessionId: 's1',
      content: 'the standing ask ![a](message_files/a.png)',
    });
    await writeFile(join(drafts.draftDir(PROJECT, created.id), 'message_files', 'a.png'), 'bytes');
    await drafts.markSent(PROJECT, created.id, { sessionId: 's1' });

    const copy = await drafts.duplicate(PROJECT, created.id, { sessionId: null });
    expect(copy.id).not.toBe(created.id);
    expect(copy.status).toBe('draft');
    expect(copy.sessionId).toBeNull();
    expect(copy.content).toBe('the standing ask ![a](message_files/a.png)');
    expect(copy.hasFiles).toBe(true);
    // The original is untouched — reusing a prompt is not moving it.
    expect((await drafts.get(PROJECT, created.id))?.status).toBe('sent');
  });
});

describe('cleanup', () => {
  it('deletes a thread\u2019s sent drafts but detaches the unsent ones', async () => {
    const drafts = makeManager();
    const sent = await drafts.create(PROJECT, { gezelId: 'tomas', sessionId: 's1', content: 'a' });
    await drafts.markSent(PROJECT, sent.id, { sessionId: 's1' });
    const unsent = await drafts.create(PROJECT, {
      gezelId: 'tomas',
      sessionId: 's1',
      content: 'still writing this',
    });
    const elsewhere = await drafts.create(PROJECT, {
      gezelId: 'tomas',
      sessionId: 's2',
      content: 'other thread',
    });

    const result = await drafts.onSessionDeleted(PROJECT, 's1');
    expect(result).toEqual({ deleted: 1, detached: 1 });
    expect(await drafts.get(PROJECT, sent.id)).toBeNull();
    expect((await drafts.get(PROJECT, unsent.id))?.sessionId).toBeNull();
    expect((await drafts.get(PROJECT, elsewhere.id))?.sessionId).toBe('s2');
  });

  it('sweeps sent drafts past the cutoff and never unsent ones', async () => {
    const drafts = makeManager();
    const old = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'old' });
    await drafts.markSent(PROJECT, old.id, { sessionId: 's1' });
    const recent = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'recent' });
    await drafts.markSent(PROJECT, recent.id, { sessionId: 's1' });
    const open = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'never sent' });

    // Backdate the first draft's send by rewriting its metadata directly —
    // the same thing 91 days of real time would do.
    const metaPath = join(drafts.draftDir(PROJECT, old.id), 'draft.json');
    const meta = JSON.parse(await (await import('node:fs/promises')).readFile(metaPath, 'utf8'));
    meta.sentAt = '2026-01-01T00:00:00.000Z';
    await writeFile(metaPath, JSON.stringify(meta, null, 2));

    const removed = await drafts.sweepSent(PROJECT, '2026-06-01T00:00:00.000Z');
    expect(removed).toBe(1);
    expect(await drafts.get(PROJECT, old.id)).toBeNull();
    expect(await drafts.get(PROJECT, recent.id)).not.toBeNull();
    expect(await drafts.get(PROJECT, open.id)).not.toBeNull();
  });

  it('reports a delete of something already gone without failing', async () => {
    const drafts = makeManager();
    expect(await drafts.delete(PROJECT, '2026-09-03-0099')).toBe(false);
  });
});

describe('events', () => {
  it('announces every change on the project stream', async () => {
    const drafts = makeManager();
    const created = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'a' });
    await drafts.writeContent(PROJECT, created.id, 'a b');
    await drafts.markSent(PROJECT, created.id, { sessionId: 's1' });
    await drafts.delete(PROJECT, created.id);

    const kinds = draftEvents().map((e) => e.event);
    expect(kinds).toHaveLength(4);
    expect(kinds.every((e) => e.type === 'prompt_draft_changed')).toBe(true);
    expect(draftEvents().every((e) => e.projectId === PROJECT)).toBe(true);
    // The gezel is the draft's, so a new-thread draft's event is still
    // attributable even though it has no session.
    expect(kinds[0]).toMatchObject({ gezelId: 'tomas', sessionId: null, status: 'draft' });
    expect(kinds[2]).toMatchObject({ status: 'sent', sessionId: 's1' });
    expect(kinds[3]).toMatchObject({ deleted: true });
  });
});
