import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';
import { formatAnswerSeed } from './question-format.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-questions-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.ensureDefaultProject();
  await store.createGezel({ name: 'Leo', role: 'Voorman' });
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 't',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  // Drain fire-and-forget background work (memory extraction, fan-out
  // writes) before tearing down. Without this, a still-running
  // extractor from the previous test can race with the next test's
  // beforeEach setup — particularly under the concurrent test-runner
  // load that the full suite produces. Mirrors the manager.test.ts
  // pattern.
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    projectId: 'default',
    gezelId: 'leo',
    sessionId: 'sess-placeholder',
    prompt: "Do you have specific symbols you'd like in the logo?",
    choices: ['Fox', 'Plant', 'Star'],
    multiSelect: true,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('Store — question persistence', () => {
  it('upserts questions per project', async () => {
    await store.writeQuestion(makeQuestion({ id: 'a' }));
    await store.writeQuestion(makeQuestion({ id: 'b', prompt: 'second?' }));
    const all = await store.listProjectQuestions('default');
    expect(all.map((q) => q.id).sort()).toEqual(['a', 'b']);

    // Upsert: same id replaces, no duplicate.
    await store.writeQuestion(makeQuestion({ id: 'a', prompt: 'updated' }));
    const after = await store.listProjectQuestions('default');
    expect(after).toHaveLength(2);
    expect(after.find((q) => q.id === 'a')?.prompt).toBe('updated');
  });

  it('listAllPendingQuestions ignores answered + spans projects', async () => {
    await store.createProject({
      name: 'B',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.writeQuestion(makeQuestion({ id: 'open', projectId: 'default' }));
    await store.writeQuestion(makeQuestion({ id: 'open-b', projectId: 'b' }));
    await store.writeQuestion(
      makeQuestion({
        id: 'closed',
        projectId: 'default',
        answer: { writeIn: 'done', at: new Date().toISOString() },
      }),
    );
    const pending = await store.listAllPendingQuestions();
    expect(pending.map((q) => q.id).sort()).toEqual(['open', 'open-b']);
  });

  it('stamps pendingQuestionId on the most recent assistant message', async () => {
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('hello, working on it now');
    await manager.send(session.id, 'kick off');
    await store.stampPendingQuestionOnLastAssistant('leo', session.id, 'q-foo');
    const after = await store.getSession('leo', session.id);
    const lastAssistant = [...(after?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant?.pendingQuestionId).toBe('q-foo');
  });

  it('a stamp survives a concurrent read-modify-write on the same session', async () => {
    // The stamp and the background memory-extraction cursor persist are
    // both read-modify-write cycles on the same file. Un-serialized,
    // whichever renames last drops the other's edit — extraction reading
    // before the stamp and writing after it silently un-stamped the
    // bubble, which is how this suite flaked under full-suite load.
    // `mutateSession` holds one lock across each whole cycle.
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('hello, working on it now');
    await manager.send(session.id, 'kick off');

    const slowCursorWrite = store.mutateSession('leo', session.id, async (s) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      s.extractedUpTo = 1;
    });
    await store.stampPendingQuestionOnLastAssistant('leo', session.id, 'q-race');
    await slowCursorWrite;

    const after = await store.getSession('leo', session.id);
    const lastAssistant = [...(after?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant?.pendingQuestionId).toBe('q-race');
    expect(after?.extractedUpTo).toBe(1);
  });

  it('a mid-turn stamp survives the next turn-end write of the live record', async () => {
    // `ask_user_question` fires mid-turn, so the record ChatManager
    // writes at turn end is an in-memory object that never saw the disk
    // stamp — writing it wholesale erased the stamp and the in-chat card
    // degraded to dropdown-only. `ChatManager.stampPendingQuestion`
    // mirrors onto the live record as well.
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('first reply');
    await manager.send(session.id, 'hello');
    await manager.stampPendingQuestion('leo', session.id, 'q-live');
    mock.script('second reply');
    await manager.send(session.id, 'again');

    const after = await store.getSession('leo', session.id);
    const stamped = (after?.messages ?? []).filter((m) => m.pendingQuestionId === 'q-live');
    expect(stamped).toHaveLength(1);
  });

  it('attaches a first-turn question to the assistant message that asked it', async () => {
    // There is no previous assistant on a session's first turn. A direct
    // last-message stamp therefore no-ops while the provider is running;
    // ChatManager must carry the question id until it constructs the
    // assistant message at turn end.
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('');

    const turn = manager.send(session.id, 'help me choose');
    await manager.stampPendingQuestion('leo', session.id, 'q-first-turn');
    await turn;

    const after = await store.getSession('leo', session.id);
    const assistant = (after?.messages ?? []).find((m) => m.role === 'assistant');
    expect(assistant?.pendingQuestionId).toBe('q-first-turn');
  });

  it('attaches a mid-turn question to the current assistant, not the prior reply', async () => {
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('First reply');
    await manager.send(session.id, 'first');

    mock.script('');
    const turn = manager.send(session.id, 'second');
    await manager.stampPendingQuestion('leo', session.id, 'q-current-turn');
    await turn;

    const after = await store.getSession('leo', session.id);
    const assistants = (after?.messages ?? []).filter((m) => m.role === 'assistant');
    expect(assistants[0]?.pendingQuestionId).toBeUndefined();
    expect(assistants[1]?.pendingQuestionId).toBe('q-current-turn');
  });

  it('end-of-turn stamps mid-turn approval questions onto the just-committed bubble', async () => {
    // Mid-turn approval intents (npm-install / command / tool-permission /
    // image-generation) are synthesized server-side BEFORE the in-flight
    // assistant message commits, so they can't stamp the bubble at
    // creation time. ChatManager catches them at the moment the bubble
    // commits via a per-iteration `iterStartedAt` filter.
    //
    // We can't reliably race a real-clock write inside the mock's
    // sendAndWait — runSend's setup (ensureState, gezel/project load,
    // system-prompt build) is highly variable, especially under the
    // concurrent test-runner load this suite produces. Instead, write
    // the question with a far-future `createdAt` that's guaranteed to
    // pass the `>= iterStartedAt` filter regardless of when the mock
    // captures it. The filter behavior is what's under test, not the
    // wall-clock timing of when `writeQuestion` was called.
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('alright, kicking off the install');
    const futureCreatedAt = new Date(Date.now() + 60_000).toISOString();
    await store.writeQuestion({
      id: 'q-npm',
      projectId: 'default',
      gezelId: 'leo',
      sessionId: session.id,
      prompt: 'Install typescript@latest?',
      intent: {
        kind: 'npm-install-approval',
        packages: [{ package: 'typescript', version: 'latest' }],
      },
      createdAt: futureCreatedAt,
    });
    await manager.send(session.id, 'install typescript please');

    const after = await store.getSession('leo', session.id);
    const lastAssistant = [...(after?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant?.pendingQuestionId).toBe('q-npm');
  });

  it('end-of-turn stamping ignores stale intent-bearing questions from prior turns', async () => {
    // Counterpart to the test above: a question with `createdAt` that
    // pre-dates the current iteration must not be picked up. Without
    // this filter, an old declined-but-not-answered approval from a
    // prior turn would re-attach to every new bubble.
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('alright, kicking off the install');
    const staleCreatedAt = new Date(Date.now() - 60_000).toISOString();
    await store.writeQuestion({
      id: 'q-stale',
      projectId: 'default',
      gezelId: 'leo',
      sessionId: session.id,
      prompt: 'Install typescript@latest?',
      intent: {
        kind: 'npm-install-approval',
        packages: [{ package: 'typescript', version: 'latest' }],
      },
      createdAt: staleCreatedAt,
    });
    await manager.send(session.id, 'install typescript please');

    const after = await store.getSession('leo', session.id);
    const lastAssistant = [...(after?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant?.pendingQuestionId).toBeUndefined();
  });

  it("end-of-turn stamping skips intent-less ask_user_question (it's already stamped on the prior bubble)", async () => {
    // Plain `ask_user_question` calls (no `intent`) are stamped
    // synchronously by the `/api/questions` route at creation time onto
    // the prior assistant bubble. End-of-turn stamping must NOT also
    // attach the same id to the new bubble, or the same card would
    // render twice in the timeline.
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('drafting something for you');
    const futureCreatedAt = new Date(Date.now() + 60_000).toISOString();
    await store.writeQuestion({
      id: 'q-bare',
      projectId: 'default',
      gezelId: 'leo',
      sessionId: session.id,
      prompt: 'Which symbol do you prefer?',
      choices: ['Fox', 'Plant'],
      createdAt: futureCreatedAt,
    });
    await manager.send(session.id, 'pick a symbol');

    const after = await store.getSession('leo', session.id);
    const lastAssistant = [...(after?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant?.pendingQuestionId).toBeUndefined();
  });
});

describe('ChatManager.deliverQuestionAnswer', () => {
  it('injects the formatted answer as a synthetic user message + triggers next turn', async () => {
    const session = await manager.createSession({ gezelId: 'leo' });
    mock.script('Roger, will draft something.', 'NONE'); // initial assistant + extractor placeholder
    await manager.send(session.id, 'help with brand');

    const q = makeQuestion({ sessionId: session.id });
    q.answer = {
      selectedChoices: [0, 1],
      writeIn: 'warm palette',
      at: new Date().toISOString(),
    };
    mock.script('Picking up the choices now.', 'NONE');
    await manager.deliverQuestionAnswer({
      sessionId: session.id,
      seed: formatAnswerSeed(q),
    });

    const disk = await store.getSession('leo', session.id);
    const userMessages = (disk?.messages ?? []).filter((m) => m.role === 'user');
    // Original "help with brand" + the synthetic answer envelope.
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    const last = userMessages[userMessages.length - 1];
    expect(last?.content).toContain('[Answer to:');
    expect(last?.content).toContain('Selected: Fox, Plant');
    expect(last?.content).toContain('Notes: warm palette');
    // No `from` — the answer is the user's own message via a different
    // affordance, not a cross-gezel handoff.
    expect(last?.from).toBeUndefined();
  });

  it("tolerates a deleted session — logs a warning, doesn't throw", async () => {
    await expect(
      manager.deliverQuestionAnswer({
        sessionId: 'no-such-session',
        seed: '[Answer to: "x"]\nfoo',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('listAllPendingQuestions — enumeration safety', () => {
  // Wild-caught: `~/.gezel-dev/projects/` picks up a `.DS_Store`, whose
  // leading dot fails `assertSafeEntityId`. The unguarded readdir fed it
  // straight to `projectQuestionsFile`, which threw, so GET
  // /api/questions 500'd for EVERY project — no pending question ever
  // reached the UI and a task parked on `ask_user_question` waited on an
  // answer the user could not give. Fired once per daemon boot.
  it('skips OS detritus in the projects root instead of throwing', async () => {
    await store.writeQuestion(makeQuestion({ id: 'pending-1' }));
    await writeFile(join(home, 'projects', '.DS_Store'), 'binary junk');

    const all = await store.listAllPendingQuestions();
    expect(all.map((entry) => entry.id)).toContain('pending-1');
  });
});
