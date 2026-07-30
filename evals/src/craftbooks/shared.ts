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
  const bytesCache = new Map<string, Promise<Uint8Array | null>>();
  const artifactReadCache = new Map<string, Promise<string | null>>();
  const artifactBytesCache = new Map<string, Promise<Uint8Array | null>>();
  let listCache: Promise<string[]> | undefined;
  let artifactListCache: Promise<string[]> | undefined;
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
    // Byte-exact read for image-signature checks. Deliberately NOT sharing
    // `readCache` — that cache holds UTF-8 decoded text, and decoding a PNG
    // through `.text()` destroys the magic bytes the check inspects.
    async readBytes(file: string): Promise<Uint8Array | null> {
      let cached = bytesCache.get(file);
      if (!cached) {
        cached = (async () => {
          try {
            const blob = await client.fetchProjectWorkspaceBlob(projectId, file);
            return new Uint8Array(await blob.arrayBuffer());
          } catch {
            return null;
          }
        })();
        bytesCache.set(file, cached);
      }
      return cached;
    },
    // Artifact-drawer accessors — what lets `artifact: true` checks (a
    // review report, an audit deliverable) evaluate instead of failing
    // closed in the runtime evaluator's reader swap.
    async readArtifact(file: string): Promise<string | null> {
      let cached = artifactReadCache.get(file);
      if (!cached) {
        cached = client
          .readProjectArtifact(projectId, file)
          .then((res) => res.content)
          .catch(() => null);
        artifactReadCache.set(file, cached);
      }
      return cached;
    },
    async listArtifacts(): Promise<string[]> {
      if (!artifactListCache) {
        artifactListCache = client
          .listProjectArtifacts(projectId, undefined, true)
          .then((listing) =>
            listing.files.filter((file) => !file.isDirectory).map((file) => file.path),
          )
          .catch(() => []);
      }
      return artifactListCache;
    },
    async readArtifactBytes(file: string): Promise<Uint8Array | null> {
      let cached = artifactBytesCache.get(file);
      if (!cached) {
        cached = client
          .fetchProjectArtifactBlob(projectId, file)
          .then(async (blob) => new Uint8Array(await blob.arrayBuffer()))
          .catch(() => null);
        artifactBytesCache.set(file, cached);
      }
      return cached;
    },
  };
}
