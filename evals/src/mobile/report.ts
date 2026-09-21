import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSession, Question } from '@bendyline/gezel';
import {
  type TrialFacts,
  missingScenarioRoles,
  sessionBehaviorRedFlags,
} from '../bin/score-trial.ts';
import { scoreTrialFacts, validateScoreEvidence } from '../fixed-rubric.ts';
import { gradeCanonical } from './canonical-grader.ts';

export interface MobileTrial {
  id: string;
  suite?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  budgetMs?: number;
  firstNativeDeltaMs?: number | null;
  error?: string;
  gezelId?: string;
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  assertions: Array<{ id: string; passed: boolean; evidence?: unknown }>;
  sessions: ChatSession[];
  questions?: Question[];
  initialGezelIds?: string[];
  autoAnswers?: TrialFacts['autoAnswer']['events'];
  artifacts: Array<{
    projectId: string;
    area: string;
    path: string;
    content: string | null;
    bytesBase64?: string;
    byteLength?: number;
  }>;
  preexistingArtifacts?: MobileTrial['artifacts'];
  seeds?: Array<{ projectId: string; path: string; content: string }>;
  canonicalFixture?: { id: string; sourceFile?: string; sourceSha256: string; output: string };
  gezels?: Array<{ id: string; name?: string; role?: string }>;
  meesterId?: string;
  [key: string]: unknown;
}
export interface MobileReport {
  schemaVersion: number;
  runId: string;
  suite: string;
  startedAt: string;
  finishedAt?: string;
  complete: boolean;
  identity: {
    provider?: { id: string };
    model?: { id: string; name?: string };
    [key: string]: unknown;
  };
  trials: MobileTrial[];
  canonicalCoreCoverage: Array<{ id: string; status: string; requirement: string }>;
  reopen?: { passed: boolean; checks: Array<{ id: string; passed: boolean }> };
  nativeRestoration?: { passed: boolean; productFiles: number; modelInventoryFiles: number };
  contracts?: {
    passed: boolean;
    mailboxRequest?: { id: string; content: string };
    assertions?: Array<{ id: string; passed: boolean; evidence?: unknown }>;
    error?: string;
  };
}

