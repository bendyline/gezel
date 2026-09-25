import { turnCancelledMessage } from '@bendyline/gezel';
import type { FileTurnIntent } from '@bendyline/gezel';
import {
  FILE_REPAIR_MUTATION_TOOLS,
  FILE_REPAIR_TOOLS,
  type LocalChatCompletionTool,
  isFileRepairTurn,
  isImmediateFileWriteTurn,
} from './constrained-turn.js';

export const LOCAL_TURN_LIMITS = {
  iterations: 96,
  noProgress: 2,
  malformed: 2,
  writeContinuations: 6,
  capTruncation: 2,
  compactRatio: 0.7,
  compactMinPrior: 2,
} as const;

type RecoveryKind = 'noProgress' | 'malformed' | 'writeContinuations' | 'capTruncation';

/**
 * One instance per send. Backends report outcomes after decoding their wire
 * format; this owner decides whether another attempt is allowed. Engine
 * deadlines remain awake-time budgets supplied by the adapter.
 */
export class LocalTurnPolicy {
  private attempts = new Map<RecoveryKind, number>();
  private lastMalformed: string | undefined;
  private compactionAttempted = false;

  constructor(private readonly checkActive: () => void = () => {}) {}

  checkpoint(): void {
    this.checkActive();
  }

  count(kind: RecoveryKind): number {
    return this.attempts.get(kind) ?? 0;
  }

  retry(kind: RecoveryKind, signature?: string): boolean {
    this.checkpoint();
    if (this.count(kind) >= LOCAL_TURN_LIMITS[kind]) return false;
    if (kind === 'malformed' && signature !== undefined && signature === this.lastMalformed)
      return false;
    this.attempts.set(kind, this.count(kind) + 1);
    if (kind === 'malformed') this.lastMalformed = signature;
    return true;
  }

  requireProgressRetry(): number {
    if (!this.retry('noProgress')) {
      throw new Error(
        `File turn ended without a successful workspace mutation after ${LOCAL_TURN_LIMITS.noProgress} corrective nudge(s).`,
      );
    }
    return this.count('noProgress');
  }

  /** Reserve before awaiting so failure/null/concurrent calls spend one attempt. */
  reserveCompaction(): boolean {
    this.checkpoint();
    if (this.compactionAttempted) return false;
    this.compactionAttempted = true;
    return true;
  }
}

export function turnCheckpoint(
  signal: AbortSignal | undefined,
  expired: () => boolean,
  timeoutError: () => Error,
): () => void {
  return () => {
    if (signal?.aborted) throw new Error(turnCancelledMessage());
    if (expired()) throw timeoutError();
  };
}

export interface FileTurnPlan {
  kind: 'create-file' | 'repair-file' | 'ordinary';
  intent?: FileTurnIntent;
}

export function planFileTurn(
  prompt: string,
  tools: LocalChatCompletionTool[] | undefined,
  intent?: FileTurnIntent,
): FileTurnPlan {
  return {
    kind: isFileRepairTurn(prompt, tools, intent)
      ? 'repair-file'
      : isImmediateFileWriteTurn(prompt, tools, intent)
        ? 'create-file'
        : 'ordinary',
    intent,
  };
}

/** Backend-independent repair surface: inspect first, then mutate; never invent tools. */
export function repairTools(
  tools: LocalChatCompletionTool[] | undefined,
  state: {
    readSucceeded: boolean;
    rewrite: boolean;
    prerequisiteReadsPending?: boolean;
    source?: boolean;
  },
): LocalChatCompletionTool[] {
  const available = (tools ?? []).filter((tool) => FILE_REPAIR_TOOLS.has(tool.function.name));
  if (state.prerequisiteReadsPending)
    return available.filter((tool) => tool.function.name === 'read_file');
  if (state.rewrite) return available.filter((tool) => tool.function.name === 'write_file');
  if (state.readSucceeded) return patchOnlyRepairTools(available) ?? available;
  return state.source ? (sourceRepairTools(available) ?? available) : available;
}

interface CompactMessage {
  role: string;
  content: string | null;
}
export interface CompactionAdapter {
  messages: readonly CompactMessage[];
  turnStart: number;
  estimatedTokens: number;
  numCtx: number;
  request?: (args: {
    priorMessages: Array<{ role: string; content: string }>;
    estimatedTokens: number;
    numCtx: number;
  }) => Promise<{ syntheticContent: string } | null>;
  replace(start: number, count: number, content: string): void;
  warn(error: unknown): void;
  completed(removed: number): void;
}

