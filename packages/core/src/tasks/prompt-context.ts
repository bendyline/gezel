/**
 * The task section of a system prompt: the current task, its outline for a
 * generalist owner, the active step's procedure and output contract, its
 * gate, its notes, and which task tools this turn wired.
 *
 * One renderer for both hosts. The desktop's is the eval-tuned one, so the
 * portable host adopts its wording; the portable host had shown every
 * step's full procedure at once, which is exactly what one-step-at-a-time
 * disclosure is meant to prevent. The block is deterministic in the task,
 * the step, the notes and the tool names, carries no timestamps and no
 * project prose, so a host that caches prompt prefixes can place it in its
 * volatile band unchanged.
 */
import { outputMediaForStep, outputMediumForStep } from '../craftbook-output-media.js';
import type { CraftbookStep } from '../schemas/craftbook.js';
import { normalizeStepGate } from '../schemas/gate.js';
import { normalizeScriptRefs } from '../schemas/script.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import { renderGateHandoffBlock } from './gate-handoff.js';

export interface PromptTaskContext {
  task: Task;
  step?: TaskCraftbookStep;
  notes?: string;
  stepNotes?: string;
}

/**
 * A craftbook step is a "gate", a phase the model must hold at until its exit
 * criteria are met rather than advance past on its first attempt, when it
 * loops back (an outgoing edge targets itself or an earlier step), carries
 * `onExit` scripts, or carries a completion gate. Forward-only books get no
 * gate anchor, by design.
 */
export function isGatedStep(
  step: Pick<CraftbookStep, 'id' | 'next' | 'branches' | 'onExit' | 'gate'>,
  steps: ReadonlyArray<Pick<CraftbookStep, 'id'>>,
): boolean {
  if (normalizeScriptRefs(step.onExit).length > 0) return true;
  if (step.gate && normalizeStepGate(step.gate).at === 'completion') return true;
  const idx = steps.findIndex((s) => s.id === step.id);
  if (idx < 0) return false;
  const targets = [...(step.next ? [step.next] : []), ...(step.branches?.map((b) => b.goto) ?? [])];
  return targets.some((target) => {
    const ti = steps.findIndex((s) => s.id === target);
    return ti >= 0 && ti <= idx;
  });
}

/**
 * The bird's-eye view a generalist task carries on every turn: the goal the
 * book works toward and every step with its state, so one owner walking the
 * whole task can shape today's step for tomorrow's. The closing sentence
 * names `advance_task_step` only when the turn wired it.
 */
export function renderTaskOutline(
  task: Task,
  activeStep: TaskCraftbookStep | undefined,
  opts: { advanceWired: boolean },
): string {
  const goal = (task.craftbook.description ?? task.description ?? '').trim();
  const activeId = activeStep?.id ?? task.activeStepId;
  const steps = task.craftbook.steps.map((s, i) => {
    const state = s.completedAt ? 'done' : s.id === activeId ? 'active' : 'pending';
    const desc = s.description?.trim() ? ` — ${s.description.trim()}` : '';
    const gated = isGatedStep(s, task.craftbook.steps) ? ' (gated)' : '';
    const fanout = s.spawnFanout
      ? ' [fanout: the runtime spawns one child task per item here and holds this step until they settle]'
      : '';
    return `${i + 1}. ${s.name} (${state})${desc}${gated}${fanout}`;
  });
  const reveal = opts.advanceWired
    ? 'finish and pass them before `advance_task_step` reveals the next'
    : 'finish and pass them before the next step is revealed';
  return [
    '### Task outline',
    ...(goal ? [`Goal: ${goal}`] : []),
    ...steps,
    '',
    `You own every step of this task in this one conversation. Steps are disclosed one at a time; the **Step procedure** and **Phase gate** below are the authoritative instructions now — ${reveal}.`,
  ].join('\n');
}

/**
 * The whole task section. `availableToolNames` undefined means every tool is
 * wired; a set narrows the guidance to the tools this turn actually has.
 */
