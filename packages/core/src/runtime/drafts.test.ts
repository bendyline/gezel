import { describe, expect, it } from 'vitest';
import { planSessionCleanup, sentDraftMeta, sweepableSentDrafts } from './drafts.js';
import { encodeText } from './files.js';
import { PortableStore } from './store.js';
import { MemoryFiles } from './test-files.js';

/** The shared module through the portable adapter, on an in-memory tree. */
async function fixture(start = '2026-09-20T12:00:00.000Z') {
  let clock = new Date(start);
  const files = new MemoryFiles();
  const store = new PortableStore({ files, now: () => clock.toISOString() });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  const gezel = await store.createGezel({ name: 'Ada', role: 'Developer' });
  const prompts = 'projects/default/artifacts/prompts';
  return {
    store,
    files,
    gezelId: gezel.id,
    prompts,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    create: (extra: Record<string, unknown> = {}) =>
      store.createPromptDraft('default', { gezelId: gezel.id, content: 'Hello', ...extra }),
  };
}

describe('prompt drafts on the portable host', () => {
  it('numbers drafts from one and keeps the sequence climbing across days', async () => {
    const f = await fixture();
    const first = await f.create();
    expect(first.id).toMatch(/^2026-09-20-0001$/);
    f.advance(2 * 24 * 60 * 60 * 1000);
    const second = await f.create();
    expect(second.id).toBe('2026-09-22-0002');
  });

  it('ignores folders that are not drafts and derives title and file state', async () => {
    const f = await fixture();
    await f.files.mkdir(`${f.prompts}/not-a-draft`);
    const draft = await f.create({ content: 'First line of the note\nMore' });
    await f.files.write(`${f.prompts}/${draft.id}/message_files/a.txt`, encodeText('x'));
    const listed = await f.store.listPromptDrafts('default');
    expect(listed.map((d) => d.id)).toEqual([draft.id]);
    const read = await f.store.getPromptDraft('default', draft.id);
    expect(read?.title).toContain('First line');
    expect(read?.fileCount).toBe(1);
    expect(read?.hasFiles).toBe(true);
  });

  it('separates new-thread drafts from a thread’s own and sorts newest first with a stable tie-break', async () => {
    const f = await fixture();
    const session = await f.store.createSession({ gezelId: f.gezelId, projectId: 'default' });
    const loose = await f.create();
    const threaded = await f.create({ sessionId: session.id });
    expect(
      (await f.store.listPromptDrafts('default', { sessionId: null })).map((d) => d.id),
    ).toEqual([loose.id]);
    expect(
      (await f.store.listPromptDrafts('default', { sessionId: session.id })).map((d) => d.id),
    ).toEqual([threaded.id]);
    // Same updatedAt (the clock did not move): the higher sequence lists first.
    expect((await f.store.listPromptDrafts('default')).map((d) => d.id)).toEqual([
      threaded.id,
      loose.id,
    ]);
  });

  it('deletes a draft emptied of both text and files, but keeps one that still holds a file', async () => {
    const f = await fixture();
    const empty = await f.create();
    expect(await f.store.writePromptDraftContent('default', empty.id, '   ')).toEqual({
      draft: null,
      deleted: true,
    });
    const withFile = await f.create();
    await f.files.write(`${f.prompts}/${withFile.id}/message_files/a.txt`, encodeText('x'));
    const kept = await f.store.writePromptDraftContent('default', withFile.id, '');
    expect(kept.deleted).toBe(false);
    expect(kept.draft?.fileCount).toBe(1);
  });

  it('keeps an empty draft that carries an attached task, and clears the task with null', async () => {
    const f = await fixture();
    const launch = {
      craftbookId: 'powerpoint-deck',
      params: { topic: 'Delft', slides: 8 },
      origin: 'user' as const,
    };
    const draft = await f.create({ content: '', taskLaunch: launch });
    expect(draft.taskLaunch).toEqual(launch);
    const kept = await f.store.writePromptDraftContent('default', draft.id, '');
    expect(kept.deleted).toBe(false);
    expect(kept.draft?.taskLaunch).toEqual(launch);
    const patched = await f.store.patchPromptDraft('default', draft.id, {
      taskLaunch: { ...launch, origin: 'suggested' },
    });
    expect(patched.taskLaunch?.origin).toBe('suggested');
    const cleared = await f.store.patchPromptDraft('default', draft.id, { taskLaunch: null });
    expect(cleared.taskLaunch).toBeUndefined();
    expect(await f.store.writePromptDraftContent('default', draft.id, '')).toEqual({
      draft: null,
      deleted: true,
    });
  });

  it('copies an attached task but drops its uploaded inputs', async () => {
    const f = await fixture();
    const source = await f.create({
      taskLaunch: {
        craftbookId: 'ebook-compile',
        params: {},
        origin: 'user' as const,
        inputs: {
          source: { from: 'upload' as const, stagingId: 'stg-abcdefgh' },
          extras: { from: 'workspace' as const, path: 'notes' },
        },
        inputLabels: { source: { label: 'Notes', fileCount: 3 }, extras: { label: 'notes' } },
      },
    });
    const copy = await f.store.duplicatePromptDraft('default', source.id);
    expect(copy.taskLaunch).toEqual({
      craftbookId: 'ebook-compile',
      params: {},
      origin: 'user',
      inputs: { extras: { from: 'workspace', path: 'notes' } },
      inputLabels: { extras: { label: 'notes' } },
    });
  });

  it('clears an optional ref with an explicit null and refuses edits to a sent draft', async () => {
    const f = await fixture();
    const draft = await f.create({ scope: 'notes' });
    expect(
      (await f.store.patchPromptDraft('default', draft.id, { scope: null })).scope,
    ).toBeUndefined();
    const session = await f.store.createSession({ gezelId: f.gezelId, projectId: 'default' });
    await f.store.markPromptDraftSent('default', draft.id, session.id);
    await expect(f.store.patchPromptDraft('default', draft.id, { scope: 'x' })).rejects.toThrow(
      /sent draft/,
    );
    await expect(f.store.writePromptDraftContent('default', draft.id, 'more')).rejects.toThrow(
      /sent draft/,
    );
  });

  it('records the send, adopts the thread it started, and stamps the message time', async () => {
    const f = await fixture();
    const draft = await f.create();
    const session = await f.store.createSession({ gezelId: f.gezelId, projectId: 'default' });
    const sent = await f.store.markPromptDraftSent(
      'default',
      draft.id,
      session.id,
      '2026-09-20T12:00:05.000Z',
    );
    expect(sent).toMatchObject({
      status: 'sent',
      sessionId: session.id,
      sentSessionId: session.id,
      sentMessageAt: '2026-09-20T12:00:05.000Z',
    });
  });

  it('copies the text and the files into a fresh open draft', async () => {
    const f = await fixture();
    const source = await f.create({ content: 'Reuse me' });
    await f.files.write(`${f.prompts}/${source.id}/message_files/a.txt`, encodeText('x'));
    await f.files.mkdir(`${f.prompts}/${source.id}/message_files/deep`);
    await f.files.write(`${f.prompts}/${source.id}/message_files/deep/b.txt`, encodeText('y'));
    const copy = await f.store.duplicatePromptDraft('default', source.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.content).toBe('Reuse me');
    expect(copy.fileCount).toBe(2);
    expect(await f.files.read(`${f.prompts}/${copy.id}/message_files/deep/b.txt`)).toEqual(
      encodeText('y'),
    );
  });

  it('reports a delete of something already gone without failing', async () => {
    const f = await fixture();
    expect(await f.store.deletePromptDraft('default', '2026-09-20-0009')).toBe(false);
  });

  it('refuses a record whose identity disagrees with its folder', async () => {
    const f = await fixture();
    const draft = await f.create();
    const raw = new TextDecoder().decode(
      (await f.files.read(`${f.prompts}/${draft.id}/draft.json`))!,
    );
    await f.files.write(
      `${f.prompts}/${draft.id}/draft.json`,
      encodeText(raw.replace(draft.id, '2026-01-01-0001')),
    );
    await expect(f.store.getPromptDraft('default', draft.id)).rejects.toThrow(/identity/);
  });
});

