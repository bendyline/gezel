import { normalizeArtifactPath } from '../path-rules.js';
import { contextBudgetCeiling, estimateTokens } from '../retrieval-budget.js';
/**
 * The text a model reads back from a gezel tool, shared by the desktop MCP
 * server and the portable runtime. The desktop loop branches on this text
 * (an `ERROR:` prefix, a `[read_file … complete]` header, a gate rejection's
 * code), and models and craftbooks are tuned against its wording, so a phone
 * running the same loop must render the same words.
 */
import {
  WORKSPACE_READ_MAX_RANGE_LINES,
  WORKSPACE_READ_MAX_RESULT_BYTES,
  type WorkspaceReadFileError,
  type WorkspaceReadFileSuccess,
} from '../schemas/api.js';
import { normalizeStepGate } from '../schemas/gate.js';
import type { Task, TaskCraftbookStep, TaskNote } from '../schemas/task.js';
import { isOwnerStep } from '../task-execution.js';
import { advanceHandoffNote, advanceStatusLine } from './advance-note.js';

/** The text of a tool-execution failure: `[code] message`, retryability, next step. */
export function toolErrorText(
  message: string,
  options: { code?: string; retryable?: boolean; hint?: string } = {},
): string {
  const prefix = options.code ? `[${options.code}] ` : '';
  const retry = options.retryable === undefined ? '' : `\nRetryable: ${options.retryable}`;
  const hint = options.hint ? `\nNext: ${options.hint}` : '';
  return `${prefix}${message}${retry}${hint}`;
}

export function renderExactToolCall(name: string, args: Record<string, unknown>): string {
  return `${name}(${JSON.stringify(args)})`;
}

// ── Reads ──────────────────────────────────────────────────────────────

/**
 * Prefix each line with a right-aligned line number and a `→` gutter, so the
 * model can target edits by line. The gutter is a display aid only — the edit
 * tools never see it. A trailing newline is preserved without numbering a
 * phantom final empty line. `startAt` numbers a window cut from mid-file.
 */
export function withLineNumbers(content: string, startAt = 1): string {
  if (content === '') return '';
  const hadTrailingNewline = content.endsWith('\n');
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = body.split('\n');
  const width = String(startAt + lines.length - 1).length;
  const numbered = lines
    .map((line, i) => `${String(startAt + i).padStart(width)}→${line}`)
    .join('\n');
  return hadTrailingNewline ? `${numbered}\n` : numbered;
}

/** A ranged `read_file` result: header, numbered lines, continuation hint. */
export function formatWorkspaceRead(result: WorkspaceReadFileSuccess, raw: boolean): string {
  const body = raw ? result.content : withLineNumbers(result.content, result.startLine);
  if (raw) return body;
  return `[read_file path=${JSON.stringify(result.path)} ${workspaceReadRangeLabel(result)}${result.completeFile ? ' complete' : ''}]\n${body || '(no lines returned)'}${workspaceReadHint(result)}`;
}

export function workspaceReadRangeLabel(result: WorkspaceReadFileSuccess): string {
  const total = result.totalLines === undefined ? '?' : String(result.totalLines);
  if (result.linesReturned === 0) return `lines=none totalLines=${total}`;
  return `lines=${result.startLine}-${result.endLine} totalLines=${total}`;
}

export function workspaceReadHint(result: WorkspaceReadFileSuccess): string {
  if (result.nextStartLine === undefined && !result.truncated) return '';
  const parts: string[] = [];
  if (result.nextStartLine !== undefined) {
    const nextEnd = result.nextStartLine + WORKSPACE_READ_MAX_RANGE_LINES - 1;
    parts.push(
      `next: read_file({"path":${JSON.stringify(result.path)},"startLine":${result.nextStartLine},"endLine":${nextEnd}})`,
    );
  }
  if (result.truncationReason) parts.push(`truncated=${result.truncationReason}`);
  return `\n\n…[${parts.join('; ')}]`;
}

/** A range the desktop refuses before reading: reversed, or longer than 400 lines. */
export function workspaceReadRangeError(args: { startLine?: number; endLine?: number }):
  | string
  | null {
  const start = args.startLine ?? 1;
  if (args.endLine !== undefined && args.endLine < start) {
    return `endLine (${args.endLine}) must be greater than or equal to startLine (${start})`;
  }
  if (args.endLine !== undefined && args.endLine - start + 1 > WORKSPACE_READ_MAX_RANGE_LINES) {
    return `a read range may contain at most ${WORKSPACE_READ_MAX_RANGE_LINES} lines`;
  }
  return null;
}

/**
 * The daemon reader's line-range result over text already in memory. The
 * daemon streams and stops once the range is complete, so a range that ends
 * before the file does reports no total; a trailing newline ends the last
 * line rather than starting another, a carriage return before a newline is
 * dropped, an omitted end reads at most 400 lines, and a range stops early at
 * 32 KB of output.
 */
