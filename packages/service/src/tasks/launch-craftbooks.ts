import {
  type Craftbook,
  type CreateTaskRequest,
  type TaskCraftbookSource,
  unmetToolsets,
} from '@bendyline/gezel';
import { installedToolsetIds } from '../craftbook/applicable.js';
import type { Store } from '../fs/store.js';
import { inlineStepsToCraftbook } from './craftbook-instantiation.js';
import { CraftbookSetupRequiredError } from './launch-errors.js';
import type { CraftbookResolver } from './manager.js';

/**
 * The recipes a task launch walks: its main craftbook and, for a spawn host,
 * the template each child clones. The resolving half of `TaskManager.create`;
 * snapshotting, parameters, and interpolation stay in the manager.
 */
export interface LaunchCraftbooks {
  mainBook: Craftbook;
  mainBookSourceId?: string;
  spawnBook?: Craftbook;
  /** Catalog provenance for each role a catalog book fills; inline recipes record none. */
  sources: TaskCraftbookSource[];
}

export async function resolveLaunchCraftbooks(
  { resolver, store }: { resolver: CraftbookResolver | undefined; store: Store },
  projectId: string,
  num: number,
  input: Omit<CreateTaskRequest, 'description'> & { description?: string },
): Promise<LaunchCraftbooks> {
  const sources: TaskCraftbookSource[] = [];
  // A catalog book whose toolsets are not installed fails the launch here,
  // before there is a task to strand.
  const resolveCatalogBook = async (
    role: TaskCraftbookSource['role'],
    catalogId: string,
    version: string | undefined,
    sourceId: string | undefined,
  ) => {
    const label = role === 'main' ? 'craftbook' : 'spawn craftbook';
    if (!resolver) {
      throw new Error(
        `task ${projectId}/${num}: ${role === 'main' ? 'craftbookId' : 'spawnsCraftbookId'} provided but no CraftbookResolver wired`,
      );
    }
    const resolved = await resolver.resolve(catalogId, {
      ...(version ? { version } : {}),
      ...(sourceId ? { sourceId } : {}),
      projectId,
    });
    if (!resolved) {
      throw new Error(`task ${projectId}/${num}: ${label} "${catalogId}" not found`);
    }
    const book = resolved.craftbook;
    const missingToolsets = unmetToolsets(
      book.toolsets,
      await installedToolsetIds(store, projectId),
      book.steps,
    );
    if (missingToolsets.length > 0) {
      throw new CraftbookSetupRequiredError(catalogId, missingToolsets);
    }
    sources.push({
      role,
      catalogId,
      ...(resolved.version ? { version: resolved.version } : {}),
      sourceId: resolved.sourceId,
    });
    return resolved;
  };

  let mainBook: Craftbook;
  let mainBookSourceId: string | undefined;
  if (input.craftbookId) {
    const resolved = await resolveCatalogBook(
      'main',
      input.craftbookId,
      input.craftbookVersion,
      input.craftbookSourceId,
    );
    mainBook = resolved.craftbook;
    mainBookSourceId = resolved.sourceId;
  } else if (input.steps && input.steps.length > 0) {
    mainBook = inlineStepsToCraftbook(input.steps, {
      name: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      defaultAssignee: input.assignee,
      ...(input.entryStepId ? { entryStepId: input.entryStepId } : {}),
    });
  } else {
    throw new Error(
      `task ${projectId}/${num}: exactly one of craftbookId or steps must be provided`,
    );
  }

  let spawnBook: Craftbook | undefined;
  if (input.spawnsCraftbookId) {
    spawnBook = (
      await resolveCatalogBook(
        'spawn',
        input.spawnsCraftbookId,
        input.spawnsCraftbookVersion,
        input.spawnsCraftbookSourceId,
      )
    ).craftbook;
  } else if (input.spawnsSteps && input.spawnsSteps.length > 0) {
    spawnBook = inlineStepsToCraftbook(input.spawnsSteps, {
      name: `${input.title} — spawn template`,
      defaultAssignee: input.assignee,
      ...(input.spawnsEntryStepId ? { entryStepId: input.spawnsEntryStepId } : {}),
    });
  } else if (mainBook.spawn) {
    // Declarative fanout: the main craftbook carries a `spawn` block, so
    // this task is a spawn host by construction — derive its spawn
    // template from `mainBook.spawn` REGARDLESS of the create path. Doing
    // it here (not only in the terminal `craftbookInvoker`) means the
    // HTTP create route, the MCP `invoke_craftbook` tool, and the eval
    // harness all produce a working spawn host — the `spawnFanout` step's
    // runtime fanout needs `task.spawnsCraftbook` present to fire.
    spawnBook = inlineStepsToCraftbook(mainBook.spawn.steps, {
      name: `${mainBook.name} — spawn template`,
      defaultAssignee: input.assignee,
      ...(mainBook.spawn.entryStepId ? { entryStepId: mainBook.spawn.entryStepId } : {}),
      // Children of a declarative fanout do the parent book's work on a
      // slice of it, so they need the parent's tool + connector
      // requirements. `inlineStepsToCraftbook` carries neither, and the
      // chat session's auto-allow derivation reads `craftbook.toolsets`
      // off the task — so children of a PR-review fanout would come up
      // without the GitHub/code-intelligence toolset their steps name.
      // The host already proved these are installed and bound at launch.
      ...(mainBook.toolsets ? { toolsets: mainBook.toolsets } : {}),
      ...(mainBook.connectors ? { connectors: mainBook.connectors } : {}),
      // And the parent's embedded script sources, for the same reason.
      // `embeddedScriptSource` resolves a shard's `scope: 'craftbook'` gate
      // ref against the SHARD's own snapshot, so a spawn template without
      // the map sends every shard to the project-installed copy — which,
      // for a book written straight onto a task, does not exist. Every
      // shard then pauses with a gate_infrastructure_error naming a path
      // the model cannot create.
      ...(mainBook.scripts ? { scripts: mainBook.scripts } : {}),
    });
  }

  return {
    mainBook,
    ...(mainBookSourceId ? { mainBookSourceId } : {}),
    ...(spawnBook ? { spawnBook } : {}),
    sources,
  };
}