export function mobileTrialFacts(
  report: MobileReport,
  trial: MobileTrial,
  directory: string,
): TrialFacts {
  const calls = trial.sessions.flatMap((s) => s.messages.flatMap((m) => m.toolCalls ?? []));
  const byTool: Record<string, number> = {};
  for (const call of calls) byTool[call.name] = (byTool[call.name] ?? 0) + 1;
  const start = Date.parse(trial.startedAt ?? report.startedAt);
  const writes = calls.filter(
    (c) => c.success && ['write_file', 'write_artifact', 'write_document'].includes(c.name),
  );
  const failures = trial.assertions.filter((a) => !a.passed).map((a) => a.id);
  const authored = trial.artifacts.filter(
    (f) =>
      (f.content !== null || typeof f.bytesBase64 === 'string') &&
      !(trial.preexistingArtifacts ?? []).some(
        (before) =>
          before.projectId === f.projectId &&
          before.area === f.area &&
          before.path === f.path &&
          before.content === f.content &&
          before.bytesBase64 === f.bytesBase64,
      ) &&
      !(trial.seeds ?? []).some(
        (s) =>
          s.projectId === f.projectId &&
          f.area === 'workspace' &&
          s.path === f.path &&
          s.content === f.content,
      ),
  );
  const totalBytes = authored.reduce(
    (sum, f) => sum + (f.byteLength ?? Buffer.byteLength(f.content ?? '')),
    0,
  );
  const recruited = (trial.gezels ?? []).filter((g) => !trial.initialGezelIds?.includes(g.id));
  const rolesCreated = [...new Set(recruited.flatMap((g) => (g.role ? [g.role] : [])))];
  const autoAnswers = trial.autoAnswers ?? [];
  const facts: TrialFacts = {
    trialId: `${report.runId}-${trial.id}`,
    scenarioId: trial.id,
    modelId:
      report.identity.model?.name ??
      report.identity.model?.id ??
      report.identity.provider?.id ??
      'unknown',
    runDir: directory,
    host: report.identity,
    outcome: {
      success: trial.status === 'pass',
      ...(trial.status === 'pass'
        ? {}
        : {
            failureMode: /budget|timeout/i.test(trial.error ?? '')
              ? 'timeout'
              : trial.status === 'blocked'
                ? 'provider-unavailable'
                : 'success-check-false',
          }),
      reason:
        trial.error ??
        (failures.length
          ? failures.join('; ')
          : trial.status === 'pass'
            ? 'All declared deterministic assertions passed'
            : `Trial is ${trial.status}`),
      durationMs: trial.durationMs ?? 0,
      timeoutMs: trial.budgetMs,
      budgetUsedFraction: trial.budgetMs ? (trial.durationMs ?? 0) / trial.budgetMs : 0,
    },
    timing: {
      startedAt: trial.startedAt ?? report.startedAt,
      finishedAt: trial.finishedAt ?? report.finishedAt ?? report.startedAt,
      timeToFirstArtifactMs: writes.length
        ? Math.min(...writes.map((c) => Date.parse(c.at ?? '') - start))
        : null,
      timeToLastArtifactWriteMs: writes.length
        ? Math.max(...writes.map((c) => Date.parse(c.at ?? '') - start))
        : null,
      timeToFirstTokenMs: trial.firstNativeDeltaMs ?? null,
      firstTurnTtftMs: null,
      timeToFirstToolCallMs: calls.length
        ? Math.min(...calls.map((c) => Date.parse(c.at ?? '') - start))
        : null,
    },
    team: {
      totalGezelsCreated: recruited.length,
      rolesCreated,
      missingExpectedRoles: missingScenarioRoles(trial.id, rolesCreated),
    },
    toolUse: {
      totalToolCalls: calls.length,
      byTool,
      redFlags: trial.sessions.flatMap((s) => sessionBehaviorRedFlags(s.gezelId, s.messages)),
    },
    artifacts: {
      htmlFiles: authored
        .filter((f) => /\.html?$/i.test(f.path))
        .map((f) => ({
          path: f.path,
          finalBytes: f.byteLength ?? Buffer.byteLength(f.content ?? ''),
          growth: [],
        })),
      imageFiles: [],
      otherFileCount: authored.filter((f) => !/\.html?$/i.test(f.path)).length,
    },
    sniff: {
      progression: [],
      latest: {
        filePath: authored[0]?.path ?? '',
        bytes: totalBytes,
        score: trial.assertions.filter((a) => a.passed).length,
        scoreMax: trial.assertions.length || 1,
        signals: trial.assertions.filter((a) => a.passed).map((a) => a.id),
        failReason: trial.error ?? (failures.join('; ') || null),
      },
    },
    autoAnswer: {
      total: autoAnswers.length,
      byKind: {
        structured: autoAnswers.filter((a) => a.kind === 'structured').length,
        inline: autoAnswers.filter((a) => a.kind === 'inline').length,
      },
      events: autoAnswers,
    },
    miscEvents: [
      ...(Array.isArray(trial.initialGezelIds) &&
      Array.isArray(trial.gezels) &&
      Array.isArray(trial.autoAnswers)
        ? []
        : [
            'Behavior evidence incomplete: absent roster baseline or intervention receipts must not be interpreted as a clean run.',
          ]),
      'Native packaged WebView service with real native inference. Latency is reported separately from capability gates.',
      'Canonical scenarios use unchanged setup, host-side graders and exact grader feedback; native providers produce every response and workspace change.',
    ],
  };
  const canonicalGrade = trial.canonicalGrade as
    | Awaited<ReturnType<typeof gradeCanonical>>
    | undefined;
  const lastSniff = canonicalGrade?.sniffs.at(-1);
  if (canonicalGrade) {
    const logged = [...canonicalGrade.logs].reverse().find((line) => /\bscore=\d/.test(line));
    const ratio = /\bscore=(\d+)\/(\d+)/.exec(logged ?? '');
    const signals =
      /\bsignals=([^ ]+)/
        .exec(logged ?? '')?.[1]
        ?.split(',')
        .filter((s) => s !== 'none') ?? [];
    facts.sniff.latest = lastSniff
      ? {
          filePath: lastSniff.key,
          bytes: lastSniff.bytes,
          score: lastSniff.score,
          scoreMax: ratio ? Number(ratio[2]) : null,
          signals,
          failReason:
            lastSniff.failReason ?? (trial.status === 'pass' ? null : facts.outcome.reason),
          runtimePassed: lastSniff.runtimePassed,
          runtimeFailed: lastSniff.runtimeFailed,
        }
      : null;
  }
  return facts;
}