export function sliceWorkspaceText(
  path: string,
  content: string,
  request: { startLine?: number; endLine?: number },
): WorkspaceReadFileSuccess | WorkspaceReadFileError {
  const encoder = new TextEncoder();
  const startLine = request.startLine ?? 1;
  const requestedEndLine = request.endLine ?? startLine + WORKSPACE_READ_MAX_RANGE_LINES - 1;
  const effectiveEndLine = Math.min(
    requestedEndLine,
    startLine + WORKSPACE_READ_MAX_RANGE_LINES - 1,
  );
  const endsWithNewline = content.endsWith('\n');
  const lines =
    content === '' ? [] : (endsWithNewline ? content.slice(0, -1) : content).split('\n');
  const totalLines = lines.length;
  const totalBytes = encoder.encode(content).length;
  const returned: string[] = [];
  let bytesReturned = 0;
  let stoppedAt: number | undefined;
  let reason: 'line-limit' | 'output-limit' | undefined;
  for (let n = startLine; n <= Math.min(effectiveEndLine, totalLines); n++) {
    let line = lines[n - 1]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const size = encoder.encode(line).length + (returned.length > 0 ? 1 : 0);
    if (bytesReturned + size > WORKSPACE_READ_MAX_RESULT_BYTES) {
      if (returned.length === 0)
        return {
          status: 'error',
          path,
          code: 'line-too-long',
          error: `line ${n} exceeds this read's ${WORKSPACE_READ_MAX_RESULT_BYTES}-byte output budget; use grep_files to narrow it`,
        };
      stoppedAt = n;
      reason = 'output-limit';
      break;
    }
    returned.push(line);
    bytesReturned += size;
  }
  const endLine = returned.length > 0 ? startLine + returned.length - 1 : 0;
  if (stoppedAt === undefined && endLine > 0 && endLine < totalLines) {
    stoppedAt = endLine + 1;
    if (effectiveEndLine < requestedEndLine || request.endLine === undefined) reason = 'line-limit';
  }
  if (stoppedAt !== undefined)
    return {
      status: 'ok',
      path,
      content: returned.join('\n'),
      startLine,
      endLine,
      linesReturned: returned.length,
      bytesReturned,
      scannedBytes: totalBytes,
      totalBytes,
      eof: false,
      completeFile: false,
      hasMore: true,
      nextStartLine: stoppedAt,
      truncated: reason !== undefined,
      truncationReason: reason,
    };
  if (startLine > totalLines && !(content === '' && startLine === 1))
    return {
      status: 'error',
      path,
      code: 'range-out-of-bounds',
      error: `startLine ${startLine} is past EOF (${totalLines} total lines)`,
    };
  const completeFile = startLine === 1 && endLine === totalLines;
  const text = returned.join('\n') + (completeFile && endsWithNewline ? '\n' : '');
  return {
    status: 'ok',
    path,
    content: text,
    startLine,
    endLine,
    linesReturned: returned.length,
    bytesReturned: bytesReturned + (completeFile && endsWithNewline ? 1 : 0),
    scannedBytes: totalBytes,
    totalLines,
    totalBytes,
    eof: true,
    completeFile,
    hasMore: false,
    truncated: false,
  };
}

/**
 * A whole-file `read_artifact`: the content, and when only part of it was
 * returned, where the slice sits and the exact call for the next one.
 */
export function readArtifactText(
  path: string,
  content: string,
  slice?: { startLine: number; linesReturned: number; totalLines: number },
): string {
  if (!slice || slice.linesReturned === slice.totalLines) return content;
  const end = slice.startLine + Math.max(0, slice.linesReturned - 1);
  const earlier = slice.startLine > 1 ? ' Earlier lines are not included in this slice.' : '';
  const nextStart = end + 1;
  const continuation =
    nextStart <= slice.totalLines
      ? ` Next: ${renderExactToolCall('read_artifact', { path, startLine: nextStart, endLine: Math.min(slice.totalLines, nextStart + WORKSPACE_READ_MAX_RANGE_LINES - 1) })}`
      : ' End of file; no later lines.';
  return `${content}\n\n[lines ${slice.startLine}-${end} of ${slice.totalLines}.${earlier}${continuation}]`;
}

// ── Writes and edits ───────────────────────────────────────────────────

/**
 * Added and removed line counts of a minimal line diff, the numbers a unified
 * diff's `+`/`-` body lines add up to. A line with and without its final
 * newline differ, as they do in a patch.
 */
export function countLineChanges(
  before: string,
  after: string,
): { addedLines: number; removedLines: number } {
  const tokens = (text: string) => (text === '' ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []));
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { addedLines: m, removedLines: n };
  // Longest common subsequence of the changed middle, one row at a time.
  let lcs = 0;
  if (n * m <= 4_000_000) {
    let previous = new Uint32Array(m + 1);
    let current = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++)
        current[j] =
          a[start + i - 1] === b[start + j - 1]
            ? previous[j - 1]! + 1
            : Math.max(previous[j]!, current[j - 1]!);
      [previous, current] = [current, previous];
    }
    lcs = previous[m]!;
  }
  return { addedLines: m - lcs, removedLines: n - lcs };
}

/** Context lines shown either side of an edit in the re-anchor window. */
export const REANCHOR_CONTEXT_LINES = 4;
/** Hard cap so a large replacement can't flood the turn with its own echo. */
export const REANCHOR_MAX_CHARS = 1400;

/**
 * The suffix of a line-addressed edit's result: how line numbers shifted and
 * the edited region re-numbered, so a second edit is aimed at the file as it
 * now is. Empty when there is nothing to show.
 */
export function reanchorText(args: {
  path: string;
  startLine: number;
  addedLines: number;
  removedLines: number;
  content: string;
}): string {
  if (args.content === '') return '';
  const body = args.content.endsWith('\n') ? args.content.slice(0, -1) : args.content;
  const lines = body.split('\n');
  const delta = args.addedLines - args.removedLines;
  const from = Math.max(1, args.startLine - REANCHOR_CONTEXT_LINES);
  const through = Math.min(
    lines.length,
    args.startLine + Math.max(args.addedLines, 1) - 1 + REANCHOR_CONTEXT_LINES,
  );
  if (through < from) return '';
  let window = withLineNumbers(lines.slice(from - 1, through).join('\n'), from);
  if (window.length > REANCHOR_MAX_CHARS) {
    window = `${window.slice(0, REANCHOR_MAX_CHARS)}\n… (window truncated; re-read for the rest)`;
  }
  const shift =
    delta === 0
      ? 'Line numbers elsewhere in the file are unchanged.'
      : `Every line after ${args.startLine} shifted by ${delta > 0 ? '+' : ''}${delta} — line numbers from an earlier read_file are stale past that point.`;
  return `\n\n${shift}\n${args.path} now reads:\n${window}`;
}

