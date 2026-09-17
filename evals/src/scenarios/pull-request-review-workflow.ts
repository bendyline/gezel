import type { Task } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { mergeCorpusCoverageShards } from '@bendyline/gezel/checks';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  API_DEFINITION,
  API_DEFINITION_PATH,
  API_USE,
  API_USE_PATH,
  LARGE_PR_CORPUS,
  LARGE_PR_NUMBER,
  LARGE_PR_TOTAL_FILES,
  LATE_DEFECT,
  LATE_DEFECT_PATH,
  buildLargePrArtifacts,
  parsePathFrontmatter,
} from './large-pr-review.ts';

const PROJECT_NAME = 'Pull Request Review Workflow Eval';
const REVIEWER_NAME = 'Rina Workflow Reviewer';

interface PublishedBatch {
  batchNumber: number;
  paths: string[];
  records: string[];
}

interface CoverageLedger {
  pullRequest?: number;
  reviewedFiles?: string[];
  reviewedRecords?: string[];
  sources?: Array<{ batchNumber: number; shard: string }>;
  complete?: boolean;
}

export const PR_REVIEW_PHASE_BUDGETS_MS = {
  deterministicSetup: 5 * 60_000,
  childOpenBatch: 15 * 60_000,
  childReviewBatch: 30 * 60_000,
  fanoutMakespan: 70 * 60_000,
  synthesis: 20 * 60_000,
  total: 90 * 60_000,
} as const;

interface PhaseMeasurement {
  actualMs: number | null;
  budgetMs: number;
  pass: boolean;
}

function elapsedMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function maxStepDuration(children: Task[], stepId: string): number | null {
  const durations = children.flatMap((child) => {
    const step = child.craftbook.steps.find((candidate) => candidate.id === stepId);
    const value = elapsedMs(step?.lastActivatedAt ?? step?.createdAt, step?.completedAt);
    return value === null ? [] : [value];
  });
  return durations.length > 0 ? Math.max(...durations) : null;
}

/** Persisted, gateable phase timings for the real local-model workflow. */
export function pullRequestReviewPhaseDiagnostics(
  host: Task,
  children: Task[],
): {
  phaseLatencies: Record<keyof typeof PR_REVIEW_PHASE_BUDGETS_MS, PhaseMeasurement>;
  restartRecovery: { resumedSteps: number; taskRefs: string[]; allCompleted: boolean };
  violations: string[];
} {
  const scan = host.craftbook.steps.find((step) => step.id === 'scan');
  const report = host.craftbook.steps.find((step) => step.id === 'report');
  const childStarts = children.map((child) => Date.parse(child.createdAt)).filter(Number.isFinite);
  const childEnds = children.map((child) => Date.parse(child.updatedAt)).filter(Number.isFinite);
  const fanoutMakespan =
    childStarts.length > 0 && childEnds.length > 0
      ? Math.max(...childEnds) - Math.min(...childStarts)
      : null;
  const actuals: Record<keyof typeof PR_REVIEW_PHASE_BUDGETS_MS, number | null> = {
    deterministicSetup: elapsedMs(host.createdAt, scan?.completedAt),
    childOpenBatch: maxStepDuration(children, 'open-batch'),
    childReviewBatch: maxStepDuration(children, 'review-batch'),
    fanoutMakespan,
    synthesis: elapsedMs(report?.lastActivatedAt ?? report?.createdAt, report?.completedAt),
    total: elapsedMs(host.createdAt, host.updatedAt),
  };
  const phaseLatencies = Object.fromEntries(
    Object.entries(PR_REVIEW_PHASE_BUDGETS_MS).map(([phase, budgetMs]) => {
      const actualMs = actuals[phase as keyof typeof actuals];
      return [phase, { actualMs, budgetMs, pass: actualMs !== null && actualMs <= budgetMs }];
    }),
  ) as Record<keyof typeof PR_REVIEW_PHASE_BUDGETS_MS, PhaseMeasurement>;
  const violations = Object.entries(phaseLatencies)
    .filter(([, measurement]) => !measurement.pass)
    .map(([phase, measurement]) =>
      measurement.actualMs === null
        ? `${phase} timing was not persisted`
        : `${phase} took ${Math.round(measurement.actualMs / 1000)}s (budget ${Math.round(measurement.budgetMs / 1000)}s)`,
    );
  const resumed = [host, ...children].filter((task) =>
    task.craftbook.steps.some((step) => (step.restartResumeCount ?? 0) > 0),
  );
  return {
    phaseLatencies,
    restartRecovery: {
      resumedSteps: resumed.reduce(
        (sum, task) =>
          sum + task.craftbook.steps.filter((step) => (step.restartResumeCount ?? 0) > 0).length,
        0,
      ),
      taskRefs: resumed.map((task) => task.ref),
      allCompleted: resumed.every((task) => task.status === 'complete'),
    },
    violations,
  };
}

