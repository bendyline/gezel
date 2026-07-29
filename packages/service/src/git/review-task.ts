import type { CodeReviewKind, Task } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { ensureGezel } from '../gezels/ensure.js';
import type { TaskManager } from '../tasks/manager.js';

const log = createLogger('git');

/** Catalog id of the snapshot-driven review craftbook (lives in gilde). */
export const CODE_REVIEW_CRAFTBOOK_ID = 'code-review';

export interface CreateReviewTaskDeps {
  store: Store;
  catalog: CatalogService;
  chat: ChatManager;
  tasks: TaskManager;
}

export interface CreateReviewTaskArgs {
  projectId: string;
  reviewId: string;
  kind: CodeReviewKind;
  branch: string;
  /** pr kind only — the base the branch is being reviewed against. */
  defaultBranch?: string;
  manifestPath: string;
  diffPath: string;
  reportPath: string;
}

export interface CreateReviewTaskResult {
  task: Task;
  gezelId: string;
  gezelName: string;
  /** True when the catalog `code-review` craftbook drove the task; false = inline fallback. */
  usedCraftbook: boolean;
}

/**
 * Create (but do not dispatch) the task behind one code review. Prefers
 * the catalog `code-review` craftbook — `{{reviewId}}` in its prompts and
 * gate/advanceWhen paths is made concrete by TaskManager.create's
 * craftbookParams interpolation. When the pinned catalog predates the
 * book, an inline two-step fallback with the same artifact gate keeps
 * the feature working. The caller dispatches via `dispatchTaskEntry`.
 */
export async function createReviewTask(
  deps: CreateReviewTaskDeps,
  args: CreateReviewTaskArgs,
): Promise<CreateReviewTaskResult> {
  const { store, catalog, chat, tasks } = deps;
  const reviewer = await ensureGezel({ opts: { jobTitle: 'reviewer' }, store, catalog, chat });
  await store
    .addGezelToProject(args.projectId, reviewer.gezelId, { source: 'task' })
    .catch(() => {});

  const detail = await catalog
    .get('craftbook-template', CODE_REVIEW_CRAFTBOOK_ID)
    .catch(() => null);
  const usedCraftbook = detail != null;

  const title =
    args.kind === 'pr'
      ? `Code review — ${args.branch} vs ${args.defaultBranch ?? 'the main branch'}`
      : 'Code review — unsaved changes';
  const description =
    `Review the ${args.kind === 'pr' ? 'branch' : 'unsaved'} change set snapshotted at ` +
    `${args.manifestPath} (+ ${args.diffPath}${args.kind === 'pr' ? ', commit list in the manifest' : ''}) ` +
    `and write the gated report artifact to ${args.reportPath}. Never modify project source.`;

  const task = usedCraftbook
    ? await tasks.create(args.projectId, {
        title,
        description,
        craftbookId: CODE_REVIEW_CRAFTBOOK_ID,
        assignee: { kind: 'gezel', gezelId: reviewer.gezelId },
        craftbookParams: { reviewId: args.reviewId, kind: args.kind, intensity: 'medium' },
        createdBy: { kind: 'user' },
      })
    : await tasks.create(args.projectId, {
        title,
        description,
        assignee: { kind: 'gezel', gezelId: reviewer.gezelId },
        createdBy: { kind: 'user' },
        steps: fallbackSteps(args, reviewer.gezelId),
      });

  // Stamp invocation pointers as an entry-step note (mirrors the command
  // launcher) so the reviewer can re-find the snapshot via read_task_notes
  // even mid-task.
  if (task.activeStepId) {
    const lines = [
      '# Invocation parameters',
      '',
      `- **reviewId**: ${args.reviewId}`,
      `- **kind**: ${args.kind}`,
      `- **manifest**: ${args.manifestPath}`,
      `- **diff**: ${args.diffPath}`,
      `- **report**: ${args.reportPath}`,
    ];
    await tasks
      .appendNote(task.projectId, task.num, {
        text: lines.join('\n'),
        author: { kind: 'user' },
        stepId: task.activeStepId,
      })
      .catch(() => {});
  }

  if (!usedCraftbook) {
    log.info(
      `[git] code-review craftbook not in catalog — task ${task.ref} uses the inline fallback steps`,
    );
  }
  return { task, gezelId: reviewer.gezelId, gezelName: reviewer.name, usedCraftbook };
}

