import { parseTaskRef } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * Find which real tasks an assistant reply mentioned in its body. Pairs
 * with the artifact-reference parser; the same chip row in the chat
 * bubble surfaces both. The model commonly emits task refs as
 * `<projectId>/<num>` either bare or wrapped in inline backticks —
 * "I created task `gezel-ux-roadmap/2`" — so we cast a wider net than
 * the artifact path matcher (no strict markdown-only requirement) and
 * gate on the ref existing in the on-disk task list to avoid promoting
 * hallucinated refs.
 */
export async function extractReferencedTasks(store: Store, content: string): Promise<string[]> {
  if (!content || content.length === 0) return [];
  const tasks = await store.listAllTasks();
  if (tasks.length === 0) return [];
  return matchReferencedTasksInContent(
    content,
    tasks.map((t) => t.ref),
  );
}

/**
 * Pure helper variant — takes a pre-listed task-ref inventory and
 * returns the canonical refs the content mentions. Same back-stop
 * timeline-read pattern as the artifact extractor: the read path can
 * pass in tasks it already gathered for the project rather than
 * re-walking task storage per message.
 */
export function matchReferencedTasksInContent(content: string, taskRefs: string[]): string[] {
  if (!content || content.length === 0) return [];
  if (taskRefs.length === 0) return [];
  const known = new Set(taskRefs);
  // The model writes refs in three shapes we need to catch:
  //   - bare: `gezel-ux-roadmap/2`
  //   - inline code: `\`gezel-ux-roadmap/2\``
  //   - markdown link: `[label](gezel-ux-roadmap/2)`
  // A single regex covers all three because backticks / brackets /
  // parens are ALL non-word characters and the inner pattern is
  // identical. We over-match on the surface form and validate against
  // the known-refs set, which is the safety rail.
  const REF_RE = /(?:^|[^\w/-])([a-zA-Z][a-zA-Z0-9_-]{0,79}\/\d{1,9})(?=[^\w/]|$)/g;
  const hits = new Set<string>();
  for (const m of content.matchAll(REF_RE)) {
    const candidate = m[1];
    if (!candidate) continue;
    // Normalize away any wrapping backticks the regex may have included
    // via the outer non-capture; the inner capture already excludes
    // them, but keep this defensive in case the regex evolves.
    const normalized = candidate.trim();
    if (!parseTaskRef(normalized)) continue;
    if (known.has(normalized)) hits.add(normalized);
  }
  // Sort for stable persisted output + tests.
  return [...hits].sort();
}
