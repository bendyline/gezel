import {
  CraftbookSchema,
  NewCraftbookStepSchema,
  StepPositionSchema,
  applyStepPatch,
  removeStepAndCleanEdges,
  reorderStepsArray,
  stepInsertionIndex,
  uniqueStepId,
  validateCraftbookGraph,
} from '../schemas/craftbook.js';
import {
  type Task,
  type UpdateTaskCraftbookRequest,
  UpdateTaskCraftbookRequestSchema,
  UpdateTaskNoteRequestSchema,
  type UpdateTaskStepRequest,
  UpdateTaskStepRequestSchema,
} from '../schemas/task.js';
import { encodeText } from './files.js';
import { requireGezel } from './gezels.js';
import { requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';
import { resolvePortableTaskExecution } from './task-execution.js';
import {
  assertPortableCraftbookSupported,
  editTaskStructure,
  getTask,
  listTaskNotes,
  taskLocation,
} from './tasks.js';

async function validate(repo: PortableRepository, task: Task) {
  const problems = validateCraftbookGraph(task.craftbook);
  if (problems.length) throw new Error(problems.join('; '));
  assertPortableCraftbookSupported(CraftbookSchema.parse(task.craftbook));
  for (const step of task.craftbook.steps) {
    if (step.assignee?.kind === 'gezel') await requireGezel(repo, step.assignee.gezelId);
    if (step.suggestedGezelId) await requireGezel(repo, step.suggestedGezelId);
  }
  if (task.craftbook.defaultAssignee?.kind === 'gezel')
    await requireGezel(repo, task.craftbook.defaultAssignee.gezelId);
}
export function updateTaskStep(
  repo: PortableRepository,
  ref: string,
  stepId: string,
  raw: UpdateTaskStepRequest,
) {
  const patch = UpdateTaskStepRequestSchema.parse(raw);
  return editTaskStructure(repo, ref, async (task) => {
    const index = task.craftbook.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw new Error('Task step not found');
    task.craftbook.steps[index] = applyStepPatch(task.craftbook.steps[index]!, patch);
    await validate(repo, task);
  });
}
export function addTaskStep(repo: PortableRepository, ref: string, raw: unknown) {
  const step = NewCraftbookStepSchema.parse(raw);
  const position = StepPositionSchema.parse(raw);
  return editTaskStructure(repo, ref, async (task) => {
    const created = {
      ...step,
      id: uniqueStepId(task.craftbook.steps, step.name, step.id),
      createdAt: repo.now(),
    };
    task.craftbook.steps.splice(stepInsertionIndex(task.craftbook.steps, position), 0, created);
    await validate(repo, task);
  });
}
export function removeTaskStep(repo: PortableRepository, ref: string, stepId: string) {
  return editTaskStructure(repo, ref, async (task) => {
    task.craftbook.steps = removeStepAndCleanEdges(task.craftbook.steps, stepId);
    if (task.craftbook.entryStepId === stepId)
      task.craftbook.entryStepId = task.craftbook.steps[0]!.id;
    if (task.activeStepId === stepId) {
      task.activeStepId = task.craftbook.steps.find((step) => !step.completedAt)?.id;
      if (!task.activeStepId) task.status = 'complete';
    }
    await validate(repo, task);
  });
}
export function reorderTaskSteps(repo: PortableRepository, ref: string, order: string[]) {
  return editTaskStructure(repo, ref, async (task) => {
    task.craftbook.steps = reorderStepsArray(task.craftbook.steps, order);
    await validate(repo, task);
  });
}
export function updateTaskCraftbook(
  repo: PortableRepository,
  ref: string,
  raw: UpdateTaskCraftbookRequest,
) {
  const patch = UpdateTaskCraftbookRequestSchema.parse(raw);
  return editTaskStructure(repo, ref, async (task) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete (task.craftbook as Record<string, unknown>)[key];
      else if (value !== undefined) (task.craftbook as Record<string, unknown>)[key] = value;
    }
    await validate(repo, task);
  });
}
export function activateTaskStep(repo: PortableRepository, ref: string, stepId: string) {
  return editTaskStructure(
    repo,
    ref,
    async (task) => {
      if (!task.craftbook.steps.some((step) => step.id === stepId))
        throw new Error('Task step not found');
      if (task.status === 'canceled') throw new Error('Canceled tasks cannot be reactivated');
      if (task.status === 'draft') await resolvePortableTaskExecution(repo, task);
      task.activeStepId = stepId;
      task.status = 'active';
      const step = task.craftbook.steps.find((step) => step.id === stepId)!;
      delete step.completedAt;
      delete step.onEnterCompletedAt;
    },
    true,
  );
}
export async function editTaskNote(
  repo: PortableRepository,
  ref: string,
  noteId: string,
  raw?: unknown,
) {
  const task = await getTask(repo, ref);
  if (!task) throw new Error('Task not found');
  const project = await requireProject(repo, task.projectId);
  if (project.status === 'readonly' || project.archived)
    throw new Error('This project does not accept task changes');
  const notes = await listTaskNotes(repo, ref);
  const index = notes.findIndex((note) => note.id === noteId);
  if (index < 0) throw new Error('Task note not found');
  const note =
    raw === undefined ? undefined : { ...notes[index]!, ...UpdateTaskNoteRequestSchema.parse(raw) };
  if (note && (!note.text.trim() || note.text.length > 64_000))
    throw new Error('A task note must contain 1–64000 characters');
  if (note) notes[index] = note;
  else notes.splice(index, 1);
  await repo.transactions.commit(
    new Map([
      [
        `${taskLocation(ref).root}/notes.jsonl`,
        encodeText(notes.map((item) => `${JSON.stringify(item)}\n`).join('')),
      ],
    ]),
  );
  return note;
}