describe('pure draft policy', () => {
  it('adopts the thread only when the draft had none', () => {
    const base = {
      id: '2026-09-20-0001',
      projectId: 'default',
      gezelId: 'ada',
      createdAt: 'a',
      updatedAt: 'a',
      status: 'draft' as const,
    };
    expect(
      sentDraftMeta({ ...base, sessionId: null }, { sessionId: 's1', at: 'b' }).sessionId,
    ).toBe('s1');
    expect(
      sentDraftMeta({ ...base, sessionId: 's0' }, { sessionId: 's1', at: 'b' }).sessionId,
    ).toBe('s0');
  });

  it('plans a thread cleanup and a sweep', () => {
    const drafts = [
      {
        id: 'a',
        sessionId: 's1',
        status: 'sent' as const,
        sentAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      { id: 'b', sessionId: 's1', status: 'draft' as const, updatedAt: '2026-01-01' },
      {
        id: 'c',
        sessionId: 's2',
        status: 'sent' as const,
        sentAt: '2026-09-01',
        updatedAt: '2026-09-01',
      },
    ];
    expect(planSessionCleanup(drafts, 's1')).toEqual({ delete: ['a'], detach: ['b'] });
    expect(sweepableSentDrafts(drafts, '2026-06-01')).toEqual(['a']);
  });
});
