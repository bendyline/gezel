import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { EscalationStage } from './gate-escalation.js';
import type { GateEvalDeps, GateWorkspaceReader } from './gate-eval.js';
import { isExactLocalSourceRead, normalizeSourcePath } from './research-evidence-match.js';
import type { StepGateOutcome } from './step-gate.js';
import { mainBookSource, stepOwnerGezelId } from './step-runtime.js';

export interface StepGatedEvent {
  projectId: string;
  task: Task;
  step: TaskCraftbookStep;
  gateAt: 'completion' | 'activation';
  decision: 'approve' | 'reject';
  attempt: number;
  maxAttempts: number;
  paused: boolean;
  outcome?: StepGateOutcome;
  /** Escalation-ladder annotations (damper-escalations carry frozen). */
  extra?: { escalationStage?: EscalationStage; frozen?: boolean };
}

export async function recordStepGateOutcome(
  store: Pick<Store, 'listSessions'>,
  history: Pick<HistoryManager, 'log'> | undefined,
  opts: StepGatedEvent,
): Promise<void> {
  const { projectId, task, step, gateAt, decision, attempt, maxAttempts, paused, outcome, extra } =
    opts;
  const failedChecks = (outcome?.checkResults ?? []).filter((c) => !c.ok);
  const rejectingScript = outcome?.runs.find((r) => r.decision === 'reject' || r.error);
  const failedKinds: string[] =
    failedChecks.length > 0
      ? failedChecks.map((c) => c.kind)
      : rejectingScript
        ? [`script:${rejectingScript.scriptName}`]
        : [];
  const book = mainBookSource(task);
  const gezelId = stepOwnerGezelId(task, step);
  // Advisory-judge telemetry: the first judge outcome's verdict +
  // surviving quote — the accumulating false-reject dataset for the
  // promote-to-fail-closed decision (task-completion §1.4c).
  const judgeOutcome = (outcome?.checkResults ?? []).find((c) => c.kind === 'judge');
  const judgeEvidence = (
    judgeOutcome?.evidence as
      | { judge?: { verdict?: string; quotes?: string[]; reason?: string } }
      | undefined
  )?.judge;
  const advisoryJudge = judgeEvidence?.verdict
    ? {
        verdict: judgeEvidence.verdict,
        ...(judgeEvidence.quotes?.[0] ? { quote: judgeEvidence.quotes[0].slice(0, 200) } : {}),
      }
    : undefined;
  // Best-effort model stamp: resolve the working session for this
  // (task, step) so gate outcomes become per-model evidence for
  // capability-floor routing (aggregateModelGateEvidence). No
  // matching session (activation-gated fresh steps, auto-advance
  // from plain sessions) → no stamp; the aggregation skips those.
  let workingModel: { model: string; provider: string } | undefined;
  if (gezelId) {
    const sessions = await store.listSessions({ gezelId }).catch(() => []);
    const working = sessions
      .filter((s) => s.taskRef === task.ref && s.stepId === step.id)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    if (working?.model) {
      workingModel = { model: working.model, provider: working.providerName };
    }
  }
  await history
    ?.log({
      kind: 'task.step.gated',
      projectId,
      ...(gezelId ? { gezelId } : {}),
      summary:
        decision === 'approve'
          ? `Gate approved ${task.ref} step "${step.name}"`
          : `Gate rejected ${task.ref} step "${step.name}" (attempt ${attempt}/${maxAttempts})`,
      details: {
        ref: task.ref,
        stepId: step.id,
        decision,
        gateAt,
        attempt,
        maxAttempts,
        paused,
        bookCatalogId: book.catalogId,
        ...(book.version ? { bookVersion: book.version } : {}),
        ...(decision === 'reject' && failedKinds.length > 0
          ? { firstFailKind: failedKinds[0], failedKinds }
          : {}),
        ...(outcome && outcome.skipped.length > 0 ? { skippedScripts: outcome.skipped } : {}),
        ...(outcome?.infrastructureError ? { infrastructureError: true } : {}),
        ...(rejectingScript?.runId ? { scriptRunId: rejectingScript.runId } : {}),
        ...(rejectingScript?.error ? { scriptError: rejectingScript.error } : {}),
        ...(rejectingScript?.logsTail ? { scriptLogsTail: rejectingScript.logsTail } : {}),
        ...(extra?.escalationStage ? { escalationStage: extra.escalationStage } : {}),
        ...(extra?.frozen ? { frozen: true } : {}),
        ...(workingModel ? workingModel : {}),
        ...(advisoryJudge ? { advisoryJudge } : {}),
      },
    })
    .catch(() => {});
}

export function gateHistoryEvidence(
  history: Pick<HistoryManager, 'listEvents'> | undefined,
  projectId: string,
  task: Task,
  step: TaskCraftbookStep,
  ws: GateWorkspaceReader,
): Pick<
  GateEvalDeps,
  'imageEvidence' | 'researchEvidence' | 'corpusReadEvidence' | 'commandEvidence'
