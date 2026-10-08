/**
 * End-of-turn deliverable checks for a chat session: observable-progress
 * auto-advance of a craftbook step, its mid-turn readiness twin, and the
 * ad-hoc `expectedDeliverable` completion gate. `ChatManager` calls these
 * with a {@link DeliverableGateDeps} it builds per call, so a collaborator
 * wired after construction (`setTaskAdvancer`, `setDraftReader`,
 * `setScriptRunner`) is seen as soon as it is set.
 */
import {
  type ChatMessageToolCall,
  type ChatSession,
  type Task,
  createLogger,
  normalizeStepGate,
  nowIso,
  parseTaskRef,
  requiredOutputMediaForGate,
  stepOnEnterProducesAdvanceFile,
  stepOwnerGezelId,
  taskEffectiveStatus,
  withEffectiveTaskStatuses,
} from '@bendyline/gezel';
import { outputMediumForStep } from '../craftbook/step-toolsets.js';
import type { DraftOverlayReader } from '../diffpack/draft-store.js';
import type { Store } from '../fs/store.js';
import type { ScriptRunner } from '../scripts/runner.js';
import {
  buildStageOneNudge,
  buildStageTwoNudge,
  escalationDisabled,
  gateFailureSignature,
  stageForPlateau,
} from '../tasks/gate-escalation.js';
import type { GateWorkspaceReader } from '../tasks/gate-eval.js';
import { type GateScriptExecutor, gateMessageFingerprint } from '../tasks/step-gate.js';
import { evaluateDeliverableContract } from './deliverable-contract.js';
import {
  completionGateWorkspaceFiles,
  deliverableWrittenThisTurn,
  evaluateDeliverableGate,
  hookOwnedAdvanceHasModelOutput,
} from './deliverable-gate.js';
import { servesEarlierActivation } from './session-step-activation.js';

const log = createLogger('chat');

export interface GateScriptDiagnostic {
  scriptName: string;
  runId?: string;
  error?: string;
  logsTail?: string;
}

/** Result the injected task advancer reports back to the chat loop. */
export type TaskAdvancerOutcome =
  | { status: 'advanced' }
  | {
      status: 'held';
      message: string;
      messageFingerprint: string;
      attempt: number;
      /** True when the gate paused the task (budget spent / plateau). */
      paused?: boolean;
      /** The gate runtime/configuration failed before judging the deliverable. */
      infrastructureError?: boolean;
      /** Present when an onExit hook, rather than the declarative gate, held completion. */
      hook?: 'onExit';
      /** The gate cannot be met under current policy (workspace writes off); paused for a human. */
      unsatisfiable?: boolean;
      /** Gate script diagnostics for durable/user-visible failure reporting. */
      scriptRuns?: GateScriptDiagnostic[];
      /** Escalation rung of `message` (≥1 = deliver raw, it IS the directive). */
      escalationStage?: number;
      /**
       * The task's active step after the hold. Differs from the held step when
       * the gate's `onReject` looped the task to another step.
       */
      activeStepId?: string;
    };

export type TaskAdvancerFn = (
  projectId: string,
  num: number,
  stepId: string,
  goto?: string,
) => Promise<TaskAdvancerOutcome>;

/** What the deliverable checks read from the chat manager. */
export interface DeliverableGateDeps {
  store: Store;
  taskAdvancer?: TaskAdvancerFn;
  draftReader?: DraftOverlayReader;
  scriptRunner?: ScriptRunner;
  /** Runtime task read whose lifecycle includes recursive parent inheritance. */
  readEffectiveTask(projectId: string, num: number): Promise<Task | null>;
  /** The live record of a session the manager holds, when it holds one. */
  liveRecord(sessionId: string): ChatSession | undefined;
}

/**
 * Observable-progress auto-advance. Called at the end of a gezel's turn:
 * if this gezel owns the active step of an active task in this project,
 * and that step declares an `advanceWhen` whose deliverable now exists +
 * clears `minBytes` + passes the optional sniff, advance the step WITHOUT
 * the model having called `advance_task_step`. This is the fix for "gezels
 * do the work but never advance the workflow" — progression rides on the
 * deliverable, not on a meta-tool call the model omits.
 *
 * Keyed on the gezel's *assignment* (not the session's task-scope) so it
 * fires even in a plain project session — the shape the meester macros
 * actually produce (no task-scoped handoff session at create today).
 * Routes through the injected `taskAdvancer` (= `TaskManager.completeStep`),
 * so the same onExit/branches/onEnter/handoff/attemptCount machinery a
 * model-driven advance would trigger runs identically downstream.
 */