export function appendedText(path: string, appended: number, total: number): string {
  return `Appended ${appended} chars to ${path} (total: ${total} chars).`;
}

export function editedText(path: string, change: { addedLines: number; removedLines: number }) {
  return `Edited ${path} (+${change.addedLines} −${change.removedLines}).`;
}

/** How the session's active craftbook step completes, as `write_artifact` explains it. */
export type StepCompletionMode = 'automatic' | 'manual' | 'unknown';

export function stepCompletionMode(
  step: { advanceWhen?: unknown } | undefined,
): StepCompletionMode {
  if (!step) return 'unknown';
  return step.advanceWhen ? 'automatic' : 'manual';
}

/**
 * The artifact files an active step's completion checks read, artifact-relative.
 * A save that lands on one of them is the step's deliverable.
 */
export function stepCheckedArtifactPaths(
  step: Pick<TaskCraftbookStep, 'gate' | 'advanceWhen'> | undefined,
): string[] {
  if (!step) return [];
  const paths = new Set<string>();
  for (const check of step.gate ? normalizeStepGate(step.gate).checks : []) {
    const file = (check as { file?: unknown }).file;
    if (
      (check as { artifact?: boolean }).artifact === true &&
      typeof file === 'string' &&
      file &&
      !file.includes('*')
    )
      paths.add(normalizeArtifactPath(file));
  }
  if (step.advanceWhen?.artifact === true && step.advanceWhen.file)
    paths.add(normalizeArtifactPath(step.advanceWhen.file));
  return [...paths];
}

/**
 * What saving an artifact means for the active step, appended to `write_artifact`.
 * `checkedByStep` marks a save onto a file a manual step's checks read: on
 * the iPhone a 2B model saved exactly that file and then rewrote it until its
 * loop guard fired, never submitting the step the generic line told it to. An
 * automatic step needs no change: its line already says to stop.
 */
export function artifactCompletionHint(
  mode: StepCompletionMode | undefined,
  options: { checkedByStep?: boolean } = {},
): string {
  if (mode === undefined) return '';
  if (options.checkedByStep && mode === 'manual')
    return "\nThis is the file the step's completion checks read. If it is complete, call advance_task_step now to submit the step; saving it again changes nothing.";
  if (mode === 'automatic')
    return '\nThis step uses automatic completion checks. Finish its required deliverable and stop; the runtime will run its completion gate. Saving does not approve the work. If the gate rejects it, repair the named problems and save the complete deliverable again.';
  if (mode === 'manual')
    return '\nSaving an artifact does not complete the task step. When its required deliverable is ready, call advance_task_step to run the completion checks. Repair specific failures if returned; do not repeatedly rewrite a finished report without submitting it.';
  return '\nFollow the active craftbook completion rule. If it uses automatic completion, finish the required deliverable and stop; otherwise call advance_task_step when ready. Saving alone is not approval. Repair any specific validation failures returned.';
}

// ── Listings ───────────────────────────────────────────────────────────

interface ListedEntry {
  path: string;
  isDirectory: boolean;
}

export function listDirText(files: readonly ListedEntry[]): string {
  const listing = files.map((f) => `${f.isDirectory ? '📁' : '📄'} ${f.path}`).join('\n');
  const summary = files.length
    ? `Listed ${files.length} ${files.length === 1 ? 'entry' : 'entries'}.`
    : 'Empty directory.';
  return listing ? `${summary}\n${listing}` : summary;
}

/**
 * A `list_dir` path that is not a folder. Answering "Empty directory." for a
 * folder that does not exist sent a 2B model on the iPhone looking for
 * `repairs/` five times, when the store it had just written was
 * `repairs.json`, until the loop guard ended the turn.
 */
export function listDirMissingText(
  path: string,
  found: 'missing' | 'file',
  nearby: readonly string[] = [],
): string {
  if (found === 'file') return `\`${path}\` is a file, not a folder. Read the file instead.`;
  const near = nearby.length ? ` Did you mean ${nearby.map((p) => `\`${p}\``).join(' or ')}?` : '';
  return `No folder or file exists at \`${path}\`.${near}`;
}

/**
 * Entries beside a missing path that the caller probably meant: the same
 * name in another case, or the name with an extension (`repairs` →
 * `repairs.json`). Paths are returned relative to the same root as `path`.
 */
export function nearbyPathMatches(
  path: string,
  siblings: readonly { name: string }[],
  limit = 3,
): string[] {
  const slash = path.lastIndexOf('/');
  const parent = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = path.slice(slash + 1).toLowerCase();
  if (!base) return [];
  const stem = (name: string) => name.replace(/\.[^.]+$/, '');
  return siblings
    .map((entry) => entry.name)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower === base || lower.startsWith(`${base}.`) || stem(lower) === stem(base);
    })
    .slice(0, limit)
    .map((name) => `${parent}${name}`);
}

