import type { GezelClient } from '@bendyline/gezel-client/node';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

const PROJECT_NAME = 'Large PR Review Eval';
const REVIEWER_NAME = 'Rina';
const PR_NUMBER = 52;
const TOTAL_FILES = 120;
const CORPUS = `data/github-pulls/pr-${PR_NUMBER}`;
const REPORT = 'pr-review.md';
const COVERAGE = 'pr-review-coverage.json';

export const API_USE_PATH = 'src/api/use-assured-api.ts';
export const API_DEFINITION_PATH = 'src/api/assured-api.ts';
export const LATE_DEFECT_PATH = 'src/security/late-authorization.ts';

const API_USE = `import { assuredApi } from './assured-api.js';

export function loadWidget(id: string): string {
  return assuredApi(id);
}
`;

const API_DEFINITION = `export function assuredApi(id: string): string {
  return \`widget:\${id}\`;
}
`;

const LATE_DEFECT = `export function canDeleteProject(userId: string, ownerId: string): boolean {
  if (!userId) return false;
  // Regression: any authenticated user can delete another owner's project.
  return true;
}
`;

interface ArtifactFixture {
  path: string;
  content: string;
}

function patchRecord(
  path: string,
  newLine: number,
  body: string,
  ordinal: number,
): ArtifactFixture {
  const filler = Array.from(
    { length: 18 },
    (_, index) =>
      `+// review-fixture-${ordinal}-${index}: deterministic padding for large diff coverage`,
  ).join('\n');
  const stem = path
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return {
    path: `${CORPUS}/files/${String(ordinal).padStart(3, '0')}--${stem}--fixture.md`,
    content: [
      '---',
      `path: ${path}`,
      'status: modified',
      'additions: 20',
      'deletions: 1',
      '---',
      '',
      `# \`${path}\``,
      '',
      '```diff',
      `@@ -1,1 +${newLine},20 @@`,
      body
        .trimEnd()
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n'),
      filler,
      '```',
      '',
    ].join('\n'),
  };
}