export async function maybeAutoAdvanceOnObservableProgress(
  deps: DeliverableGateDeps,
  state: { record: ChatSession },
  drained: ChatMessageToolCall[],
  sessionId: string,
): Promise<{
  /** The active step completed and ownership moved; this session must yield. */
  autoAdvanced?: true;
  unmetEditGate?: { taskRef: string; file: string };
  gateRejected?: {
    taskRef: string;
    stepId: string;
    message: string;
    fingerprint: string;
    paused?: boolean;
    escalationStage?: number;
    infrastructureError?: boolean;
    hook?: 'onExit';
    unsatisfiable?: boolean;
    scriptRuns?: GateScriptDiagnostic[];
  };
}> {
  if (!deps.taskAdvancer) return {};
  const projectId = state.record.projectId;
  if (!projectId) return {};
  const gezelId = state.record.gezelId;
  // The model's own advance wins — never double-advance in one turn.
  if (drained.some((d) => d.name === 'advance_task_step' && d.success)) return {};

  const scopedRef = state.record.taskRef ? parseTaskRef(state.record.taskRef) : null;
  const scopedTask = scopedRef
    ? await deps.readEffectiveTask(scopedRef.projectId, scopedRef.num)
    : null;
  const tasks = state.record.taskRef
    ? scopedTask
      ? [scopedTask]
      : []
    : withEffectiveTaskStatuses(
        await deps.store.listProjectTasks(projectId).catch(() => [] as Task[]),
      );
  // First owned, active edit-gate that HELD because the model didn't
  // write to the deliverable this turn. Surfaced to the caller so the
  // false-"done" re-prompt can fire (the active half of the gate).
  let unmetEditGate: { taskRef: string; file: string } | undefined;
  for (const task of tasks) {
    // A task-scoped handoff may share its gezel with the host and dozens of
    // fanout siblings. Its tool trace is evidence only for that task. The
    // older assignment-only fallback remains for ordinary project sessions,
    // but a pinned session must never advance some other task merely because
    // the same reviewer owns both (wild-caught when a child read made the PR
    // review host spend its collect-gate attempt early).
    if (state.record.taskRef && task.ref !== state.record.taskRef) continue;
    // A scheduled run always arrives task-scoped, so an unpinned session is
    // never doing its step. Default always holds the Meester's Night Shift
    // oversight task, which made every front-door reply that read as
    // finished "unmet" on night-shift-report.md. On a routed PowerPoint ask
    // the resulting nudge turn was still clamped to `invoke_craftbook`, and
    // it launched a second deck crew (qwen3.8-27b, 2026-09-23).
    if (!state.record.taskRef && (task.cron || task.nightShift?.enabled)) continue;
    if (taskEffectiveStatus(task) !== 'active' || !task.activeStepId) continue;
    const step = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    const adv = step?.advanceWhen;
    if (!step) continue;
    // `terminal` means that completing this step completes the task. It is
    // not an instruction to bypass observable-progress handling. In fact,
    // terminal artifact steps are the most important place to do this: the
    // provider stops after the checkpoint write, then the completion gate
    // must validate that write and finish (or repair) the task.
    const normalizedGate = step.gate ? normalizeStepGate(step.gate) : undefined;
    const readEvidenceOnly =
      !adv &&
      normalizedGate?.at === 'completion' &&
      normalizedGate.checks.length > 0 &&
      normalizedGate.checks.every(
        (check) => check.kind === 'corpusReadEvidence' || check.kind === 'artifactReadEvidence',
      ) &&
      normalizedGate.scripts.length === 0;
    if (!adv && !readEvidenceOnly) continue;
    // Only this gezel's step (step assignee → suggested → task assignee);
    // an owner step advances only when the owner says so.
    const owner = stepOwnerGezelId(task, step);
    if (owner !== gezelId) continue;
    // A loop re-enters a step under a NEW session; a turn ending in the
    // session of an earlier pass is not this pass's work. Wild-caught on
    // spreadsheet-model (qwen3.8-flash-next, 2026-09-30): a nudge into
    // build's first-pass session ended after evaluate looped back to build,
    // advanced the new pass on the unchanged index.html, and took the write
    // lease from the session actually rebuilding it.
    if (servesEarlierActivation(state.record, task.ref, step)) {
      log.info(
        `skip observable advance: session ${sessionId} belongs to an earlier activation of ` +
          `${task.ref}/${step.id} (bound ${state.record.stepActivationId}, current ${step.lastActivatedAt})`,
      );
      continue;
    }

    // A fixed-action evidence step intentionally hides
    // `advance_task_step`: the only useful model action is opening the
    // exact records, and the completion gate can prove that from service
    // History. Once the turn has a successful artifact read, try the gate
    // automatically. Partial/truncated reads stay held and feed the exact
    // missing ranges back through the normal rejection loop.
    if (readEvidenceOnly) {
      const attemptedRead = drained.some(
        (call) => call.success && (call.name === 'read_artifact' || call.name === 'read_artifacts'),
      );
      if (!attemptedRead) continue;
      log.info(
        `session ${sessionId}: read evidence observed on ${task.ref} step "${step.id}" — auto-advancing`,
      );
      const outcome = await deps.taskAdvancer(projectId, task.num, step.id).catch((err) => {
        log.error('[chat] read-evidence auto-advance failed:', err);
        return null;
      });
      if (outcome && outcome.status === 'held') {
        return {
          gateRejected: {
            taskRef: task.ref,
            stepId: step.id,
            message: outcome.message,
            fingerprint: outcome.messageFingerprint,
            ...(outcome.paused !== undefined ? { paused: outcome.paused } : {}),
            ...(outcome.infrastructureError !== undefined
              ? { infrastructureError: outcome.infrastructureError }
              : {}),
            ...(outcome.hook !== undefined ? { hook: outcome.hook } : {}),
            ...(outcome.unsatisfiable !== undefined
              ? { unsatisfiable: outcome.unsatisfiable }
              : {}),
            ...(outcome.scriptRuns !== undefined ? { scriptRuns: outcome.scriptRuns } : {}),
            ...(outcome.escalationStage !== undefined
              ? { escalationStage: outcome.escalationStage }
              : {}),
          },
        };
      }
      return outcome?.status === 'advanced' ? { autoAdvanced: true } : {};
    }

    // From here the ordinary observable is a persisted deliverable.
    if (!adv) continue;

    // A hook-owned `advanceWhen.file` is evidence prepared by the runtime,
    // not proof that the model completed every other required output. Pull
    // Request Review's scope step is the wild-caught case: onEnter wrote the
    // immutable batches file, while the model still owed a task note. A
    // failed read-only turn therefore satisfied the file observable and
    // burned a gate attempt before the note could exist. Hold automatic
    // progression until this turn produces the model-owned task-note
    // surface. Pure runtime steps such as coverage collection still advance
    // from their hook-owned file because they declare no model output.
    const hookOwnsAdvanceFile = stepOnEnterProducesAdvanceFile(step);
    const taskNoteIsModelOutput =
      outputMediumForStep(step) === 'task-note' ||
      requiredOutputMediaForGate(step.gate).has('task-note');
    if (!hookOwnedAdvanceHasModelOutput(hookOwnsAdvanceFile, taskNoteIsModelOutput, drained)) {
      continue;
    }

    const content = await readStepDeliverable(
      deps,
      projectId,
      task,
      adv.file,
      adv.artifact === true,
    );
    // `requireChange` steps (edit-an-existing-file deliverables) gate on
    // the model having written to `adv.file` THIS turn — presence alone
    // would advance on turn 1 since the source already exists. The
    // turn's drained tool calls carry the path + success of each write.
    // Match the write's drawer too: a workspace edit cannot prove an
    // artifact checkpoint changed, nor can another task's same-named file.
    const gate = evaluateDeliverableGate({ content, spec: adv, writes: drained });
    if (!gate.satisfied) {
      if (
        adv.requireChange &&
        !unmetEditGate &&
        !deliverableWrittenThisTurn(drained, adv.file, adv.artifact === true)
      ) {
        unmetEditGate = { taskRef: task.ref, file: adv.file };
      }
      continue;
    }

    log.info(
      `session ${sessionId}: observable progress on ${task.ref} step "${step.id}" ` +
        `(${gate.reason}) — auto-advancing`,
    );
    const outcome = await deps.taskAdvancer(projectId, task.num, step.id, adv.goto).catch((err) => {
      log.error('[chat] observable auto-advance failed:', err);
      return null;
    });
    // The step's COMPLETION gate judged the deliverable and rejected
    // it: the deliverable exists (advanceWhen fired) but isn't good
    // enough yet. Surface the prescriptive message so the continuation
    // loop can re-prompt this same session toward the named gaps.
    // A rejection whose onReject looped the task to ANOTHER step leaves this
    // session nothing to repair: its step is no longer active. Re-prompting
    // it "toward the named gaps" started invoice-run's reviewer on a stale
    // turn that paused the whole task (qwen3.8-27b, 2026-10-01). Yield like
    // a handoff instead.
    if (
      outcome &&
      outcome.status === 'held' &&
      !outcome.paused &&
      outcome.activeStepId !== undefined &&
      outcome.activeStepId !== step.id
    ) {
      log.info(
        `session ${sessionId}: ${task.ref} step "${step.id}" gate rejected and looped the task ` +
          `to "${outcome.activeStepId}" — yielding`,
      );
      return { autoAdvanced: true };
    }
    if (outcome && outcome.status === 'held') {
      log.info(
        `session ${sessionId}: ${task.ref} step "${step.id}" gate rejected ` +
          `(attempt ${outcome.attempt}) — holding`,
      );
      return {
        gateRejected: {
          taskRef: task.ref,
          stepId: step.id,
          message: outcome.message,
          fingerprint: outcome.messageFingerprint,
          ...(outcome.paused !== undefined ? { paused: outcome.paused } : {}),
          ...(outcome.infrastructureError !== undefined
            ? { infrastructureError: outcome.infrastructureError }
            : {}),
          ...(outcome.hook !== undefined ? { hook: outcome.hook } : {}),
          ...(outcome.unsatisfiable !== undefined ? { unsatisfiable: outcome.unsatisfiable } : {}),
          ...(outcome.scriptRuns !== undefined ? { scriptRuns: outcome.scriptRuns } : {}),
          ...(outcome.escalationStage !== undefined
            ? { escalationStage: outcome.escalationStage }
            : {}),
        },
      };
    }
    return outcome?.status === 'advanced' ? { autoAdvanced: true } : {};
  }
  return unmetEditGate ? { unmetEditGate } : {};
}

