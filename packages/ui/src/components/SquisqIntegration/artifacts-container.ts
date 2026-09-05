/**
 * ContentContainer adapter over project artifacts. Sibling of
 * {@link createDocumentsContentContainer} but scoped to a single
 * project's `artifacts/` tree — the per-project surface squisq's editor
 * mounts when the user opens a markdown file out of the Projects view.
 *
 * The wiring mirrors the documents variant: text I/O goes through the
 * existing JSON-bodied write endpoint, binary I/O goes through the
 * `?raw=1` reader and the dedicated `PUT /raw` writer added for this
 * integration. MIME-type guessing is identical (artifacts are organized
 * by extension; the listing API doesn't carry a type field).
 */

import type { GezelClient } from '@bendyline/gezel-client';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { type ContentStorage, createContentContainer } from './content-container.js';

export interface ArtifactsContentContainerOptions {
  /** Project id whose `artifacts/` tree this container wraps. */
  projectId: string;
  /**
   * Sub-path within `artifacts/` this container is rooted at. Use the
   * directory of the currently-open artifact. Empty string = the
   * project's artifacts root.
   */
  root: string;
  /** Authenticated gezel client. */
  client: GezelClient;
  /** Primary-doc filename override — basename of the file the user opened. */
  primaryDocumentFilename?: string;
  /** Prefix exposed in Markdown while storage remains companion-relative. */
  referencePrefix?: string;
  /** Storage tree to wrap. Defaults to the project artifact drawer. */
  source?: 'artifacts' | 'workspace';
}

export function createProjectContentContainer(
  options: ArtifactsContentContainerOptions,
): ContentContainer {
  const { client, projectId, source = 'artifacts' } = options;
  // Workspace operations retain their workspace authority gate, including raw writes.
  const storage: ContentStorage =
    source === 'workspace'
      ? {
          readText: (path) => client.readProjectWorkspaceFile(projectId, path),
          readBlob: (path) => client.fetchProjectWorkspaceBlob(projectId, path),
          writeText: (path, content) =>
            client.writeProjectWorkspaceFile(projectId, { path, content }),
          writeBinary: (path, data, mime) =>
            client.writeProjectWorkspaceBinary(projectId, path, data, mime),
          remove: (path) => client.rmProjectWorkspacePath(projectId, path, { recursive: true }),
          list: (path) => client.listProjectWorkspace(projectId, path, true),
        }
      : {
          readText: (path) => client.readProjectArtifact(projectId, path),
          readBlob: (path) => client.fetchProjectArtifactBlob(projectId, path),
          writeText: (path, content) => client.writeProjectArtifact(projectId, path, content),
          writeBinary: (path, data, mime) =>
            client.writeProjectArtifactBinary(projectId, path, data, mime),
          remove: (path) => client.deleteProjectArtifact(projectId, path),
          list: (path) => client.listProjectArtifacts(projectId, path, true),
        };
  return createContentContainer(options, storage);
}

export function createArtifactsContentContainer(
  options: ArtifactsContentContainerOptions,
): ContentContainer {
  return createProjectContentContainer({ ...options, source: 'artifacts' });
}