export async function writeMobileEvaluationReport(report: MobileReport, output: string) {
  await mkdir(output, { recursive: true });
  const rows: string[] = [];
  for (const trial of report.trials) {
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(trial.id)) throw new Error('Invalid native trial id');
    const completeBehaviorEvidence =
      Array.isArray(trial.initialGezelIds) &&
      Array.isArray(trial.gezels) &&
      Array.isArray(trial.autoAnswers) &&
      Boolean(trial.evidenceCapturedAt) &&
      Array.isArray(trial.evidenceCaptureErrors) &&
      trial.evidenceCaptureErrors.length === 0 &&
      !trial.evidenceCaptureError &&
      !trial.cancellationError;
    const nativeFinished =
      ['pass', 'ungraded'].includes(trial.status) &&
      Boolean(trial.finishedAt) &&
      completeBehaviorEvidence &&
      trial.assertions.every((check) => check.passed) &&
      ['native-inference-observed', 'no-provider-error'].every((id) =>
        trial.assertions.some((check) => check.id === id && check.passed),
      );
    const reopened = report.reopen?.checks.filter((check) => check.id.startsWith(`${trial.id}:`));
    const survivedReopen = Boolean(reopened?.length && reopened.every((check) => check.passed));
    if (['pass', 'ungraded'].includes(trial.status) && (!nativeFinished || !survivedReopen)) {
      trial.status = 'fail';
      trial.error ??= !nativeFinished
        ? !completeBehaviorEvidence
          ? 'Native trial has incomplete roster, intervention, or artifact evidence'
          : 'Native trial did not finish with passing inference and provider assertions'
        : 'This trial has missing or failed reload persistence evidence';
    }
    const directory = join(output, trial.id);
    await mkdir(directory, { recursive: true });
    const artifactsDir = join(directory, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    for (const [index, artifact] of trial.artifacts.entries()) {
      if (artifact.content === null && artifact.bytesBase64 === undefined) continue;
      const name = `${index}-${encodeURIComponent(artifact.projectId)}-${encodeURIComponent(artifact.area)}-${encodeURIComponent(artifact.path)}`;
      await writeFile(
        join(artifactsDir, name),
        artifact.bytesBase64 === undefined
          ? artifact.content!
          : Buffer.from(artifact.bytesBase64, 'base64'),
      );
    }
    if (trial.canonicalFixture) {
      try {
        const grade = await gradeCanonical(trial);
        trial.canonicalGrade = grade;
        trial.assertions.push({
          id: 'unchanged-canonical-success-check',
          passed: grade.success,
          evidence: grade,
        });
        if (grade.unavailableRuntime)
          trial.error =
            'Host runtime grader unavailable; this is an infrastructure failure, never a pass';
        if (grade.unavailableRuntime) trial.graderFailure = true;
        trial.status =
          nativeFinished && survivedReopen && grade.success
            ? 'pass'
            : trial.status === 'blocked'
              ? 'blocked'
              : 'fail';
      } catch (error) {
        trial.status = 'fail';
        trial.error = `Canonical grading failed: ${error instanceof Error ? error.message : String(error)}`;
        trial.graderFailure = true;
      }
      const coverage = report.canonicalCoreCoverage.find((entry) => entry.id === trial.id);
      if (coverage) coverage.status = trial.status;
    }
    const facts = mobileTrialFacts(report, trial, directory);
    const failureClass =
      trial.status === 'blocked'
        ? 'infra'
        : trial.graderFailure
          ? 'grader'
          : trial.status === 'pass'
            ? 'pass'
            : 'unclassified';
    const result = {
      failureClass,
      success: trial.status === 'pass',
      suite: trial.suite,
      reason: facts.outcome.reason,
    };
    const score = scoreTrialFacts(facts, result);
    validateScoreEvidence(score, facts, result);
    await Promise.all([
      writeFile(join(directory, 'trial.json'), `${JSON.stringify(trial, null, 2)}\n`),
      writeFile(join(directory, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`),
      writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`),
      writeFile(join(directory, 'score.json'), `${JSON.stringify(score, null, 2)}\n`),
    ]);
    rows.push(
      `| ${trial.suite ?? 'mobile-product-v1'} | ${trial.id} | ${trial.status} | ${score.composite.toFixed(1)} | ${((trial.durationMs ?? 0) / 1000).toFixed(1)} | ${facts.outcome.reason.replaceAll('|', '/').replaceAll('\n', ' ')} |`,
    );
  }
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const summary = [
    '# Native mobile evaluation',
    '',
    `Run: ${report.runId}. Provider: ${report.identity.provider?.id ?? 'unknown'}. Model: ${report.identity.model?.name ?? report.identity.model?.id ?? 'unknown'}.`,
    `Device: ${String(report.identity.device ?? 'unknown')}. OS: ${String(report.identity.os ?? 'unknown')} ${String(report.identity.osVersion ?? '')}.`,
    '',
    report.suite === 'mobile-contracts'
      ? 'Contract-only run. Deterministic provider completions exercise product mechanics; no native model inference runs and this is not a model quality result.'
      : 'Canonical native trials retain the existing desktop prompts, evidence, success checks, and host-side repair/feedback loops. Host tools only grade artifacts produced by the packaged mobile app. These results remain separate from mobile workflow probes; unsupported cases do not count as passes.',
    '',
    '| Suite | Trial | Result | Fixed rubric /10 | Seconds | Evidence summary |',
    '| --- | --- | --- | ---: | ---: | --- |',
    ...rows,
    '',
    `Reload persistence: ${report.reopen?.passed ? 'passed' : 'failed or unavailable'}.`,
    ...(['Android', 'iOS'].includes(String(report.identity.os))
      ? [
          `Original native product and model selection restored: ${report.nativeRestoration?.passed ? 'verified' : 'failed or unverified'}.`,
        ]
      : []),
    `Separate native product contracts: ${report.contracts?.passed ? 'passed' : 'failed or unavailable'}.`,
    '',
    ...(report.contracts?.assertions ?? []).map(
      (check) => `- ${check.id}: ${check.passed ? 'passed' : 'FAILED'}`,
    ),
    ...(report.contracts?.error ? [`- Contract error: ${report.contracts.error}`] : []),
    '',
    'Canonical core coverage (unsupported and unrun cases remain outside passing counts):',
    '',
    ...report.canonicalCoreCoverage.map(
      (entry) =>
        `- ${entry.id}: ${entry.status}${['unsupported', 'not-run'].includes(entry.status) ? ` — ${entry.requirement}` : ''}`,
    ),
    '',
    'Each trial directory contains the native transcripts/artifact bytes, deterministic assertion evidence, facts.json, result.json, and fixed-rubric score.json. Qualitative judgment and failure diagnosis must use this evidence; deterministic success alone is not a visual or prose quality claim.',
    '',
  ].join('\n');
  await writeFile(join(output, 'report.md'), summary);
  return {
    success:
      report.complete &&
      report.reopen?.passed === true &&
      (!['Android', 'iOS'].includes(String(report.identity.os)) ||
        report.nativeRestoration?.passed === true) &&
      (report.trials.length > 0 || report.suite === 'mobile-contracts') &&
      report.contracts?.passed === true &&
      report.trials.every((trial) => trial.status === 'pass'),
    summary,
  };
}