/** Deterministic >80 KB, 120-path PR corpus used by the scenario and its test. */
export function buildLargePrArtifacts(): ArtifactFixture[] {
  const records: ArtifactFixture[] = [];
  records.push(patchRecord(API_USE_PATH, 1, API_USE, 1));
  for (let ordinal = 2; ordinal <= TOTAL_FILES - 2; ordinal++) {
    const path = `src/features/feature-${String(ordinal).padStart(3, '0')}.ts`;
    records.push(
      patchRecord(
        path,
        1,
        `export const feature${ordinal} = ${ordinal};\nexport const label${ordinal} = 'safe-${ordinal}';`,
        ordinal,
      ),
    );
  }
  records.push(patchRecord(API_DEFINITION_PATH, 1, API_DEFINITION, TOTAL_FILES - 1));
  records.push(patchRecord(LATE_DEFECT_PATH, 1, LATE_DEFECT, TOTAL_FILES));

  const paths = records.map((record, index) => ({
    ordinal: index + 1,
    path: parsePathFrontmatter(record.content),
    status: 'modified',
    additions: 20,
    deletions: 1,
  }));
  const manifest = {
    schemaVersion: 1,
    pullRequest: PR_NUMBER,
    totalFiles: paths.length,
    batchSize: 25,
    batches: Array.from({ length: Math.ceil(paths.length / 25) }, (_, index) => ({
      number: index + 1,
      start: index * 25 + 1,
      end: Math.min((index + 1) * 25, paths.length),
      paths: paths.slice(index * 25, (index + 1) * 25).map((entry) => entry.path),
    })),
    files: paths,
  };
  const overview: ArtifactFixture = {
    path: `${CORPUS}/001--pr-52-overview--fixture.md`,
    content: [
      '---',
      'pull: 52',
      'headRef: codex/large-pr-review',
      'baseRef: main',
      'changedFiles: 120',
      'url: https://github.example.test/acme/widget/pull/52',
      '---',
      '',
      '# PR #52: Exercise complete large-PR review',
      '',
      'CI/check status: success (typecheck and unit tests).',
      'The API call appears in the first record; its valid definition appears near the end.',
      'A real authorization regression appears in the final changed file.',
      '',
    ].join('\n'),
  };
  return [
    overview,
    {
      path: `${CORPUS}/attachments/001/pr-52-files.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    ...records,
  ];
}

function parsePathFrontmatter(content: string): string {
  return /^path:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? '';
}

async function findProject(client: GezelClient): Promise<{ id: string } | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === PROJECT_NAME) ?? null;
}

async function readWorkspace(client: GezelClient, projectId: string, path: string) {
  try {
    return await (await client.fetchProjectWorkspaceBlob(projectId, path)).text();
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const project = await ctx.client.createProject({
    name: PROJECT_NAME,
    about:
      'A deterministic 120-file pull-request corpus. Review every artifact record in bounded batches and verify cross-file claims against the workspace checkout.',
    missionObjectives:
      'Cover all 120 changed paths; do not claim assuredApi is missing; catch the authorization defect in src/security/late-authorization.ts:4; write a local request-changes report.',
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
    description: 'Reviews large code changes in bounded batches and verifies cross-file claims.',
  });
  await ctx.client.addGezelToProject(project.id, reviewer.id);
  await ctx.client.sendChatMessage(reviewer.id, {
    projectId: project.id,
    message: largePrReviewScenario.prompt,
    expectedDeliverable: {
      kind: 'file',
      filePath: REPORT,
      checks: [
        { kind: 'minBytes', file: REPORT, bytes: 500 },
        { kind: 'corpusCoverage', file: COVERAGE, corpusDir: CORPUS },
        {
          kind: 'contains',
          file: REPORT,
          pattern: 'Coverage:\\s*120\\s*/\\s*120\\s+changed files',
          flags: 'i',
        },
        {
          kind: 'contains',
          file: REPORT,
          pattern: 'src/security/late-authorization\\.ts(?::|\\s*\\|\\s*)4',
          flags: 'i',
        },
        {
          kind: 'contains',
          file: REPORT,
          pattern: 'Verdict:\\s*request-changes',
          flags: 'i',
        },
        {
          kind: 'notContains',
          file: REPORT,
          pattern:
            'assuredApi.{0,80}(missing|does not exist|undefined)|(?:missing|does not exist|undefined).{0,80}assuredApi',
          flags: 'is',
        },
      ],
    },
  });
  ctx.log(
    `[large-pr-review] seeded ${TOTAL_FILES} changed-file records (${buildLargePrArtifacts().reduce((sum, file) => sum + file.content.length, 0)} chars) and dispatched ${REVIEWER_NAME}`,
  );
}

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const project = await findProject(ctx.client);
  if (!project) return { done: false };
  const report = await readWorkspace(ctx.client, project.id, REPORT);
  if (!report) {
    // Record the absence rather than returning silently. Without this the
    // scenario emits NO sniff for the whole trial: no `[scenario]` line, no
    // facts.json progression, and `recoveryFilePathForSniff(null)` is null
    // so the re-engage nudge cannot even name the file it wants. A 2026-08-31
    // trial ground for 56 minutes and 138 tool calls and left nothing to
    // triage from. `deliverableMissing` keeps every retry-loop path stood
    // down, so this is instrumentation and not a new way to fail.
    ctx.recordSniff?.({
      key: 'large-pr-review',
      score: 0,
      bytes: 0,
      repairFilePath: REPORT,
      deliverableMissing: true,
      failReason: `${REPORT} does not exist yet`,
    });
    await postMissingDeliverableFeedback(ctx, REPORT, { projectId: project.id });
    return { done: false };
  }
  const coverageText = await readWorkspace(ctx.client, project.id, COVERAGE);
  if (!coverageText) {
    ctx.recordSniff?.({
      key: 'large-pr-review',
      score: 0,
      bytes: report.length,
      repairFilePath: COVERAGE,
      deliverableMissing: true,
      failReason: `${COVERAGE} does not exist yet`,
    });
    await postMissingDeliverableFeedback(ctx, COVERAGE, { projectId: project.id });
    return { done: false };
  }
  let reviewed: string[] = [];
  try {
    const parsed = JSON.parse(coverageText) as { reviewedFiles?: unknown };
    reviewed = Array.isArray(parsed.reviewedFiles)
      ? parsed.reviewedFiles.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    await postSniffFeedback(
      ctx,
      COVERAGE,
      {
        ok: false,
        signals: [],
        score: 0,
        scoreMax: 1,
        failReason: 'coverage ledger is not valid JSON',
        missingRequiredSignals: ['valid-json-coverage-ledger'],
      },
      { projectId: project.id, sourceText: coverageText },
    );
    return { done: false };
  }
  const expected = buildLargePrArtifacts()
    .slice(2)
    .map((fixture) => parsePathFrontmatter(fixture.content));
  const reviewedSet = new Set(reviewed);
  const complete =
    reviewedSet.size === TOTAL_FILES && expected.every((path) => reviewedSet.has(path));
  const signals = [
    complete ? 'coverage-120-of-120' : null,
    /Coverage:\s*120\s*\/\s*120\s+changed files/i.test(report) ? 'coverage-summary' : null,
    /src\/security\/late-authorization\.ts(?::|\s*\|\s*)4/i.test(report)
      ? 'late-defect-citation'
      : null,
    /Verdict:\s*request-changes/i.test(report) ? 'request-changes' : null,
    !/assuredApi.{0,80}(missing|does not exist|undefined)|(?:missing|does not exist|undefined).{0,80}assuredApi/is.test(
      report,
    )
      ? 'no-false-missing-api'
      : null,
  ].filter((value): value is string => value !== null);
  const sourcesUnchanged =
    (await readWorkspace(ctx.client, project.id, API_USE_PATH)) === API_USE &&
    (await readWorkspace(ctx.client, project.id, API_DEFINITION_PATH)) === API_DEFINITION &&
    (await readWorkspace(ctx.client, project.id, LATE_DEFECT_PATH)) === LATE_DEFECT;
  if (signals.length === 5 && sourcesUnchanged) {
    return {
      done: true,
      success: true,
      reason: `complete large-PR review (${[...signals, 'source-unchanged'].join(', ')})`,
    };
  }
  const missingRequiredSignals = [
    ...(complete ? [] : [`coverage ledger names ${reviewedSet.size}/${TOTAL_FILES} exact paths`]),
    ...(!signals.includes('coverage-summary') ? ['Coverage: 120/120 changed files'] : []),
    ...(!signals.includes('late-defect-citation')
      ? [`cite ${LATE_DEFECT_PATH}:4 and explain the cross-owner deletion risk`]
      : []),
    ...(!signals.includes('request-changes') ? ['Verdict: request-changes'] : []),
    ...(!signals.includes('no-false-missing-api')
      ? ['remove the false missing-API claim; assuredApi is defined in src/api/assured-api.ts']
      : []),
    ...(!sourcesUnchanged ? ['restore all seeded source files byte-for-byte'] : []),
  ];
  const score = signals.length + (sourcesUnchanged ? 1 : 0);
  ctx.recordSniff?.({
    key: 'large-pr-review',
    score,
    bytes: report.length,
    repairFilePath: REPORT,
    ...(missingRequiredSignals[0] === undefined ? {} : { failReason: missingRequiredSignals[0] }),
  });
  ctx.logChanged(
    'large-pr-review',
    `[scenario] large-pr-review bytes=${report.length} score=${score}/6 coverage=${reviewedSet.size}/${TOTAL_FILES} signals=${signals.join(',') || 'none'}`,
  );
  await postSniffFeedback(
    ctx,
    REPORT,
    {
      ok: false,
      signals,
      score,
      scoreMax: 6,
      failReason: missingRequiredSignals[0],
      missingRequiredSignals,
    },
    { projectId: project.id, sourceText: report },
  );
  return { done: false };
}

export const largePrReviewScenario: EvalScenario = {
  id: 'large-pr-review',
  description:
    'A 120-file, >80 KB pull-request corpus with an early API use, late valid definition, and final-file authorization defect.',
  prompt: `Review PR #${PR_NUMBER} from the complete artifact corpus at artifacts/${CORPUS}. The corpus contains an overview, a machine-readable manifest, and one patch record per changed file. It is intentionally larger than one model/tool response.

Work in bounded batches of at most 25 record files. Maintain ${COVERAGE} as valid JSON with exact "reviewedFiles" and "reviewedRecords" arrays, preserving prior entries after every batch. Maintain concise observations as you go. Review all ${TOTAL_FILES} paths before synthesizing ${REPORT}.

The first changed file calls assuredApi. Before alleging that an API is missing, verify the checkout with find_symbol, search_code, or grep_files; its definition may occur later. CI/typecheck is recorded as successful in the overview. A real authorization defect exists in a late changed file and must be cited as path:new-line evidence.

The final report must include "Coverage: 120/120 changed files", a findings table, and "Verdict: request-changes". Do not modify source and do not post anything externally.`,
  suggestedTrials: 1,
  // Bounded for the `developer` suite. Until that suite landed this
  // scenario carried no ceiling at all and inherited the runner's 8-hour
  // default, so a wedged trial could hold the device for a working day.
  timeoutMs: 40 * 60_000,
  progressTimeoutMs: 12 * 60_000,
  skipInitialPrompt: true,
  setup,
  successCheck,
};