export function listArtifactsText(
  files: readonly ListedEntry[],
  subpath: string,
  truncated: boolean | undefined,
): string {
  const listing = files
    .map((f) =>
      f.isDirectory
        ? `📁 ${f.path}`
        : `📄 ${f.path}\n   open: ${renderExactToolCall('read_artifact', { path: f.path })}`,
    )
    .join('\n');
  const summary = files.length
    ? `Listed ${files.length} ${files.length === 1 ? 'artifact entry' : 'artifact entries'}${subpath ? ` under ${subpath}/` : ''}.`
    : subpath
      ? `No artifacts under ${subpath}/.`
      : 'No artifacts yet.';
  const truncation = truncated
    ? `\nResults were truncated; ${subpath ? 'narrow `path` further' : 'pass `path` to scope the walk'} or use \`recursive: false\`.`
    : '';
  return listing ? `${summary}\n${listing}${truncation}` : `${summary}${truncation}`;
}

export function listDocumentsText(files: readonly ListedEntry[]): string {
  const listing = files.map((f) => `${f.isDirectory ? 'dir ' : 'file'} ${f.path}`).join('\n');
  const summary = files.length
    ? `Listed ${files.length} ${files.length === 1 ? 'document entry' : 'document entries'}.`
    : 'No documents found.';
  return listing ? `${summary}\n${listing}` : summary;
}

// ── Memory ─────────────────────────────────────────────────────────────

export function searchMemoryText(
  results: readonly { text: string; score: number; day: string; scope: string }[],
  degradedMessage?: string,
): string {
  const resultSummary = results.length
    ? `Found ${results.length} relevant ${results.length === 1 ? 'memory' : 'memories'}.`
    : 'No relevant memories found.';
  const summary = degradedMessage ? `${degradedMessage} ${resultSummary}` : resultSummary;
  const formatted = results
    .map((r) => `[${r.scope}/${r.day} score=${r.score.toFixed(2)}] ${r.text}`)
    .join('\n\n');
  return formatted ? `${summary}\n${formatted}` : summary;
}

export function saveMemoryText(
  status: 'saved' | 'duplicate',
  scope: string,
  degradedMessage?: string,
): string {
  const savedSummary =
    status === 'duplicate'
      ? `Memory already existed (${scope}); no duplicate was added.`
      : `Memory saved (${scope}).`;
  return degradedMessage ? `${savedSummary} ${degradedMessage}` : savedSummary;
}

// ── Tasks ──────────────────────────────────────────────────────────────

export function readTaskNotesText(
  ref: string,
  stepId: string | undefined,
  notes: readonly TaskNote[],
): string {
  const summary = `Loaded ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} for ${ref}${stepId ? `/${stepId}` : ''}.`;
  return `${summary}\n${JSON.stringify({ notes })}`;
}

export function writeTaskNoteText(
  ref: string,
  stepId: string | undefined,
  note: { id: string; at: string },
): string {
  return `Appended note ${note.id} to ${ref}${stepId ? `/${stepId}` : ''} at ${note.at}.`;
}

/** A completed `advance_task_step`: one plain sentence, then the bookkeeping. */
export function advanceTaskStepText(ref: string, stepId: string, task: Task): string {
  const active = task.craftbook.steps.find((s) => s.id === task.activeStepId);
  const assigneeId =
    active?.assignee?.kind === 'gezel' ? active.assignee.gezelId : active?.suggestedGezelId;
  const handoffNote = advanceHandoffNote({
    status: task.status,
    assigneeId,
    ownerStep: isOwnerStep(active),
  });
  const statusLine = advanceStatusLine({
    completedName: task.craftbook.steps.find((s) => s.id === stepId)?.name ?? stepId,
    nextName: active?.name,
    status: task.status,
    taskTitle: task.title,
    ownerStep: isOwnerStep(active),
  });
  return `${statusLine}\n\nCompleted step "${stepId}" on ${ref}. Active step is now "${active?.name ?? task.activeStepId ?? '(none)'}".${handoffNote}`;
}

/** The gate outcome of an `advance_task_step` that did not complete the step. */
export interface AdvanceGateOutcome {
  message: string;
  attempt?: number;
  maxAttempts?: number;
  paused?: boolean;
  hook?: string;
  infrastructureError?: boolean;
  scriptRuns?: readonly { scriptName: string; runId?: string; error?: string }[];
}

/** The error an `advance_task_step` returns when its gate or exit hook refused the step. */
export function advanceGateFailureText(
  ref: string,
  stepId: string,
  gate: AdvanceGateOutcome,
): string {
  // A declarative gate can reject the work, or an onExit lifecycle
  // script can fail after gate approval. Both use the same compatible
  // wire envelope, but a hook failure is infrastructure—not a defect
  // the model should try to repair in the deliverable.
  const exitHookFailed = gate.hook === 'onExit';
  const pausedNote = exitHookFailed
    ? ' The lifecycle script could not finish, so the task is PAUSED and the step remains incomplete. Do not retry or rewrite the deliverable; report the script/runtime problem.'
    : gate.infrastructureError
      ? ' The gate itself could not run, so the task is PAUSED and no deliverable attempt was consumed. Do not rewrite the deliverable; report the gate/runtime problem.'
      : gate.paused
        ? ' The rejection budget is exhausted — the task is now PAUSED for the user; summarize where you got stuck and what you tried.'
        : ' Address these specifically, then call `advance_task_step` again.';
  const failedRun = gate.scriptRuns?.find((run) => run.error || run.runId);
  const diagnosticNote = failedRun
    ? `\nScript diagnostic: ${failedRun.scriptName}${failedRun.runId ? ` (run ${failedRun.runId})` : ''}${failedRun.error ? ` — ${failedRun.error}` : ''}. Full redacted logs are in the task note.`
    : '';
  return toolErrorText(
    exitHookFailed
      ? `Step "${stepId}" on ${ref} was NOT completed because its onExit script failed:\n\n${gate.message}\n${pausedNote}${diagnosticNote}`
      : gate.infrastructureError
        ? `Step "${stepId}" on ${ref} was NOT completed because its gate could not run:\n\n${gate.message}\n${pausedNote}${diagnosticNote}`
        : `Step "${stepId}" on ${ref} was NOT completed — its gate rejected the work (attempt ${gate.attempt}/${gate.maxAttempts}):\n\n${gate.message}\n${pausedNote}`,
    {
      code: exitHookFailed
        ? 'step_exit_script_failed'
        : gate.infrastructureError
          ? 'gate_infrastructure_error'
          : 'gate_rejected',
      retryable: !gate.paused && !gate.infrastructureError,
    },
  );
}

