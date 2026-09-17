/**
 * Explicitly invoked, repository-owned workflow drivers run in the CLI process.
 * They compose the public client and native craftbooks, like an ordinary npm
 * script. They are not sandboxed craftbook scripts or model-invocable tools.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Craftbook,
  type Task,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  nowIso,
  parseCraftbookDoc,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { CliError } from './connection.js';
import { parseCraftbookParams, waitForTask } from './craftbook-command.js';

/** Validate generated documents with the same contracts as the daemon, before installing them. */
export function validateWorkflowCraftbook(document: unknown): Craftbook {
  const parsed = parseCraftbookDoc(JSON.stringify(document), 'json');
  if (!parsed.ok) throw new CliError(formatCraftbookDocErrors(parsed.errors));
  const built = craftbookFromDoc(parsed.doc, { now: nowIso() });
  if (!built.ok) throw new CliError(formatCraftbookDocErrors(built.errors));
  return built.craftbook;
}

export async function runWorkflow(
  client: GezelClient,
  projectId: string,
  workspace: string,
  file: string,
  args: string[],
  log: (message: string) => void = console.error,
  invocation?: { craftbook: Craftbook; params: Record<string, string>; timeoutMs?: number },
) {
  const named = /^[a-z][a-z0-9-]*$/.test(file);
  const path = await realpath(resolve(workspace, named ? `.gezel/workflows/${file}.mjs` : file));
  if (invocation) {
    const local = relative(await realpath(workspace), path);
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('../') ||
      local.startsWith('..\\')
    ) {
      throw new CliError('A craftbook workflow module must remain inside its project workspace.');
    }
  }
  const module = await import(pathToFileURL(path).href);
  if (typeof module.run !== 'function')
    throw new CliError(`workflow ${path} must export an async run(context) function`);
  return module.run({
    client,
    projectId,
    workspace: resolve(workspace),
    args,
    ...(invocation ?? {}),
    log,
    validateCraftbook: validateWorkflowCraftbook,
    runCraftbook: async (
      id: string,
      params: Record<string, string>,
      options: {
        timeoutMs?: number;
        title?: string;
        taskRef?: string;
        parentTaskRef?: string;
        onCreated?: (task: Task) => Promise<void>;
      } = {},
    ) => {
      let ref = options.taskRef;
      if (!ref) {
        const { craftbook: book } = await client.getCraftbook(id, { projectId, source: 'project' });
        const parsed = parseCraftbookParams(
          book,
          Object.entries(params).map(([key, value]) => `${key}=${value}`),
        );
        const task = await client.createTask(projectId, {
          title: options.title ?? book.name,
          description: `Run the project craftbook ${book.name}. Follow every step and satisfy its required outcomes before completing this task.`,
          craftbookId: id,
          craftbookSourceId: 'project',
          craftbookVersion: book.version,
          craftbookParams: parsed,
          dispatchEntry: true,
          roleBasedNameOnlyMode: true,
          trustScripts: true,
          ...(options.parentTaskRef ? { parentTaskRef: options.parentTaskRef } : {}),
        });
        await options.onCreated?.(task);
        ref = task.ref;
      }
      log(`Following ${ref}`);
      return waitForTask(client, ref, {
        timeoutMs: options.timeoutMs ?? invocation?.timeoutMs ?? 7_200_000,
        onProgress: (task) =>
          log(`${task.ref}: ${task.status} (${task.activeStepId ?? 'finished'})`),
      });
    },
  });
}
