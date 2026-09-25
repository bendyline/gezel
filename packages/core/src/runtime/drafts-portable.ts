/**
 * The portable host's side of the prompt-draft port: the repository's
 * journalled commit behind `apply`, and the recipient check that needs the
 * project, gezel, session and task modules (kept out of the shared module
 * so it does not import them).
 */
import type { PromptDraftFiles, PromptDraftHost, PromptDraftRecipient } from './drafts.js';
import { encodeText } from './files.js';
import { requireGezel } from './gezels.js';
import { projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';
import { getSession } from './sessions.js';
import { getTask } from './tasks.js';

export function promptsRoot(projectId: string): string {
  return `${projectRoot(projectId)}/artifacts/prompts`;
}

export function promptDraftFiles(repo: PortableRepository, projectId: string): PromptDraftFiles {
  const root = promptsRoot(projectId);
  const abs = (path: string) => (path ? `${root}/${path}` : root);
  const walk = async (
    dir: string,
    out: Array<{ path: string; isDirectory: boolean }>,
  ): Promise<void> => {
    for (const entry of await repo.list(abs(dir))) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      out.push({ path, isDirectory: entry.isDirectory });
      if (entry.isDirectory) await walk(path, out);
    }
  };
  return {
    list: async (dir) =>
      (await repo.list(abs(dir))).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
      })),
    readText: (path) => repo.text(abs(path)),
    readBytes: (path) => repo.files.read(abs(path)),
    tree: async (dir) => {
      const out: Array<{ path: string; isDirectory: boolean }> = [];
      await walk(dir, out);
      return out;
    },
    apply: async (change) => {
      const writes = new Map<string, Uint8Array>();
      for (const [path, value] of change.writes ?? [])
        writes.set(abs(path), typeof value === 'string' ? encodeText(value) : value);
      await repo.transactions.commit(
        writes,
        (change.removes ?? []).map(abs),
        (change.mkdirs ?? []).map(abs),
      );
    },
  };
}

export async function validatePortableDraftRecipient(
  repo: PortableRepository,
  projectId: string,
  input: PromptDraftRecipient,
): Promise<void> {
  await requireProject(repo, projectId);
  await requireGezel(repo, input.gezelId);
  if (input.taskRef) {
    const task = await getTask(repo, input.taskRef);
    if (!task || task.projectId !== projectId)
      throw new Error('Task does not belong to the selected project');
  } else if (input.craftbookRef)
    throw new Error('Craftbook authoring conversations are unavailable on this host');
  if (input.sessionId) {
    const session = await getSession(repo, input.gezelId, input.sessionId);
    if (!session || session.projectId !== projectId)
      throw new Error('This conversation does not belong to the selected project and gezel');
    if (
      (input.taskRef && input.taskRef !== session.taskRef) ||
      (input.craftbookRef && input.craftbookRef !== session.craftbookRef)
    )
      throw new Error('This conversation does not belong to the selected task or craftbook');
  }
}

export function promptDraftHost(repo: PortableRepository): PromptDraftHost {
  return {
    now: () => repo.now(),
    validateRecipient: (projectId, input) => validatePortableDraftRecipient(repo, projectId, input),
  };
}
