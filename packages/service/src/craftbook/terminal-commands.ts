import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { startCraftbookRun } from '../tasks/craftbook-run.js';
import type { EntryDispatchDeps } from '../tasks/entry-dispatch.js';
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
    const run = await startCraftbookRun(
      { store, tasks, taskRunner, ...(history ? { history } : {}), craftbookResolver, resolveRole },
      { projectId, craftbookId, params },
    );
    return {
      taskRef: run.task.ref,
      craftbookName: run.craftbookName,
      ...(run.assigneeName ? { assigneeName: run.assigneeName } : {}),
      started: run.started,
    };
  };

  return { listCraftbookCommands, craftbookInvoker };
}