/** A created task, and whether its entry step is already running or still needs a brief. */
export function createTaskText(
  created: Task,
  options: { dispatch: boolean; callerGezelId?: string },
): string {
  const assigneeGezelId = created.assignee.kind === 'gezel' ? created.assignee.gezelId : null;
  const spawnNote = created.spawnsCraftbook
    ? ` Spawn craftbook has ${created.spawnsCraftbook.steps.length} step(s).`
    : '';
  const fanoutNote = created.fanout?.materializedAt
    ? ` Materialized ${created.fanout.count} instance(s) from the spawn craftbook.`
    : '';
  const kickoff = options.dispatch
    ? `\n\nEntry step dispatched — ${assigneeGezelId ?? 'the assignee'} starts in a task-scoped session with the step contract in-prompt. Do not message_gezel them a duplicate kickoff.`
    : created.craftbook.steps.length > 0 &&
        assigneeGezelId &&
        assigneeGezelId !== options.callerGezelId
      ? // The action leads: Gemma 4 E4B on a phone wrote a task note after the
        // older "Prefer dispatch… For this task, call message_gezel" wording,
        // and the assignee never ran (Galaxy S26, 2026-10-02).
        `\n\nNext: call message_gezel({ gezel: "${assigneeGezelId}", message: "new task ${created.ref} — ${created.title}: <one-line ask>" }). ${assigneeGezelId} has not been told about this task and will not start it until you do. (\`dispatch: true\` on create_task starts the assignee directly next time.)`
      : '';
  return `Created ${created.ref} — "${created.title}" with ${created.craftbook.steps.length} step(s).${spawnNote}${fanoutNote}${kickoff}`;
}

// ── Questions and handoffs ─────────────────────────────────────────────

/** An `ask_user_question` call with no question text: a nudge, not an error. */
export const ASK_USER_QUESTION_EMPTY_TEXT =
  'ask_user_question needs a non-empty `question` string — that\'s the actual question to show the user. Retry this tool call with `question: "..."`.';

/**
 * A crew member a question card names, other than the gezel asking. "Ask your
 * colleague to read crew-brief.md" sent a 2B model to `ask_user_question` in
 * every crew-handoff trial on two phones (2026-10-01): the card reached the
 * person using the app, never the colleague.
 *
 * Names in the pool double as words (Max, Rose, Grace, Jack, Ivy), so only
 * a capital the name owns counts: a display name matches case-sensitively,
 * and a one-word name never at the start of a sentence, where grammar
 * supplies the capital ("What max length…", "Grace period?"). An id counts
 * only when compound (`eval-colleague`, `max-2`); a one-word id is the
 * lowercased name and carries no signal of its own.
 */
