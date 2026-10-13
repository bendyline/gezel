/**
 * Which workspace files a step's completion gate reads, shared by the
 * desktop's and the phone's mid-turn "deliverable is ready" checks.
 */

import type { GateCheck } from '../schemas/gate.js';

/**
 * Normalize a workspace-relative path for comparison: forward slashes,
 * no `./` or `workspace/` prefix, no doubled or leading slashes. Paths
 * stay case-sensitive (Linux workspaces).
 */
export function normalizeWorkspacePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^workspace\//, '')
    .replace(/^\/+/, '');
}

/** Completion-gate checks that fail outright when their `file` is absent. */
const FILE_PRESENCE_CHECK_KINDS: ReadonlySet<GateCheck['kind']> = new Set([
  'minBytes',
  'sniff',
  'contains',
  'htmlLint',
  'jsonPathEquals',
  'csvShape',
]);

/**
 * Other workspace files a step's completion gate reads, which must exist
 * before the mid-turn "deliverable is ready" steer may fire. `advanceWhen`
 * names one file, but a multi-file build step gates the rest: pwa-offline
 * advances on `index.html` and also checks `sw.js`, which its procedure
 * writes afterwards. Telling the model to stop there would spend a gate
 * attempt on a file it was about to write.
 */
export function completionGateWorkspaceFiles(
  checks: readonly GateCheck[],
  deliverableFile: string,
): string[] {
  const deliverable = normalizeWorkspacePath(deliverableFile);
  const files = new Set<string>();
  for (const check of checks) {
    if (!FILE_PRESENCE_CHECK_KINDS.has(check.kind)) continue;
    if (!('file' in check) || typeof check.file !== 'string') continue;
    if ('artifact' in check && check.artifact) continue;
    const file = normalizeWorkspacePath(check.file);
    if (file && file !== deliverable) files.add(file);
  }
  return [...files];
}
