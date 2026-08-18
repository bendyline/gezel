import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-session-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function sessionFixture(overrides: Partial<ChatSession> = {}): ChatSession {
  const now = '2026-04-14T10:00:00Z';
  return {
    version: 1,
    id: 'sess-a',
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'copilot',
    model: 'mock-fast',
    title: 'Untitled',
    createdAt: now,
    lastActivityAt: now,
    messages: [],
    providerState: {},
    ...overrides,
  };
}

describe('Store session CRUD', () => {
  it('writeSession then getSession round-trips', async () => {
    const session = sessionFixture({
      id: 'sess-1',
      title: 'Hello',
      messages: [{ role: 'user', content: 'hi', at: '2026-04-14T10:00:00Z' }],
    });
    await store.writeSession(session);
    const got = await store.getSession('ada', 'sess-1');
    expect(got?.title).toBe('Hello');
    expect(got?.messages).toHaveLength(1);
  });

  it('getSession returns null for a missing id', async () => {
    expect(await store.getSession('ada', 'missing')).toBeNull();
  });

  it('listTimeline omits hidden messages but keeps them on disk', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'sess-hidden',
        messages: [
          { role: 'user', content: 'real question', at: '2026-04-14T10:00:00Z' },
          {
            role: 'user',
            content: '[Checkers page]: Your opponent played c3-d4.',
            at: '2026-04-14T10:00:01Z',
            hidden: true,
          },
          { role: 'assistant', content: 'I play d6-c5.', at: '2026-04-14T10:00:02Z' },
        ],
      }),
    );

    const timeline = await store.listTimeline({ gezelId: 'ada', limit: 50 });
    const contents = timeline.messages.map((m) => m.content);
    expect(contents).toEqual(['real question', 'I play d6-c5.']);

    const onDisk = await store.getSession('ada', 'sess-hidden');
    expect(onDisk?.messages).toHaveLength(3);
    expect(onDisk?.messages.find((m) => m.hidden)?.content).toContain('[Checkers page]');
  });

  /**
   * Threads written before `ChatMessage.origin` existed still open with a
   * dispatch seed, and would keep rendering it as the user's own words. A
   * task-scoped session is always created by the dispatcher *before* its
   * seed is sent, so its first user message is machine-authored by
   * construction — inferred structurally rather than by matching seed
   * wording, which drifts with every copy edit.
   */
  it('listTimeline infers system origin for a legacy task seed', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'sess-legacy-task',
        taskRef: 'default/1',
        stepId: 'oversight',
        messages: [
          {
            role: 'user',
            content: 'The previous step has been completed and handed step `oversight` to you.',
            at: '2026-04-14T10:00:00Z',
          },
          { role: 'assistant', content: 'On it.', at: '2026-04-14T10:00:02Z' },
          // A real reply from the user, later in the same task thread.
          { role: 'user', content: 'looks good, carry on', at: '2026-04-14T10:05:00Z' },
        ],
      }),
    );

    const timeline = await store.listTimeline({ gezelId: 'ada', limit: 50 });
    const rows = timeline.messages.filter((m) => m.sessionId === 'sess-legacy-task');
    expect(rows[0]?.origin).toBe('system');
    expect(rows[1]?.origin).toBeUndefined();
    // Only the opening seed is machinery — the user's own later turn stays theirs.
    expect(rows[2]?.origin).toBeUndefined();
  });

  it('listTimeline leaves an ordinary session untouched by the legacy inference', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'sess-plain',
        messages: [
          { role: 'user', content: 'hello there', at: '2026-04-14T11:00:00Z' },
          { role: 'assistant', content: 'hi', at: '2026-04-14T11:00:01Z' },
        ],
      }),
    );

    const timeline = await store.listTimeline({ gezelId: 'ada', limit: 50 });
    const rows = timeline.messages.filter((m) => m.sessionId === 'sess-plain');
    expect(rows.every((m) => m.origin === undefined)).toBe(true);
  });

  it('listTimeline scoped to a taskRef drops unrelated sessions in the project', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'sess-task',
        taskRef: 'molen-internal/1',
        projectId: 'molen-internal',
        messages: [
          { role: 'user', content: 'about the contract review', at: '2026-04-14T10:00:00Z' },
        ],
      }),
    );
    await store.writeSession(
      sessionFixture({
        id: 'sess-other-task',
        taskRef: 'molen-internal/2',
        projectId: 'molen-internal',
        messages: [{ role: 'user', content: 'about a different task', at: '2026-04-14T10:00:01Z' }],
      }),
    );
    await store.writeSession(
      sessionFixture({
        id: 'sess-unscoped',
        projectId: 'molen-internal',
        messages: [
          { role: 'user', content: 'general project check-in', at: '2026-04-14T10:00:02Z' },
        ],
      }),
    );

    const scoped = await store.listTimeline({
      projectId: 'molen-internal',
      taskRef: 'molen-internal/1',
      limit: 50,
    });
    expect(scoped.messages.map((m) => m.content)).toEqual(['about the contract review']);

    const unscoped = await store.listTimeline({ projectId: 'molen-internal', limit: 50 });
    expect(unscoped.messages).toHaveLength(3);
  });

  it('listTimeline scoped to a taskRef keeps handoff sessions from other gezels', async () => {
    await store.createGezel({ name: 'Boz', role: 'Writer' });
    await store.writeSession(
      sessionFixture({
        id: 'sess-ada',
        gezelId: 'ada',
        taskRef: 'molen-internal/1',
        projectId: 'molen-internal',
        createdAt: '2026-04-14T10:00:00Z',
        messages: [{ role: 'user', content: 'scope the review', at: '2026-04-14T10:00:00Z' }],
      }),
    );
    await store.writeSession(
      sessionFixture({
        id: 'sess-boz',
        gezelId: 'boz',
        taskRef: 'molen-internal/1',
        projectId: 'molen-internal',
        createdAt: '2026-04-14T11:00:00Z',
        messages: [{ role: 'user', content: 'write the report', at: '2026-04-14T11:00:00Z' }],
      }),
    );

    const scoped = await store.listTimeline({
      projectId: 'molen-internal',
      taskRef: 'molen-internal/1',
      limit: 50,
    });
    expect(scoped.messages.map((m) => m.gezelId)).toEqual(['ada', 'boz']);
    // Handoff lineage still resolves inside the narrowed scope.
    expect(scoped.messages.find((m) => m.gezelId === 'boz')?.handoffFrom).toEqual({
      gezelId: 'ada',
      sessionId: 'sess-ada',
    });
  });

  describe('listTimeline reference backfill', () => {
    const reviewReply = [
      'Full review in `pr-review.md`.',
      'The CLI `--title` default is in `packages/cli/src/commands/image.ts:84,230`,',
      'and `useFrameCapture.ts:1633` drops the style. Minors are two `docs/API.md` omissions.',
    ].join('\n');

    const writeReply = () =>
      store.writeSession(
        sessionFixture({
          id: 'sess-review',
          messages: [{ role: 'assistant', content: reviewReply, at: '2026-04-14T10:00:00Z' }],
        }),
      );

    it('resolves artifacts, and locator-suffixed workspace paths, from the reply body', async () => {
      await store.writeProjectArtifact('default', 'pr-review.md', '# review');
      await writeReply();

      const timeline = await store.listTimeline({
        gezelId: 'ada',
        limit: 50,
        workspaceFiles: async () => [
          'packages/cli/src/commands/image.ts',
          'src/hooks/useFrameCapture.ts',
          'docs/API.md',
          'src/unmentioned.ts',
        ],
      });

      expect(timeline.messages[0]?.referencedFiles).toEqual([
        { kind: 'artifact', path: 'pr-review.md' },
        { kind: 'workspace', path: 'docs/API.md' },
        { kind: 'workspace', path: 'packages/cli/src/commands/image.ts' },
        { kind: 'workspace', path: 'src/hooks/useFrameCapture.ts' },
      ]);
    });

    it('still emits the artifact-only projection for older clients', async () => {
      await store.writeProjectArtifact('default', 'pr-review.md', '# review');
      await writeReply();

      const timeline = await store.listTimeline({
        gezelId: 'ada',
        limit: 50,
        workspaceFiles: async () => ['docs/API.md'],
      });
      expect(timeline.messages[0]?.referencedArtifacts).toEqual(['pr-review.md']);
    });

    it('finds artifacts only when no workspace listing is supplied', async () => {
      await store.writeProjectArtifact('default', 'pr-review.md', '# review');
      await writeReply();

      const timeline = await store.listTimeline({ gezelId: 'ada', limit: 50 });
      expect(timeline.messages[0]?.referencedFiles).toEqual([
        { kind: 'artifact', path: 'pr-review.md' },
      ]);
    });

    it('widens a legacy artifact-only message when nothing re-resolves', async () => {
      await store.writeSession(
        sessionFixture({
          id: 'sess-legacy',
          messages: [
            {
              role: 'assistant',
              content: 'wrote the report',
              at: '2026-04-14T10:00:00Z',
              referencedArtifacts: ['since-deleted.md'],
            },
          ],
        }),
      );

      const timeline = await store.listTimeline({ gezelId: 'ada', limit: 50 });
      expect(timeline.messages[0]?.referencedFiles).toEqual([
        { kind: 'artifact', path: 'since-deleted.md' },
      ]);
    });
  });

  it('findSessionById locates across gezels', async () => {
    await store.createGezel({ name: 'Boz', role: 'Writer' });
    await store.writeSession(sessionFixture({ id: 'A', gezelId: 'ada' }));
    await store.writeSession(sessionFixture({ id: 'B', gezelId: 'boz' }));
    const found = await store.findSessionById('B');
    expect(found?.gezelId).toBe('boz');
  });

  it('listSessions filters by gezelId', async () => {
    await store.createGezel({ name: 'Boz', role: 'Writer' });
    await store.writeSession(sessionFixture({ id: 'A1', gezelId: 'ada' }));
    await store.writeSession(sessionFixture({ id: 'A2', gezelId: 'ada' }));
    await store.writeSession(sessionFixture({ id: 'B1', gezelId: 'boz' }));
    const ada = await store.listSessions({ gezelId: 'ada' });
    expect(ada.map((s) => s.id).sort()).toEqual(['A1', 'A2']);
  });

  it('listSessions filters by projectId', async () => {
    await store.writeSession(sessionFixture({ id: 'A', projectId: 'default' }));
    await store.writeSession(sessionFixture({ id: 'B', projectId: 'other' }));
    const def = await store.listSessions({ gezelId: 'ada', projectId: 'default' });
    expect(def).toHaveLength(1);
    expect(def[0]?.id).toBe('A');
  });

  it('listSessions returns newest-first by lastActivityAt', async () => {
    await store.writeSession(sessionFixture({ id: 'old', lastActivityAt: '2026-04-01T00:00:00Z' }));
    await store.writeSession(sessionFixture({ id: 'mid', lastActivityAt: '2026-04-10T00:00:00Z' }));
    await store.writeSession(sessionFixture({ id: 'new', lastActivityAt: '2026-04-14T00:00:00Z' }));
    const sessions = await store.listSessions({ gezelId: 'ada' });
    expect(sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('listSessions derives a useful label for a completed legacy reaction thread', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'legacy-reaction',
        title: 'New session',
        messages: [
          {
            role: 'user',
            content: '[Checkers page]: Your opponent played c3-d4.',
            at: '2026-04-14T10:00:00Z',
            hidden: true,
          },
          { role: 'assistant', content: 'I play d6-c5.', at: '2026-04-14T10:00:02Z' },
        ],
      }),
    );

    const sessions = await store.listSessions({ gezelId: 'ada' });
    expect(sessions[0]?.title).toBe('Checkers opponent played c3-d4');
    expect((await store.getSession('ada', 'legacy-reaction'))?.title).toBe('New session');
  });

  it('listSessions leaves a passive-CC-only legacy thread unnamed', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'passive-cc',
        title: 'New session',
        messages: [
          {
            role: 'user',
            content: '@Ada can you finish the release?',
            at: '2026-04-14T10:00:00Z',
          },
        ],
      }),
    );

    const sessions = await store.listSessions({ gezelId: 'ada' });
    expect(sessions[0]?.title).toBe('New session');
  });

  it('deleteSession removes the file', async () => {
    await store.writeSession(sessionFixture({ id: 'gone' }));
    expect(await store.getSession('ada', 'gone')).not.toBeNull();
    await store.deleteSession('ada', 'gone');
    expect(await store.getSession('ada', 'gone')).toBeNull();
  });

  it('writeSession is idempotent (overwrites the same id)', async () => {
    await store.writeSession(sessionFixture({ id: 'same', title: 'v1' }));
    await store.writeSession(sessionFixture({ id: 'same', title: 'v2' }));
    const hit = await store.getSession('ada', 'same');
    expect(hit?.title).toBe('v2');
  });

  describe('legacy-intent migration on getSession', () => {
    it('extracts inline italic intents into structured entries and rewrites content', async () => {
      const before =
        'Looking at the script now.\n_Building cart checkout flow_\n\nHere is the plan…';
      await store.writeSession(
        sessionFixture({
          id: 'legacy',
          messages: [
            { role: 'user', content: 'go', at: '2026-04-14T10:00:00Z' },
            { role: 'assistant', content: before, at: '2026-04-14T10:00:05Z' },
          ],
        }),
      );
      const hit = await store.getSession('ada', 'legacy');
      const msg = hit?.messages[1];
      expect(msg?.content).toBe('Looking at the script now.Here is the plan…');
      expect(msg?.intents).toEqual([
        { label: 'Building cart checkout flow', afterChars: 'Looking at the script now.'.length },
      ]);
    });

    it('is idempotent — a second read does not re-mutate an already-migrated message', async () => {
      await store.writeSession(
        sessionFixture({
          id: 'already',
          messages: [
            {
              role: 'assistant',
              content: 'Hello',
              at: '2026-04-14T10:00:05Z',
              intents: [{ label: 'Phase', afterChars: 5 }],
            },
          ],
        }),
      );
      const first = await store.getSession('ada', 'already');
      const second = await store.getSession('ada', 'already');
      expect(second?.messages[0]?.content).toBe('Hello');
      expect(second?.messages[0]?.intents).toEqual(first?.messages[0]?.intents);
    });

    it('leaves messages without the legacy marker untouched (no false positives on inline italics)', async () => {
      const before = 'Use `_foo_` here and _bar_ is emphasized.';
      await store.writeSession(
        sessionFixture({
          id: 'plain',
          messages: [{ role: 'assistant', content: before, at: '2026-04-14T10:00:05Z' }],
        }),
      );
      const hit = await store.getSession('ada', 'plain');
      expect(hit?.messages[0]?.content).toBe(before);
      expect(hit?.messages[0]?.intents).toBeUndefined();
    });

    it('extracts multiple adjacent intents preserving their offsets', async () => {
      const before = 'Start.\n_First phase_\n\nMid text.\n_Second phase_\n\nEnd.';
      await store.writeSession(
        sessionFixture({
          id: 'multi',
          messages: [{ role: 'assistant', content: before, at: '2026-04-14T10:00:05Z' }],
        }),
      );
      const hit = await store.getSession('ada', 'multi');
      expect(hit?.messages[0]?.content).toBe('Start.Mid text.End.');
      expect(hit?.messages[0]?.intents).toEqual([
        { label: 'First phase', afterChars: 'Start.'.length },
        { label: 'Second phase', afterChars: 'Start.Mid text.'.length },
      ]);
    });
  });

  it('round-trips a structured last-turn-error detail', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'crashed',
        lastTurnError: '[llama-cpp] on-device engine crashed (SIGILL)',
        lastTurnErrorDetail: {
          code: 'native-engine-crash',
          engine: 'llama-cpp',
          incidentId: 'native-51832-1785547847453',
          exitCode: null,
          signal: 'SIGILL',
          diagnostics: { model: 'gemma4-26b-q4', contextTotal: 32768, flashAttention: true },
        },
      }),
    );
    const hit = await store.getSession('ada', 'crashed');
    expect(hit?.lastTurnErrorDetail).toEqual({
      code: 'native-engine-crash',
      engine: 'llama-cpp',
      incidentId: 'native-51832-1785547847453',
      exitCode: null,
      signal: 'SIGILL',
      diagnostics: { model: 'gemma4-26b-q4', contextTotal: 32768, flashAttention: true },
    });
  });

  it('reads a session written before the structured detail existed', async () => {
    // Old installs have no `lastTurnErrorDetail` key at all. Absent is a
    // valid value, not a parse failure — no migration, no version bump.
    await store.writeSession(
      sessionFixture({ id: 'legacy', lastTurnError: 'something went wrong' }),
    );
    const hit = await store.getSession('ada', 'legacy');
    expect(hit?.lastTurnError).toBe('something went wrong');
    expect(hit?.lastTurnErrorDetail).toBeUndefined();
  });

  it('summary fields strip messages', async () => {
    await store.writeSession(
      sessionFixture({
        id: 'has-msgs',
        messages: [
          { role: 'user', content: 'x', at: '2026-04-14T10:00:00Z' },
          {
            role: 'user',
            content: 'Can you review this?',
            at: '2026-04-14T10:01:00Z',
            from: { gezelId: 'reviewer', gezelName: 'Reviewer' },
          },
          {
            role: 'assistant',
            content: 'The latest\nreply is ready.',
            at: '2026-04-14T10:02:00Z',
          },
        ],
      }),
    );
    const list = await store.listSessions({ gezelId: 'ada' });
    const summary = list.find((s) => s.id === 'has-msgs');
    expect(summary).toBeDefined();
    expect(summary?.lastMessagePreview).toBe('The latest reply is ready.');
    expect(summary?.involvedGezelIds).toEqual(['ada', 'reviewer']);
    expect((summary as Record<string, unknown>).messages).toBeUndefined();
  });
});
