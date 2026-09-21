import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MessageGezelRequest, SendChatRequest } from '@bendyline/gezel';
import { completedRepairActionSnapshot } from '../runner.ts';
import { conflictSynthesisScenario } from '../scenarios/conflict-synthesis.ts';
import { dataWrangleScenario } from '../scenarios/data-wrangle.ts';
import { failingTestsSpecScenario } from '../scenarios/failing-tests-spec.ts';
import { incidentPostmortemScenario } from '../scenarios/incident-postmortem.ts';
import { opsRunbookScenario } from '../scenarios/ops-runbook.ts';
import { planAndEstimateScenario } from '../scenarios/plan-and-estimate.ts';
import { schemaMigrationScenario } from '../scenarios/schema-migration.ts';
import { symptomDebugScenario } from '../scenarios/symptom-debug.ts';
import { tankCombatScenario } from '../scenarios/tankcombat.ts';
import { ticTacToeScenario } from '../scenarios/tictactoe.ts';
import type { EvalContext, EvalScenario, EvalTerminalFailure } from '../types.ts';
import type { MobileTrial } from './report.ts';

export const canonicalScenarios: Record<string, EvalScenario> = {
  'incident-postmortem': incidentPostmortemScenario,
  'conflict-synthesis': conflictSynthesisScenario,
  'data-wrangle': dataWrangleScenario,
  tictactoe: ticTacToeScenario,
  tankcombat: tankCombatScenario,
  'schema-migration': schemaMigrationScenario,
  'failing-tests-spec': failingTestsSpecScenario,
  'symptom-debug': symptomDebugScenario,
  'ops-runbook-anomaly': opsRunbookScenario,
  'plan-and-estimate': planAndEstimateScenario,
};
export type CanonicalFeedback =
  | { kind: 'messageGezel'; gezelId: string; body: MessageGezelRequest }
  | { kind: 'sendChatMessage'; gezelId: string; body: SendChatRequest };

/** Keep the canonical grader's WeakMap caches and repair ladder across device snapshots. */
export class MobileCanonicalGrader {
  private trial!: MobileTrial;
  private readonly logs: string[] = [];
  private readonly sniffs: Array<Parameters<NonNullable<EvalContext['recordSniff']>>[0]> = [];
  private feedback: CanonicalFeedback[] = [];
  private readonly changedLogs = new Map<string, string>();
  private terminal: EvalTerminalFailure | undefined;
  private readonly context: EvalContext;