export function crewMemberNamedIn(
  text: string,
  crew: readonly { id: string; name: string }[],
  selfId: string | undefined,
): { id: string; name: string } | undefined {
  const occurrences = (word: string, flags: string) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, `g${flags}`);
    return [...text.matchAll(pattern)].map((match) => match.index ?? 0);
  };
  const startsSentence = (index: number) => {
    const lead = text.slice(0, index).replace(/[\p{Zs}\t"'“‘«(\[{*_•>#-]+$/u, '');
    return lead === '' || /[.!?:;…\n]$/.test(lead);
  };
  const namesId = (id: string) => /[^\p{L}]/u.test(id) && occurrences(id, 'iu').length > 0;
  const namesName = (value: string) => {
    const name = value.trim();
    if (name.length < 2) return false;
    const found = occurrences(name, 'u');
    // A multi-word name, or one in a script without case, is distinctive alone.
    if (/\s/.test(name) || !/^[\p{Lu}\p{Ll}]/u.test(name)) return found.length > 0;
    return /^\p{Lu}/u.test(name) && found.some((index) => !startsSentence(index));
  };
  return crew.find(
    (member) => member.id !== selfId && (namesId(member.id) || namesName(member.name)),
  );
}

export function askUserQuestionText(
  questionId: string,
  deduplicated: boolean,
  colleague?: { id: string; name: string },
): string {
  return askUserQuestionBody(questionId, deduplicated) + colleagueNote(colleague);
}

function colleagueNote(colleague: { id: string; name: string } | undefined): string {
  if (!colleague) return '';
  return `\n\nThis card goes to the person using the app, not to ${colleague.name}. To give ${colleague.name} the work, call message_gezel({ gezel: ${JSON.stringify(colleague.id)}, message: "<what ${colleague.name} should do>" }) once the answer arrives.`;
}

function askUserQuestionBody(questionId: string, deduplicated: boolean): string {
  if (deduplicated)
    return `[STOP — a question is ALREADY waiting for the user]\n\nYou asked the user a question on an earlier turn (id ${questionId}) and they haven't answered it yet, so this new question was NOT posted — re-asking a reworded version would only stack duplicate cards. Do NOT rephrase and ask again. **END YOUR TURN now** and wait; their answer arrives as the next user message starting with "[Answer to: …]". If the work can proceed without that answer, take a concrete action (route, hand off, or build) instead of asking.`;
  return `[STOP — question card is now in front of the user]\n\nThe runtime posted the card (id ${questionId}). The user sees it in chat, on the Home panel, and as a badge. **END YOUR TURN HERE** — do NOT emit a follow-up assistant message, a "thanks for waiting" sentence, or another \`ask_user_question\` call. Any further text or tool calls this turn are runtime-suppressed and never reach the user; the card is the message. Their answer will arrive as the next user message starting with "[Answer to: …]" — your turn fires again then.`;
}

export function asyncHandoffReleaseInstruction(
  recipientName: string,
  deliveryState: 'parked' | 'dispatched',
): string {
  if (deliveryState === 'parked') {
    return `The handoff is durably parked and has NOT entered ${recipientName}'s provider queue because your current turn still holds its slot. END YOUR TURN NOW — do not call more tools or wait — so this turn releases the slot and ${recipientName}'s turn can dispatch. Their reply will arrive asynchronously in a later turn.`;
  }
  return `${recipientName}'s turn has entered the provider queue. END YOUR TURN NOW — do not call more tools or wait — so your turn releases its provider slot. Their reply will arrive asynchronously in a later turn.`;
}

export function messageGezelText(args: {
  recipientName: string;
  deliveryState: 'parked' | 'dispatched';
  deduplicated?: boolean;
  expectedFilePath?: string | null;
}): string {
  const deliverableText =
    args.expectedFilePath !== undefined
      ? ` They have been asked to write ${args.expectedFilePath ? `\`${args.expectedFilePath}\`` : 'the file'} before replying.`
      : '';
  const release = asyncHandoffReleaseInstruction(args.recipientName, args.deliveryState);
  if (args.deduplicated)
    return `An identical file handoff is already pending with ${args.recipientName}; joined it instead of creating another message. ${release}`;
  return args.deliveryState === 'parked'
    ? `Accepted the message for ${args.recipientName}.${deliverableText} ${release}`
    : `Dispatched the message to ${args.recipientName}.${deliverableText} ${release}`;
}

// ── Scripts ────────────────────────────────────────────────────────────

export interface ScriptRunSummary {
  runId: string;
  status: string;
  error?: string;
  output?: unknown;
  callsSummary: readonly { kind: string; durationMs: number; error?: string }[];
}

/** A script run's result text; a failed run is an error that leads with its message. */
export function scriptRunText(res: ScriptRunSummary): { text: string; isError: boolean } {
  const header = `run ${res.runId} — status: ${res.status}${res.error ? ` — error: ${res.error}` : ''}`;
  const callsSummary = res.callsSummary.length
    ? `\ncalls:\n${res.callsSummary
        .map((c) => `  - ${c.kind} (${c.durationMs}ms)${c.error ? ` — ${c.error}` : ''}`)
        .join('\n')}`
    : '';
  const outputBlock =
    res.output === undefined ? '' : `\noutput:\n${JSON.stringify(res.output, null, 2)}`;
  // A failed tool row already carries a red ✗ and error styling. Lead with
  // the actionable script message instead of repeating a run UUID, status,
  // and "error" label that are useful to machinery but noisy in the chat.
  if (res.status === 'error')
    return { text: `${res.error ?? 'Script failed.'}${outputBlock}${callsSummary}`, isError: true };
  return { text: `${header}${outputBlock}${callsSummary}`, isError: false };
}

// ── Roster, projects and tasks ─────────────────────────────────────────

export function listGezelsText(gezels: readonly { id: string; name: string; role?: string }[]) {
  const listing = gezels
    .map((g) => `• ${g.name}${g.role ? ` (${g.role})` : ''} — id: ${g.id}`)
    .join('\n');
  const summary = gezels.length
    ? `Listed ${gezels.length} ${gezels.length === 1 ? 'gezel' : 'gezels'}.`
    : 'No gezels yet.';
  return listing ? `${summary}\n${listing}` : summary;
}

export function listProjectsText(
  projects: readonly {
    id: string;
    name: string;
    description?: string;
    workingDir?: string;
    voormanGezelId?: string;
    detectedProjectType?: { id: string };
    projectTypeId?: string;
    architecture?: string;
  }[],
): string {
  const listing = projects
    .map((p) => {
      const type = p.projectTypeId ?? p.detectedProjectType?.id;
      const head = `• ${p.name} — id: ${p.id}${type ? ` [${type}]` : ''}${p.workingDir ? ` (ext: ${p.workingDir})` : ''}${p.voormanGezelId ? ` (voorman: ${p.voormanGezelId})` : ''}`;
      const body = p.architecture ?? p.description;
      return body ? `${head}\n    ${body}` : head;
    })
    .join('\n');
  const summary = projects.length
    ? `Listed ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}.`
    : 'No projects yet.';
  return listing ? `${summary}\n${listing}` : summary;
}

export function formatTaskLine(t: {
  ref: string;
  title: string;
  status: string;
  assignee: { kind: string; gezelId?: string };
  activeStepId?: string;
  craftbook: { steps: Array<{ id: string; name: string; completedAt?: string }> };
  spawnsCraftbook?: { steps: Array<unknown> };
  parentTaskRef?: string;
}): string {
  const who = t.assignee.kind === 'user' ? 'user' : t.assignee.gezelId;
  const active = t.activeStepId
    ? t.craftbook.steps.find((s) => s.id === t.activeStepId)
    : undefined;
  const stepLabel = t.activeStepId
    ? `active step: ${active?.name ?? t.activeStepId}`
    : t.spawnsCraftbook
      ? `spawn craftbook (${t.spawnsCraftbook.steps.length} step blueprint)`
      : 'no active step';
  const parentLabel = t.parentTaskRef ? ` · child of ${t.parentTaskRef}` : '';
  return `• ${t.ref} [${t.status}] (→ ${who}) — "${t.title}" · ${stepLabel}${parentLabel}`;
}

export function listTasksText(tasks: readonly Parameters<typeof formatTaskLine>[0][]): string {
  const summary = tasks.length
    ? `Listed ${tasks.length} matching ${tasks.length === 1 ? 'task' : 'tasks'}.`
    : 'No tasks match.';
  return tasks.length ? `${summary}\n${tasks.map(formatTaskLine).join('\n')}` : summary;
}

export function getTaskText(task: { ref: string }): string {
  return `Loaded task ${task.ref}.\n${JSON.stringify(task, null, 2)}`;
}

export function addGezelToProjectText(gezelId: string, projectId: string, added: boolean) {
  return added
    ? `Added gezel ${gezelId} to project ${projectId}.`
    : `Gezel ${gezelId} is already on the roster for project ${projectId}.`;
}

export function getScriptRunText(run: { id: string; status: string }): string {
  return `Loaded script run ${run.id} — status: ${run.status}.\n${JSON.stringify(run, null, 2)}`;
}

/** `list_scripts`: project scripts, then the read-only standard library and its scope. */
/**
 * The scripts a gezel can run. Actions lead and spell out choice values; the
 * gate checks, which serve craftbook completion gates, follow as one line each.
 * Listed in catalogue order with full detail, the one action a chat turn
 * needed (`storeRecords`) sat eleventh of twelve behind ten gates, a 2B model
 * on the Galaxy S26 called it missing, and every run's first call guessed
 * `mode` because a choice input showed only "choice" (2026-10-01).
 */
export function listScriptsText(
  project: readonly ListedScript[],
  standard: readonly ListedScript[],
): string {
  const inputList = (s: ListedScript) =>
    s.meta.inputs
      ? Object.entries(s.meta.inputs)
          .map(([k, f]) => {
            const type =
              f.type === 'choice' && f.options?.length
                ? f.options.map((option) => option.value).join('|')
                : f.type;
            return `${k}: ${type}${f.required ? '' : '?'}`;
          })
          .join(', ')
      : '—';
  const full = (s: ListedScript) => {
    const requires = s.meta.requires?.length ? s.meta.requires.join(', ') : '—';
    return `• ${s.name} — ${s.meta.description}\n    inputs: ${inputList(s)}\n    requires: ${requires}`;
  };
  const compact = (s: ListedScript) =>
    `• ${s.name}(${inputList(s)}) — ${s.meta.description.replace(/^Gate:\s*/i, '')}`;
  const isGate = (s: ListedScript) => s.meta.kind === 'gate';
  const actions = standard.filter((s) => !isGate(s));
  const gates = standard.filter(isGate);
  const sections: string[] = [];
  sections.push(
    project.length
      ? `## Project scripts\n${project.map(full).join('\n')}`
      : 'No project scripts yet.',
  );
  if (actions.length) {
    sections.push(
      `## Standard actions (read-only, scope: "standard")\n${actions.map(full).join('\n')}`,
    );
  }
  if (gates.length) {
    sections.push(
      `## Standard gate checks (read-only, scope: "standard"), for craftbook completion gates\n${gates.map(compact).join('\n')}`,
    );
  }
  const count = project.length + standard.length;
  const summary = `Listed ${count} installed ${count === 1 ? 'script' : 'scripts'}.`;
  return `${summary}\n${sections.join('\n\n')}`;
}

