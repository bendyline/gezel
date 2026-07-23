import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEventEnvelope } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { KeurmeesterManager, parseVerdict } from './manager.js';

const VALID_VERDICT_JSON = JSON.stringify({
  diagnosis: 'The model finished reasoning but never emitted the writeFile call.',
  failureClass: 'silent_stall',
  action: {
    kind: 'corrective_prompt',
    prompt: 'Stop reading. Call writeFile for review.md now.',
  },
  confidence: 'high',
});

describe('parseVerdict', () => {
  it('parses a fenced json block', () => {
    const verdict = parseVerdict(`Here you go:\n\`\`\`json\n${VALID_VERDICT_JSON}\n\`\`\`\n`);
    expect(verdict.failureClass).toBe('silent_stall');
  });

  it('parses a bare json object', () => {
    expect(parseVerdict(VALID_VERDICT_JSON).confidence).toBe('high');
  });

  it('parses json embedded in prose', () => {
    const verdict = parseVerdict(`My verdict follows.\n${VALID_VERDICT_JSON}\nDone.`);
    expect(verdict.action.kind).toBe('corrective_prompt');
  });

  it('throws on unparseable input', () => {
    expect(() => parseVerdict('I think the model is just tired.')).toThrow();
  });

  it('throws on valid json that fails the schema', () => {
    expect(() => parseVerdict('{"diagnosis":"x"}')).toThrow();
  });
});