/** Preserve all system bands and the active tool exchange on every backend. */
export async function compactLocalTurn(
  policy: LocalTurnPolicy,
  adapter: CompactionAdapter,
  force = false,
): Promise<boolean> {
  policy.checkpoint();
  if (
    !adapter.request ||
    (!force && adapter.estimatedTokens / adapter.numCtx < LOCAL_TURN_LIMITS.compactRatio)
  )
    return false;
  let start = 0;
  while (start < adapter.turnStart && adapter.messages[start]?.role === 'system') start++;
  const prior = adapter.messages
    .slice(start, adapter.turnStart)
    .flatMap((message) =>
      (message.role === 'user' || message.role === 'assistant') && message.content
        ? [{ role: message.role, content: message.content }]
        : [],
    );
  if (prior.length < LOCAL_TURN_LIMITS.compactMinPrior || !policy.reserveCompaction()) return false;
  let result: { syntheticContent: string } | null;
  try {
    result = await adapter.request({
      priorMessages: prior,
      estimatedTokens: adapter.estimatedTokens,
      numCtx: adapter.numCtx,
    });
  } catch (error) {
    policy.checkpoint();
    adapter.warn(error);
    return false;
  }
  policy.checkpoint();
  if (!result?.syntheticContent) return false;
  const removed = adapter.turnStart - start;
  adapter.replace(start, removed, result.syntheticContent);
  adapter.completed(removed);
  return true;
}

const SOURCE_REPAIR_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'validate',
  'replace_in_file',
  'replace_lines',
]);

/**
 * Does a repair-mode tool result say the file we were sent to repair is not
 * on disk at all?
 *
 * This surface deliberately withholds every creating tool so a model patches
 * instead of re-emitting a whole file. That discipline is only coherent when
 * the target exists: when it does not, `read_file` and both patch tools can
 * only fail, and the turn burns its allowance discovering that. Wild-caught
 * on schema-migration (2026-09-18 and again on HEAD), where the scored
 * deliverable `tests/migrate.test.ts` was never created — the model resolved
 * every signal that was an EDIT and no signal that was a CREATION, then
 * aborted being told it "couldn't find a working call shape". There was no
 * working call shape to find. `readFileForEditOrThrow` even answers "Use
 * `write_file` to create it first", naming a tool the surface removed.
 *
 * Split by tool for a reason. A read reports absence in whatever wording its
 * transport produced — `read_file "<p>": <base>` wraps an unwrapped API error
 * that may read "not found", "404", or "no such file", which is why
 * `cross-drawer-read-tools` sniffs all three — so matching one exact phrase
 * misses most of them (it did: a first cut keyed on "file not found in
 * workspace" left 1 of 3 trials still deadlocked). A MUTATION cannot be that
 * loose: `replace_in_file` answers "`find` string was not found" when the file
 * is present and only the anchor is missing, and treating that as absence
 * would send a whole-file rewrite at a file that just needed a better anchor.
 */
const MISSING_TARGET_READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'read_files', 'stat']);
const MISSING_TARGET_READ = /\bnot found\b|\bno such file\b|\b404\b/i;
const MISSING_TARGET_EDIT = /\bfile does not exist\b|\bfile not found in workspace\b/i;
export function isMissingRepairTargetOutput(toolName: string, output: string): boolean {
  return MISSING_TARGET_READ_TOOLS.has(toolName)
    ? MISSING_TARGET_READ.test(output)
    : MISSING_TARGET_EDIT.test(output);
}
export function mutationOnlyRepairTools(
  tools: LocalChatCompletionTool[] | undefined,
): LocalChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const mutationTools = tools.filter((tool) => {
    const name = tool.function.name;
    return !!name && FILE_REPAIR_MUTATION_TOOLS.has(name);
  });
  return mutationTools.length > 0 ? mutationTools : tools;
}

export function sourceRepairTools(
  tools: LocalChatCompletionTool[] | undefined,
): LocalChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const sourceRepairTools = tools.filter((tool) => {
    const name = tool.function.name;
    return !!name && SOURCE_REPAIR_TOOLS.has(name);
  });
  const canPatch = sourceRepairTools.some((tool) => {
    const name = tool.function.name;
    return name === 'replace_lines' || name === 'replace_in_file';
  });
  return canPatch ? sourceRepairTools : tools;
}

export function patchOnlyRepairTools(
  tools: LocalChatCompletionTool[] | undefined,
): LocalChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const replaceInFile = tools.find((tool) => tool.function.name === 'replace_in_file');
  const replaceLines = tools.find((tool) => tool.function.name === 'replace_lines');
  const preferredPatchTools = [replaceInFile, replaceLines].filter(
    (tool): tool is LocalChatCompletionTool => !!tool,
  );
  if (preferredPatchTools.length > 0) return preferredPatchTools;
  return mutationOnlyRepairTools(tools);
}
