import type { ProjectFileEntry } from '../schemas/project.js';
import type { PortableStore } from './store.js';

/** Same shallow Output-pane scope as desktop, with a bounded mobile traversal. */
export async function portableWorkspaceHtmlPages(store: PortableStore, projectId: string) {
  const files: ProjectFileEntry[] = [];
  const queue = [{ path: '', depth: 0 }];
  let visited = 0;
  let truncated = false;
  while (queue.length && visited < 5000 && files.length < 500) {
    const folder = queue.shift()!;
    const listing = await store.listFiles('workspace', projectId, folder.path);
    truncated ||= listing.truncated;
    for (const entry of listing.entries) {
      if (++visited > 5000 || files.length >= 500) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory) {
        if (entry.name !== 'node_modules' && folder.depth < 4)
          queue.push({ path: entry.path, depth: folder.depth + 1 });
      } else if (/\.html?$/i.test(entry.name)) files.push(entry);
    }
  }
  return { files, truncated: truncated || queue.length > 0 };
}
