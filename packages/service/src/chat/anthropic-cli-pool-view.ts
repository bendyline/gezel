import { type ChatSession, displayName } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { DEFAULT_CLAUDE_POOL_SIZE } from '../providers/anthropic-cli/index.js';
import type { ClaudeWorkerPool } from '../providers/anthropic-cli/worker-pool.js';

/**
 * Wire shape for the Claude CLI worker pool snapshot exposed via
 * `/api/queues`. Drives the header `ClaudeCliPoolPill` — the
 * always-visible status indicator that lists warm workers per (gezel,
 * project) and lights up when one of them is mid-turn.
 */
export interface AnthropicCliPoolView {
  size: number;
  /** Configured cap from `config.anthropicCli.poolSize` (default 4). */
  poolSize: number;
  workers: Array<{
    sessionId: string;
    gezelId: string;
    gezelName: string;
    projectId: string;
    projectName: string;
    idle: boolean;
    alive: boolean;
    /** ms-epoch of the worker's last turn entry/exit, used for LRU. */
    lastUsedAt: number;
    /** Captured Claude-side session id; null until system.init arrives. */
    claudeSessionId: string | null;
  }>;
}

/** The pool's snapshot with each worker's gezel and project display names. */
export async function describeAnthropicCliPool(
  pool: ClaudeWorkerPool,
  store: Pick<Store, 'readConfig' | 'getGezel' | 'getProject'>,
  getSessionRecord: (sessionId: string) => Promise<ChatSession | null>,
): Promise<AnthropicCliPoolView> {
  const snap = pool.snapshot();
  const config = await store.readConfig();
  const boringMode = config.roleBasedNameOnlyMode ?? false;
  const workers: AnthropicCliPoolView['workers'] = [];
  for (const w of snap.workers) {
    // Resolve display names by reading the persisted ChatSession +
    // gezel + project. Each lookup is a couple of small file reads;
    // we tolerate misses (a session in flight whose record we can't
    // find right now) by falling back to the id.
    const record = await getSessionRecord(w.sessionId).catch(() => null);
    const gezel = record ? await store.getGezel(record.gezelId).catch(() => null) : null;
    const project = record ? await store.getProject(record.projectId).catch(() => null) : null;
    workers.push({
      sessionId: w.sessionId,
      gezelId: record?.gezelId ?? '',
      gezelName: gezel
        ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, boringMode)
        : (record?.gezelId ?? 'unknown'),
      projectId: record?.projectId ?? '',
      projectName: project?.name ?? record?.projectId ?? 'unknown',
      idle: w.idle,
      alive: w.alive,
      lastUsedAt: w.lastUsedAt,
      claudeSessionId: w.claudeSessionId,
    });
  }
  // Read the configured cap so the pill can show "2 / 10 warm".
  const poolSize = config.anthropicCli?.poolSize ?? DEFAULT_CLAUDE_POOL_SIZE;
  return { size: snap.size, poolSize, workers };
}