export function renderTaskContextBlock(
  task: PromptTaskContext,
  options: { availableToolNames?: ReadonlySet<string> } = {},
): string {
  const availableToolNames = options.availableToolNames;
  const wired = (name: string) => availableToolNames === undefined || availableToolNames.has(name);
  const activeStepAttempt = task.step?.attemptCount ?? 0;
  const activeStepIsGate = task.step ? isGatedStep(task.step, task.task.craftbook.steps) : false;
  const t = task.task;
  const step = task.step;
  const assigneeLabel = t.assignee.kind === 'user' ? 'the user' : t.assignee.gezelId;
  const lines: string[] = [
    `### Current task: ${t.ref} — "${t.title}"`,
    `Status: **${t.status}**. Assigned to: **${assigneeLabel}**.`,
  ];
  if (t.executionMode === 'generalist') {
    lines.push(
      renderTaskOutline(t, step, {
        advanceWired: wired('advance_task_step'),
      }),
    );
  }
  // Drafting mode is a property of the RUN, injected by the runtime — a
  // craftbook must read identically whether it edits in place or drafts a
  // proposal, so no book carries this prose itself. Saying it plainly is
  // load-bearing: a gezel that believes it edited the workspace writes
  // "fixed" into its task notes, and that claim flows into the issue
  // lifecycle and the review card the user reads.
  if (t.diffpackId) {
    const editToolsWired =
      availableToolNames === undefined ||
      ['write_file', 'replace_in_file', 'replace_lines'].some((name) =>
        availableToolNames.has(name),
      );
    const toolSentence = editToolsWired
      ? 'Use `read_file`, `write_file`, `replace_in_file`, and `replace_lines` exactly as you always do. They behave normally and you will read your own edits back — but they land in the proposal.'
      : 'Your file edits land in the proposal, and you will read your own edits back.';
    lines.push(
      [
        '#### Change-proposal mode',
        '',
        `You are drafting CHANGE PROPOSAL DP-${t.diffpackId}, not editing this project.`,
        '',
        toolSentence,
        'The project files do not change until a person reviews the proposal and clicks',
        'Apply. Never claim you "fixed" or "applied" anything; you proposed it.',
        '',
        'Anything that RUNS the project — scripts, tests, a build — still sees the',
        'unmodified files, so it cannot confirm your change. Say what you could not',
        'verify rather than implying you did.',
      ].join('\n'),
    );
  }
  // Fanout children advertise the HOST's folder (artifactDir is inherited
  // at spawn) — shards share one namespace so collect gates resolve.
  // Roster-gated: naming a tool the turn didn't wire is a documented
  // failure class (ADR 0001).
  const taskArtifactFolder = t.artifactDir ?? `tasks/${t.num}`;
  if (wired('write_artifact')) {
    lines.push(
      `Task artifact folder: \`${taskArtifactFolder}/\` in the **artifacts drawer** — store this task's working files (notes, drafts, reports, analysis) there, e.g. \`write_artifact({ path: ${JSON.stringify(`${taskArtifactFolder}/notes.md`)}, ... })\`, unless the step procedure names another path.`,
    );
  }
  if (t.craftbookParams && Object.keys(t.craftbookParams).length > 0) {
    const params = Object.entries(t.craftbookParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const safeKey = key.replaceAll('`', '\\`');
        const safeValue = JSON.stringify(value).replaceAll('`', '\\`');
        return `- \`${safeKey}\`: ${safeValue}`;
      })
      .join('\n');
    lines.push(
      `### Invocation parameters\n\nThese values were supplied when the task was launched and are authoritative task inputs. Do not replace them with unrelated workspace files or recalled context. A \`content\` value is inline source material; a \`sourcePath\` value names the workspace file to read.\n\n${params}`,
    );
  }
  if (t.description) lines.push(t.description.trim());
  if (step) {
    const stepAssignee =
      step.assignee?.kind === 'user'
        ? 'the user'
        : (step.assignee?.gezelId ?? step.suggestedGezelId ?? assigneeLabel);
    lines.push(
      `Active step: **${step.name}** (id: \`${step.id}\`). Step assignee/suggestion: **${stepAssignee}**.`,
    );
    if (step.description) lines.push(step.description.trim());
    // step.prompt carries the *procedure* — the concrete instructions the
    // craftbook author wrote for this step ("call github_pr_list, then
    // run the pr-context script…"). Missing this turns a multi-paragraph
    // recipe into a one-sentence pep talk and medium-tier models go
    // straight into "let me re-read task notes" loops looking for the
    // procedure that's already in the manifest.
    if (step.prompt && step.prompt.trim().length > 0) {
      lines.push(`#### Step procedure\n\n${step.prompt.trim()}`);
    }
    const handoffBlock = renderGateHandoffBlock(t, step.id);
    if (handoffBlock) lines.push(handoffBlock);
    const outputMedium = outputMediumForStep(step);
    if (outputMedium) {
      const target = step.advanceWhen?.file ? ` \`${step.advanceWhen.file}\`` : '';
      const allowedMedia = outputMediaForStep(step);
      const additionalMedia = (step.toolPolicy?.additionalOutputMedia ?? []).filter(
        (medium) => medium !== outputMedium && allowedMedia.has(medium),
      );
      const additionalContract =
        additionalMedia.length > 0
          ? ` The procedure also authorizes these secondary write surfaces: ${additionalMedia
              .map((medium) => `**${medium}**`)
              .join(', ')}. They do not substitute for the primary result.`
          : '';
      const contract =
        outputMedium === 'workspace'
          ? `Write the primary result${target} in the **project workspace**.`
          : outputMedium === 'artifact'
            ? `Write the primary result${target} in the **artifacts drawer** with \`write_artifact\`.`
            : outputMedium === 'task-note'
              ? 'Write the primary result with `write_task_note`.'
              : 'This step has no persisted output. Do not create a workspace file, artifact, shared document, or task note.';
      lines.push(
        `#### Output contract\n\n${contract}${additionalContract} Any write surface not listed here is intentionally unavailable; do not substitute one drawer for another.`,
      );
    }
    if (step.consumes && step.consumes.length > 0) {
      const inputLines = step.consumes.map((input) => {
        const tool = input.artifact ? 'read_artifact' : 'read_file';
        const drawer = input.artifact ? 'artifacts drawer' : 'project workspace';
        const call = `${tool}({ path: ${JSON.stringify(input.file)} })`;
        return wired(tool)
          ? `- \`${input.file}\` — required input in the **${drawer}**. Open it with \`${call}\`; do not try the other drawer.`
          : `- \`${input.file}\` — required input in the **${drawer}**, but \`${tool}\` is not wired this turn. Do not claim it is missing; delegate or surface the unavailable read capability.`;
      });
      lines.push(`#### Required inputs\n\n${inputLines.join('\n')}`);
    }
    if (activeStepIsGate) {
      const attemptNote =
        activeStepAttempt > 1
          ? ` You are on **attempt ${activeStepAttempt}** of this step — a previous pass did not clear the gate, so fix the specific gap named in the notes rather than starting over.`
          : '';
      // A completion gate is enforced BY THE RUNTIME: advance_task_step
      // returns a rejection verdict until the gate's checks/scripts
      // approve. Tell the model that explicitly so a rejection reads
      // as actionable feedback, not a tool malfunction.
      const hasCompletionGate =
        step.gate !== undefined && normalizeStepGate(step.gate).at === 'completion';
      const enforcementNote = hasCompletionGate
        ? ' This gate is enforced automatically: `advance_task_step` will be REJECTED with a verdict naming the unmet criteria until they are genuinely met — read the rejection message and fix exactly what it names.'
        : '';
      lines.push(
        `#### Phase gate\n\nThis phase is a **gate**: it does not advance until its exit criteria are actually met. Before you \`advance_task_step\` forward, verify those criteria against the deliverable and the task notes. If any criterion is unmet, route as the procedure says (loop back / re-run the gate) and address the named gap — do **not** advance to a "finish"/"ship" step with anything unmet. Under-delivering is the failure this gate exists to catch.${enforcementNote}${attemptNote}`,
      );
    }
  }
  if (t.plan && t.plan.trim().length > 0) {
    lines.push(`### Task plan\n\n${t.plan.trim()}`);
  }
  if (task.notes) {
    lines.push(`### Task notes\n\n${task.notes}`);
  }
  if (task.stepNotes && step) {
    lines.push(`### Notes for step "${step.name}"\n\n${task.stepNotes}`);
  }
  const taskToolCandidates = [
    'read_task_notes',
    'write_task_note',
    'advance_task_step',
    'set_task_status',
    'update_task',
    'assign_task',
    'search_history',
  ];
  const taskToolsThisTurn = availableToolNames
    ? taskToolCandidates.filter((name) => availableToolNames.has(name))
    : taskToolCandidates;
  if (taskToolsThisTurn.length > 0) {
    lines.push(
      `Task tools wired this turn: ${taskToolsThisTurn.map((name) => `\`${name}\``).join(', ')}. Use only these task tools to record progress or move the workflow.`,
    );
  }
  lines.push(
    wired('read_task_notes')
      ? 'The task plan and notes above are a snapshot taken when this session started — call `read_task_notes` if you need the latest.'
      : 'The task plan and notes above are the task context available this turn; no task-note read tool is wired.',
  );
  return lines.join('\n\n');
}