/**
 * A step deliverable as the observable-progress check reads it. A drafting
 * task's workspace deliverable lives in the diffpack overlay — judge the
 * proposed tree, not the untouched real one. Artifact deliverables are
 * real in both modes.
 */
export function readStepDeliverable(
  deps: DeliverableGateDeps,
  projectId: string,
  task: Task,
  file: string,
  artifact: boolean,
): Promise<string | null> {
  return (
    artifact
      ? deps.store.readProjectArtifact(projectId, file)
      : task.diffpackId && deps.draftReader
        ? deps.draftReader.read(projectId, task.diffpackId, file)
        : deps.store.readProjectWorkspaceFile(projectId, file)
  ).catch(() => null);
}

/**
 * Mid-turn twin of the workspace branch of
 * {@link maybeAutoAdvanceOnObservableProgress}: the same task status,
 * step ownership, read and {@link evaluateDeliverableGate} verdict, so the
 * local loop's "deliverable is ready" footer never fires on a file the
 * end-of-turn advance would hold. It additionally waits for every other
 * workspace file the completion gate reads (see
 * {@link completionGateWorkspaceFiles}).
 */
export async function workspaceDeliverableReady(
  deps: DeliverableGateDeps,
  projectId: string,
  taskNum: number,
  stepId: string,
  session: ChatSession,
  writtenThisTurn: boolean,
): Promise<boolean> {
  const task = await deps.readEffectiveTask(projectId, taskNum);
  if (!task || taskEffectiveStatus(task) !== 'active' || task.activeStepId !== stepId) {
    return false;
  }
  const step = task.craftbook.steps.find((s) => s.id === stepId);
  const adv = step?.advanceWhen;
  if (!step || !adv || adv.artifact) return false;
  if (stepOwnerGezelId(task, step) !== session.gezelId) return false;
  // The live record: a gate self-loop adopts its new activation there.
  const record = deps.liveRecord(session.id) ?? session;
  if (servesEarlierActivation(record, task.ref, step)) return false;
  const content = await readStepDeliverable(deps, projectId, task, adv.file, false);
  const writes = writtenThisTurn ? [{ name: 'write_file', path: adv.file, success: true }] : [];
  if (!evaluateDeliverableGate({ content, spec: adv, writes }).satisfied) return false;
  const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
  if (gate?.at !== 'completion') return true;
  for (const file of completionGateWorkspaceFiles(gate.checks, adv.file)) {
    if ((await readStepDeliverable(deps, projectId, task, file, false)) === null) return false;
  }
  return true;
}