  constructor(private readonly feedbackEnabled = false) {
    const produced = () =>
      this.trial.artifacts.filter(
        (file) =>
          !this.trial.preexistingArtifacts?.some(
            (before) =>
              before.projectId === file.projectId &&
              before.area === file.area &&
              before.path === file.path &&
              before.content === file.content,
          ),
      );
    const files = (projectId: string, area: string) => ({
      files: produced()
        .filter((f) => f.projectId === projectId && f.area === area && f.content !== null)
        .map((f) => ({
          path: f.path,
          name: f.path.split('/').at(-1),
          isDirectory: false,
          size: Buffer.byteLength(f.content ?? ''),
        })),
    });
    const blob = async (projectId: string, area: string, path: string) => {
      const file = produced().find(
        (f) => f.projectId === projectId && f.area === area && f.path === path,
      );
      if (file?.content == null)
        throw new Error(`Native artifact was not produced: ${area}/${path}`);
      return new Blob([file.content]);
    };
    const retainedSession = (id: string, projectId?: string) =>
      this.trial.sessions
        .filter((s) => s.gezelId === id && (!projectId || s.projectId === projectId) && !s.archived)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    const enqueue = (feedback: CanonicalFeedback) => {
      if (!this.feedbackEnabled) throw new Error('Final grading cannot mutate the native product');
      const target = this.trial.gezels?.find((g) => g.id === feedback.gezelId);
      const session = retainedSession(feedback.gezelId, feedback.body.projectId);
      if (!target || !session)
        throw new Error('Canonical feedback has no retained native recipient/session');
      this.feedback.push(feedback);
      return {
        accepted: true as const,
        sessionId: session.id,
        toGezelId: target.id,
        toGezelName: target.name ?? target.id,
        gezelId: target.id,
      };
    };
    const methods = {
      listProjects: async () => ({ projects: this.trial.projects ?? [] }),
      listGezels: async () => ({ gezels: this.trial.gezels ?? [] }),
      listInflightTurns: async () => ({ inflight: this.trial.inflight ?? [] }),
      listProjectWorkspace: async (id: string) => files(id, 'workspace'),
      listProjectArtifacts: async (id: string) => files(id, 'artifacts'),
      fetchProjectWorkspaceBlob: (id: string, path: string) => blob(id, 'workspace', path),
      fetchProjectArtifactBlob: (id: string, path: string) => blob(id, 'artifacts', path),
      listChatSessions: async (filter?: { projectId?: string }) => ({
        sessions: this.trial.sessions.filter(
          (s) => !filter?.projectId || s.projectId === filter.projectId,
        ),
      }),
      getChatSession: async (id: string) => {
        const session = this.trial.sessions.find((s) => s.id === id);
        if (!session) throw new Error(`Native session not found: ${id}`);
        return session;
      },
      messageGezel: async (gezelId: string, body: MessageGezelRequest) =>
        enqueue({ kind: 'messageGezel', gezelId, body }),
      sendChatMessage: async (gezelId: string, body: SendChatRequest) =>
        enqueue({ kind: 'sendChatMessage', gezelId, body }),
    };
    this.context = {
      client: new Proxy(methods, {
        get(target, name) {
          if (!(name in target))
            throw new Error(`Canonical grader requested an unadapted API: ${String(name)}`);
          return target[name as keyof typeof target];
        },
      }) as unknown as EvalContext['client'],
      meesterId: 'unknown',
      repairPolicy: feedbackEnabled ? 'harness' : 'runtime',
      log: (line) => this.logs.push(line),
      logChanged: (key, line) => {
        if (this.changedLogs.get(key) !== line) {
          this.changedLogs.set(key, line);
          this.logs.push(line);
        }
      },
      recordSniff: (sniff) => this.sniffs.push(sniff),
      requestTerminalFailure: (failure) => {
        this.terminal = failure;
      },
      snapshotRepairActions: async ({ sessionId }) => {
        const session = this.trial.sessions.find((s) => s.id === sessionId);
        return session ? completedRepairActionSnapshot(session, false) : null;
      },
    };
  }
  async grade(trial: MobileTrial) {
    const scenario = canonicalScenarios[trial.id];
    if (!scenario) throw new Error(`No unchanged canonical grader for ${trial.id}`);
    const sourceFile = trial.id === 'ops-runbook-anomaly' ? 'ops-runbook' : trial.id;
    const source = await readFile(new URL(`../scenarios/${sourceFile}.ts`, import.meta.url));
    if (createHash('sha256').update(source).digest('hex') !== trial.canonicalFixture?.sourceSha256)
      throw new Error(
        'Canonical source changed since this native test was packaged; rebuild its fixtures before comparing scores',
      );
    for (const file of trial.artifacts)
      if (
        !file.path ||
        file.path.startsWith('/') ||
        file.path.includes('\\') ||
        file.path.includes(':') ||
        file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
        [...file.path].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error('Unsafe native workspace path in grading snapshot');
    if (this.feedbackEnabled && (!Array.isArray(trial.inflight) || trial.inflight.length))
      throw new Error('Canonical feedback requires an explicitly idle native snapshot');
    this.trial = trial;
    this.context.meesterId = trial.meesterId ?? trial.gezelId ?? 'unknown';
    this.feedback = [];
    const logStart = this.logs.length;
    const sniffStart = this.sniffs.length;
    let verdict = await scenario.successCheck(this.context);
    if (!verdict.done && this.terminal)
      verdict = { done: true, success: false, reason: this.terminal.reason };
    const unavailableRuntime = this.logs
      .slice(logStart)
      .some((line) => /runtime check skipped|bootstrapError=/i.test(line));
    return {
      success: verdict.done && verdict.success === true && !unavailableRuntime,
      verdict,
      sniffs: this.sniffs.slice(sniffStart),
      logs: this.logs.slice(logStart),
      unavailableRuntime,
      feedback: [...this.feedback],
    };
  }
}
export async function gradeCanonical(trial: MobileTrial) {
  return new MobileCanonicalGrader().grade(trial);
}
