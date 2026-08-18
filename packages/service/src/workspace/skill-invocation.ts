import type { DiscoveredSkill, NewCraftbookStep, Task } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { type EntryDispatchResult, dispatchTaskEntry } from '../tasks/entry-dispatch.js';
import type { TaskManager } from '../tasks/manager.js';
import type { TaskRunner } from '../tasks/runner.js';

const log = createLogger('import-sync');

/**
 * ─ Invoking a workspace SKILL.md ─────────────────────────────────────
 *
 * A SKILL.md carries a procedure but no crew: nothing in the file says
 * which craftsman should run it, and the harnesses these files come from
 * (Claude Code, gstack, Codex) have exactly one agent, so they never had
 * to. Handing the raw body to a task therefore produced a task nobody
 * owned — assigned to the user, never dispatched, no chat. The skill
 * looked invoked and nothing happened.
 *
 * So invocation is a triage-first scaffold, not a single step:
 *
 *   1. `triage`  — the project's VOORMAN reads the skill, decides
 *                  whether this workspace can actually run it, and
 *                  stamps the executing role onto step 2.
 *   2. `run`     — the skill's own procedure, run by whoever step 1
 *                  named. Deliberately role-less at create time; the
 *                  voorman's `craftbook_update_step` fills it in and
 *                  `advance_task_step` resolves it into a real gezel.
 *   3. `verify`  — back to the voorman: did the skill actually deliver?
 *
 * Steps 1 and 3 are built here rather than left to the model to add,
 * because a validation step that only exists when a model remembers to
 * author it is not a gate. The voorman TAILORS them (its triage note is
 * what step 3 checks against); it doesn't have to invent them.
 */

/** Stable step ids — the triage prompt names them, so they can't be derived. */
export const SKILL_TRIAGE_STEP_ID = 'triage';
export const SKILL_RUN_STEP_ID = 'run';
export const SKILL_VERIFY_STEP_ID = 'verify';

/** Role hint used when the project has no voorman to point at yet. */
const VOORMAN_ROLE = 'voorman';

export interface SkillInvocationOptions {
  /**
   * The project's voorman, when it has one. Preferred over the role hint:
   * `suggestedRole` would run `ensureGezel`, which can recruit a SECOND
   * foreman alongside the one already leading this project.
   */
  voormanGezelId?: string;
}

/** Workspace-relative paths in prompts always read with forward slashes. */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Find a discovered skill by its workspace-relative source path.
 *
 * Separator-insensitive on purpose: the scanner stores whatever
 * `path.relative` produced (backslashes on Windows), while every caller
 * that types a path by hand — a model, the CLI, a docs example — writes
 * forward slashes. Matching the raw strings makes the same request work
 * on macOS and 404 on Windows.
 */
export function findDiscoveredSkill(
  skills: readonly DiscoveredSkill[],
  source: string,
): DiscoveredSkill | undefined {
  const wanted = posixPath(source);
  return skills.find((s) => posixPath(s.source) === wanted);
}

/** The directory the SKILL.md lives in — companion files are relative to it. */
function skillDir(source: string): string {
  const normalized = posixPath(source);
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : '';
}

/** Assign a coordination step to the project's voorman, by id or by role. */
function voormanBinding(opts: SkillInvocationOptions): Partial<NewCraftbookStep> {
  return opts.voormanGezelId
    ? { assignee: { kind: 'gezel', gezelId: opts.voormanGezelId } }
    : { suggestedRole: VOORMAN_ROLE };
}

function triagePrompt(skill: DiscoveredSkill): string {
  const source = posixPath(skill.source);
  const companions = (skill.files ?? []).map((f) => `\`${skillDir(source)}/${f.relPath}\``);
  const companionLine =
    companions.length > 0
      ? ` It ships with companion files — ${companions.join(', ')} — read the ones it depends on before you decide.`
      : '';
  const shellLine = skill.hasShellScripts
    ? '\n\nThis skill contains shell blocks. Gezel does not run shell: whoever takes step 2 has to reach the same outcome with the tools they actually have, so weigh that when you pick the role.'
    : '';

  return [
    `A workspace skill has been handed to you: **${skill.name}** (\`${source}\`).`,
    '',
    'You are not the one running it. Read it, judge whether it can be run here, and put it in the right hands.',
    '',
    `1. \`read_file({ path: "${source}" })\` — read the whole skill.${companionLine}`,
    '2. Check what it needs against THIS workspace: the files, inputs, and tools it names. Check them, do not assume they exist.',
    '3. `write_task_note` with your verdict — what the skill produces, what it needs, and the job title of the craftsman who should run it. Step 3 verifies the run against this note, so name the concrete outputs you expect.',
    '4. Then exactly one of:',
    `   - **Runnable here** → \`craftbook_update_step({ stepId: "${SKILL_RUN_STEP_ID}", suggestedRole: "<job title>" })\`, then \`advance_task_step({ stepId: "${SKILL_TRIAGE_STEP_ID}" })\`. That opens step 2 with a gezel of that role — one is recruited if the crew has nobody suitable.`,
    '   - **Not runnable here** → `set_task_status({ status: "paused" })`, with a note naming exactly what is missing. Do not advance.',
    '',
    'Pick the role from the work the skill actually does — "developer", "reviewer", "designer", "researcher", "copywriter", "planner" — not from the skill\'s title.',
    shellLine,
  ]
    .join('\n')
    .trim();
}