interface ListedScript {
  name: string;
  meta: {
    description: string;
    kind?: string;
    inputs?: Record<
      string,
      { type: string; required?: boolean; options?: readonly { value: string }[] }
    >;
    requires?: readonly string[];
  };
}

// ── Search ─────────────────────────────────────────────────────────────

const SEARCH_SNIPPET_MAX_CHARS = 200;

function clampSearchSnippet(snippet: string): string {
  const collapsed = snippet.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SEARCH_SNIPPET_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SEARCH_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

export interface SearchResultRow {
  kind: string;
  title: string;
  snippet?: string;
  projectId?: string;
  path?: string;
  uri?: string;
  line?: number;
  lineEnd?: number;
  source?: string;
  retrievalSource?: string;
  tier?: string;
}

export interface SearchCraftbookSuggestion {
  id: string;
  name: string;
  source: string;
  description?: string;
  invocation: { arguments: unknown };
}

/**
 * `search`'s text: a summary, result rows budgeted to the context window (at
 * least one), a continuation cursor when more exists, and craftbook options.
 * Rows are the model-facing results, already mapped to paths it can open.
 */
export function searchResultText(input: {
  results: readonly SearchResultRow[];
  craftbooks: readonly SearchCraftbookSuggestion[];
  projectId: string;
  truncated: boolean;
  sourcesIncomplete?: boolean;
  hiddenBelowRelevanceFloor?: number;
  cursor?: number;
  contextWindow?: number;
}): { text: string; summary: string; moreExists: boolean; hidden: number; nextCursor?: number } {
  const { projectId } = input;
  const lines = input.results.map((r) => {
    const provenance = r.retrievalSource ?? r.source ?? r.kind;
    const projectScope = r.projectId && r.projectId !== projectId ? ` project=${r.projectId}` : '';
    // Mark only high-confidence hits; unmarked rows are the weak tier —
    // a marker on every row would just spend tokens saying nothing.
    const confidence = r.tier === 'strong' ? ' strong' : '';
    const lineSpan = r.line
      ? `:${r.line}${r.lineEnd && r.lineEnd !== r.line ? `-${r.lineEnd}` : ''}`
      : '';
    // Knowledge rows have no filesystem path — the citation URI is the
    // handle the model passes to read_document.
    const where = r.path ? `${r.path}${lineSpan}` : (r.uri ?? r.title);
    const title = !r.path && r.uri ? ` ${r.title}` : '';
    const preview = r.snippet ? ` — ${clampSearchSnippet(r.snippet)}` : '';
    return `[${provenance}${projectScope}${confidence}] ${where}${title}${preview}`;
  });
  const craftbookLines = input.craftbooks.map((craftbook) => {
    const source =
      craftbook.source === 'bundled'
        ? 'Gilde'
        : craftbook.source === 'project'
          ? 'project-local'
          : 'local';
    const description = craftbook.description ? ` — ${craftbook.description}` : '';
    const callArguments = JSON.stringify(craftbook.invocation.arguments);
    return `[craftbook:${source}] ${craftbook.name} (${craftbook.id})${description}\n  If this procedure fits and \`invoke_craftbook\` is available, call \`invoke_craftbook\` directly with arguments \`${callArguments}\`; otherwise ignore it.`;
  });
  // A source that timed out is not a source with nothing on the topic. A
  // researcher told "no match" records the corpus as empty and moves on,
  // which is how a cold reference-catalog model read as "the food
  // catalog has nothing on quiche".
  const incomplete = input.sourcesIncomplete === true;
  // Off-topic matches the relevance model left out. Named, so "nothing
  // relevant" never reads as "nothing indexed".
  const weak = input.hiddenBelowRelevanceFloor ?? 0;
  const weakNote = weak > 0 ? ` (${weak} weak match${weak === 1 ? '' : 'es'} hidden)` : '';
  const count = input.results.length;
  const resultSummary = count
    ? `Found ${count} relevant result${count === 1 ? '' : 's'} across active, linked, and shared project knowledge${incomplete ? ' (partial: some sources did not answer in time)' : input.truncated ? ' (truncated)' : ''}${weakNote}`
    : incomplete
      ? 'Nothing returned yet: some sources did not answer in time, so this is not evidence the topic is absent. Repeat the same search once before concluding there is no indexed material'
      : weak > 0
        ? `No closely relevant results${weakNote}`
        : 'No indexed project knowledge matched';
  const summary = input.craftbooks.length
    ? `${resultSummary}; suggested ${input.craftbooks.length} relevant craftbook${input.craftbooks.length === 1 ? '' : 's'}.`
    : `${resultSummary}.`;
  // Budget the rendered text to the session model's context window.
  // Summary and craftbook recipes are small and load-bearing, so they are
  // reserved first; result rows then fill the remainder (always at least
  // one, so a tight window still gets the best hit). The model explicitly
  // asked for results, so it gets 2× the per-turn indexed-context ceiling;
  // an unknown window gets a fixed budget.
  const craftbookSection = craftbookLines.length
    ? `Craftbook options:\n${craftbookLines.join('\n')}`
    : null;
  const ceiling = contextBudgetCeiling(input.contextWindow);
  const budget = Number.isFinite(ceiling) ? ceiling * 2 : 2_000;
  let usedTokens =
    estimateTokens(summary) + (craftbookSection ? estimateTokens(craftbookSection) : 0);
  const shownLines: string[] = [];
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (shownLines.length > 0 && usedTokens + cost > budget) break;
    shownLines.push(line);
    usedTokens += cost;
  }
  const hidden = lines.length - shownLines.length;
  const moreExists = input.truncated || hidden > 0;
  const nextCursor =
    moreExists && shownLines.length > 0 ? (input.cursor ?? 0) + shownLines.length : undefined;
  // Prescriptive recovery, grep_files-style: a truncated response tells
  // the model exactly how to get the rest instead of dead-ending.
  const truncationFooter =
    moreExists && nextCursor !== undefined
      ? `Results truncated${hidden > 0 ? ` (${hidden} retrieved but not shown — output budgeted to the context window)` : ''}. Continue with cursor=${nextCursor}, or narrow with pathPrefix/sources.`
      : null;
  const sections = [
    ...(shownLines.length ? [shownLines.join('\n')] : []),
    ...(truncationFooter ? [truncationFooter] : []),
    ...(craftbookSection ? [craftbookSection] : []),
  ];
  return {
    text: sections.length ? `${summary}\n${sections.join('\n\n')}` : summary,
    summary,
    moreExists,
    hidden,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export function listGildeText(
  templates: readonly { id: string; name: string; description: string }[],
): string {
  if (!templates.length) return 'No templates in the gilde.';
  return templates.map((t) => `• ${t.name} (id: ${t.id}) — ${t.description}`).join('\n');
}

/** A project's crew: the shared roster in order, then workspace-local gezels. */
export function listProjectGezelsText(
  projectId: string,
  roster: readonly { id: string; gezel?: { name: string; role?: string } }[],
  local: readonly { id: string; name: string; role?: string }[],
): string {
  if (roster.length === 0 && local.length === 0)
    return `Project ${projectId} has no shared-roster or workspace-local gezels yet.`;
  const sections: string[] = [`Project ${projectId} gezels:`];
  if (roster.length > 0) {
    sections.push(
      [
        `Shared roster (${roster.length}):`,
        ...roster.map(({ id, gezel: g }) =>
          g ? `• ${g.name}${g.role ? ` (${g.role})` : ''} — id: ${id}` : `• id: ${id}`,
        ),
      ].join('\n'),
    );
  }
  if (local.length > 0) {
    sections.push(
      [
        `Workspace-local (${local.length}):`,
        ...local.map((g) => `• ${g.name}${g.role ? ` (${g.role})` : ''} — id: ${g.id}`),
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}
