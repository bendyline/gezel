import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { KeurmeesterCaseStore } from '../keurmeester/case-store.js';
import { KeurmeesterManager } from '../keurmeester/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * End-to-end trigger-1 flow: a tiny local model exhausts its
 * continuation-nudge budget, the KeurmeesterManager consults a
 * (mocked) frontier provider, and the verdict's corrective prompt
 * funds exactly one extra recovery continuation. Everything runs
 * through the real `runSend` loop — the same path production takes.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const VERDICT_REPLY = `\`\`\`json\n${JSON.stringify({
  diagnosis: 'The model stalls after reasoning instead of answering.',
  failureClass: 'silent_stall',
  action: {
    kind: 'corrective_prompt',
    prompt: 'Answer the user in one plain sentence now. Do not plan, do not read anything.',
  },
  confidence: 'high',
})}\n\`\`\``;

// Tiny tier (no parseable size in the model id) gets a continuation
// budget of 4 (`turn.continuation-budget` tier default) — the initial
// turn plus four nudge turns must all stall before the trigger fires.
const STALLED_TURNS = 5;

describe('ChatManager — keurmeester intervention on nudge-budget exhaustion', () => {
  let home: string;
  let store: Store;
  let events: ChatEventBus;
  let manager: ChatManager;
  let localMock: MockProvider;
  let frontierMock: MockProvider;
  let history: HistoryManager;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-keurm-e2e-'));
    store = new Store({ home });
    await store.ensureLayout();
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createProject({ name: 'Default' });
    await store.writeConfig({
      provider: 'mlx',
      keurmeester: { enabled: true, providerName: 'openai', model: 'gpt-test' },
    });
    events = new ChatEventBus();
    localMock = new MockProvider({ name: 'mlx' });
    frontierMock = new MockProvider({ name: 'openai' });
    history = new HistoryManager(home);
    manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [
        ['mlx', localMock],
        ['openai', frontierMock],
      ],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
      history,
    });
    const keurmeester = new KeurmeesterManager({
      store,
      history,
      events,
      home,
      oneShot: (prompt, timeoutMs, opts) => manager.oneShotCompletion(prompt, timeoutMs, opts),
    });
    // Mirror the service.ts wiring: the turn-abort recovery path delivers
    // its corrective prompt through the real messageGezel.
    keurmeester.setChat({
      messageGezel: (args) => manager.messageGezel(args),
      ensureOrCreateSession: (args) => manager.ensureOrCreateSession(args),
      send: (sessionId, text, opts) => manager.send(sessionId, text, opts),
    });
    manager.setKeurmeester(keurmeester);
  });

  afterEach(async () => {
    await manager.drainBackground();
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  it('consults the frontier model and unblocks the stalled turn', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    // Every in-budget turn stalls (empty replies), then the granted
    // recovery continuation produces a real answer.
    for (let i = 0; i < STALLED_TURNS; i++) localMock.script('');
    frontierMock.script(VERDICT_REPLY);
    localMock.script('The review is ready: the code is solid, two nits noted inline.');

    await manager.send(session.id, 'review my code');

    const disk = await store.getSession('ada', session.id);
    expect(disk).toBeTruthy();

    // The visible thread carries the inspector's notice followed by the
    // recovered answer.
    const notice = disk!.messages.find((m) => m.synthetic === 'keurmeester-notice');
    expect(notice).toBeTruthy();
    expect(notice!.content).toContain('stepped in');
    const last = disk!.messages[disk!.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('review is ready');

    // The frontier mock answered exactly one consult.
    const consultSends = frontierMock.calls.filter((c) => c.kind === 'send');
    expect(consultSends).toHaveLength(1);
    expect(consultSends[0]!.prompt).toContain('struggling journeyman');

    // Case log: opened (applied) + closed (unblocked).
    const cases = await new KeurmeesterCaseStore(home).read();
    expect(cases).toHaveLength(2);
    const opened = cases.find((c) => c.record === 'case.opened');
    const closed = cases.find((c) => c.record === 'case.closed');
    expect(opened && opened.record === 'case.opened' && opened.applied).toBe(true);
    expect(closed && closed.record === 'case.closed' && closed.outcome).toBe('unblocked');

    // Audit trail.
    const interventions = await history.listEvents({ kinds: ['keurmeester.intervention'] });
    expect(interventions).toHaveLength(1);
  });

  it('leaves the pre-existing give-up path untouched when disabled', async () => {
    await store.writeConfig({ keurmeester: { enabled: false } });
    const session = await manager.createSession({ gezelId: 'ada' });
    for (let i = 0; i < STALLED_TURNS; i++) localMock.script('');

    await manager.send(session.id, 'review my code');

    // No consult, no notice — just the familiar stall warning.
    expect(frontierMock.calls.filter((c) => c.kind === 'send')).toHaveLength(0);
    const disk = await store.getSession('ada', session.id);
    expect(disk!.messages.some((m) => m.synthetic === 'keurmeester-notice')).toBe(false);
    expect(await new KeurmeesterCaseStore(home).read()).toHaveLength(0);
  });

  it(
    'consults on a silent-stall turn abort and re-drives the session (trigger 5)',
    { timeout: 15_000 },
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      // The kickoff turn dies the way the wild-caught petshop run did: the
      // provider's mid-stream watchdog aborts with zero visible output.
      localMock.scriptSendFailure(
        '[llama-cpp] no output for 120s mid-stream; aborting (received 0 chars in 543s before going silent for 498s).',
      );
      frontierMock.script(VERDICT_REPLY);
      // The recovery turn (messageGezel from the keurmeester) succeeds.
      localMock.script('Recovered: here is the answer you asked for.');

      await expect(manager.send(session.id, 'build the site')).rejects.toThrow(/no output/);

      // The consult + recovery run fire-and-forget after the send rejects —
      // poll until the case log shows the closed outcome.
      const caseStore = new KeurmeesterCaseStore(home);
      let cases = await caseStore.read();
      for (
        let i = 0;
        i < 100 && cases.filter((c) => c.record === 'case.closed').length === 0;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
        cases = await caseStore.read();
      }

      const opened = cases.find((c) => c.record === 'case.opened');
      expect(opened && opened.record === 'case.opened' && opened.trigger).toBe('turn_aborted');
      expect(opened && opened.record === 'case.opened' && opened.applied).toBe(true);
      const closed = cases.find((c) => c.record === 'case.closed');
      expect(closed && closed.record === 'case.closed' && closed.outcome).toBe('unblocked');

      // The recovery turn landed on the same session as a keurmeester
      // message and produced a real reply.
      const disk = await store.getSession('ada', session.id);
      const contents = disk!.messages.map((m) => m.content).join('\n');
      expect(contents).toContain('Message from');
      expect(contents).toContain('Recovered: here is the answer');
    },
  );

  it('never consults on a transport-class abort', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    localMock.scriptSendFailure('connect ECONNREFUSED 127.0.0.1:8080');

    await expect(manager.send(session.id, 'build the site')).rejects.toThrow(/ECONNREFUSED/);
    await new Promise((r) => setTimeout(r, 150));

    expect(frontierMock.calls.filter((c) => c.kind === 'send')).toHaveLength(0);
    expect(await new KeurmeesterCaseStore(home).read()).toHaveLength(0);
  });

  it(
    'stays silent on a single guard abort but consults on consecutive ones',
    { timeout: 15_000 },
    async () => {
      const session = await manager.createSession({ gezelId: 'ada' });
      // First guard abort (tool-loop tracker teaching message): the
      // guard's own recovery gets its chance — no consult.
      localMock.scriptSendFailure(
        '[llama.cpp] aborting — `replace_lines` failed 5 times in a row this turn.',
      );
      await expect(manager.send(session.id, 'fix the file')).rejects.toThrow(/replace_lines/);
      await new Promise((r) => setTimeout(r, 150));
      expect(frontierMock.calls.filter((c) => c.kind === 'send')).toHaveLength(0);

      // Second abort on the same session: the guard's recovery has
      // demonstrably failed — trigger 5 consults and re-drives.
      localMock.scriptSendFailure(
        '[llama-cpp] direct file-work turn ended without a successful workspace mutation after 2 corrective nudge(s).',
      );
      frontierMock.script(VERDICT_REPLY);
      localMock.script('Rewrote the file whole; the deliverable is in place.');
      await expect(manager.send(session.id, 'try again')).rejects.toThrow(/file-work/);

      const caseStore = new KeurmeesterCaseStore(home);
      let cases = await caseStore.read();
      for (
        let i = 0;
        i < 100 && cases.filter((c) => c.record === 'case.closed').length === 0;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
        cases = await caseStore.read();
      }
      const opened = cases.find((c) => c.record === 'case.opened');
      expect(opened && opened.record === 'case.opened' && opened.trigger).toBe('turn_aborted');
      expect(
        opened &&
          opened.record === 'case.opened' &&
          (opened.signals as { consecutiveAborts?: boolean }).consecutiveAborts,
      ).toBe(true);
      const closed = cases.find((c) => c.record === 'case.closed');
      expect(closed && closed.record === 'case.closed' && closed.outcome).toBe('unblocked');
    },
  );

  it('never consults on consecutive transport-class aborts', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    localMock.scriptSendFailure('connect ECONNREFUSED 127.0.0.1:8080');
    await expect(manager.send(session.id, 'build')).rejects.toThrow();
    localMock.scriptSendFailure('connect ECONNREFUSED 127.0.0.1:8080');
    await expect(manager.send(session.id, 'build again')).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(frontierMock.calls.filter((c) => c.kind === 'send')).toHaveLength(0);
    expect(await new KeurmeesterCaseStore(home).read()).toHaveLength(0);
  });

  it('closes the case as gave_up when the granted continuation also stalls', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    for (let i = 0; i < STALLED_TURNS; i++) localMock.script('');
    frontierMock.script(VERDICT_REPLY);
    localMock.script(''); // the recovery turn stalls too

    await manager.send(session.id, 'review my code');

    const cases = await new KeurmeesterCaseStore(home).read();
    const closed = cases.find((c) => c.record === 'case.closed');
    expect(closed && closed.record === 'case.closed' && closed.outcome).toBe('gave_up');
    // One consult only — the failed recovery turn must not re-summon
    // the inspector within the same send.
    expect(frontierMock.calls.filter((c) => c.kind === 'send')).toHaveLength(1);
  });
});
