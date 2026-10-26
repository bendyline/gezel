import { type ChatSession, toolCallBlockedHistoryEntry } from '@bendyline/gezel';
import type { ToolCallEvent } from '@bendyline/gezel-inference/internal/providers/types';
import type { HistoryManager } from '../history/manager.js';
import type { ArtifactReadSlice } from './artifact-read-evidence.js';

export interface ToolCallHistoryInput {
  info: ToolCallEvent;
  session: Pick<ChatSession, 'id' | 'projectId' | 'gezelId' | 'taskRef' | 'stepId' | 'subagentFor'>;
  /** The file actually opened or written, after any read resolution. */
  path?: string;
  paths: string[];
  resolvedReadPath?: string;
  requestedReadPath?: string;
  readFuzzy?: boolean;
  readSlices: ArtifactReadSlice[];
  diff?: string;
  addedLines?: number;
  removedLines?: number;
}

/**
 * Writes the history a finished tool call leaves: a
 * `security.tool-call-blocked` entry when the egress tripwire stopped it, then
 * the `tool.called` receipt. Gate evidence reads that receipt's details
 * (`gate-history.ts`), so its keys are a contract, not a log format.
 */
export async function logToolCallHistory(
  history: Pick<HistoryManager, 'log'>,
  input: ToolCallHistoryInput,
): Promise<void> {
  const { info, session, path, paths, readSlices, diff, addedLines, removedLines } = input;
  if (info.egressIndicators?.length) {
    await history.log(
      toolCallBlockedHistoryEntry({
        tool: info.name,
        surface: 'mcp-toolset',
        indicators: info.egressIndicators,
        projectId: session.projectId,
        gezelId: session.gezelId,
        sessionId: session.id,
      }),
    );
  }
  const researchTarget = researchTargetForToolCall(info.name, info.args);
  await history.log({
    kind: 'tool.called',
    projectId: session.projectId,
    gezelId: session.gezelId,
    summary: info.success
      ? `Tool ${info.name} ran (${info.durationMs}ms)`
      : `Tool ${info.name} failed: ${info.errorMessage ?? 'unknown error'}`,
    details: {
      name: info.name,
      ...(info.providerToolName ? { providerToolName: info.providerToolName } : {}),
      sessionId: session.id,
      ...(session.taskRef ? { taskRef: session.taskRef } : {}),
      ...(session.stepId ? { stepId: session.stepId } : {}),
      // A teammate's reads count toward the task it works for.
      ...(!session.taskRef && session.subagentFor
        ? { taskRef: session.subagentFor.taskRef, subagent: true }
        : {}),
      argKeys: info.argKeys,
      durationMs: info.durationMs,
      success: info.success,
      ...(info.deliveredResultTruncated !== undefined
        ? { deliveredResultTruncated: info.deliveredResultTruncated }
        : {}),
      ...(path ? { path } : {}),
      ...(info.name === 'read_image_as_base64'
        ? { imageArtifact: info.args?.artifact === true || info.args?.artifact === 'true' }
        : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(input.resolvedReadPath ? { resolvedPath: input.resolvedReadPath } : {}),
      ...(input.requestedReadPath ? { requestedPath: input.requestedReadPath } : {}),
      ...(input.readFuzzy !== undefined ? { fuzzy: input.readFuzzy } : {}),
      ...(readSlices.length > 0 ? { artifactReadSlices: readSlices } : {}),
      ...(researchTarget ? { researchTarget } : {}),
      ...(info.errorMessage ? { errorMessage: info.errorMessage } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(addedLines !== undefined ? { addedLines } : {}),
      ...(removedLines !== undefined ? { removedLines } : {}),
    },
  });
}

/**
 * Retain a compact, non-secret proof that a successful tool call was aimed at
 * source acquisition. Full arguments already live on the session turn; the
 * history event only needs enough to distinguish an external lookup from a
 * local preview/navigation call when a research gate completes mid-turn.
 */
function researchTargetForToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  if (name === 'web_search' || name === 'wikipedia_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    return query ? `query:${query.slice(0, 240)}` : undefined;
  }
  if (name === 'wikipedia_read') {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    return title ? `article:${title.slice(0, 240)}` : undefined;
  }
  if (name === 'fetch_url' || name === 'browser_navigate') {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    return /^https?:\/\//i.test(url) ? url.slice(0, 500) : undefined;
  }
  if (name === 'run_playwright_script') {
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    return path ? `script:${path.slice(0, 240)}` : 'scripted-browser-run';
  }
  return undefined;
}
