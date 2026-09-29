/**
 * The routes a freshly-activated step can take with NO model turn: an
 * activation-moment gate the runtime judges and routes itself, and a
 * declarative per-item fanout the runtime spawns itself. Both run from the
 * `onStepActivated` hook wired in product-service.ts, ahead of the
 * single-gezel handoff; each returns true when it handled the activation,
 * so the caller dispatches no worker turn.
 */

import {
  type Task,
  type TaskCraftbookStep,
  createLogger,
  isEngagementAllowed,
  normalizeStepGate,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { ScriptRunner } from '../scripts/runner.js';
import { deriveFanoutChildTitle } from './fanout-title.js';
import type { GateWorkspaceReader } from './gate-eval.js';
import { type TaskManager, stepOwnerGezelId } from './manager.js';
import { extractSpawnItems } from './spawn-items.js';
import { evaluateStepGate } from './step-gate.js';

// `service`, not `tasks`: the eval harness reads these `[gate]`/`[fanout]`
// lines from the service log, and they predate this module.
const log = createLogger('service');

export interface RuntimeActivationDeps {
  store: Pick<
    Store,
    | 'getProject'
    | 'readConfig'
    | 'readProjectArtifact'
    | 'readProjectWorkspaceFile'
    | 'writeProjectArtifact'
    | 'writeProjectWorkspaceFile'
  >;
  tasks: Pick<
    TaskManager,
    | 'gateWorkspaceReader'
    | 'completeStep'
    | 'appendNote'
    | 'setStatus'
    | 'listChildren'
    | 'spawnChild'
  >;
  scriptRunner: Pick<ScriptRunner, 'run'>;
  history: Pick<HistoryManager, 'log'>;
}

export interface StepActivation {
  projectId: string;
  task: Task;
  newStep: TaskCraftbookStep;
}

/**
 * When the newly-activated step declares an activation-moment gate
 * (legacy GateSpec, or a StepGate with `at: 'activation'`), the RUNTIME
 * evaluates it against the workspace and routes the task — with NO model
 * turn. This is what carries a small model through the loop: it only ever
 * has to `write_file`; the runtime judges + routes + loops. Completion-moment
 * gates are NOT handled here — they fire inside TaskManager.completeStep as
 * a guard.
 *
 * Returns false when there is no activation gate, and when the gate approved
 * but names a reviewer: that falls through to start a session for the
 * reviewer role (Layer 2), the dynamic Playwright pass.
 */
export async function runActivationGate(
  deps: RuntimeActivationDeps,
  { projectId, task, newStep }: StepActivation,
): Promise<boolean> {
  if (!newStep.gate) return false;
  const gate = normalizeStepGate(newStep.gate);
  if (gate.at !== 'activation') return false;
  const { store, tasks, scriptRunner, history } = deps;
  const gateProject = await store.getProject(projectId).catch(() => null);
  if (gateProject && !projectAllowsAmbientWork(gateProject)) return true;
  const attempt = newStep.attemptCount ?? 1;
  const onFail = gate.onReject ?? task.craftbook.entryStepId;
  // Shared with completion gates: for a drafting task this reader is
  // the diffpack overlay, so activation gates judge the proposed tree.
  const reader: GateWorkspaceReader = tasks.gateWorkspaceReader(projectId, task);
  const outcome = await evaluateStepGate({
    gate,
    ws: reader,
    // Activation gates run with no session in flight; standard-scope
    // scripts are trusted, everything else respects engagement mode.
    runScript: async (ref) => {
      if (ref.scope !== 'standard') {
        const config = await store.readConfig();
        if (!isEngagementAllowed(config)) return 'skipped';
      }
      return scriptRunner.run({
        projectId,
        scriptName: ref.name,
        ...(ref.scope ? { scope: ref.scope } : {}),
        inputs: ref.inputs,
        trigger: { kind: 'step', taskRef: task.ref, stepId: newStep.id, moment: 'gate' },
      });
    },
  });

  // Mirror of TaskManager.logStepGated for the legacy activation
  // moment — without this the per-book gate stats silently miss
  // every activation-gated (legacy GateSpec) book.
  const logActivationGated = (decision: 'approve' | 'reject', paused: boolean) => {
    const failedKinds = (outcome.checkResults ?? [])
      .filter((c) => !c.ok)
      .map((c) => c.kind as string);
    const book = task.sourceCraftbookIds?.find((s) => s.role === 'main');
    const gezelId = stepOwnerGezelId(task, newStep);
    return history
      .log({
        kind: 'task.step.gated',
        projectId,
        ...(gezelId ? { gezelId } : {}),
        summary:
          decision === 'approve'
            ? `Gate approved ${task.ref} step "${newStep.name}"`
            : `Gate rejected ${task.ref} step "${newStep.name}" (attempt ${attempt}/${gate.maxAttempts})`,
        details: {
          ref: task.ref,
          stepId: newStep.id,
          decision,
          gateAt: 'activation',
          attempt,
          maxAttempts: gate.maxAttempts,
          paused,
          bookCatalogId: book?.catalogId ?? task.craftbook.id,
          ...(book?.version ? { bookVersion: book.version } : {}),
          ...(decision === 'reject' && failedKinds.length > 0
            ? { firstFailKind: failedKinds[0], failedKinds }
            : {}),
          ...(outcome.skipped.length > 0 ? { skippedScripts: outcome.skipped } : {}),
        },
      })
      .catch(() => {});
  };

  if (outcome.decision === 'approve' && !gate.reviewer) {
    // Floor cleared and no dynamic reviewer to consult → advance.
    await logActivationGated('approve', false);
    const onPass = outcome.goto ?? gate.onApprove ?? newStep.next;
    if (onPass) {
      await tasks
        .completeStep(projectId, task.num, newStep.id, onPass, { cause: 'gate' })
        .catch((err) => log.error('[gate] pass-advance failed:', err));
    }
    return true;
  }
  if (outcome.decision === 'reject') {
    // Write the concrete gaps so the builder fixes THOSE, then loop
    // back — unless we've looped too many times, then pause + surface.
    await tasks
      .appendNote(projectId, task.num, {
        text: `# Evaluation gate — not yet met (attempt ${attempt})\n\n${outcome.message ?? ''}\n\nAddress these, then the gate re-checks automatically.`,
        author: { kind: 'user' },
        stepId: outcome.goto ?? onFail,
      })
      .catch(() => {});
    if (attempt >= gate.maxAttempts) {
      await tasks.setStatus(projectId, task.num, 'paused').catch(() => {});
      log.warn(
        `[gate] ${task.ref} step "${newStep.id}" not met after ${attempt} attempts — pausing for help`,
      );
      await logActivationGated('reject', true);
      return true;
    }
    await logActivationGated('reject', false);
    await tasks
      .completeStep(projectId, task.num, newStep.id, outcome.goto ?? onFail, {
        cause: 'gate',
      })
      .catch((err) => log.error('[gate] fail-loop failed:', err));
    return true;
  }
  return false;
}

/**
 * A step marked `spawnFanout` on a spawn-host task (one carrying a
 * `spawnsCraftbook`) fans out one child task per item in the parent
 * craftbook's `spawn.overFile` JSON array on its declared surface — the
 * runtime does the spawning, with NO model tool call. Each child inherits the
 * item's fields as `variation.context` (string-substituted into its step
 * prompt + gate paths) and dispatches through its own entry-step binding (the
 * existing spawnChild → onStepActivated path). After fanning out we stamp the
 * step's advanceWhen deliverable and advance to the next (collect) step — the
 * crew (children) ARE the work, so no redundant parent worker turn is
 * started. The collect step's fileCount gate is the barrier that waits on the
 * children's files. Fail-safe: every read/parse/spawn error is logged and
 * swallowed so a malformed run never throws into the lifecycle. Idempotent:
 * we skip spawning when the parent already has children (a loop-back
 * re-activation must not double-spawn).
 */
export async function runSpawnFanout(
  deps: RuntimeActivationDeps,
  { projectId, task, newStep }: StepActivation,
): Promise<boolean> {
  const spawn = task.craftbook.spawn;
  if (!newStep.spawnFanout || !task.spawnsCraftbook || !spawn) return false;
  const { store, tasks } = deps;
  // Ambient-work guard, same as the single-gezel dispatch: a read-only /
  // inactive / stable project pauses all autonomous work, and a fanout
  // spawns child turns, so honor it here too.
  const fanoutProject = await store.getProject(projectId).catch(() => null);
  if (fanoutProject && !projectAllowsAmbientWork(fanoutProject)) return true;
  try {
    const existing = await tasks.listChildren(task.ref).catch(() => []);
    if (existing.length === 0) {
      const raw = await (spawn.overArtifact
        ? store.readProjectArtifact(projectId, spawn.overFile)
        : store.readProjectWorkspaceFile(projectId, spawn.overFile)
      ).catch(() => null);
      const items = raw ? extractSpawnItems(raw, spawn.itemsPath) : [];
      if (items.length === 0) {
        log.warn(
          `[fanout] ${task.ref} step "${newStep.id}": no items in ${spawn.overFile} — skipping fanout`,
        );
      } else {
        for (const item of items) {
          const context: Record<string, string> = {};
          for (const [k, v] of Object.entries(item)) {
            // Scalars substitute as themselves; anything structural is
            // JSON so the child can parse it. `String(['a','b'])` gives
            // `a,b` — readable in a prompt, but a child whose slice of
            // work IS that array (a batch's `paths`) then has no way to
            // recover the items, and any path built from it is junk.
            context[k] =
              v == null
                ? ''
                : typeof v === 'string'
                  ? v
                  : typeof v === 'object'
                    ? JSON.stringify(v)
                    : String(v);
          }
          const title = deriveFanoutChildTitle(context);
          await tasks
            .spawnChild(task.ref, { context, ...(title ? { title } : {}) })
            .catch((err) =>
              log.error(`[fanout] ${task.ref}: spawnChild failed for one item:`, err),
            );
        }
        log.info(
          `[fanout] ${task.ref} step "${newStep.id}": spawned ${items.length} child(ren) from ${spawn.overFile}`,
        );
      }
    }
    // Stamp the step's advanceWhen deliverable (a machine manifest of the
    // fanned-out items) so the produced-deliverable record exists, then
    // advance to the next step. The children draft in parallel; the
    // collect step's fileCount gate waits on their files.
    const advanceFile = newStep.advanceWhen?.file;
    if (advanceFile) {
      const kids = await tasks.listChildren(task.ref).catch(() => []);
      const manifest = `# Fanned out ${kids.length} draft(s)\n\n${kids
        .map((k) => `- ${k.ref}: ${k.title}`)
        .join('\n')}\n`;
      await (newStep.advanceWhen?.artifact
        ? store.writeProjectArtifact(projectId, advanceFile, manifest)
        : store.writeProjectWorkspaceFile(projectId, advanceFile, manifest)
      ).catch((err) => log.warn(`[fanout] ${task.ref}: could not write ${advanceFile}:`, err));
    }
    const nextStep = newStep.advanceWhen?.goto ?? newStep.next;
    if (nextStep) {
      await tasks
        .completeStep(projectId, task.num, newStep.id, nextStep, { cause: 'gate' })
        .catch((err) => log.error(`[fanout] ${task.ref}: advance after fanout failed:`, err));
    }
  } catch (err) {
    log.error(`[fanout] ${task.ref} step "${newStep.id}" fanout crashed (non-fatal):`, err);
  }
  return true;
}
