/**
 * Start a craftbook run from service code: resolve the book (project-local
 * books included), pick its owner, create the task, note the parameters on
 * the entry step, and dispatch it. Shared by the in-chat terminal's
 * craftbook commands and lookouts, so "who picks this up?" has one answer.
 */

import type { Task, TaskAssignee, TaskInputSource } from '@bendyline/gezel';
import { projectLeadGezelId } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { type EntryDispatchDeps, dispatchTaskEntry } from './entry-dispatch.js';
import type { CraftbookResolver, TaskManager } from './manager.js';

export interface CraftbookRunDeps {
  store: Pick<Store, 'getProject' | 'readConfig'> & EntryDispatchDeps['store'];
  tasks: Pick<TaskManager, 'create' | 'appendNote'>;
  taskRunner: EntryDispatchDeps['taskRunner'];
  history?: EntryDispatchDeps['history'];
  craftbookResolver: CraftbookResolver;
  /** The role→gezel resolution the step-activation path uses. */
  resolveRole: (role: string, projectId: string) => Promise<{ gezelId: string } | null>;
}

export interface CraftbookRunInput {
  projectId: string;
  craftbookId: string;
  params?: Record<string, string>;
  inputs?: Record<string, TaskInputSource>;
  /** Service-only provenance (`lookout`, …). */
  origin?: Task['origin'];
  title?: string;
  description?: string;
}

export interface CraftbookRunResult {
  task: Task;
  craftbookName: string;
  assigneeName?: string;
  started: boolean;
}

/**
 * Who owns a run: the gezel matching the entry step's role, else the
 * project's lead (voorman, or the Meester in Default), else the person.
 */
export async function resolveCraftbookOwner(
  deps: Pick<CraftbookRunDeps, 'store' | 'resolveRole'>,
  projectId: string,
  entryRole: string | undefined,
): Promise<TaskAssignee> {
  if (entryRole) {
    const owner = await deps.resolveRole(entryRole, projectId).catch(() => null);
    if (owner?.gezelId) return { kind: 'gezel', gezelId: owner.gezelId };
  }
  // A book whose entry step names no role — every SKILL.md conversion that
  // carried no persona — would otherwise launch owned by the user and never
  // dispatch: created, active, and inert.
  const project = await deps.store.getProject(projectId).catch(() => null);
  const config = await deps.store.readConfig().catch(() => null);
  const leadGezelId = project ? projectLeadGezelId(project, config?.meesterGezelId) : undefined;
  return leadGezelId ? { kind: 'gezel', gezelId: leadGezelId } : { kind: 'user' };
}

export async function startCraftbookRun(
  deps: CraftbookRunDeps,
  input: CraftbookRunInput,
): Promise<CraftbookRunResult> {
  const { projectId, craftbookId } = input;
  const params = input.params ?? {};
  // Resolve through the task resolver's chain, not the catalog alone: a
  // project-local book (`.gezel/craftbooks/`) is a book this project defined.
  const resolved = await deps.craftbookResolver
    .resolve(craftbookId, { projectId })
    .catch(() => null);
  if (!resolved) throw new Error(`unknown craftbook "${craftbookId}"`);
  const m = resolved.craftbook;

  const paramSummary = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const withClause = paramSummary ? ` with ${paramSummary}.` : '.';
  const tail = m.description ? ` ${m.description}` : '';
  const description = (
    input.description ?? `Run the "${m.name}" craftbook against this project${withClause}${tail}`
  ).slice(0, 2000);

  const entryRole = m.steps.find((s) => s.id === m.entryStepId)?.suggestedRole;
  const assignee = await resolveCraftbookOwner(deps, projectId, entryRole);

  const task = await deps.tasks.create(
    projectId,
    {
      title: input.title ?? `${m.name} — ${new Date().toLocaleString()}`,
      description,
      craftbookId,
      assignee,
      ...(Object.keys(params).length > 0 ? { craftbookParams: params } : {}),
      ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
      // A craftbook with a declarative `spawn` block becomes a spawn host:
      // its child template rides in as `spawnsCraftbook`, and the runtime
      // fans out one child per item when the `spawnFanout` step activates.
      ...(m.spawn
        ? {
            spawnsSteps: m.spawn.steps,
            ...(m.spawn.entryStepId ? { spawnsEntryStepId: m.spawn.entryStepId } : {}),
          }
        : {}),
      createdBy: { kind: 'user' },
    },
    ...(input.origin ? [{ origin: input.origin }] : []),
  );

  // Invocation params as an entry-step note, so the gezel reads them via
  // `read_task_notes` (mirrors spawnChild's instance context).
  if (Object.keys(params).length > 0 && task.activeStepId) {
    const lines = ['# Invocation parameters', ''];
    for (const [k, v] of Object.entries(params)) lines.push(`- **${k}**: ${v}`);
    await deps.tasks
      .appendNote(task.projectId, task.num, {
        text: lines.join('\n'),
        author: { kind: 'user' },
        stepId: task.activeStepId,
      })
      .catch(() => {
        /* note is best-effort */
      });
  }

  const dispatch = await dispatchTaskEntry(
    {
      store: deps.store,
      taskRunner: deps.taskRunner,
      ...(deps.history ? { history: deps.history } : {}),
    },
    task,
  );
  return {
    task,
    craftbookName: m.name,
    ...(dispatch.assigneeName ? { assigneeName: dispatch.assigneeName } : {}),
    started: dispatch.enqueued,
  };
}