> {
  return {
    imageEvidence: async (artifact = false) => {
      if (!history) return { observable: false, paths: [] };
      const events = await history.listEvents({
        projectId,
        kinds: ['tool.called'],
        ...(step.lastActivatedAt ? { from: step.lastActivatedAt } : {}),
      });
      const paths = events.flatMap((event) => {
        const d = event.details;
        return d?.success === true &&
          d.name === 'read_image_as_base64' &&
          d.imageArtifact === artifact &&
          d.taskRef === task.ref &&
          // Generalist sessions survive graph transitions; their bridge's
          // step tag can name the previous step after a repair back-edge.
          // The current activation's timestamp is the authority in that
          // mode. Stepwise workers still require the exact step tag.
          (d.stepId === step.id ||
            (task.executionMode === 'generalist' && Boolean(step.lastActivatedAt))) &&
          typeof d.path === 'string'
          ? [d.path]
          : [];
      });
      return { observable: true, paths };
    },
    researchEvidence: async ({ sourcePath, tools }) => {
      if (!history) return { observable: false, matches: [] };
      const events = await history.listEvents({
        projectId,
        kinds: ['tool.called'],
        ...(step.lastActivatedAt ? { from: step.lastActivatedAt } : {}),
      });
      const allowed = new Set(tools);
      const expectedPath = normalizeSourcePath(sourcePath);
      const matches: Array<{
        tool: string;
        path?: string;
        target?: string;
        at?: string;
      }> = [];
      for (const event of events) {
        const details = event.details as Record<string, unknown> | undefined;
        if (!details || details.success !== true) continue;
        if (details.taskRef !== task.ref || details.stepId !== step.id) continue;
        const tool = typeof details.name === 'string' ? details.name : '';
        const path = typeof details.path === 'string' ? details.path : undefined;
        const paths = Array.isArray(details.paths)
          ? details.paths.filter((value): value is string => typeof value === 'string')
          : [];
        const target =
          typeof details.researchTarget === 'string' ? details.researchTarget : undefined;
        const exactLocalRead = isExactLocalSourceRead(
          { tool, ...(path !== undefined ? { path } : {}), paths },
          expectedPath,
        );
        let externalAcquisition = allowed.has(tool) && target !== undefined;
        if (externalAcquisition && tool === 'run_playwright_script') {
          const scriptPath = target?.startsWith('script:') ? target.slice('script:'.length) : '';
          const script = scriptPath
            ? ((await ws.readArtifact?.(scriptPath)) ?? (await ws.read(scriptPath)))
            : null;
          // A successful Playwright run is source acquisition only when
          // the script itself targets an external URL. Local preview/QA
          // scripts must not satisfy a research gate by accident.
          externalAcquisition = Boolean(script && /https?:\/\//i.test(script));
        }
        if (!exactLocalRead && !externalAcquisition) continue;
        matches.push({
          tool,
          ...(path ? { path } : {}),
          ...(target ? { target } : {}),
          at: event.at,
        });
      }
      return { observable: true, matches };
    },
    corpusReadEvidence: async () => {
      if (!history) return { observable: false, slices: [] };
      const events = await history.listEvents({
        projectId,
        kinds: ['tool.called'],
        ...(step.createdAt ? { from: step.createdAt } : {}),
      });
      const slices: Array<{
        path: string;
        startLine: number;
        endLine: number;
        totalLines: number;
      }> = [];
      for (const event of events) {
        const details = event.details as Record<string, unknown> | undefined;
        if (
          !details ||
          details.success !== true ||
          details.taskRef !== task.ref ||
          details.stepId !== step.id
        )
          continue;
        const reads = details.artifactReadSlices;
        if (!Array.isArray(reads)) continue;
        for (const value of reads) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const read = value as Record<string, unknown>;
          if (
            typeof read.path !== 'string' ||
            !Number.isSafeInteger(read.startLine) ||
            !Number.isSafeInteger(read.endLine) ||
            !Number.isSafeInteger(read.totalLines)
          )
            continue;
          slices.push({
            path: read.path,
            startLine: read.startLine as number,
            endLine: read.endLine as number,
            totalLines: read.totalLines as number,
          });
        }
      }
      return { observable: true, slices };
    },
    commandEvidence: async ({ scope, name, args }) => {
      if (!history) return { observable: false, runs: [] };
      const events = await history.listEvents({
        projectId,
        kinds: [scope === 'script' ? 'workspace.script.run' : 'workspace.npx.run'],
        ...(step.lastActivatedAt ? { from: step.lastActivatedAt } : {}),
      });
      const sameArgs = (value: unknown): boolean => {
        const eventArgs = Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : [];
        return eventArgs.length === args.length && eventArgs.every((v, i) => v === args[i]);
      };
      // `listEvents` returns newest-first, but its stable sort leaves
      // SAME-millisecond events in append order (oldest of the tie
      // first) — and two quick runs can land in one millisecond. Track
      // the position and re-sort with it as the tiebreaker so "latest
      // run" is really the latest.
      const runs = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => {
          const details = event.details as Record<string, unknown> | undefined;
          if (!details) return false;
          // Attribution comes from the MCP env, not model args — a
          // receipt from another task or step never counts here.
          if (details.taskRef !== task.ref || details.stepId !== step.id) return false;
          if (details.name !== name) return false;
          return sameArgs(details.args);
        })
        .sort((a, b) =>
          a.event.at < b.event.at ? 1 : a.event.at > b.event.at ? -1 : b.index - a.index,
        )
        .map(({ event }) => {
          const details = event.details as Record<string, unknown>;
          return {
            exitCode: typeof details.exitCode === 'number' ? details.exitCode : 1,
            timedOut: details.timedOut === true,
            at: event.at,
            ...(typeof details.stderrTail === 'string' ? { stderrTail: details.stderrTail } : {}),
            ...(typeof details.stdoutTail === 'string' ? { stdoutTail: details.stdoutTail } : {}),
          };
        });
      return {
        observable: true,
        ...(task.diffpackId ? { drafting: true } : {}),
        runs,
      };
    },
  };
}
