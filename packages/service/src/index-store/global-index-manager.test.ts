import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ChatSession } from '@bendyline/gezel';
import { gezelSessionsDir, globalIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { GlobalIndexManager, chunkTranscript } from './global-index-manager.js';
import { GlobalIndex, openGlobalCollection } from './global-index.js';

let home: string;
let store: Store;
let history: HistoryManager;
let manager: GlobalIndexManager;
let globalIndex: GlobalIndex;
let ftsAvailable: boolean;

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    version: 1,
    id: 'sess-1',
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'copilot',
    title: 'Chat about widgets',
    createdAt: '2026-04-05T10:00:00Z',
    lastActivityAt: '2026-04-05T10:22:00Z',
    messages: [
      { role: 'user', content: 'how do we frobnicate the widget?', at: '2026-04-05T10:00:00Z' },
      { role: 'assistant', content: 'with the frobnicator, carefully', at: '2026-04-05T10:22:00Z' },
    ],
    providerState: {},
    ...overrides,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-global-index-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  manager = new GlobalIndexManager({ store, history });
  globalIndex = new GlobalIndex(home);
  store.onSessionChange((ev) => manager.enqueueSession(ev));
  const probe = await openGlobalCollection(home, 'sessions');
  ftsAvailable = probe ? probe.ftsAvailable : false;
  probe?.close();
});

afterEach(async () => {
  manager.stop();
  await rm(home, { recursive: true, force: true });
});

describe('chunkTranscript', () => {
  it('keeps 1-based message indices, skipping empty messages without renumbering', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first', at: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: '', at: '2026-01-01T00:00:01Z' },
      { role: 'user', content: 'third', at: '2026-01-01T00:00:02Z' },
    ];
    const chunks = chunkTranscript(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.lineStart).toBe(1);
    expect(chunks[0]?.lineEnd).toBe(3);
    expect(chunks[0]?.text).toBe('user: first\nuser: third');
  });

  it('splits into multiple chunks past the size cap', () => {
    const big = 'x'.repeat(3000);
    const messages: ChatMessage[] = [
      { role: 'user', content: big, at: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: big, at: '2026-01-01T00:00:01Z' },
    ];
    const chunks = chunkTranscript(messages);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.lineStart).toBe(1);
    expect(chunks[1]?.lineStart).toBe(2);
  });

  it('labels inter-gezel messages with the sender name', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'status?',
        at: '2026-01-01T00:00:00Z',
        from: { gezelId: 'm1', gezelName: 'Meester' },
      },
    ];
    expect(chunkTranscript(messages)[0]?.text).toBe('Meester: status?');
  });
});

describe('GlobalIndexManager sessions', () => {
  it('indexes a written session and finds it by transcript content', async () => {
    if (!ftsAvailable) return;
    await store.writeSession(makeSession());
    await manager.flush();

    const hits = await globalIndex.searchSessions('frobnicate');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe('sess-1');
    expect(hits[0]?.gezelId).toBe('ada');
    expect(hits[0]?.projectId).toBe('default');
    expect(hits[0]?.title).toBe('Chat about widgets');
    expect(hits[0]?.messageStart).toBe(1);
    expect(hits[0]?.lastActivityAt).toBe('2026-04-05T10:22:00Z');
  });

  it('filters by gezel and project', async () => {
    if (!ftsAvailable) return;
    await store.writeSession(makeSession());
    await store.writeSession(makeSession({ id: 'sess-2', gezelId: 'bob', projectId: 'proj-x' }));
    await manager.flush();

    const adaOnly = await globalIndex.searchSessions('frobnicate', { gezelId: 'ada' });
    expect(adaOnly.map((h) => h.sessionId)).toEqual(['sess-1']);
    const projOnly = await globalIndex.searchSessions('frobnicate', { projectId: 'proj-x' });
    expect(projOnly.map((h) => h.sessionId)).toEqual(['sess-2']);
  });

  it('is idempotent and refreshes metadata on archive without a transcript change', async () => {
    if (!ftsAvailable) return;
    const session = makeSession();
    await store.writeSession(session);
    await manager.flush();
    await store.writeSession({ ...session, archived: true });
    await manager.flush();

    const hits = await globalIndex.searchSessions('frobnicate');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.archived).toBe(true);
  });

  it('prunes a deleted session', async () => {
    if (!ftsAvailable) return;
    await store.writeSession(makeSession());
    await manager.flush();
    await store.deleteSession('ada', 'sess-1');
    await manager.flush();

    expect(await globalIndex.searchSessions('frobnicate')).toHaveLength(0);
  });

  it('reconcile picks up session files written without the hook and self-heals a wiped db', async () => {
    if (!ftsAvailable) return;
    const sessDir = gezelSessionsDir(home, 'ada');
    await mkdir(sessDir, { recursive: true });
    await writeFile(join(sessDir, 'sess-1.json'), JSON.stringify(makeSession()), 'utf8');
    await manager.reconcile();
    expect(await globalIndex.searchSessions('frobnicate')).toHaveLength(1);

    await rm(globalIndexDbFile(home), { force: true });
    expect(await globalIndex.searchSessions('frobnicate')).toHaveLength(0);
    await manager.reconcile();
    expect(await globalIndex.searchSessions('frobnicate')).toHaveLength(1);
  });

  it('respects the searchIndex config gate', async () => {
    if (!ftsAvailable) return;
    await store.writeConfig({ searchIndex: { sessions: false } });
    await store.writeSession(makeSession());
    await manager.flush();
    expect(await globalIndex.searchSessions('frobnicate')).toHaveLength(0);
  });
});

