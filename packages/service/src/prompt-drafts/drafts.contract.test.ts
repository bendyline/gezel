import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { portableStoreOverHome } from '../test-support/portable-node-files.js';
import { PromptDraftManager } from './manager.js';

/**
 * One draft script through the desktop manager, read back by the portable
 * store, and the mirror. The two hosts share the module; this is the proof
 * that the adapters under it agree byte for byte.
 */
let home: string;
let store: Store;
let gezelId: string;
const fixedNow = new Date('2026-09-22T10:00:00.000Z');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-drafts-contract-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  gezelId = (await store.createGezel({ name: 'Ada', role: 'Developer' })).id;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const metaBytes = (draftId: string) =>
  readFile(
    join(home, 'projects', 'default', 'artifacts', 'prompts', draftId, 'draft.json'),
    'utf8',
  );

describe('prompt drafts agree across hosts', () => {
  it('drafts the desktop wrote read identically on the portable host', async () => {
    const manager = new PromptDraftManager({ store, now: () => fixedNow });
    const created = await manager.create('default', { gezelId, content: 'Draft one' });
    await manager.writeContent('default', created.id, 'Draft one, revised');
    await manager.patchMeta('default', created.id, { scope: 'notes' });
    const copy = await manager.duplicate('default', created.id);
    await manager.markSent('default', created.id, { sessionId: 'sess-1' });
    await manager.noteSentMessageAt('default', created.id, '2026-09-22T10:00:05.000Z');

    const portable = portableStoreOverHome(home, { now: () => fixedNow.toISOString() });
    expect(await portable.listPromptDrafts('default')).toEqual(await manager.list('default'));
    expect(await portable.getPromptDraft('default', copy.id)).toEqual(
      await manager.get('default', copy.id),
    );
  });

  it('drafts the portable host wrote read identically on the desktop, byte for byte', async () => {
    const portable = portableStoreOverHome(home, { now: () => fixedNow.toISOString() });
    const created = await portable.createPromptDraft('default', {
      gezelId,
      content: 'From the phone',
    });
    await portable.patchPromptDraft('default', created.id, { scope: 'notes' });
    const before = await metaBytes(created.id);

    const manager = new PromptDraftManager({ store, now: () => fixedNow });
    expect(await manager.get('default', created.id)).toEqual(
      await portable.getPromptDraft('default', created.id),
    );
    // Re-saving through the desktop changes only the timestamp, and writes the
    // record in the same shape and formatting the phone did.
    await manager.patchMeta('default', created.id, {});
    const after = await metaBytes(created.id);
    const strip = (raw: string) => {
      const { updatedAt: _u, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(after).toBe(`${JSON.stringify(JSON.parse(after), null, 2)}\n`);
  });
});
