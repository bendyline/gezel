import { projectManagedWorkspaceWritable } from '@bendyline/gezel';
import { api } from '../../api.js';
import {
  type OutsideInLayout,
  chooseOutsideInSource,
  createProjectContentContainer,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  resolveOutsideInLayout,
  supportsOutsideInMarkdownEditing,
  withOutsideInMetadata,
} from '../../components/SquisqIntegration/index.js';
import {
  BINARY_FILE,
  isBinaryFileName,
  looksBinary,
  mediaSentinel,
} from '../../components/file-browser/index.js';

type FileSource = 'workspace' | 'artifacts';

export interface OutsideInOpenFile {
  layout: OutsideInLayout;
  sourcePath: string;
  editingEnabled: boolean;
}

async function findCompanion(projectId: string, layout: OutsideInLayout, source: FileSource) {
  // Navigation can arrive before the file tree has loaded (or from another project).
  const { files } =
    source === 'workspace'
      ? await api.listProjectWorkspace(projectId, layout.companionDirectory, false, {
          hidden: true,
        })
      : await api.listProjectArtifacts(projectId, layout.companionDirectory, false, {
          hidden: true,
        });
  return chooseOutsideInSource(
    layout,
    files.filter((entry) => !entry.isDirectory).map((entry) => entry.path),
  );
}

export async function prepareProjectOutsideInDocument(
  projectId: string,
  path: string,
  source: FileSource,
  companionPath?: string | null,
): Promise<OutsideInOpenFile & { content: string }> {
  const layout = resolveOutsideInLayout(path);
  if (!layout) throw new Error('This file does not support a Markdown companion.');
  let sourcePath =
    companionPath === undefined ? await findCompanion(projectId, layout, source) : companionPath;
  const canWrite =
    source === 'artifacts' || projectManagedWorkspaceWritable(await api.getProject(projectId));
  let content: string;
  if (sourcePath) {
    const response =
      source === 'workspace'
        ? await api.readProjectWorkspaceFile(projectId, sourcePath)
        : await api.readProjectArtifact(projectId, sourcePath);
    content = response.content;
  } else {
    if (!canWrite) {
      throw new Error(
        'Enable workspace writes for this external project before importing its Markdown companion.',
      );
    }
    const blob =
      source === 'workspace'
        ? await api.fetchProjectWorkspaceBlob(projectId, path)
        : await api.fetchProjectArtifactBlob(projectId, path);
    const imported = await importOutsideInDocument(await blob.arrayBuffer(), layout);
    if (looksBinary(imported.markdown)) {
      throw new Error('Could not open this document: its Markdown preview contains binary data.');
    }
    const container = createProjectContentContainer({
      projectId,
      root: layout.companionDirectory,
      client: api,
      primaryDocumentFilename: layout.markdownFilename,
      source,
    });
    for (const entry of await imported.container.listFiles()) {
      if (/\.md$/i.test(entry.path)) continue;
      const data = await imported.container.readFile(entry.path);
      if (data) await container.writeFile(entry.path, data, entry.mimeType);
    }
    await container.writeDocument(imported.markdown, layout.markdownFilename);
    sourcePath = layout.markdownPath;
    content = imported.markdown;
  }
  if (looksBinary(content)) {
    throw new Error('Could not open this document: its Markdown preview contains binary data.');
  }
  const linkedContent = withOutsideInMetadata(content, layout);
  if (linkedContent !== content && canWrite) {
    if (source === 'workspace') {
      await api.writeProjectWorkspaceFile(projectId, { path: sourcePath, content: linkedContent });
    } else {
      await api.writeProjectArtifact(projectId, sourcePath, linkedContent);
    }
  }
  return {
    layout: { ...layout, markdownPath: sourcePath },
    sourcePath,
    content: linkedContent,
    editingEnabled:
      supportsOutsideInMarkdownEditing(layout.format) &&
      isOutsideInMarkdownEditingEnabled(linkedContent),
  };
}

/** Shared by file-tree selection, task Open, search, and cross-project navigation. */
export async function loadProjectFile(
  projectId: string,
  path: string,
  source: FileSource,
): Promise<{
  path: string;
  content: string;
  source: FileSource;
  size?: number;
  outsideIn?: OutsideInOpenFile;
}> {
  const layout = resolveOutsideInLayout(path);
  if (layout) {
    const companion = await findCompanion(projectId, layout, source);
    // Standalone HTML remains runnable until its companion records editing intent.
    if (layout.format !== 'html' || companion) {
      const { content, ...outsideIn } = await prepareProjectOutsideInDocument(
        projectId,
        path,
        source,
        companion,
      );
      return { path, content, source, outsideIn };
    }
  }
  const nonText = mediaSentinel(path) ?? (isBinaryFileName(path) ? BINARY_FILE : null);
  if (nonText) return { path, content: nonText, source };
  const response =
    source === 'workspace'
      ? await api.readProjectWorkspaceFile(projectId, path)
      : await api.readProjectArtifact(projectId, path);
  return {
    ...response,
    source,
    content: looksBinary(response.content) ? BINARY_FILE : response.content,
  };
}
