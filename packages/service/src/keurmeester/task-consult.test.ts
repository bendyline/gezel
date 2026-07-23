import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docFromCraftbook, serializeCraftbookDoc } from '@bendyline/gezel';
import type { Craftbook } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskScheduler } from '../tasks/scheduler.js';
import { KeurmeesterManager } from './manager.js';

/**
 * Phase 2/3 coverage: task-level triggers (stuck-step redrive
 * exhaustion, completion-gate exhaustion), rewrite application through
 * the real TaskManager, outcome tracking, and the bounded takeover
 * ladder — all with a scripted frontier consult and a fake chat port.
 */

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;
let events: ChatEventBus;
let km: KeurmeesterManager;
let oneShotReplies: string[];
let oneShotCalls: string[];
let messaged: Array<{ from: string; to: string; text: string }>;
let takeoverSends: string[];
let onTakeoverSend: (() => Promise<void>) | undefined;

const NOW = new Date('2026-05-01T12:00:00Z');

function verdictJson(action: Record<string, unknown>, diagnosis = 'the step defeats the model') {
  return JSON.stringify({
    diagnosis,
    failureClass: 'task_shape',
    action,
    confidence: 'high',
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-keurm-task-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'Cron' });
  await store.createGezel({ name: 'Freja', role: 'Developer' });
  // Assignee runs on a local tiny-tier model; the consult target is a
  // pinned cloud provider. cooldownMs=1 so sequential consults in one
  // test don't trip the cooldown.
  await store.writeConfig({
    provider: 'mlx',
    keurmeester: { enabled: true, providerName: 'openai', model: 'gpt-test', cooldownMs: 1 },
  });
  tasks = new TaskManager(store, history);
  events = new ChatEventBus();
  oneShotReplies = [];
  oneShotCalls = [];
  messaged = [];
  takeoverSends = [];
  onTakeoverSend = undefined;
  km = new KeurmeesterManager({
    store,
    history,
    events,
    home,
    oneShot: async (prompt) => {
      oneShotCalls.push(prompt);
      const reply = oneShotReplies.shift();
      if (reply === undefined) throw new Error('no scripted one-shot reply');
      return reply;
    },
  });
  km.setTasks(tasks);
  km.setChat({
    messageGezel: async (args) => {
      messaged.push({ from: args.fromGezelId, to: args.toGezelIdOrName, text: args.text });
      return {
        sessionId: 'assignee-session',
        toGezelName: args.toGezelIdOrName,
        toGezelId: args.toGezelIdOrName,
      };
    },
    ensureOrCreateSession: async () => ({ id: 'keurmeester-session' }),
    send: async (_sessionId, text) => {
      takeoverSends.push(text);
      await onTakeoverSend?.();
      return {};
    },
  });
  tasks.setKeurmeester(km);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Active task in project `cron` whose entry step is stalled at the
 * redrive budget, with a deliverable spec + completion gate. */
async function makeExhaustedTask(opts: { redriveCount?: number; gateMaxAttempts?: number } = {}) {
  const created = await tasks.create('cron', {
    title: 'Threat model',
    assignee: { kind: 'gezel', gezelId: 'freja' },
    steps: [{ name: 'Scope' }, { name: 'Done' }],
  });
  const rec = await store.readTask('cron', created.num);
  const entryStepId = rec!.craftbook.steps[0]!.id;
  const nextStepId = rec!.craftbook.steps[1]!.id;
  const steps = rec!.craftbook.steps.map((s, i) =>
    i === 0
      ? {
          ...s,
          advanceWhen: { file: 'notes/scope.md', minBytes: 1, sniff: 'nonempty' as const },
          gate: {
            at: 'completion' as const,
            checks: [{ kind: 'minBytes' as const, file: 'notes/scope.md', bytes: 120 }],
            onReject: entryStepId,
            maxAttempts: opts.gateMaxAttempts ?? 3,
          },
          lastActivatedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
          ...(opts.redriveCount !== undefined ? { redriveCount: opts.redriveCount } : {}),
        }
      : s,
  );
  await store.writeTask({
    ...rec!,
    craftbook: { ...rec!.craftbook, steps },
    activeStepId: entryStepId,
  });
  return { num: created.num, ref: rec!.ref, entryStepId, nextStepId };
}

function makeScheduler(): TaskScheduler {
  const chatStub = {
    isProjectActive: () => false,
    isGezelActive: () => false,
    messageGezel: async () => ({ sessionId: 'x', toGezelName: 'x', toGezelId: 'x' }),
  };
  const scheduler = new TaskScheduler({
    manager: tasks,
    chat: chatStub as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
    store,
    now: () => NOW,
  });
  scheduler.setKeurmeester(km);
  return scheduler;
}

describe('step_redrive_exhausted trigger (scheduler sweep)', () => {
  it('applies a rewrite_step verdict: craftbook patched, budget reset, task stays active', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({
        kind: 'rewrite_step',
        stepId: entryStepId,
        prompt:
          'Write notes/scope.md with exactly three bullet points: assets, threats, mitigations.',
        deliverable: 'notes/scope.md',
      }),
    );

    await makeScheduler().sweepStuckSteps();

    const rec = await store.readTask('cron', num);
    expect(rec!.status).toBe('active');
    const step = rec!.craftbook.steps.find((s) => s.id === entryStepId)!;
    expect(step.prompt).toContain('exactly three bullet points');
    expect(step.advanceWhen?.file).toBe('notes/scope.md');
    // One more re-drive window: maxRedrives(3) - 1.
    expect(step.redriveCount).toBe(2);
    // Handback note reached the assignee, from the minted keurmeester.
    expect(messaged).toHaveLength(1);
    expect(messaged[0]!.to).toBe('freja');
    expect(messaged[0]!.text).toContain('rewrote its instructions');
    // Case recorded as applied.
    const cases = await km.cases.read();
    const opened = cases.find((c) => c.record === 'case.opened');
    expect(opened && opened.record === 'case.opened' && opened.applied).toBe(true);
    expect(opened && opened.record === 'case.opened' && opened.trigger).toBe(
      'step_redrive_exhausted',
    );
  });

  it('closes the case as unblocked when the step later advances', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({ kind: 'rewrite_step', stepId: entryStepId, prompt: 'Write the file now.' }),
    );
    await makeScheduler().sweepStuckSteps();

    // The (rewritten) step now produces its deliverable and advances.
    await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'x'.repeat(200));
    await tasks.completeStepChecked('cron', num, entryStepId, undefined, { cause: 'auto' });

    const cases = await km.cases.read();
    const closed = cases.find((c) => c.record === 'case.closed');
    expect(closed && closed.record === 'case.closed' && closed.outcome).toBe('unblocked');
  });

  it('pauses as before on stand_down', async () => {
    const { num } = await makeExhaustedTask({ redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({ kind: 'stand_down', reason: 'the user must decide' }, 'not a model problem'),
    );
    await makeScheduler().sweepStuckSteps();
    const rec = await store.readTask('cron', num);
    expect(rec!.status).toBe('paused');
    const cases = await km.cases.read();
    const opened = cases.find((c) => c.record === 'case.opened');
    expect(opened && opened.record === 'case.opened' && opened.applied).toBe(false);
  });

  it('applies a rewrite_craftbook verdict after one document repair retry', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    // Build a valid replacement document from the live craftbook with a
    // sharper step prompt, then script: verdict carrying a BROKEN
    // document → repair retry returns the valid one.
    const rec = await store.readTask('cron', num);
    const doc = docFromCraftbook(rec!.craftbook as unknown as Craftbook);
    const revised = {
      ...doc,
      steps: doc.steps.map((s) =>
        s.id === entryStepId ? { ...s, prompt: 'One file, notes/scope.md, three bullets.' } : s,
      ),
    };
    const validDocument = serializeCraftbookDoc(revised, 'markdown');
    oneShotReplies.push(
      verdictJson({
        kind: 'rewrite_craftbook',
        document: 'this is not a craftbook document at all',
        rationale: 'decompose the scope step',
      }),
      validDocument,
    );

    await makeScheduler().sweepStuckSteps();

    expect(oneShotCalls).toHaveLength(2);
    expect(oneShotCalls[1]).toContain('rejected by validation');
    const updated = await store.readTask('cron', num);
    expect(updated!.status).toBe('active');
    const step = updated!.craftbook.steps.find((s) => s.id === entryStepId)!;
    expect(step.prompt).toContain('three bullets');
    expect(messaged[0]!.text).toContain('reshaped the craftbook');
  });

  it('closes a superseded case as re_triggered when the same step consults again', async () => {
    const { entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({ kind: 'rewrite_step', stepId: entryStepId, prompt: 'Attempt one.' }),
    );
    await makeScheduler().sweepStuckSteps();

    // The rewrite didn't stick: the step exhausts its budget again.
    const rec = (await tasks.list({ projectId: 'cron', status: 'active' }))[0]!;
    await tasks.resetStepRecoveryBudget('cron', rec.num, entryStepId, { redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({ kind: 'corrective_prompt', prompt: 'Just write the file, nothing else.' }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await makeScheduler().sweepStuckSteps();

    const cases = await km.cases.read();
    const closed = cases.filter((c) => c.record === 'case.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.record === 'case.closed' && closed[0]!.outcome).toBe('re_triggered');
    expect(cases.filter((c) => c.record === 'case.opened')).toHaveLength(2);
  });

  it('enforces the per-task consult budget', async () => {
    const { entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    await store.writeConfig({
      keurmeester: {
        enabled: true,
        providerName: 'openai',
        cooldownMs: 1,
        maxConsultsPerTask: 1,
      },
    });
    oneShotReplies.push(
      verdictJson({ kind: 'rewrite_step', stepId: entryStepId, prompt: 'Attempt one.' }),
    );
    await makeScheduler().sweepStuckSteps();
    expect(oneShotCalls).toHaveLength(1);

    const rec = (await tasks.list({ projectId: 'cron' }))[0]!;
    await tasks.resetStepRecoveryBudget('cron', rec.num, entryStepId, { redriveCount: 3 });
    await new Promise((r) => setTimeout(r, 5));
    await makeScheduler().sweepStuckSteps();
    // Budget spent → no second consult; the task paused instead.
    expect(oneShotCalls).toHaveLength(1);
    expect((await store.readTask('cron', rec.num))!.status).toBe('paused');
  });
});

describe('gate_exhausted trigger (completion gate)', () => {
  it('keeps the task active with a fresh gate budget on an applied consult', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ gateMaxAttempts: 1 });
    // Deliverable exists (passes advanceWhen) but is under the gate's
    // 120-byte floor — the single allowed attempt exhausts immediately.
    await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'too short');
    oneShotReplies.push(
      verdictJson({
        kind: 'corrective_prompt',
        prompt: 'The gate needs 120+ bytes: expand notes/scope.md with one paragraph per threat.',
      }),
    );

    const outcome = await tasks.completeStepChecked('cron', num, entryStepId, undefined, {
      cause: 'auto',
    });

    expect(outcome.status).toBe('held');
    const rec = await store.readTask('cron', num);
    expect(rec!.status).toBe('active');
    const step = rec!.craftbook.steps.find((s) => s.id === entryStepId)!;
    expect(step.gateAttempts).toBeUndefined();
    expect(messaged).toHaveLength(1);
    expect(messaged[0]!.text).toContain('120+ bytes');
    const cases = await km.cases.read();
    const opened = cases.find((c) => c.record === 'case.opened');
    expect(opened && opened.record === 'case.opened' && opened.trigger).toBe('gate_exhausted');
  });

  it('pauses as before when the consult stands down', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ gateMaxAttempts: 1 });
    await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'too short');
    oneShotReplies.push(verdictJson({ kind: 'stand_down', reason: 'gate criteria are wrong' }));

    await tasks.completeStepChecked('cron', num, entryStepId, undefined, { cause: 'auto' });

    expect((await store.readTask('cron', num))!.status).toBe('paused');
  });
});