describe('GlobalIndexManager documents (retired collection)', () => {
  beforeEach(() => {
    store.onDocumentChange((ev) => manager.enqueueDocument(ev));
  });

  it('no longer indexes documents — the library is a project', async () => {
    if (!ftsAvailable) return;
    // Documents are indexed by the per-project pipeline now (ADR 0006).
    // Mirroring them here too would answer searches from a second, unranked
    // copy that no longer tracks the library's real content.
    await store.writeDocument('guides/style.md', '# Style\nAlways use the zwaluw pattern.');
    await manager.flush();

    const index = await openGlobalCollection(home, 'documents');
    expect(index).not.toBeNull();
    try {
      expect(index!.allFiles()).toHaveLength(0);
    } finally {
      index!.close();
    }
  });

  it('purges rows left behind by the old pipeline', async () => {
    if (!ftsAvailable) return;
    // Simulate an upgrade: an install whose global db still carries the
    // documents the retired writer indexed. Left in place they would keep
    // surfacing in search, including documents since deleted.
    const seed = await openGlobalCollection(home, 'documents');
    expect(seed).not.toBeNull();
    try {
      seed!.putChunks('guides/legacy.md', 'hash-1', [
        { kind: 'paragraph', lineStart: 1, lineEnd: 2, text: 'stale zwaluw content' },
      ]);
      seed!.upsertFile({
        path: 'guides/legacy.md',
        hash: 'hash-1',
        size: 20,
        mtimeMs: Date.now(),
        lang: null,
        kind: 'markdown',
        modality: 'text',
        trivial: false,
        indexedAt: new Date().toISOString(),
        loc: null,
      });
      expect(seed!.allFiles()).toHaveLength(1);
    } finally {
      seed!.close();
    }

    await manager.reconcile();

    const after = await openGlobalCollection(home, 'documents');
    try {
      expect(after!.allFiles()).toHaveLength(0);
    } finally {
      after!.close();
    }
  });

  it('does not add managed companion operations to user-facing history', async () => {
    await store.writeDocument('brief.md', '# Visible');
    await store.writeDocument('brief_files/brief.md', '# Companion');
    await store.renameDocument('brief_files/brief.md', 'brief_files/source.md');
    await store.deleteDocument('brief_files');

    const events = await history.listEvents();
    expect(events.map((event) => event.summary)).toEqual(['Created document brief.md']);
  });
});

describe('GlobalIndexManager history mirror', () => {
  it('returns null before the first backfill, then answers q queries after reconcile', async () => {
    if (!ftsAvailable) return;
    history.subscribe((ev) => manager.enqueueHistory(ev));
    await history.log({ kind: 'gezel.created', gezelId: 'ada', summary: 'Created "Ada"' });
    await manager.flush();
    expect(await globalIndex.searchHistory({ q: 'Ada' })).toBeNull();

    await manager.reconcile();
    const hits = await globalIndex.searchHistory({ q: 'Ada' });
    expect(hits).toHaveLength(1);
    expect(hits?.[0]?.kind).toBe('gezel.created');
  });

  it('backfills pre-existing JSONL idempotently and applies structured filters', async () => {
    if (!ftsAvailable) return;
    await history.log({
      kind: 'gezel.created',
      gezelId: 'ada',
      at: '2026-01-01T00:00:00Z',
      summary: 'Created "Ada"',
      details: { name: 'Ada Lovelace' },
    });
    await history.log({
      kind: 'project.created',
      projectId: 'proj-x',
      at: '2026-02-01T00:00:00Z',
      summary: 'Created project "Ada tribute"',
    });
    await manager.reconcile();
    await manager.reconcile();

    const all = await globalIndex.searchHistory({ q: 'Ada' });
    expect(all).toHaveLength(2);
    expect(await globalIndex.searchHistory({ q: 'Ada', kinds: ['project.created'] })).toHaveLength(
      1,
    );
    expect(await globalIndex.searchHistory({ q: 'Ada', projectId: 'proj-x' })).toHaveLength(1);
    expect(await globalIndex.searchHistory({ q: 'Ada', to: '2026-01-15T00:00:00Z' })).toHaveLength(
      1,
    );
    // Details are searchable and quotes are escaped safely.
    expect(await globalIndex.searchHistory({ q: 'Lovelace' })).toHaveLength(1);
    expect(await globalIndex.searchHistory({ q: '"Ada tribute"' })).toHaveLength(1);
  });

  it('feeds HistoryManager q-queries through the backend after backfill', async () => {
    if (!ftsAvailable) return;
    history.setQueryBackend((f) => globalIndex.searchHistory(f));
    await history.log({ kind: 'gezel.created', gezelId: 'ada', summary: 'Created "Ada"' });
    // Before backfill the backend returns null → JSONL scan answers.
    expect(await history.listEvents({ q: 'Ada' })).toHaveLength(1);
    history.subscribe((ev) => manager.enqueueHistory(ev));
    await manager.reconcile();
    await history.log({ kind: 'gezel.renamed', gezelId: 'ada', summary: 'Renamed Ada' });
    await manager.flush();
    const events = await history.listEvents({ q: 'Ada', limit: 5 });
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('gezel.renamed');
  });
});