async function findProject(client: GezelClient): Promise<{ id: string } | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === PROJECT_NAME) ?? null;
}

async function restartDuringActiveShard(ctx: EvalContext): Promise<boolean> {
  const project = await findProject(ctx.client);
  if (!project) return false;
  const { tasks } = await ctx.client.listProjectTasks(project.id);
  const host = tasks.find(
    (task) =>
      !task.parentTaskRef &&
      task.sourceCraftbookIds?.some(
        (source) => source.role === 'main' && source.catalogId === 'pull-request-review',
      ),
  );
  if (!host) return false;
  const children = (await ctx.client.listTaskChildren(project.id, host.num, { limit: 1_000 }))
    .tasks;
  return children.some(
    (child) =>
      child.status === 'active' &&
      (child.activeStepId === 'open-batch' || child.activeStepId === 'review-batch'),
  );
}

async function readArtifact(
  client: GezelClient,
  projectId: string,
  path: string,
): Promise<string | null> {
  try {
    return await (await client.fetchProjectArtifactBlob(projectId, path)).text();
  } catch {
    return null;
  }
}

async function readWorkspace(
  client: GezelClient,
  projectId: string,
  path: string,
): Promise<string | null> {
  try {
    return await (await client.fetchProjectWorkspaceBlob(projectId, path)).text();
  } catch {
    return null;
  }
}

function parseBatches(text: string): PublishedBatch[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value) || value.length === 0) return null;
    const batches: PublishedBatch[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
      const fields = raw as Record<string, unknown>;
      if (fields.batchNumber !== index + 1) return null;
      if (
        !Array.isArray(fields.paths) ||
        fields.paths.length === 0 ||
        fields.paths.some((item) => typeof item !== 'string') ||
        !Array.isArray(fields.records) ||
        fields.records.length !== fields.paths.length ||
        fields.records.some((item) => typeof item !== 'string')
      ) {
        return null;
      }
      batches.push({
        batchNumber: index + 1,
        paths: fields.paths as string[],
        records: fields.records as string[],
      });
    }
    return batches;
  } catch {
    return null;
  }
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function reportFindingRows(report: string): string[] {
  const findings = /##\s+Findings\s*([\s\S]*?)##\s+Verdict/i.exec(report)?.[1] ?? '';
  return findings
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line.startsWith('|') && !/^\|\s*#\s*\|/i.test(line) && !/^\|\s*:?-{3,}/.test(line),
    );
}

