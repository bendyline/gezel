import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskManager } from './manager.js';
import { type RuntimeActivationDeps, runSpawnFanout } from './runtime-activation.js';

/**
 * invoice-run's evaluate → draft loop through the real TaskManager and the
 * runtime fanout: a rejection after the crew settled re-drafts every item
 * with the review's findings, and the gate's maxAttempts still ends the loop.
 */

let home: string;
let store: Store;
let tasks: TaskManager;

const BILLABLES = [
  { client: 'Harbor & Pine Architects', number: '2026-042', rate: '1840.00' },
  { client: 'Kestrel Coffee Roasters', number: '2026-043', rate: '2600.00' },
];
const FAILING_VERDICT =
  'One invoice per billable client. PASS\nEvery amount traces to a ledger entry. FAIL\n  2026-043 bills 2,060.00; the ledger says 2,600.00\n';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-fanout-revision-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
  tasks = new TaskManager(store);
  const deps: RuntimeActivationDeps = {
    store,
    tasks,
    scriptRunner: {
      run: async () => 'skipped',
    } as unknown as RuntimeActivationDeps['scriptRunner'],
    history: { log: async () => {} } as unknown as RuntimeActivationDeps['history'],
  };
  tasks.setStepActivatedHook(async ({ projectId, task, newStep }) => {
    await runSpawnFanout(deps, { projectId, task, newStep });
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function invoiceRunHost(): Promise<Task> {
  const created = await tasks.create('default', {
    title: 'Monthly Invoice Run',
    description: 'A spawn host whose reviewer can send the invoices back.',
    assignee: { kind: 'user' },
    steps: [
      { id: 'scope', name: 'Scope the run', next: 'draft' },
      {
        id: 'draft',
        name: 'Draft the invoices',
        spawnFanout: true,
        advanceWhen: { file: 'tasks/1/draft.md', artifact: true },
        next: 'collect',
      },
      { id: 'collect', name: 'Collect and summarize', next: 'evaluate' },
      {
        id: 'evaluate',
        name: 'Evaluate',
        advanceWhen: { file: 'tasks/1/verdict.md', artifact: true },
        gate: {
          at: 'completion',
          checks: [
            {
              kind: 'notContains',
              file: 'tasks/1/verdict.md',
              pattern: '\\bFAIL\\s*$',
              flags: 'm',
              label: 'no criterion line ends in FAIL',
              artifact: true,
            },
          ],
          onReject: 'draft',
          maxAttempts: 3,
        },
        next: 'finish',
      },
      { id: 'finish', name: 'Finish', terminal: true },
    ],
    spawnsSteps: [
      {
        id: 'draft-invoice',
        name: 'Draft the invoice for {{client}}',
        prompt: 'Draft {{number}}.',
      },
    ],
  } as never);
  // An inline-steps host has no catalog `spawn` block; give it the one
  // invoice-run declares.
  const host = (await tasks.get('default', created.num))!;
  await store.writeTask({
    ...host,
    craftbook: {
      ...host.craftbook,
      spawn: {
        overFile: 'tasks/1/billables.json',
        overArtifact: true,
        steps: [{ id: 'draft-invoice', name: 'Draft the invoice for {{client}}' }],
      },
    },
  });
  await store.writeProjectArtifact('default', 'tasks/1/billables.json', JSON.stringify(BILLABLES));
  return host;
}

async function settleCrew(ref: string): Promise<void> {
  for (const child of await tasks.listChildren(ref, { status: 'active' })) {
    await tasks.setStatus('default', child.num, 'complete');
  }
}

async function reviewAndReject(num: number): Promise<void> {
  await tasks.completeStep('default', num, 'collect', 'evaluate');
  await store.writeProjectArtifact('default', 'tasks/1/verdict.md', FAILING_VERDICT);
  const outcome = await tasks.completeStepChecked('default', num, 'evaluate');
  expect(outcome.status).toBe('held');
}

describe('fanout loop-back after the crew settled', () => {
  it('re-drafts every item with the findings, bounded by the gate maxAttempts', async () => {
    const host = await invoiceRunHost();
    await tasks.completeStep('default', host.num, 'scope', 'draft');
    expect(await tasks.listChildren(host.ref)).toHaveLength(2);
    expect((await tasks.get('default', host.num))!.activeStepId).toBe('collect');

    // Pass 1 fails review: the loop must re-draft, not fall straight through.
    await settleCrew(host.ref);
    await reviewAndReject(host.num);
    let children = await tasks.listChildren(host.ref);
    expect(children).toHaveLength(4);
    const pass2 = children.filter((c) => c.status === 'active');
    expect(pass2.map((c) => c.title).sort()).toEqual([
      'Invoice 2026-042 — Harbor & Pine Architects (pass 2)',
      'Invoice 2026-043 — Kestrel Coffee Roasters (pass 2)',
    ]);
    for (const child of pass2) {
      const notes = (await tasks.listNotes('default', child.num)).map((n) => n.text).join('\n');
      expect(notes).toContain('# Revision pass 2 — the review sent this work back');
      expect(notes).toContain('2026-043 bills 2,060.00; the ledger says 2,600.00');
      expect(notes).toContain('# Instance context');
    }
    let after = (await tasks.get('default', host.num))!;
    expect(after.activeStepId).toBe('collect');
    const manifest = await store.readProjectArtifact('default', 'tasks/1/draft.md');
    expect(manifest).toContain('Fanned out 2 draft(s)');

    // Pass 2 fails too: the gate's count survives the loop through the crew.
    await settleCrew(host.ref);
    await tasks.completeStep('default', host.num, 'collect', 'evaluate');
    after = (await tasks.get('default', host.num))!;
    expect(after.craftbook.steps.find((s) => s.id === 'evaluate')!.gateAttempts).toBe(1);
    await store.writeProjectArtifact('default', 'tasks/1/verdict.md', FAILING_VERDICT);
    await tasks.completeStepChecked('default', host.num, 'evaluate');
    children = await tasks.listChildren(host.ref);
    expect(children).toHaveLength(6);
    const pass3 = children.filter((c) => c.status === 'active');
    const pass3Notes = await tasks.listNotes('default', pass3[0]!.num);
    expect(pass3Notes.some((n) => n.text.includes('# Revision pass 3'))).toBe(true);

    // Pass 3 is the last the gate allows: pause on evaluate, no fourth crew.
    await settleCrew(host.ref);
    await reviewAndReject(host.num);
    after = (await tasks.get('default', host.num))!;
    expect(after.status).toBe('paused');
    expect(after.activeStepId).toBe('evaluate');
    expect(await tasks.listChildren(host.ref)).toHaveLength(6);
  });

  it('still advances through a re-activation while the crew is drafting', async () => {
    const host = await invoiceRunHost();
    await tasks.completeStep('default', host.num, 'scope', 'draft');
    // The crew is still active; a loop-back now must not double-spawn.
    await tasks.completeStep('default', host.num, 'collect', 'evaluate');
    await store.writeProjectArtifact('default', 'tasks/1/verdict.md', FAILING_VERDICT);
    await tasks.completeStepChecked('default', host.num, 'evaluate');
    expect(await tasks.listChildren(host.ref)).toHaveLength(2);
    expect((await tasks.get('default', host.num))!.activeStepId).toBe('collect');
  });
});
