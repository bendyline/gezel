import { type TaskAssignee, projectLeadGezelId } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { type EntryDispatchDeps, dispatchTaskEntry } from '../tasks/entry-dispatch.js';
import type { CraftbookResolver, TaskManager } from '../tasks/manager.js';
import type { CraftbookInvoker } from '../terminal/manager.js';
import type { CraftbookCommandSpec } from '../terminal/resolve.js';
import {
  type ProjectGitStatusReader,
  listApplicableCraftbooks,
  projectCraftbookSummaries,
} from './applicable.js';

export interface CraftbookTerminalCommandDeps {
  store: Store;
  catalog: CatalogService;
  git: ProjectGitStatusReader;
  tasks: TaskManager;
  taskRunner: EntryDispatchDeps['taskRunner'];
  history?: EntryDispatchDeps['history'];
  craftbookResolver: CraftbookResolver;
  /** The role→gezel resolution the step-activation path uses. */
  resolveRole: (role: string, projectId: string) => Promise<{ gezelId: string } | null>;
}

export interface CraftbookTerminalCommands {
  listCraftbookCommands: (projectId: string) => Promise<CraftbookCommandSpec[]>;
  craftbookInvoker: CraftbookInvoker;
}

/**
 * The in-chat terminal's craftbook commands: which books a project
 * recognizes as commands (e.g. `code-review security high`), and the
 * launcher that turns one into a started task.
 */
export function createCraftbookTerminalCommands(
  deps: CraftbookTerminalCommandDeps,
): CraftbookTerminalCommands {
  const { store, catalog, git, tasks, taskRunner, history, craftbookResolver, resolveRole } = deps;

  // Only craftbooks applicable to THIS project (requirements met) are
  // recognized as terminal commands — so e.g. `pull-request-review`
  // isn't a command in a non-GitHub project. Project-local books are
  // merged in (shadowing same-id catalog entries) to match what the
  // launcher rail offers: without them, clicking a book this repo
  // defined itself staged a line the terminal then tried to run as a
  // shell command.
  const listCraftbookCommands = async (projectId: string): Promise<CraftbookCommandSpec[]> => {
    const projectItems = await projectCraftbookSummaries(store, projectId, { git });
    const projectIds = new Set(projectItems.map((it) => it.manifest.id));
    const catalogItems = await listApplicableCraftbooks(catalog, store, projectId, { git });
    const items = [
      ...projectItems,
      ...catalogItems.filter((it) => !projectIds.has(it.manifest.id)),
    ];
    return items.flatMap((it) =>
      it.manifest.kind === 'craftbook-template'
        ? [
            {
              id: it.manifest.id,
              command: it.manifest.command ?? it.manifest.id,
              ...(it.manifest.paramSchema ? { paramSchema: it.manifest.paramSchema } : {}),
            },
          ]
        : [],
    );
  };

  // NOTE: an ordinary entry step is NOT sent through `onStepActivated`, so
  // `dispatchTaskEntry` is its single kickoff. Deterministic entry setup may
  // auto-advance; that later phase uses `onStepActivated`, and the entry
  // helper refuses to dispatch it a second time. Its OTHER call site is the
  // create route's `dispatchEntry` flag (routes/project-tasks.ts, the
  // meester macros' path).
  const craftbookInvoker: CraftbookInvoker = async ({ projectId, craftbookId, params }) => {
    // Resolve through the task resolver's chain, not the catalog alone: a
    // project-local book (`.gezel/craftbooks/`, usually converted from a
    // repo SKILL.md) is offered by the launcher rail, so a catalog-only
    // lookup here rejected exactly the books this project defined itself.
    const resolved = await craftbookResolver.resolve(craftbookId, { projectId }).catch(() => null);
    if (!resolved) {
      throw new Error(`unknown craftbook "${craftbookId}"`);
    }
    const m = resolved.craftbook;

    const paramSummary = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const withClause = paramSummary ? ` with ${paramSummary}.` : '.';
    const tail = m.description ? ` ${m.description}` : '';
    const description =
      `Run the "${m.name}" craftbook against this project${withClause}${tail}`.slice(0, 2000);

    // Assignee = role-matched gezel for the entry step, not the user.
    const entryRole = m.steps.find((s) => s.id === m.entryStepId)?.suggestedRole;
    let assignee: TaskAssignee = { kind: 'user' };
    if (entryRole) {
      const owner = await resolveRole(entryRole, projectId).catch(() => null);
      if (owner?.gezelId) assignee = { kind: 'gezel', gezelId: owner.gezelId };
    }
    if (assignee.kind === 'user') {
      // A book whose entry step names no role — every SKILL.md conversion
      // that carried no persona — would otherwise launch owned by the user
      // and never dispatch: created, active, and inert, which reads to the
      // user as "I ran it and nothing happened". The project lead (voorman,
      // or the Meester in Default) is the standing answer to "who picks
      // this up?". Falls through to the user only when there is none.
      const project = await store.getProject(projectId).catch(() => null);
      const config = await store.readConfig().catch(() => null);
      const leadGezelId = project ? projectLeadGezelId(project, config?.meesterGezelId) : undefined;
      if (leadGezelId) assignee = { kind: 'gezel', gezelId: leadGezelId };
    }

    const task = await tasks.create(projectId, {
      title: `${m.name} — ${new Date().toLocaleString()}`,
      description,
      craftbookId,
      assignee,
      ...(Object.keys(params).length > 0 ? { craftbookParams: params } : {}),
      // A craftbook with a declarative `spawn` block becomes a spawn host:
      // its child template rides in as `spawnsCraftbook`, and the runtime
      // fans out one child per item when the `spawnFanout` step activates
      // (see the onStepActivated fanout branch). No cron/fanout needed —
      // the fanout trigger is the spawn-host mechanism for this book.
      ...(m.spawn
        ? {
            spawnsSteps: m.spawn.steps,
            ...(m.spawn.entryStepId ? { spawnsEntryStepId: m.spawn.entryStepId } : {}),
          }
        : {}),
      createdBy: { kind: 'user' },
    });

    // Stamp invocation params as an entry-step note so the gezel reads
    // them via `read_task_notes` (mirrors spawnChild's instance context).
    if (Object.keys(params).length > 0 && task.activeStepId) {
      const lines = ['# Invocation parameters', ''];
      for (const [k, v] of Object.entries(params)) lines.push(`- **${k}**: ${v}`);
      await tasks
        .appendNote(task.projectId, task.num, {
          text: lines.join('\n'),
          author: { kind: 'user' },
          stepId: task.activeStepId,
        })
        .catch(() => {
          /* note is best-effort */
        });
    }

    // Entry-gezel resolution + ambient-work guard + enqueue live in the
    // shared helper so this launcher and the create-route `dispatchEntry`
    // flag (the meester macros' path) cannot drift.
    const dispatch = await dispatchTaskEntry({ store, taskRunner, history }, task);

    return {
      taskRef: task.ref,
      craftbookName: m.name,
      ...(dispatch.assigneeName ? { assigneeName: dispatch.assigneeName } : {}),
      started: dispatch.enqueued,
    };
  };

  return { listCraftbookCommands, craftbookInvoker };
}