describe('KeurmeesterManager', () => {
  let home: string;
  let store: Store;
  let history: HistoryManager;
  let events: ChatEventBus;
  let oneShotReplies: string[];
  let oneShotCalls: Array<{ prompt: string; opts: Record<string, unknown> }>;
  let manager: KeurmeesterManager;

  const baseCtx = () => ({
    trigger: 'nudge_budget_exhausted' as const,
    triggerSummary: 'turn still stalled after 4/4 nudges',
    sessionId: 'sess-1',
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'mlx',
    model: 'test-2b',
    modelTier: 'tiny',
    transcript: [
      { role: 'user', content: 'write the review' },
      { role: 'assistant', content: '' },
    ],
    toolTrace: ['readFile(review-notes.md) → ok'],
    signals: { continuations: 4, maxContinuations: 4, toolCallsThisTurn: 0 },
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-keurm-'));
    store = new Store({ home });
    await store.ensureLayout();
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createProject({ name: 'Default' });
    history = new HistoryManager(home);
    events = new ChatEventBus();
    oneShotReplies = [];
    oneShotCalls = [];
    manager = new KeurmeesterManager({
      store,
      history,
      events,
      home,
      oneShot: async (prompt, _timeoutMs, opts) => {
        oneShotCalls.push({ prompt, opts: opts as Record<string, unknown> });
        const reply = oneShotReplies.shift();
        if (reply === undefined) throw new Error('no scripted one-shot reply');
        return reply;
      },
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('does nothing when supervision is not enabled', async () => {
    expect(await manager.shouldConsult(baseCtx())).toBe(false);
  });

  it('skips non-local providers and non-at-risk tiers', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    expect(await manager.shouldConsult({ ...baseCtx(), providerName: 'openai' })).toBe(false);
    expect(await manager.shouldConsult({ ...baseCtx(), modelTier: 'medium' })).toBe(false);
  });

  it('refuses a local provider as the consult target', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'ollama' } });
    expect(await manager.shouldConsult(baseCtx())).toBe(false);
  });

  it('no-ops when enabled but no frontier target is configured', async () => {
    await store.writeConfig({ keurmeester: { enabled: true } });
    expect(await manager.shouldConsult(baseCtx())).toBe(false);
  });

  it('resolves the config-pinned frontier target', async () => {
    await store.writeConfig({
      keurmeester: { enabled: true, providerName: 'openai', model: 'gpt-test' },
    });
    expect(await manager.shouldConsult(baseCtx())).toEqual({
      providerName: 'openai',
      model: 'gpt-test',
    });
  });

  it('never supervises the keurmeester itself', async () => {
    const created = await store.createFreshKeurmeester('Berend');
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    expect(await manager.shouldConsult({ ...baseCtx(), gezelId: created.id })).toBe(false);
  });

  it('runs a full consult: mints the gezel, applies the prompt, records everything', async () => {
    await store.writeConfig({
      keurmeester: { enabled: true, providerName: 'openai', model: 'gpt-test' },
    });
    oneShotReplies.push(`\`\`\`json\n${VALID_VERDICT_JSON}\n\`\`\``);
    const published: ChatEventEnvelope[] = [];
    events.subscribeAll((envelope) => published.push(envelope));

    const result = await manager.consultChatStall(baseCtx());
    expect(result).toBeTruthy();
    expect(result!.correctivePrompt).toContain('writeFile');
    expect(result!.keurmeesterName).toBeTruthy();

    // Lazy mint: pointer now set, gezel exists with the inspector role.
    const config = await store.readConfig();
    expect(config.keurmeesterGezelId).toBeTruthy();
    const minted = await store.getGezel(config.keurmeesterGezelId!);
    expect(minted?.parsed.frontmatter.role).toBe('Keurmeester');

    // Consult ran on the pinned frontier target through the persona lane.
    expect(oneShotCalls).toHaveLength(1);
    expect(oneShotCalls[0]!.opts.providerName).toBe('openai');
    expect(oneShotCalls[0]!.opts.model).toBe('gpt-test');
    expect(oneShotCalls[0]!.opts.useKeurmeester).toBe(true);

    // Case record on disk.
    const cases = await manager.cases.read();
    expect(cases).toHaveLength(1);
    const opened = cases[0]!;
    expect(opened.record).toBe('case.opened');
    if (opened.record === 'case.opened') {
      expect(opened.applied).toBe(true);
      expect(opened.verdict?.action.kind).toBe('corrective_prompt');
      expect(opened.consultProviderName).toBe('openai');
      // debugMode off → no raw payloads persisted.
      expect(opened.debug).toBeUndefined();
    }

    // History event + SSE event.
    const historyEvents = await history.listEvents({ kinds: ['keurmeester.intervention'] });
    expect(historyEvents).toHaveLength(1);
    const sse = published.filter((p) => p.event.type === 'keurmeester_intervention');
    expect(sse).toHaveLength(1);

    // Cooldown: an immediate second consult on the same session is refused.
    expect(await manager.shouldConsult(baseCtx())).toBe(false);
  });

  it('persists debug payloads when debugMode is on', async () => {
    await store.writeConfig({
      debugMode: true,
      keurmeester: { enabled: true, providerName: 'openai' },
    });
    oneShotReplies.push(VALID_VERDICT_JSON);
    await manager.consultChatStall(baseCtx());
    const cases = await manager.cases.read();
    const opened = cases[0]!;
    if (opened.record === 'case.opened') {
      expect(opened.debug?.prompt).toContain('struggling journeyman');
      expect(opened.debug?.rawResponse).toContain('silent_stall');
    }
  });

  it('repairs an unparseable first reply with one retry', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    oneShotReplies.push('The journeyman seems stuck, poor fellow.', VALID_VERDICT_JSON);
    const result = await manager.consultChatStall(baseCtx());
    expect(result?.correctivePrompt).toBeTruthy();
    expect(oneShotCalls).toHaveLength(2);
    expect(oneShotCalls[1]!.prompt).toContain('could not be parsed');
  });

  it('records a verdict-less case when both replies fail to parse', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    oneShotReplies.push('nope', 'still nope');
    const result = await manager.consultChatStall(baseCtx());
    expect(result).toBeNull();
    const cases = await manager.cases.read();
    expect(cases).toHaveLength(1);
    const opened = cases[0]!;
    if (opened.record === 'case.opened') {
      expect(opened.verdict).toBeUndefined();
      expect(opened.applied).toBe(false);
    }
  });

  it('returns no corrective prompt on stand_down', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    oneShotReplies.push(
      JSON.stringify({
        diagnosis: 'The daemon lost its network connection; not a model failure.',
        failureClass: 'unknown',
        action: { kind: 'stand_down', reason: 'infrastructure failure' },
        confidence: 'medium',
      }),
    );
    const result = await manager.consultChatStall(baseCtx());
    expect(result).toBeTruthy();
    expect(result!.correctivePrompt).toBeUndefined();
  });

  it('downgrades not-yet-appliable actions to stand_down', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    oneShotReplies.push(
      JSON.stringify({
        diagnosis: 'The task shape defeats the model.',
        failureClass: 'task_shape',
        action: { kind: 'takeover_step', instruction: 'do the step' },
        confidence: 'high',
      }),
    );
    const result = await manager.consultChatStall(baseCtx());
    expect(result).toBeTruthy();
    expect(result!.correctivePrompt).toBeUndefined();
    const cases = await manager.cases.read();
    const opened = cases[0]!;
    if (opened.record === 'case.opened') {
      expect(opened.applied).toBe(false);
      expect(opened.verdict?.action.kind).toBe('takeover_step');
    }
  });

  it('enforces the per-session consult budget', async () => {
    await store.writeConfig({
      keurmeester: {
        enabled: true,
        providerName: 'openai',
        maxConsultsPerSession: 2,
        cooldownMs: 1,
      },
    });
    oneShotReplies.push(VALID_VERDICT_JSON, VALID_VERDICT_JSON);
    expect(await manager.consultChatStall(baseCtx())).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    expect(await manager.consultChatStall(baseCtx())).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    // Third consult: budget of 2 is spent, regardless of cooldown.
    expect(await manager.consultChatStall(baseCtx())).toBeNull();
    expect(oneShotCalls).toHaveLength(2);
  });

  it('closes a case with an outcome record', async () => {
    await store.writeConfig({ keurmeester: { enabled: true, providerName: 'openai' } });
    oneShotReplies.push(VALID_VERDICT_JSON);
    const result = await manager.consultChatStall(baseCtx());
    await manager.closeCase(result!.caseId, 'unblocked', 1);
    const cases = await manager.cases.read();
    expect(cases).toHaveLength(2);
    const closed = cases.find((c) => c.record === 'case.closed');
    expect(closed && closed.record === 'case.closed' && closed.outcome).toBe('unblocked');
  });
});