describe('deliverable_plateau trigger (gate-escalation stage 3)', () => {
  it('consults on a frozen-resubmit plateau and resets the ladder on an applied verdict', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ gateMaxAttempts: 10 });
    // Deliverable passes advanceWhen (minBytes 1) but fails the gate's
    // 120-byte floor — and never changes, so resubmits 2-4 route through
    // the frozen-resubmit branch and climb the ladder to stage 3.
    await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'too short');
    oneShotReplies.push(
      verdictJson({
        kind: 'corrective_prompt',
        prompt: 'The gate wants 120+ bytes. Append one paragraph per threat to notes/scope.md.',
      }),
    );

    for (let i = 0; i < 4; i++) {
      await tasks.completeStepChecked('cron', num, entryStepId, undefined, { cause: 'auto' });
    }

    // Stages 0-2 consumed no consults; stage 3 consumed exactly one.
    expect(oneShotCalls).toHaveLength(1);
    const cases = await km.cases.read();
    const opened = cases.find((c) => c.record === 'case.opened');
    expect(opened && opened.record === 'case.opened' && opened.trigger).toBe('deliverable_plateau');
    expect(opened && opened.record === 'case.opened' && opened.applied).toBe(true);
    // Applied verdict: task stays active with a FULLY fresh ladder
    // (attempts + trail), so the next reject starts at stage 0.
    const rec = await store.readTask('cron', num);
    expect(rec!.status).toBe('active');
    const step = rec!.craftbook.steps.find((s) => s.id === entryStepId)!;
    expect(step.gateAttempts).toBeUndefined();
    expect(step.gateAttemptHistory).toBeUndefined();
    // The corrective prompt reached the assignee.
    expect(messaged.some((m) => m.text.includes('120+ bytes'))).toBe(true);
  });

  it('consults on a content-churning plateau (same failing checks, changing bytes) before the attempt budget', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ gateMaxAttempts: 10 });
    oneShotReplies.push(
      verdictJson({ kind: 'stand_down', reason: 'the gate criteria themselves look wrong' }),
    );

    // Four rejects with DIFFERENT content each time — the busy rewrite
    // rathole: bytes churn, the failing-check signature never moves.
    for (let i = 0; i < 4; i++) {
      await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', `too short v${i}`);
      await tasks.completeStepChecked('cron', num, entryStepId, undefined, { cause: 'auto' });
    }

    expect(oneShotCalls).toHaveLength(1);
    const cases = await km.cases.read();
    const opened = cases.find((c) => c.record === 'case.opened');
    expect(opened && opened.record === 'case.opened' && opened.trigger).toBe('deliverable_plateau');
    // stand_down → the stage-3 pause proceeds exactly as before.
    expect(opened && opened.record === 'case.opened' && opened.applied).toBe(false);
    expect((await store.readTask('cron', num))!.status).toBe('paused');
  });
});

