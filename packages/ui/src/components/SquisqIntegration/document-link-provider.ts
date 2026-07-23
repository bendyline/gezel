/**
 * Sibling-document link provider for squisq's link-insert dialog.
 *
 * Squisq's editor surfaces a "Browse documents" picker when a
 * `documentLinkProvider` is wired into `EditorShell`. The provider is
 * called with the user's query string (empty on first open, then the
 * substring they're typing) and returns up to N candidates. Each
 * candidate's `path` lands verbatim in the markdown URL — we hand back
 * paths *relative to the current document* so refactoring the docs
 * tree later doesn't break links.
 */

import type { GezelClient } from '@bendyline/gezel-client';
import type { DocumentLinkProvider } from '@bendyline/squisq-editor-react';

export interface DocumentLinkProviderOptions {
  client: GezelClient;
  /** Path of the document the editor is currently displaying. */
  currentDocumentPath: string;
  /**
   * Cap on returned candidates per query. Defaults to 20 — wide enough
   * for a useful list, narrow enough that the dialog stays scannable.
   */
  limit?: number;
  /** Strategy for picking which artifacts/docs to surface. */
  source?: 'documents' | 'project-artifacts';
  /** When `source === 'project-artifacts'`, the project id to scan. */
  projectId?: string;
}

function relativizePath(currentDocPath: string, targetPath: string): string {
  const currentDir = currentDocPath.replace(/\/[^/]*$/, '');
  if (!currentDir) return targetPath;
  if (targetPath.startsWith(`${currentDir}/`)) {
    return targetPath.slice(currentDir.length + 1);
  }
  // Different subtree — fall back to a project-root-relative path.
  return targetPath;
}

export function createDocumentLinkProvider(
  options: DocumentLinkProviderOptions,
): DocumentLinkProvider {
  const { client, currentDocumentPath, limit = 20, source = 'documents', projectId } = options;

  return async (query: string) => {
    const q = query.trim().toLowerCase();
    try {
      const res =
        source === 'project-artifacts' && projectId
          ? await client.listProjectArtifacts(projectId, undefined, true)
          : await client.listDocuments(undefined, true);
      const matches = res.files
        .filter((f) => !f.isDirectory)
        .filter((f) => f.path !== currentDocumentPath)
        .filter((f) => /\.(md|markdown|mdx|txt)$/i.test(f.name))
        .filter((f) => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        .slice(0, limit);
      return matches.map((f) => ({
        path: relativizePath(currentDocumentPath, f.path),
        label: f.name.replace(/\.(md|markdown|mdx|txt)$/i, ''),
        description: f.path,
      }));
    } catch {
      return [];
    }
  };
}