/**
 * Evaluate a consultation session's `expectedDeliverable` completion
 * contract at the end of the specialist's turn — the ad-hoc sibling of
 * the craftbook completion gate in
 * `maybeAutoAdvanceOnObservableProgress`. On reject, returns the
 * prescriptive verdict so `runSend` re-prompts the specialist with the
 * named gaps (same re-prompt machinery a step gate uses). No-op unless
 * the session carries a file contract (`checks`/`scripts`).
 */
export async function maybeGateExpectedDeliverable(
  deps: DeliverableGateDeps,
  state: { record: ChatSession },
  sessionId: string,
): Promise<{
  deliverableRejected?: {
    message: string;
    fingerprint: string;
    stage?: number;
    stopRetrying?: boolean;
    filePath?: string;
    plateauCount?: number;
  };
}> {
  const ed = state.record.expectedDeliverable;
  if (!ed || ed.kind !== 'file') return {};
  const checks = ed.checks ?? [];
  const scripts = ed.scripts ?? [];
  if (checks.length === 0 && scripts.length === 0) return {};
  const projectId = state.record.projectId;
  if (!projectId) return {};
  const runner = deps.scriptRunner;
  // Scripts need the runner; if it isn't wired, don't half-evaluate.
  if (scripts.length > 0 && !runner) return {};

  const ws: GateWorkspaceReader = {
    read: (f) => deps.store.readProjectWorkspaceFile(projectId, f).catch(() => null),
    list: async () =>
      (await deps.store.listProjectWorkspaceRecursive(projectId).catch(() => []))
        .filter((e) => !e.isDirectory)
        .map((e) => e.path),
    // Byte reader for image-signature checks (fileCount.verifyImageBytes).
    readBytes: (f) => deps.store.readProjectWorkspaceBinary(projectId, f).catch(() => null),
    readArtifact: (f) => deps.store.readProjectArtifact(projectId, f).catch(() => null),
    readArtifactBytes: async (f) =>
      (await deps.store.readProjectArtifactBinary(projectId, f).catch(() => null))?.data ?? null,
    listArtifacts: async () =>
      (await deps.store.listProjectArtifactsRecursive(projectId).catch(() => []))
        .filter((e) => !e.isDirectory)
        .map((e) => e.path),
  };
  const runScript: GateScriptExecutor = async (ref) => {
    // Ad-hoc deliverable gates run only trusted, packed standard checks.
    if ((ref.scope ?? 'project') !== 'standard' || !runner) return 'skipped';
    return runner.run({
      projectId,
      scriptName: ref.name,
      scope: 'standard',
      inputs: ref.inputs ?? {},
      trigger: { kind: 'chat', sessionId, gezelId: state.record.gezelId },
    });
  };

  const verdict = await evaluateDeliverableContract({
    contract: { checks, scripts },
    ws,
    runScript,
  });
  if (verdict.decision === 'reject' && verdict.message && verdict.fingerprint) {
    // Ad-hoc twin of the craftbook plateau ladder: consecutive rejects
    // with the same failing-check signature climb targeted-edit →
    // full-rewrite → stop-retrying. Persisted on the session record so
    // the ladder survives restarts; cleared on approve below.
    const signature = gateFailureSignature(verdict.checkResults, []);
    const prior = state.record.deliverableGatePlateau;
    const count = prior?.signatureHash === signature ? prior.count + 1 : 1;
    let stage = escalationDisabled() ? 0 : stageForPlateau(count);
    const filePath = ed.filePath;
    if (stage === 2 && !filePath) stage = 1;
    state.record.deliverableGatePlateau = {
      signatureHash: signature,
      count,
      stage,
      at: nowIso(),
    };
    await deps.store.writeSession(state.record).catch(() => {});
    const adHocSurface =
      checks.length > 0 && checks.every((c) => (c as { artifact?: boolean }).artifact === true)
        ? ('artifact' as const)
        : ('workspace' as const);
    const message =
      stage === 1
        ? buildStageOneNudge({
            ...(filePath ? { file: filePath } : {}),
            failingBullets: verdict.message,
            frozen: false,
            surface: adHocSurface,
          })
        : stage === 2 && filePath
          ? buildStageTwoNudge({
              file: filePath,
              failingBullets: verdict.message,
              repeats: count,
              surface: adHocSurface,
            })
          : verdict.message;
    log.info(
      `session ${sessionId}: expectedDeliverable gate rejected — holding${stage > 0 ? ` (escalation stage ${stage}, ${count} identical)` : ''}`,
    );
    return {
      deliverableRejected: {
        message,
        fingerprint: gateMessageFingerprint(message),
        ...(stage > 0 ? { stage } : {}),
        ...(stage >= 3 ? { stopRetrying: true } : {}),
        ...(filePath ? { filePath } : {}),
        plateauCount: count,
      },
    };
  }
  if (state.record.deliverableGatePlateau) {
    delete state.record.deliverableGatePlateau;
    await deps.store.writeSession(state.record).catch(() => {});
  }
  return {};
}
