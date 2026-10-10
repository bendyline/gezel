import type {
  CraftbookStepOutputMedium,
  CraftbookStepWritableOutputMedium,
  NewCraftbookStep,
} from './schemas/craftbook.js';
import { requiredOutputMediaForGate, stepOnEnterProducesAdvanceFile } from './schemas/craftbook.js';
import type { TaskCraftbookStep } from './schemas/task.js';

const TASK_NOTE_OUTPUT_SIGNAL =
  /\bwrite_task_note\b|\b(?:write|record|append|summarize)[^.!?\n]{0,100}\b(?:task\s+)?notes?\b|\bwrite\s+PASS\s*\/\s*FAIL\b/i;

const WORKSPACE_MUTATION_SIGNAL =
  /\b(?:write_file|append_to_file|replace_in_file|replace_lines|apply_patch|insert_at_marker)\b|\b(?:edit|change|patch|fix)\b[^.!?\n]{0,80}\b(?:actual|workspace|source|project)\s+files?\b|\b(?:add|create|implement|modify|strengthen|update|write)\b[^.!?\n]{0,100}\b(?:regression\s+tests?|tests?\s+(?:case|file|suite)|source\s+(?:code|files?)|code\s+(?:fix|change|implementation))\b/i;

/**
 * A procedure that tells the step to write a named file in prose — "write
 * `brief.md`", "save the recipe to `automations/<slug>.json`" — needs a writer
 * as much as one that names `write_file`. Without this the policy fell back to
 * `none` or `task-note`, `builtinDisallows` removed `workspace-fs-write`, and
 * freeze-scope, reviewer-loop and automation-recipe each shipped a step told
 * to write a file with nothing that could (2026-10-10 coverage run, 0 of 6
 * models' fault). A `{{workPath}}`, `{{task.dir}}` or `tasks/` path is the
 * artifacts drawer.
 */
