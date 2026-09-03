import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { PromptDraftManager } from './manager.js';
import { PromptDraftSweeper } from './sweeper.js';

let home: string;
let store: Store;
let drafts: PromptDraftManager;

const PROJECT = 'default';
const NOW = new Date(2026, 8, 3, 12, 0, 0);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-draft-sweeper-'));
  store = new Store({ home });
  await store.ensureLayout();
  // The sweep walks real projects, so the default one has to exist.
  await store.ensureDefaultProject();
  drafts = new PromptDraftManager({ store, now: () => NOW });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

/** Backdate a sent draft the way real elapsed time would. */
async function backdateSend(draftId: string, sentAt: string): Promise<void> {
  const metaPath = join(drafts.draftDir(PROJECT, draftId), 'draft.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  meta.sentAt = sentAt;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

async function sentDaysAgo(days: number): Promise<string> {
  const created = await drafts.create(PROJECT, { gezelId: 'tomas', content: `sent ${days}d ago` });
  await drafts.markSent(PROJECT, created.id, { sessionId: 's1' });
  await backdateSend(created.id, new Date(NOW.getTime() - days * 86_400_000).toISOString());
  return created.id;
}

function makeSweeper(): PromptDraftSweeper {
  return new PromptDraftSweeper({ store, drafts, now: () => NOW });
}

describe('PromptDraftSweeper', () => {
  it('removes sent drafts past the default window and keeps the ones inside it', async () => {
    const stale = await sentDaysAgo(91);
    const recent = await sentDaysAgo(89);

    const result = await makeSweeper().sweep();
    expect(result.deleted).toBe(1);
    expect(await drafts.get(PROJECT, stale)).toBeNull();
    expect(await drafts.get(PROJECT, recent)).not.toBeNull();
  });

  it('never removes an unsent draft, however old', async () => {
    const open = await drafts.create(PROJECT, { gezelId: 'tomas', content: 'a year of thinking' });
    // An unsent draft has no sentAt at all; age is simply not a reason.
    await makeSweeper().sweep();
    expect(await drafts.get(PROJECT, open.id)).not.toBeNull();
  });

  it('keeps everything when the user chose to keep drafts forever', async () => {
    const stale = await sentDaysAgo(400);
    await store.writeConfig({ promptDrafts: { keepSentDays: 0 } });
    const result = await makeSweeper().sweep();
    expect(result.deleted).toBe(0);
    expect(await drafts.get(PROJECT, stale)).not.toBeNull();
  });

  it('honours a shortened window', async () => {
    const stale = await sentDaysAgo(8);
    await store.writeConfig({ promptDrafts: { keepSentDays: 7 } });
    expect((await makeSweeper().sweep()).deleted).toBe(1);
    expect(await drafts.get(PROJECT, stale)).toBeNull();
  });

  it('stops cleanly when it never started', () => {
    expect(() => makeSweeper().stop()).not.toThrow();
  });
});
