import { api } from '../../api.js';
import type { FileEntry } from '../FileTree.js';

/**
 * Which tree a file browser is pointed at. Everything else about the panel —
 * layout, view modes, mutations, previews — is identical across the three, so
 * this discriminator only decides wiring (which endpoints, which editor
 * container), never which features exist.
 */
export type FileBrowserKind = 'documents' | 'workspace' | 'artifacts';

/**
 * The seam between the shared file browser and the tree it is browsing.
 *
 * Every capability the panel offers is either a method here or absent: an
 * adapter without `mkdir` gets no New folder action, one with `canWrite:
 * false` gets no mutations at all. That keeps the read-only workspace and the
 * fully-writable documents library on one code path instead of two panels
 * that drift.
 */
export interface FileBrowserSource {
  kind: FileBrowserKind;
  /** Display name in the panel header and the collapsed rail. */
  title: string;
  /** Whether mutations are offered at all (workspace honors the write policy). */
  canWrite: boolean;
  list(opts: { hidden: boolean }): Promise<{ files: FileEntry[]; truncated?: boolean }>;
  read(path: string): Promise<{ content: string }>;
  fetchBlob(path: string): Promise<Blob>;
  write(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Blob, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
  rename?(fromPath: string, toPath: string): Promise<void>;
  /** Open the underlying directory in the OS file manager. */
  reveal?(): Promise<void>;
  /**
   * Custom event dispatched after a mutation so other surfaces (the sidebar's
   * documents tree) can refresh. Sources without listeners omit it.
   */
  changeEventPrefix?: string;
}

export function documentsFileSource(): FileBrowserSource {
  return {
    kind: 'documents',
    title: 'Documents',
    canWrite: true,
    list: ({ hidden }) => api.listDocuments('', true, { stats: true, hidden }),
    read: (path) => api.readDocument(path),
    fetchBlob: (path) => api.fetchDocumentBlob(path),
    write: async (path, content) => {
      await api.writeDocument(path, content);
    },
    writeBinary: async (path, data, contentType) => {
      await api.writeDocumentBinary(path, data, contentType);
    },
    remove: async (path) => {
      await api.deleteDocument(path);
    },
    mkdir: async (path) => {
      await api.createDocumentFolder(path);
    },
    rename: async (fromPath, toPath) => {
      await api.renameDocument(fromPath, toPath);
    },
    reveal: async () => {
      await api.revealDocuments();
    },
    changeEventPrefix: 'gezel:document',
  };
}

export function projectFileSource(
  projectId: string,
  kind: 'workspace' | 'artifacts',
  opts: { canWrite: boolean },
): FileBrowserSource {
  const workspace = kind === 'workspace';
  return {
    kind,
    title: workspace ? 'Workspace' : 'Artifacts',
    canWrite: opts.canWrite,
    list: ({ hidden }) =>
      workspace
        ? api.listProjectWorkspace(projectId, '', true, { stats: true, hidden })
        : api.listProjectArtifacts(projectId, '', true, { stats: true, hidden }),
    read: (path) =>
      workspace
        ? api.readProjectWorkspaceFile(projectId, path)
        : api.readProjectArtifact(projectId, path),
    fetchBlob: (path) =>
      workspace
        ? api.fetchProjectWorkspaceBlob(projectId, path)
        : api.fetchProjectArtifactBlob(projectId, path),
    write: async (path, content) => {
      if (workspace) await api.writeProjectWorkspaceFile(projectId, { path, content });
      else await api.writeProjectArtifact(projectId, path, content);
    },
    writeBinary: async (path, data, contentType) => {
      if (workspace) await api.writeProjectWorkspaceBinary(projectId, path, data, contentType);
      else await api.writeProjectArtifactBinary(projectId, path, data, contentType);
    },
    remove: async (path) => {
      if (workspace) await api.rmProjectWorkspacePath(projectId, path, { recursive: true });
      else await api.deleteProjectArtifact(projectId, path);
    },
    mkdir: async (path) => {
      if (workspace) await api.mkdirProjectWorkspace(projectId, { path });
      else await api.createProjectArtifactFolder(projectId, path);
    },
    rename: async (fromPath, toPath) => {
      if (workspace) await api.renameProjectWorkspacePath(projectId, { fromPath, toPath });
      else await api.renameProjectArtifactPath(projectId, fromPath, toPath);
    },
    reveal: async () => {
      await api.revealProject(projectId, kind);
    },
  };
}