const PROSE_FILE_OUTPUT =
  /\b(?:write|writes|writing|save|saves|saving|create|creates|creating|produce|produces|generate|generates|emit|emits|draft|drafts)\b([^.!?\n`]{0,80}?)(?:`((?:\{\{[\w.]+\}\}\/)?[\w.<>{}\/-]*\.(?:md|json|html?|csv|tsv|txt|ya?ml|xml|js|mjs|ts|py|sh|svg))`|((?:\{\{[\w.]+\}\}\/|[\w.<>{}-]+\/)[\w.<>{}\/-]*\.(?:md|json|html?|csv|tsv|txt|ya?ml|xml|js|mjs|ts|py|sh|svg))\b)/gi;
/** A path after one of these words is an input the output draws on, not the output. */
const INPUT_PATH_LEAD =
  /\b(?:from|following|per|against|using|read|reading|open|opening|check|checking|cite|citing|based on)\b/i;

/** Artifacts-drawer paths: the task folder and the accessory prefixes. */
const ARTIFACT_PATH = /^(?:\{\{(?:workPath|task\.dir)\}\}|tasks\/|notes\/|reviews\/|reports\/)/;

function proseFileOutputMedium(
  text: string,
  step: NewCraftbookStep,
): CraftbookStepWritableOutputMedium | null {
  for (const m of text.matchAll(PROSE_FILE_OUTPUT)) {
    const path = m[2] ?? m[3];
    if (!path || INPUT_PATH_LEAD.test(m[1] ?? '')) continue;
    // Paths are relative to their declared drawer. An artifact handoff such
    // as security/review.md must not acquire workspace writes just because
    // its prefix is unfamiliar (nor should a workspace reports/ path drift
    // into artifacts). Only undeclared paths need the prefix heuristic.
    if (step.deliverable?.path === path) {
      return step.deliverable.artifact ? 'artifact' : 'workspace';
    }
    if (step.advanceWhen?.file === path) {
      return step.advanceWhen.artifact ? 'artifact' : 'workspace';
    }
    const check = gateChecks(step).find((check) => check.file === path);
    if (check) return check.artifact === true ? 'artifact' : 'workspace';
    return ARTIFACT_PATH.test(path) ? 'artifact' : 'workspace';
  }
  return null;
}

function procedureText(step: NewCraftbookStep): string {
  return [step.name, step.description, step.prompt, step.suggestedRole].filter(Boolean).join('\n');
}

function gateChecks(step: NewCraftbookStep): Array<Record<string, unknown>> {
  const gate = step.gate;
  return gate && 'checks' in gate && Array.isArray(gate.checks)
    ? (gate.checks as Array<Record<string, unknown>>)
    : [];
}

/** Resolve the authored blueprint's primary result drawer without prompt inference. */
export function outputMediumForCraftbookBlueprint(
  step: NewCraftbookStep,
): CraftbookStepOutputMedium {
  const gateRequiredMedia = [...requiredOutputMediaForGate(step.gate)];
  const runtimeOwnsAdvanceFile = stepOnEnterProducesAdvanceFile(step);
  if (step.toolPolicy?.outputMedium) {
    // A gate is an executable exit contract. It outranks a contradictory
    // `none` annotation, which would otherwise author a step that cannot
    // produce the state its own gate inspects.
    if (step.toolPolicy.outputMedium === 'none' && gateRequiredMedia[0]) {
      return gateRequiredMedia[0];
    }
    const advanceSurface = step.advanceWhen?.artifact ? 'artifact' : 'workspace';
    if (runtimeOwnsAdvanceFile && step.toolPolicy.outputMedium === advanceSurface) {
      return gateRequiredMedia[0] ?? 'none';
    }
    return step.toolPolicy.outputMedium;
  }
  if (step.deliverable?.path) return step.deliverable.artifact ? 'artifact' : 'workspace';
  if (step.advanceWhen?.file && !runtimeOwnsAdvanceFile) {
    return step.advanceWhen.artifact ? 'artifact' : 'workspace';
  }
  if (runtimeOwnsAdvanceFile) return gateRequiredMedia[0] ?? 'none';
  const fileCheck = gateChecks(step).find(
    (check) => typeof check.file === 'string' && check.file.length > 0,
  );
  if (fileCheck) return fileCheck.artifact === true ? 'artifact' : 'workspace';
  if (gateRequiredMedia[0]) return gateRequiredMedia[0];
  const text = procedureText(step);
  if (
    /\b(?:write_file|append_to_file|replace_in_file|replace_lines|apply_patch|insert_at_marker)\b/i.test(
      text,
    )
  ) {
    return 'workspace';
  }
  if (/\bwrite_artifact\b/i.test(text)) return 'artifact';
  const prose = proseFileOutputMedium(text, step);
  if (prose) return prose;
  return TASK_NOTE_OUTPUT_SIGNAL.test(text) ? 'task-note' : 'none';
}

/**
 * Every output surface the authored step procedure requires after applying
 * the same inference used to persist generated policies. Runtime consumers
 * use this as a compatibility floor for tasks embedded from an older catalog
 * whose generated `additionalOutputMedia` predates the current detector.
 */
export function outputMediaForCraftbookBlueprint(
  step: NewCraftbookStep,
): ReadonlySet<CraftbookStepWritableOutputMedium> {
  const primary = outputMediumForCraftbookBlueprint(step);
  return new Set([
    ...(primary === 'none' ? [] : [primary]),
    ...additionalOutputMediaForStep(step, primary),
  ] as CraftbookStepWritableOutputMedium[]);
}

export function additionalOutputMediaForStep(
  step: NewCraftbookStep,
  primary: CraftbookStepOutputMedium,
): CraftbookStepWritableOutputMedium[] {
  if (primary === 'none') return [];
  const text = procedureText(step);
  const out = new Set(step.toolPolicy?.additionalOutputMedia ?? []);
  for (const medium of requiredOutputMediaForGate(step.gate)) out.add(medium);
  if (WORKSPACE_MUTATION_SIGNAL.test(text)) {
    out.add('workspace');
  }
  if (/\bwrite_artifact\b/i.test(text)) out.add('artifact');
  const prose = proseFileOutputMedium(text, step);
  if (prose) out.add(prose);
  if (TASK_NOTE_OUTPUT_SIGNAL.test(text)) out.add('task-note');
  out.delete(primary as CraftbookStepWritableOutputMedium);
  return [...out].sort();
}

/**
 * Resolve the step's result surface. Explicit JSON wins. Legacy/file-gated
 * steps get the same unambiguous behavior immediately, before their catalog
 * entry has been republished with `toolPolicy.outputMedium`.
 */
export function outputMediumForStep(
  step: Pick<TaskCraftbookStep, 'toolPolicy' | 'advanceWhen' | 'gate' | 'onEnter'> | undefined,
): CraftbookStepOutputMedium | null {
  if (!step) return null;
  const gateRequiredMedia = [...requiredOutputMediaForGate(step.gate)];
  const runtimeOwnsAdvanceFile = stepOnEnterProducesAdvanceFile(step);
  if (step.toolPolicy?.outputMedium) {
    const advanceSurface = step.advanceWhen?.artifact ? 'artifact' : 'workspace';
    if (runtimeOwnsAdvanceFile && step.toolPolicy.outputMedium === advanceSurface) {
      return gateRequiredMedia[0] ?? 'none';
    }
    return step.toolPolicy.outputMedium;
  }
  if (step.advanceWhen?.file && !runtimeOwnsAdvanceFile) {
    return step.advanceWhen.artifact ? 'artifact' : 'workspace';
  }
  if (runtimeOwnsAdvanceFile) return gateRequiredMedia[0] ?? 'none';
  const gate = step.gate;
  const checks = gate && 'checks' in gate && Array.isArray(gate.checks) ? gate.checks : [];
  const fileCheck = checks.find(
    (check): check is (typeof checks)[number] & { file: string; artifact?: boolean } =>
      'file' in check && typeof check.file === 'string' && check.file.length > 0,
  );
  if (gateRequiredMedia[0]) return gateRequiredMedia[0];
  if (fileCheck) return fileCheck.artifact ? 'artifact' : 'workspace';
  return null;
}

/** Primary plus explicitly-authorized secondary result surfaces. */
export function outputMediaForStep(
  step:
    | Partial<
        Pick<
          TaskCraftbookStep,
          | 'name'
          | 'description'
          | 'prompt'
          | 'suggestedRole'
          | 'toolPolicy'
          | 'advanceWhen'
          | 'gate'
          | 'consumes'
          | 'onEnter'
          | 'onExit'
        >
      >
    | undefined,
): ReadonlySet<CraftbookStepOutputMedium> {
  const primary = outputMediumForStep(step);
  const procedureMedia = step?.name
    ? outputMediaForCraftbookBlueprint(step as NewCraftbookStep)
    : new Set<CraftbookStepOutputMedium>();
  if (!primary) return procedureMedia;
  const gateRequiredMedia = requiredOutputMediaForGate(step?.gate);
  if (primary === 'none') {
    const required = new Set([...procedureMedia, ...gateRequiredMedia]);
    return required.size > 0 ? required : new Set(['none']);
  }
  return new Set([
    primary,
    ...(step?.toolPolicy?.additionalOutputMedia ?? []),
    ...procedureMedia,
    ...gateRequiredMedia,
  ]);
}