/** The report skeleton both paths instruct — kept in one place. */
function reportSkeleton(reviewId: string): string {
  return [
    '# Code Review — <one-line title>',
    `Review-ID: ${reviewId}`,
    '',
    '## Summary',
    '<2-6 sentences: what the change does, overall risk. If there are no findings, say "No findings." here.>',
    '',
    '## Findings',
    '| # | Severity | File | Line | Finding | Recommendation |',
    '|---|----------|------|------|---------|----------------|',
    '<one row per finding; severities: critical, major, minor, nit. Keep the header row even when there are no findings.>',
    '',
    '## Verdict',
    'Verdict: approve',
    '<or> Verdict: request-changes',
    '<one sentence of rationale. Any critical or major finding means request-changes.>',
  ].join('\n');
}

/**
 * Minimal two-step inline book mirroring the catalog craftbook's report
 * step: same deliverable, same declarative checks, same stdlib gate
 * script. The per-step `assignee` stamp is load-bearing — it is what
 * `TaskRunner.rehydrateFromStore` reads to re-enqueue after a restart
 * that lands between create and dispatch.
 */
function fallbackSteps(args: CreateReviewTaskArgs, gezelId: string) {
  const reportPath = args.reportPath;
  return [
    {
      id: 'review-report',
      name: 'Review the change set and write the report',
      suggestedRole: 'reviewer',
      assignee: { kind: 'gezel' as const, gezelId },
      prompt: [
        '**You are the reviewer for one snapshotted change set.** In this task you read code and write exactly ONE report artifact — never modify project source files.',
        '',
        `**Your first tool call this turn:** \`read_artifact({ path: "${args.manifestPath}" })\`. It lists the review kind (\`commit\` = unsaved work vs the last save; \`pr\` = this branch vs the default branch), the base/head, every changed file, and — for branch reviews — the commit list. Then read \`${args.diffPath}\` with \`read_artifact\` (use head/lines slices on a large diff).`,
        '',
        'Walk the diff hunk by hunk and review for correctness, security, data-loss risk, error handling, tests, and clarity. Use `read_file` on workspace files when you need surrounding context. Only discuss files that appear in the change set. Cite every finding as `path:line` using paths exactly as they appear in the diff.',
        '',
        `Then write the complete report in ONE \`write_artifact\` call to \`${reportPath}\`, exactly this skeleton:`,
        '',
        '```',
        reportSkeleton(args.reviewId),
        '```',
        '',
        'Do not write any workspace file. If the gate rejects, fix exactly the gap it names and rewrite the whole artifact in one `write_artifact` call. When the report is written, call `advance_task_step` (writing the file may advance this step for you).',
      ].join('\n'),
      advanceWhen: { file: reportPath, artifact: true, minBytes: 400 },
      gate: {
        at: 'completion' as const,
        checks: [
          { kind: 'minBytes' as const, file: reportPath, bytes: 400, artifact: true },
          {
            kind: 'contains' as const,
            file: reportPath,
            pattern: '##\\s+Summary',
            label: 'Summary section',
            artifact: true,
          },
          {
            kind: 'contains' as const,
            file: reportPath,
            pattern: '##\\s+Findings',
            label: 'Findings section',
            artifact: true,
          },
          {
            kind: 'contains' as const,
            file: reportPath,
            pattern: 'Verdict:\\s*(approve|request-changes)',
            label: 'verdict line',
            artifact: true,
          },
          {
            kind: 'tableShape' as const,
            file: reportPath,
            requiredColumns: ['Severity', 'File', 'Finding'],
            artifact: true,
          },
        ],
        scripts: [
          {
            name: 'checkReviewReport',
            scope: 'standard' as const,
            inputs: { reviewId: args.reviewId },
          },
        ],
        onReject: 'review-report',
        maxAttempts: 4,
      },
      next: 'review-done',
    },
    {
      id: 'review-done',
      name: 'Deliver the verdict',
      suggestedRole: 'reviewer',
      assignee: { kind: 'gezel' as const, gezelId },
      terminal: true,
      prompt: [
        'The report is written and passed its gate. Write one final task note with `write_task_note`:',
        '`Verdict: <approve|request-changes> — N findings (a critical, b major, c minor, d nit)` plus a one-paragraph summary.',
        `Tell the user the full report is in the project artifacts at \`${reportPath}\` (the Review panel renders it). Then call \`advance_task_step\` to complete the task.`,
      ].join('\n'),
    },
  ];
}
