import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryEvent } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryManager } from '../history/manager.js';
import { Store } from './store.js';

/**
 * "Who changed the guidelines, and when?" — the question the library exists
 * to be able to answer about itself. Overwrites used to emit nothing at all,
 * because the editor autosaves and per-write events would flood the log.
 */

let home: string;
let store: Store;
let history: HistoryManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-doc-audit-'));
  history = new HistoryManager(home);
  // A short window so a test can observe a sitting close.
  store = new Store({ home, history, auditQuietWindowMs: 60 });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 150));
const kinds = (events: HistoryEvent[]) => events.map((e) => e.kind);

describe('document edit audit', () => {
  it('records one event per sitting, not one per save', async () => {
    await store.writeDocument('guidelines.md', 'v1\n');
    // What an editor autosave burst looks like.
    await store.writeDocument('guidelines.md', 'v1\nv2\n');
    await store.writeDocument('guidelines.md', 'v1\nv2\nv3\n');
    await store.writeDocument('guidelines.md', 'v1\nv2\nv3\nv4\n');
    await settle();

    const events = await history.listEvents();
    // Newest-first from the log; the point is that four saves produced one
    // edit event, not four.
    expect(kinds(events).sort()).toEqual(['document.created', 'document.updated']);
    const edit = events.find((e) => e.kind === 'document.updated')!;
    expect(edit.details).toMatchObject({ path: 'guidelines.md', revisions: 3, source: 'ui' });
  });

  it('reports how much moved, measured against the sitting’s starting point', async () => {
    await store.writeDocument('policy.md', 'keep\nremove me\n');
    await settle();
    await store.writeDocument('policy.md', 'keep\nbrand new line\n');
    await settle();

    const edit = (await history.listEvents()).find((e) => e.kind === 'document.updated')!;
    expect(edit.details).toMatchObject({ addedLines: 1, removedLines: 1 });
  });

  it('attributes a gezel edit to that gezel, separately from the user’s', async () => {
    await store.writeDocument('shared.md', 'base\n');
    await settle();
    await store.writeDocument('shared.md', 'base\nfrom the app\n');
    await store.writeDocument('shared.md', 'base\nfrom a gezel\n', { gezelId: 'ada' });
    await settle();

    const edits = (await history.listEvents()).filter((e) => e.kind === 'document.updated');
    // Two actors, two stories — merging them would credit one with the
    // other's changes.
    expect(edits).toHaveLength(2);
    const byGezel = edits.find((e) => e.gezelId === 'ada');
    expect(byGezel?.details).toMatchObject({ source: 'gezel' });
    expect(edits.find((e) => !e.gezelId)?.details).toMatchObject({ source: 'ui' });
  });

  it('closes the sitting against the name the edits were made under', async () => {
    await store.writeDocument('draft.md', 'one\n');
    await settle();
    await store.writeDocument('draft.md', 'one\ntwo\n');
    await store.renameDocument('draft.md', 'final.md');
    await settle();

    const edit = (await history.listEvents()).find((e) => e.kind === 'document.updated')!;
    expect(edit.details).toMatchObject({ path: 'draft.md' });
  });

  it('says nothing about the editor’s own companion files', async () => {
    // Outside-in twins are machinery, not documents the user filed.
    await store.writeDocument('brief.docx_files/brief.md', 'twin\n');
    await store.writeDocument('brief.docx_files/brief.md', 'twin edited\n');
    await settle();
    expect(await history.listEvents()).toEqual([]);
  });
});
