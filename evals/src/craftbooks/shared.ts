import type { GezelClient } from '@bendyline/gezel-client/node';
import type { CraftbookEvalWorkspace } from './gates.ts';

/**
 * Shared, spec-agnostic helpers used by both the generic craftbook eval
 * adapter ([scenario.ts](./scenario.ts)) and the hand-authored craftbook
 * AUTHORING scenarios ([authoring/](./authoring/)). Extracted (not
 * duplicated) from scenario.ts so the two grading surfaces can't drift.
 */

/** Resolve a project id by exact name; `null` while it doesn't exist yet. */
export async function findProjectIdByName(
  client: GezelClient,
  name: string,
): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === name)?.id ?? null;
}

/**
 * A read-cached `CraftbookEvalWorkspace` view over a project's workspace,
 * suitable for one `successCheck` poll: reads and the recursive listing
 * are memoized for the lifetime of the returned object, so gate checks
 * that touch the same file repeatedly pay one HTTP fetch.
 */
export function workspaceFromClient(
  client: GezelClient,
  projectId: string,
): CraftbookEvalWorkspace {
  const readCache = new Map<string, Promise<string | null>>();
  let listCache: Promise<string[]> | undefined;
  return {
    async read(file: string): Promise<string | null> {
      let cached = readCache.get(file);
      if (!cached) {
        cached = (async () => {
          try {
            const blob = await client.fetchProjectWorkspaceBlob(projectId, file);
            return await blob.text();
          } catch {
            return null;
          }
        })();
        readCache.set(file, cached);
      }
      return cached;
    },
    async list(): Promise<string[]> {
      if (!listCache) {
        listCache = (async () => {
          try {
            const listing = await client.listProjectWorkspace(projectId, undefined, true);
            return listing.files.filter((file) => !file.isDirectory).map((file) => file.path);
          } catch {
            return [];
          }
        })();
      }
      return listCache;
    },
  };
}