async function setup(ctx: EvalContext): Promise<void> {
  const project = await ctx.client.createProject({
    name: PROJECT_NAME,
    about:
      'A deterministic large pull-request corpus used to exercise the real pull-request-review craftbook, including runtime fanout, read evidence, coverage shards, synthesis, and completion.',
    missionObjectives:
      'Review all 120 changed paths through the craftbook workflow; verify assuredApi before alleging it is missing; catch the cross-owner deletion regression at src/security/late-authorization.ts:4; leave source unchanged.',
  });
  await ctx.client.writeProjectWorkspaceFile(project.id, { path: API_USE_PATH, content: API_USE });
  await ctx.client.writeProjectWorkspaceFile(project.id, {
    path: API_DEFINITION_PATH,
    content: API_DEFINITION,
  });
  await ctx.client.writeProjectWorkspaceFile(project.id, {
    path: LATE_DEFECT_PATH,
    content: LATE_DEFECT,
  });
  for (const fixture of buildLargePrArtifacts()) {
    await ctx.client.writeProjectArtifact(project.id, fixture.path, fixture.content);
  }

  const reviewer = await ctx.client.createGezel({
    name: REVIEWER_NAME,
    role: 'Reviewer',
    description:
      'Executes bounded pull-request reviews, records exact coverage, and verifies cross-file claims before deciding a verdict.',
  });
  await ctx.client.addGezelToProject(project.id, reviewer.id);
  const task = await ctx.client.createTask(project.id, {
    title: 'Exercise the complete pull-request review workflow',
    description:
      'Run the pull-request-review craftbook end to end against the seeded 120-file corpus and produce a fully grounded local review.',
    craftbookId: 'pull-request-review',
    craftbookParams: {
      number: String(LARGE_PR_NUMBER),
      focus: 'general correctness',
      intensity: 'medium',
      corpusScope: LARGE_PR_CORPUS,
    },
    assignee: { kind: 'gezel', gezelId: reviewer.id },
    dispatchEntry: true,
  });
  ctx.log(
    `[pull-request-review-workflow] seeded ${LARGE_PR_TOTAL_FILES} records and dispatched attributed task ${task.ref}`,
  );
}

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const project = await findProject(ctx.client);
  if (!project) return { done: false };
  const { tasks } = await ctx.client.listProjectTasks(project.id);
  const host = tasks.find(
    (task) =>
      !task.parentTaskRef &&
      task.sourceCraftbookIds?.some(
        (source) => source.role === 'main' && source.catalogId === 'pull-request-review',
      ),
  );
  if (!host) return { done: false };
  if (host.status === 'canceled' || host.status === 'paused') {
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: `attributed craftbook task ended ${host.status} at ${host.activeStepId ?? 'no active step'}`,
    };
  }

  const workPath = host.artifactDir ?? `tasks/${host.num}`;
  const batchesPath = `${workPath}/pr-review/batches.json`;
  const batchesText = await readArtifact(ctx.client, project.id, batchesPath);
  const batches = batchesText ? parseBatches(batchesText) : null;
  const children = (await ctx.client.listTaskChildren(project.id, host.num, { limit: 1_000 }))
    .tasks;
  let shardCount = 0;
  if (batches) {
    for (const batch of batches) {
      if (
        await readArtifact(
          ctx.client,
          project.id,
          `${workPath}/pr-review/coverage-${batch.batchNumber}.json`,
        )
      ) {
        shardCount += 1;
      }
    }
  }
  const completedChildren = children.filter((child) => child.status === 'complete').length;
  const report = await readArtifact(ctx.client, project.id, `${workPath}/pr-review.md`);
  ctx.recordSniff?.({
    key: 'pull-request-review-workflow',
    score: report ? 1 : 0,
    bytes: report?.length ?? 0,
    repairFilePath: `${workPath}/pr-review.md`,
    deliverableMissing: !report,
    milestones: completedChildren + shardCount + (host.status === 'complete' ? 1 : 0),
  });
  ctx.logChanged(
    'pull-request-review-workflow',
    `[scenario] pull-request-review-workflow host=${host.status}:${host.activeStepId ?? 'none'} children=${completedChildren}/${children.length} shards=${shardCount}/${batches?.length ?? 0} report=${report?.length ?? 0}B`,
  );
  if (host.status !== 'complete') return { done: false };
  if (!batchesText || !batches || !report) {
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason:
        'craftbook task completed without all required runtime artifacts (batches.json and pr-review.md)',
    };
  }

  const failures: string[] = [];
  const phaseDiagnostics = pullRequestReviewPhaseDiagnostics(host, children);
  for (const violation of phaseDiagnostics.violations) {
    failures.push(`phase latency budget failed: ${violation}`);
  }
  if (phaseDiagnostics.restartRecovery.resumedSteps === 0) {
    failures.push('controlled restart produced no persisted restart-resume evidence');
  } else if (!phaseDiagnostics.restartRecovery.allCompleted) {
    failures.push(
      `restart interruption stranded task(s): ${phaseDiagnostics.restartRecovery.taskRefs.join(', ')}`,
    );
  }
  const expectedFiles = buildLargePrArtifacts()
    .slice(2)
    .map((fixture) => parsePathFrontmatter(fixture.content));
  const expectedRecords = buildLargePrArtifacts()
    .slice(2)
    .map((fixture) => fixture.path);
  const publishedFiles = batches.flatMap((batch) => batch.paths);
  const publishedRecords = batches.flatMap((batch) => batch.records);
  if (!sameStrings(publishedFiles, expectedFiles)) {
    failures.push('published batches do not exactly cover the seeded changed paths in order');
  }
  if (!sameStrings(publishedRecords, expectedRecords)) {
    failures.push('published batches do not exactly cover the seeded patch records in order');
  }
  if (children.length !== batches.length) {
    failures.push(`fanout created ${children.length}/${batches.length} children`);
  }
  const unfinishedChildren = children.filter((child) => child.status !== 'complete');
  if (unfinishedChildren.length > 0) {
    failures.push(`${unfinishedChildren.length} child tasks did not complete`);
  }

  const shards: Array<{ path: string; content: string }> = [];
  for (const batch of batches) {
    const path = `${workPath}/pr-review/coverage-${batch.batchNumber}.json`;
    const content = await readArtifact(ctx.client, project.id, path);
    if (!content) {
      failures.push(`missing coverage shard ${batch.batchNumber}`);
      continue;
    }
    shards.push({ path, content });
    try {
      const shard = JSON.parse(content) as Record<string, unknown>;
      if (
        shard.batchNumber !== batch.batchNumber ||
        !sameStrings(shard.reviewedFiles, batch.paths) ||
        !sameStrings(shard.reviewedRecords, batch.records)
      ) {
        failures.push(`coverage shard ${batch.batchNumber} does not exactly match its batch`);
      }
    } catch {
      failures.push(`coverage shard ${batch.batchNumber} is not valid JSON`);
    }
  }

  const ledgerPath = `${workPath}/pr-review-coverage.json`;
  const ledgerText = await readArtifact(ctx.client, project.id, ledgerPath);
  if (!ledgerText) {
    failures.push('runtime coverage ledger is missing');
  } else {
    const merge = mergeCorpusCoverageShards(batchesText, shards, {
      pullRequest: LARGE_PR_NUMBER,
      requireComplete: true,
      batchesFile: batchesPath,
    });
    if (!merge.ok || !merge.ledger) {
      failures.push(`coverage provenance failed: ${merge.detail}`);
    } else {
      try {
        const ledger = JSON.parse(ledgerText) as CoverageLedger;
        if (
          ledger.pullRequest !== LARGE_PR_NUMBER ||
          ledger.complete !== true ||
          !sameStrings(ledger.reviewedFiles, merge.ledger.reviewedFiles) ||
          !sameStrings(ledger.reviewedRecords, merge.ledger.reviewedRecords) ||
          JSON.stringify(ledger.sources) !== JSON.stringify(merge.ledger.sources)
        ) {
          failures.push('runtime ledger is not the exact deterministic merge of the batch shards');
        }
      } catch {
        failures.push('runtime coverage ledger is not valid JSON');
      }
    }
  }

  const { entries } = await ctx.client.listHistory({
    projectId: project.id,
    kind: 'tool.called',
    limit: 1_000,
  });
  const sessionSummaries = (await ctx.client.listChatSessions({ projectId: project.id })).sessions;
  for (const child of children) {
    const readObserved = entries.some(
      (entry) =>
        entry.entryType === 'event' &&
        entry.details?.taskRef === child.ref &&
        entry.details?.stepId === 'open-batch' &&
        entry.details?.success === true &&
        (entry.details?.name === 'read_artifact' || entry.details?.name === 'read_artifacts'),
    );
    const writeObserved = entries.some(
      (entry) =>
        entry.entryType === 'event' &&
        entry.details?.taskRef === child.ref &&
        entry.details?.stepId === 'review-batch' &&
        entry.details?.success === true &&
        entry.details?.name === 'write_artifact',
    );
    if (!readObserved) failures.push(`${child.ref} has no successful open-batch read receipt`);
    if (!writeObserved) failures.push(`${child.ref} has no successful review-batch write receipt`);

    const childSessions = sessionSummaries.filter((session) => session.taskRef === child.ref);
    if (childSessions.length !== 1) {
      failures.push(
        `${child.ref} used ${childSessions.length} task sessions; open-batch evidence and review-batch reasoning must share exactly one`,
      );
      continue;
    }
    const session = await ctx.client.getChatSession(childSessions[0]!.id);
    const calls = session.messages.flatMap((message) => message.toolCalls ?? []);
    const persistedRead = calls.find(
      (call) =>
        call.success === true && (call.name === 'read_artifact' || call.name === 'read_artifacts'),
    );
    const persistedWrite = calls.find(
      (call) => call.success === true && call.name === 'write_artifact',
    );
    if (!persistedRead) {
      failures.push(`${child.ref} has no persisted patch read in its review session`);
    } else if (
      persistedRead.resultTruncated === true ||
      !persistedRead.resultText ||
      persistedRead.resultText.includes('characters omitted')
    ) {
      failures.push(`${child.ref} persisted only truncated patch evidence into its review session`);
    }
    if (!persistedWrite) {
      failures.push(
        `${child.ref} has no persisted review checkpoint write in the evidence session`,
      );
    }
  }

  if (!/Coverage:\s*120\s*\/\s*120\s+changed files/i.test(report)) {
    failures.push('final report does not state Coverage: 120/120 changed files');
  }
  if (!/src\/security\/late-authorization\.ts(?::|\s*\|\s*)4/i.test(report)) {
    failures.push(`final report does not cite ${LATE_DEFECT_PATH}:4`);
  }
  if (!/Verdict:\s*request-changes/i.test(report)) {
    failures.push('final report does not request changes for the authorization regression');
  }
  const findingRows = reportFindingRows(report);
  if (findingRows.length > 8) {
    failures.push(
      `final report contains ${findingRows.length} findings instead of a concise verified set`,
    );
  }
  const nonActionable = findingRows.find((row) =>
    /\b(?:no\s+(?:defect|issue|finding|action\s+needed)|acceptable\s+as[- ]is|accept\s+as[- ]is|worth\s+noting|future\s+optimization|pre[- ]existing|intentional\s+limitation|needs?\s+(?:central\s+)?verification|contingent|undefined\s+behavior|may|might|could|potentially|hardening\s+suggestion|best\s+addressed\s+in\s+follow[- ]ups)\b/i.test(
      row,
    ),
  );
  if (nonActionable) {
    failures.push('final report promoted a non-issue or no-action suggestion into Findings');
  }
  if (
    /Verdict:\s*approve/i.test(report) &&
    findingRows.some((row) => /\|\s*(?:critical|major)\s*\|/i.test(row))
  ) {
    failures.push('final report approves despite a critical or major finding');
  }
  if (
    /assuredApi.{0,80}(missing|does not exist|undefined)|(?:missing|does not exist|undefined).{0,80}assuredApi/is.test(
      report,
    )
  ) {
    failures.push('final report falsely claims assuredApi is missing');
  }
  const synthesisText = await readArtifact(
    ctx.client,
    project.id,
    `${workPath}/pr-review/synthesis-data.json`,
  );
  if (!synthesisText) {
    failures.push('structured synthesis data is missing');
  } else {
    try {
      const synthesis = JSON.parse(synthesisText) as { verificationCandidates?: unknown };
      const verificationCandidates = synthesis.verificationCandidates;
      if (!Array.isArray(verificationCandidates)) {
        failures.push('synthesis data has no verificationCandidates[] channel');
      } else if (
        !verificationCandidates.some(
          (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).path === API_USE_PATH &&
            /assuredApi/i.test(String((candidate as Record<string, unknown>).claim)),
        )
      ) {
        failures.push(
          `cross-file ${API_USE_PATH} assuredApi candidate was not preserved in verificationCandidates[]`,
        );
      }
    } catch {
      failures.push('structured synthesis data is not valid JSON');
    }
  }
  const sourcesUnchanged =
    (await readWorkspace(ctx.client, project.id, API_USE_PATH)) === API_USE &&
    (await readWorkspace(ctx.client, project.id, API_DEFINITION_PATH)) === API_DEFINITION &&
    (await readWorkspace(ctx.client, project.id, LATE_DEFECT_PATH)) === LATE_DEFECT;
  if (!sourcesUnchanged) failures.push('seeded checkout source was modified');

  if (failures.length > 0) {
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: failures.join('; '),
      diagnostics: { pullRequestReview: phaseDiagnostics },
    };
  }
  return {
    done: true,
    success: true,
    reason: `real craftbook workflow completed ${batches.length} batches with exact read/write receipts, deterministic 120-file coverage provenance, a cited request-changes verdict, and unchanged source`,
    diagnostics: { pullRequestReview: phaseDiagnostics },
  };
}

export const pullRequestReviewWorkflowScenario: EvalScenario = {
  id: 'pull-request-review-workflow',
  description:
    'Dispatches the real pull-request-review craftbook against a deterministic 120-file corpus and grades its fanout, read receipts, observations, exact coverage provenance, host synthesis, verdict, and source immutability.',
  prompt:
    'Run the pull-request-review craftbook over all 120 changed paths. The final local report must cite src/security/late-authorization.ts:4, use Verdict: request-changes, avoid a false missing-assuredApi claim, and leave source unchanged.',
  evidenceTexts: [
    'Review all 120 changed paths through the craftbook workflow; verify assuredApi before alleging it is missing; catch the cross-owner deletion regression at src/security/late-authorization.ts:4; leave source unchanged.',
  ],
  suggestedTrials: 1,
  timeoutMs: 90 * 60_000,
  progressTimeoutMs: 12 * 60_000,
  skipInitialPrompt: true,
  repairPolicy: 'runtime',
  restartWhen: restartDuringActiveShard,
  setup,
  successCheck,
};
