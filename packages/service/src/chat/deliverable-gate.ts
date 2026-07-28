/**
 * Decide whether a craftbook step's `advanceWhen` deliverable is
 * satisfied at the end of an assignee's turn — the pure core of
 * `ChatManager.maybeAutoAdvanceOnObservableProgress`.
 *
 * The legacy gate was "file exists + clears `minBytes` + passes the
 * optional `sniff`". That works for a step whose deliverable is a NEW
 * file (an `index.html` that didn't exist before). It is actively wrong
 * for an EDIT step — fix a bug in `Geohash.ts`, refactor a module —
 * because the source file already exists and is large from turn 1, so
 * the gate fires immediately and advances past the step before any fix
 * lands. That's exactly why bug-fix steps couldn't carry an
 * `advanceWhen` at all, which left them with no observable-progress gate
 * and let a small model declare "I've identified the fix" and drift off
 * (wild-caught: gemma4-e4b on the squisq Geohash bug).
 *
 * `requireChange` closes that: presence is no longer enough — the
 * assignee must have *written to* the deliverable during the turn that
 * triggers the advance. The signal is the turn's drained tool calls
 * (`ChatMessageToolCall[]`), each of which carries the `path` it
 * touched and whether it succeeded — so this needs NO baseline
 * snapshot, no extra persistence, and survives a daemon restart. The
 * `minBytes`/`sniff` floor still applies on top, so the gate can never
 * PASS a truncated or stub edit, only hold-and-loop.
 *
 * Pure + dependency-light (only `runStepSniff`, itself pure) so the
 * decision is unit-testable in isolation from the chat loop.
 */

import { type StepSniffName, runStepSniff } from './step-sniff.js';

/** The subset of `AdvanceWhen` this gate reads (structural, not imported). */
export interface DeliverableGateSpec {
  file: string;
  minBytes?: number;
  sniff?: StepSniffName;
  requireChange?: boolean;
}

/** The subset of a turn's `ChatMessageToolCall` the gate reads. */
export interface DeliverableWrite {
  name: string;
  path?: string;
  success: boolean;
}

export interface DeliverableGateResult {
  satisfied: boolean;
  /** Human-readable explanation — logged on advance, useful when it holds. */
  reason: string;
}

/**
 * Workspace-mutating tools whose successful call against the deliverable
 * counts as "the assignee edited it this turn". Mirrors the write set in
 * `tool-repeat-tracker.ts`; kept local so the gate has no cross-module
 * coupling.
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'replace_in_file',
  'append_to_file',
  'apply_patch',
  'insert_at_marker',
]);

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

/**
 * Did a successful write-shaped tool target `file` among this turn's
 * tool calls? Lenient about a `workspace/` / `./` prefix mismatch
 * between the gate's `file` and the recorded tool `path` — but the
 * suffix match is anchored on a `/` boundary so `Geohash.ts` doesn't
 * match `OtherGeohash.ts`.
 */
export function deliverableWrittenThisTurn(
  writes: readonly DeliverableWrite[],
  file: string,
): boolean {
  const target = normalizeWorkspacePath(file);
  if (!target) return false;
  for (const w of writes) {
    if (!w.success || !w.path || !WRITE_TOOL_NAMES.has(w.name)) continue;
    const wp = normalizeWorkspacePath(w.path);
    if (wp === target || wp.endsWith(`/${target}`) || target.endsWith(`/${wp}`)) return true;
  }
  return false;
}

/**
 * Evaluate the observable-progress gate for one step's deliverable.
 * `content` is the deliverable file's current contents (null when it
 * doesn't exist); `writes` is the turn's drained tool calls.
 */
export function evaluateDeliverableGate(input: {
  content: string | null;
  spec: DeliverableGateSpec;
  writes: readonly DeliverableWrite[];
}): DeliverableGateResult {
  const { content, spec, writes } = input;
  if (content === null) {
    return { satisfied: false, reason: `deliverable ${spec.file} not found` };
  }
  const minBytes = spec.minBytes ?? 1;
  if (content.length < minBytes) {
    return {
      satisfied: false,
      reason: `${spec.file} below minBytes (${content.length} < ${minBytes})`,
    };
  }
  if (spec.sniff && !runStepSniff(spec.sniff, content)) {
    return { satisfied: false, reason: `${spec.file} failed ${spec.sniff} sniff` };
  }
  if (spec.requireChange && !deliverableWrittenThisTurn(writes, spec.file)) {
    return {
      satisfied: false,
      reason: `${spec.file} present but not written this turn (requireChange)`,
    };
  }
  return {
    satisfied: true,
    reason: `${spec.file}, ${content.length}b${spec.sniff ? `, ${spec.sniff} ok` : ''}${
      spec.requireChange ? ', edited this turn' : ''
    }`,
  };
}
