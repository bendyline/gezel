/**
 * Step-0 feasibility probe for the invoice-run per-client TASK-INSTANCE
 * fan-out restructure.
 *
 * Question it answers: in the eval's DIRECT-WORKER harness (a single
 * worker gezel, no Meester orchestrating, no project voorman), does a
 * spawn-craftbook CHILD task actually get DISPATCHED to a gezel and run
 * a turn — the precondition for it ever writing a per-client invoice
 * file? Or do children materialize `active` but sit idle because nothing
 * drives them?
 *
 * We spawn a real `gezeld` (mock provider) and create three declarative-
 * fanout parent tasks, one per child-step assignee shape:
 *   A) child step carries an explicit `suggestedGezelId` (a real gezel id)
 *   B) child step carries only a `suggestedRole` (what a catalog spawn
 *      book's step would carry — the model can't know gezel ids)
 *   C) child step carries an explicit `assignee` (kind:'gezel')
 *
 * The child that DISPATCHES is the one for which a task-scoped chat
 * session appears (the mock runs a turn — it echoes, but a session +
 * a `send` is proof the runner engaged the assignee). Detection is by
 * `listChatSessions({projectId})` filtered to each child's ref.
 *
 * Why the mock can't prove "writes the file": the mock provider only
 * echoes over HTTP (it can't be scripted from out-of-process), so it
 * never calls writeFile. The dispatch signal (session + turn) is the
 * true feasibility gate — with real dispatch a competent model writes
 * the file; without dispatch no model ever gets the chance.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx scripts/spike-spawn-children.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOrSpawn, resolveDaemonEntry } from '@bendyline/gezel-client/node';
import type { GezelClient } from '@bendyline/gezel-client/node';

const WORKER_ROLE = 'designer';

interface CaseResult {
  label: string;
  childRefs: string[];
  dispatchedRefs: string[];
  dispatched: boolean;
}

async function pollForChildDispatch(
  client: GezelClient,
  projectId: string,
  childRefs: string[],
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const { sessions } = await client.listChatSessions({ projectId });
    for (const s of sessions) {
      const ref = (s as { taskRef?: string }).taskRef;
      if (ref && childRefs.includes(ref)) seen.add(ref);
    }
    if (seen.size >= childRefs.length) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return [...seen];
}

async function runCase(
  client: GezelClient,
  projectId: string,
  workerId: string,
  label: string,
  childStep: Record<string, unknown>,
): Promise<CaseResult> {
  const parent = await client.createTask(projectId, {
    title: `Fanout probe — ${label}`,
    description: `Feasibility probe parent task exercising declarative fanout dispatch (${label}).`,
    assignee: { kind: 'gezel', gezelId: workerId },
    steps: [
      {
        name: 'Coordinate',
        prompt: 'Host step. Children do the per-instance work.',
      },
    ],
    spawnsSteps: [childStep as never],
    fanout: { count: 2 },
  });

  const { tasks: children } = await client.listTaskChildren(projectId, parent.num);
  const childRefs = children.map((c) => c.ref);
  console.log(
    `[probe:${label}] parent=${parent.ref} fanout.materializedAt=${parent.fanout?.materializedAt ?? 'NONE'} children=[${childRefs.join(', ')}]`,
  );
  // Log the child's resolved entry-step assignment so we can see whether
  // the role was resolved to a gezel on spawn.
  for (const c of children) {
    const step = c.craftbook.steps.find((s) => s.id === c.activeStepId);
    console.log(
      `[probe:${label}]   child ${c.ref}: taskAssignee=${JSON.stringify(c.assignee)} step.suggestedGezelId=${step?.suggestedGezelId ?? 'NONE'} step.assignee=${JSON.stringify(step?.assignee ?? null)} step.suggestedRole=${step?.suggestedRole ?? 'NONE'}`,
    );
  }

  const dispatchedRefs = await pollForChildDispatch(client, projectId, childRefs, 30_000);
  return {
    label,
    childRefs,
    dispatchedRefs,
    dispatched: dispatchedRefs.length > 0,
  };
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-spawn-probe-'));
  let child: { kill(signal: string): void; exitCode: number | null } | undefined;
  try {
    const spawned = await discoverOrSpawn({
      daemonEntry: resolveDaemonEntry(import.meta.url),
      detached: false,
      stdio: 'pipe',
      home,
      env: {
        ...process.env,
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_PORT: '0',
      },
      timeoutMs: 30_000,
    });
    child = spawned.child ?? undefined;
    const client = spawned.client;

    await client.updateConfig({
      provider: 'copilot',
      firstRunCompleted: true,
      aiEngagementMode: 'proactive',
      securityPolicy: {
        level: 'free',
        allowFileEdits: true,
        allowExternalChat: true,
        allowExternalServices: true,
        allowScriptExecution: true,
        allowAppNetwork: true,
      },
    });

    const project = await client.createProject({ name: 'Spawn Probe' });
    const worker = await client.createGezel({ name: 'Jules', role: WORKER_ROLE });
    await client.addGezelToProject(project.id, worker.id);
    console.log(`[probe] project=${project.id} worker=${worker.id} role="${WORKER_ROLE}"`);

    const childPromptA = {
      name: 'Draft invoice',
      prompt:
        'Write one print-ready HTML invoice for this client to invoices/inv.html, then report DONE.',
      suggestedGezelId: worker.id,
    };
    const childPromptB = {
      name: 'Draft invoice',
      prompt:
        'Write one print-ready HTML invoice for this client to invoices/inv.html, then report DONE.',
      suggestedRole: WORKER_ROLE,
    };
    const childPromptC = {
      name: 'Draft invoice',
      prompt:
        'Write one print-ready HTML invoice for this client to invoices/inv.html, then report DONE.',
      assignee: { kind: 'gezel', gezelId: worker.id },
    };

    const results: CaseResult[] = [];
    results.push(await runCase(client, project.id, worker.id, 'A-suggestedGezelId', childPromptA));
    results.push(await runCase(client, project.id, worker.id, 'B-suggestedRole', childPromptB));
    results.push(await runCase(client, project.id, worker.id, 'C-explicit-assignee', childPromptC));

    console.log('\n[probe] ===== VERDICT =====');
    for (const r of results) {
      console.log(
        `[probe] ${r.label}: children=${r.childRefs.length} dispatched=${r.dispatchedRefs.length} → ${r.dispatched ? 'DISPATCHED' : 'NO DISPATCH (children idle)'}`,
      );
    }
    const roleOnly = results.find((r) => r.label === 'B-suggestedRole');
    console.log(
      `\n[probe] KEY: catalog-style role-only child steps ${roleOnly?.dispatched ? 'DO' : 'do NOT'} auto-dispatch in the direct-worker harness.`,
    );
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[probe] FAIL:', err);
  process.exit(1);
});