function runPrompt(skill: DiscoveredSkill): string {
  const source = posixPath(skill.source);
  const dir = skillDir(source);
  const companionLine =
    (skill.files ?? []).length > 0
      ? ` Its companion files live under \`${dir}/\` — open one with \`read_file\` when a step calls for it; never work from memory of them.`
      : '';

  return [
    `Run the workspace skill **${skill.name}**, defined in \`${source}\`.${companionLine}`,
    '',
    'Start with `read_task_notes` — the voorman assessed this skill and recorded which outputs are expected of you.',
    '',
    "The skill's own procedure follows. Work it as written; when it is done, `write_task_note` naming each file you produced (with its path) and `advance_task_step` so the voorman can verify.",
    '',
    '---',
    '',
    skill.body,
  ].join('\n');
}

function verifyPrompt(skill: DiscoveredSkill): string {
  return [
    `**${skill.name}** has been run. Verify it actually delivered before this task closes.`,
    '',
    '1. `read_task_notes` — your own triage verdict and the notes from the run.',
    '2. Check each output the skill was supposed to produce: open the file (`read_file` / `read_artifact`). A summary claiming it exists is not evidence.',
    '3. Then exactly one of:',
    '   - **Delivered** → `set_task_status({ status: "complete", verification: "<one line per output, with its path>" })`.',
    `   - **Gaps** → \`advance_task_step({ stepId: "${SKILL_VERIFY_STEP_ID}", next: "${SKILL_RUN_STEP_ID}" })\` after a note naming exactly what is missing, so it goes back for another pass.`,
  ].join('\n');
}

/**
 * The three-step scaffold for one skill. Pure — the caller supplies the
 * voorman binding and owns task creation.
 */
export function skillInvocationSteps(
  skill: DiscoveredSkill,
  opts: SkillInvocationOptions = {},
): NewCraftbookStep[] {
  const voorman = voormanBinding(opts);
  return [
    {
      id: SKILL_TRIAGE_STEP_ID,
      name: `Assess "${skill.name}" and assign it`,
      description: 'Read the skill, judge whether this workspace can run it, choose the craftsman.',
      prompt: triagePrompt(skill),
      ...voorman,
    },
    {
      id: SKILL_RUN_STEP_ID,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      prompt: runPrompt(skill),
      // No role: step 1 stamps one on. A role guessed here would win over
      // the voorman's read of the skill (`maybeResolveStepRole` respects an
      // existing binding), which is the whole point of triaging first.
    },
    {
      id: SKILL_VERIFY_STEP_ID,
      name: 'Verify the skill delivered',
      description: 'Check the promised outputs exist before the task closes.',
      prompt: verifyPrompt(skill),
      terminal: true,
      ...voorman,
    },
  ];
}

export interface SkillInvocationDeps {
  store: Pick<Store, 'getProject' | 'getGezel'>;
  tasks: Pick<TaskManager, 'create'>;
  taskRunner: Pick<TaskRunner, 'enqueueHandoff'>;
  history?: Pick<HistoryManager, 'log'>;
}

export interface SkillInvocationResult {
  task: Task;
  dispatch: EntryDispatchResult;
}

/**
 * Create and kick off the triage-first task for a discovered skill.
 *
 * The task is created with NO explicit assignee so the entry step's
 * binding becomes the owner (`assigneeAuto`) — the voorman, not the user.
 * `dispatchTaskEntry` is the same single-channel kickoff the command
 * launcher and the `dispatchEntry` create flag use; without it the task
 * sits active with nobody engaged, which is exactly the failure this
 * scaffold exists to fix.
 */
export async function invokeWorkspaceSkill(
  deps: SkillInvocationDeps,
  projectId: string,
  skill: DiscoveredSkill,
): Promise<SkillInvocationResult> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  const voormanGezelId = project?.voormanGezelId;
  const source = posixPath(skill.source);

  const task = await deps.tasks.create(projectId, {
    title: `${skill.name} (workspace skill)`,
    description:
      `Run the workspace skill "${skill.name}" (${source}) against this project. The voorman assesses it first and assigns the craftsman.${
        skill.description ? ` ${skill.description}` : ''
      }`.slice(0, 2000),
    steps: skillInvocationSteps(skill, {
      ...(voormanGezelId ? { voormanGezelId } : {}),
    }),
    entryStepId: SKILL_TRIAGE_STEP_ID,
    createdBy: { kind: 'user' },
  });

  const dispatch = await dispatchTaskEntry(
    {
      store: deps.store,
      taskRunner: deps.taskRunner,
      ...(deps.history ? { history: deps.history } : {}),
    },
    task,
  );
  if (!dispatch.enqueued) {
    log.warn(
      `[import-sync] ${projectId}: skill "${skill.name}" task ${task.ref} created but not started (${dispatch.reason ?? 'unknown'})`,
    );
  }
  return { task, dispatch };
}
