import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keurmeesterDigestsDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { KeurmeesterCaseStore } from './case-store.js';
import { KeurmeesterDigestGenerator, aggregateCases } from './digest.js';

let home: string;
let store: Store;
let history: HistoryManager;
let cases: KeurmeesterCaseStore;
let oneShotReplies: string[];
let oneShotCalls: string[];

function makeGenerator(now: string): KeurmeesterDigestGenerator {
  return new KeurmeesterDigestGenerator({
    store,
    history,
    home,
    now: () => new Date(now),
    oneShot: async (prompt) => {
      oneShotCalls.push(prompt);
      const reply = oneShotReplies.shift();
      if (reply === undefined) throw new Error('no scripted digest reply');
      return reply;
    },
  });
}

async function seedCase(opts: {
  ts: string;
  action?: string;
  outcome?: string;
  taskRef?: string;
  failed?: boolean;
}): Promise<void> {
  const caseId = `kc-${opts.ts}`;
  await cases.append({
    record: 'case.opened',
    caseId,
    ts: opts.ts,
    trigger: 'step_redrive_exhausted',
    gezelId: 'freja',
    projectId: 'cron',
    ...(opts.taskRef ? { taskRef: opts.taskRef } : {}),
    providerName: 'mlx',
    model: 'test-2b',
    modelTier: 'tiny',
    consultProviderName: 'openai',
    signals: {},
    ...(opts.failed
      ? {}
      : {
          verdict: {
            diagnosis: 'the step defeats the model',
            failureClass: 'task_shape',
            action:
              opts.action === 'rewrite_step'
                ? { kind: 'rewrite_step', stepId: 's1', prompt: 'do it' }
                : { kind: 'corrective_prompt', prompt: 'do it' },
            confidence: 'high',
          },
        }),
    applied: !opts.failed,
    consultDurationMs: 5000,
    promptChars: 4000,
    responseChars: 300,
  });
  if (opts.outcome) {
    await cases.append({
      record: 'case.closed',
      caseId,
      ts: opts.ts,
      outcome: opts.outcome as never,
      turnsObserved: 1,
    });
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-keurm-digest-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.writeConfig({
    keurmeester: { enabled: true, providerName: 'openai', model: 'gpt-test' },
  });
  cases = new KeurmeesterCaseStore(home);
  oneShotReplies = [];
  oneShotCalls = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('aggregateCases', () => {
  it('groups by trigger/action/outcome and finds repeat offenders', async () => {
    await seedCase({ ts: '2026-07-01T10:00:00.000Z', outcome: 'unblocked', taskRef: 'cron/1' });
    await seedCase({ ts: '2026-07-01T11:00:00.000Z', outcome: 'gave_up', taskRef: 'cron/1' });
    await seedCase({ ts: '2026-07-01T12:00:00.000Z', taskRef: 'cron/2', failed: true });
    const stats = aggregateCases(await cases.read());
    expect(stats.consults).toBe(3);
    expect(stats.applied).toBe(2);
    expect(stats.actions.corrective_prompt).toBe(2);
    expect(stats.actions.consult_failed).toBe(1);
    expect(stats.outcomes.unblocked).toBe(1);
    expect(stats.unblockedRate).toBe('50%');
    expect(stats.repeatOffenders).toEqual([{ taskRef: 'cron/1', consults: 2 }]);
    expect(stats.promptBlock).toContain('cron/1 (2×)');
  });
});

describe('KeurmeesterDigestGenerator', () => {
  it('writes a digest with recommendations and logs history', async () => {
    await seedCase({ ts: '2026-07-05T10:00:00.000Z', outcome: 'unblocked', taskRef: 'cron/1' });
    oneShotReplies.push('Tighten the scope step: one deliverable per step.');

    const wrote = await makeGenerator('2026-07-06T09:00:00.000Z').sweep();
    expect(wrote).toBe(true);

    const files = await readdir(keurmeesterDigestsDir(home));
    expect(files).toEqual(['2026-07-06.md']);
    const digest = await readFile(join(keurmeesterDigestsDir(home), '2026-07-06.md'), 'utf8');
    expect(digest).toContain('Keurmeester digest — 2026-07-06');
    expect(digest).toContain('Systemic recommendations');
    expect(digest).toContain('Tighten the scope step');
    expect(oneShotCalls[0]).toContain('RECOMMENDATIONS');

    const events = await history.listEvents({ kinds: ['keurmeester.digest.generated'] });
    expect(events).toHaveLength(1);
  });

  it('is a no-op with no new cases, and idempotent across sweeps', async () => {
    expect(await makeGenerator('2026-07-06T09:00:00.000Z').sweep()).toBe(false);

    await seedCase({ ts: '2026-07-05T10:00:00.000Z', outcome: 'unblocked' });
    oneShotReplies.push('Recommendation.');
    expect(await makeGenerator('2026-07-06T09:00:00.000Z').sweep()).toBe(true);
    // Second sweep, no new cases since the state watermark → no digest,
    // no LLM call.
    expect(await makeGenerator('2026-07-07T09:00:00.000Z').sweep()).toBe(false);
    expect(oneShotCalls).toHaveLength(1);

    // A new case after the watermark rolls a fresh digest.
    await seedCase({ ts: '2026-07-07T08:00:00.000Z', outcome: 'gave_up' });
    oneShotReplies.push('Another recommendation.');
    expect(await makeGenerator('2026-07-07T09:00:00.000Z').sweep()).toBe(true);
    const files = await readdir(keurmeesterDigestsDir(home));
    expect(files.sort()).toEqual(['2026-07-06.md', '2026-07-07.md']);
  });

  it('writes a stats-only digest when no frontier target is configured', async () => {
    await store.writeConfig({ debugMode: true, keurmeester: null as never });
    await seedCase({ ts: '2026-07-05T10:00:00.000Z' });

    expect(await makeGenerator('2026-07-06T09:00:00.000Z').sweep()).toBe(true);
    expect(oneShotCalls).toHaveLength(0);
    const digest = await readFile(join(keurmeesterDigestsDir(home), '2026-07-06.md'), 'utf8');
    expect(digest).toContain('stats-only digest');
  });

  it('respects the enabled/debugMode gate', async () => {
    await store.writeConfig({ keurmeester: null as never });
    await seedCase({ ts: '2026-07-05T10:00:00.000Z' });
    expect(await makeGenerator('2026-07-06T09:00:00.000Z').sweep()).toBe(false);
  });
});