describe('takeover ladder (Phase 3)', () => {
  it('offers takeover only after an applied consult on the step, executes it, and verifies through the gate', async () => {
    const { num, entryStepId, nextStepId } = await makeExhaustedTask({ redriveCount: 3 });

    // Rung 1: corrective prompt (marks the step as already-consulted).
    oneShotReplies.push(
      verdictJson({ kind: 'corrective_prompt', prompt: 'Write notes/scope.md now.' }),
    );
    await makeScheduler().sweepStuckSteps();
    expect(oneShotCalls[0]).not.toContain('takeover_step');

    // Rung 2: still stuck → takeover now offered; the verdict takes it.
    // The takeover turn (fake send) writes a gate-passing deliverable.
    const rec = (await tasks.list({ projectId: 'cron' }))[0]!;
    await tasks.resetStepRecoveryBudget('cron', rec.num, entryStepId, { redriveCount: 3 });
    onTakeoverSend = async () => {
      await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'x'.repeat(200));
    };
    oneShotReplies.push(
      verdictJson({
        kind: 'takeover_step',
        instruction: 'Create notes/scope.md with the full threat model yourself.',
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await makeScheduler().sweepStuckSteps();

    expect(oneShotCalls[1]).toContain('takeover_step');
    expect(takeoverSends).toHaveLength(1);
    expect(takeoverSends[0]).toContain('taking over ONE failing step');
    // Verified through the task's own machinery: step advanced.
    const updated = await store.readTask('cron', num);
    expect(updated!.activeStepId).toBe(nextStepId);
    expect(updated!.status).toBe('active');
    // Handback note + takeover_completed outcome.
    expect(messaged.some((m) => m.text.includes('completed the step'))).toBe(true);
    const cases = await km.cases.read();
    const closed = cases.filter((c) => c.record === 'case.closed');
    expect(
      closed.some((c) => c.record === 'case.closed' && c.outcome === 'takeover_completed'),
    ).toBe(true);
  });

  it('marks a takeover that produces no deliverable as takeover_failed and pauses', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({ kind: 'corrective_prompt', prompt: 'Write notes/scope.md now.' }),
    );
    await makeScheduler().sweepStuckSteps();

    await tasks.resetStepRecoveryBudget('cron', num, entryStepId, { redriveCount: 3 });
    // Takeover turn does nothing — the deliverable never appears.
    oneShotReplies.push(
      verdictJson({ kind: 'takeover_step', instruction: 'Create the file yourself.' }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await makeScheduler().sweepStuckSteps();

    const cases = await km.cases.read();
    expect(cases.some((c) => c.record === 'case.closed' && c.outcome === 'takeover_failed')).toBe(
      true,
    );
    // The whole ladder is spent — paused for a human.
    expect((await store.readTask('cron', num))!.status).toBe('paused');
  });

  it('refuses a second takeover on the same step (cap 1/step)', async () => {
    const { num, entryStepId } = await makeExhaustedTask({ redriveCount: 3 });
    oneShotReplies.push(
      verdictJson({ kind: 'corrective_prompt', prompt: 'Write notes/scope.md now.' }),
    );
    await makeScheduler().sweepStuckSteps();

    // First takeover fails (no deliverable) — pauses the task.
    await tasks.resetStepRecoveryBudget('cron', num, entryStepId, { redriveCount: 3 });
    oneShotReplies.push(verdictJson({ kind: 'takeover_step', instruction: 'Do it.' }));
    await new Promise((r) => setTimeout(r, 5));
    await makeScheduler().sweepStuckSteps();

    // Re-activate and exhaust again: takeover no longer offered, and an
    // improvised takeover verdict is downgraded to stand_down.
    await tasks.setStatus('cron', num, 'active');
    await tasks.resetStepRecoveryBudget('cron', num, entryStepId, { redriveCount: 3 });
    oneShotReplies.push(verdictJson({ kind: 'takeover_step', instruction: 'Again.' }));
    await new Promise((r) => setTimeout(r, 5));
    await makeScheduler().sweepStuckSteps();

    expect(oneShotCalls).toHaveLength(3);
    expect(oneShotCalls[2]).not.toContain('takeover_step');
    expect(takeoverSends).toHaveLength(1);
    const cases = await km.cases.read();
    const opened = cases.filter((c) => c.record === 'case.opened');
    expect(opened[2]!.record === 'case.opened' && opened[2]!.applied).toBe(false);
  });
});
