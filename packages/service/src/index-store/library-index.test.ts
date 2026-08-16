import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';

/**
 * The shared library is indexed by the ordinary per-project pipeline (ADR
 * 0006). These cover what makes the library different from a code workspace:
 * what must not be indexed, and what must not be written into the user's
 * folder.
 */

let home: string;
let store: Store;
let ci: ContentIndex;
let libraryId: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-library-idx-'));
  store = new Store({ home });
  await store.ensureLayout();
  const shared = await store.ensureSharedProject();
  libraryId = shared.id;
  ci = new ContentIndex(store, home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function refresh(): Promise<void> {
  await ci.refresh(libraryId);
}

describe('shared library indexing', () => {
  it('makes document content searchable', async () => {
    await store.writeDocument('policies/refunds.md', '# Refunds\n\nWe refund within 30 days.');
    await refresh();

    const found = await ci.searchLibrary(libraryId, 'refund');
    if (found.engine === 'unavailable') return; // sqlite/FTS not built here
    expect(found.results.map((r) => r.path)).toContain('policies/refunds.md');
  });

  it('indexes a document once, not twice as its editable twin', async () => {
    // Outside-in editing keeps a markdown twin beside a binary document.
    // Both describe the same document; offering both invites the model to
    // open the stale one.
    await store.writeDocument('decks/brief.md', '# Brief\n\nThe zwaluw campaign.');
    await store.writeDocument('decks/brief.pptx_files/brief.md', '# Twin\n\nThe zwaluw campaign.');
    await refresh();

    const found = await ci.searchLibrary(libraryId, 'zwaluw');
    if (found.engine === 'unavailable') return;
    expect(found.results.map((r) => r.path)).toEqual(['decks/brief.md']);
  });

  it('ignores cloud-sync and editor droppings', async () => {
    await store.writeDocument('handbook.md', '# Handbook\n\nThe ooievaar rule.');
    // What a sync client and an open Word document leave behind.
    await store.writeDocument('~$handbook.docx', 'lock ooievaar');
    await store.writeDocument('handbook.md.tmp', 'partial ooievaar');
    await refresh();

    const found = await ci.searchLibrary(libraryId, 'ooievaar');
    if (found.engine === 'unavailable') return;
    expect(found.results.map((r) => r.path)).toEqual(['handbook.md']);
  });

  it('writes nothing of its own into the user’s library folder', async () => {
    // The library may be a cloud-synced folder the user browses in Finder.
    // Derived state (sqlite, shadow conversions) belongs home-side; a
    // `.gezel/` directory appearing in their documents is the failure.
    await store.writeDocument('mission.md', '# Mission\n\nSimplify AI.');
    await refresh();

    // Only documents — the ones seeded or written above. Anything else here
    // is gezel machinery that escaped into the user's folder.
    const entries = await readdir(store.documentsDir());
    expect(entries.filter((e) => e.endsWith('.md')).sort()).toEqual([
      'About this library.md',
      'mission.md',
    ]);
    expect(entries.filter((e) => !e.endsWith('.md'))).toEqual([]);
  });
});
