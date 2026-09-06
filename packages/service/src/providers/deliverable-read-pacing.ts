import type { FileTurnIntent } from '@bendyline/gezel';
import { canonicalToolName } from '@bendyline/gezel-mcp';
import { isImmediateFileWritePrompt } from './constrained-turn.js';
import { TurnAbortError } from './turn-abort-error.js';

const DEFAULT_SOFT_READ_WARNING_AT = 5;
const DEFAULT_HARD_READ_ABORT_AT = 6;
const HARD_ABORT_OUTPUT_CHAR_LIMIT = 8_000;

const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_dir',
  'read_file',
  'read_files',
  'stat',
  'validate',
  'list_artifacts',
  'read_artifact',
  'grep_artifact',
  'grep_files',
  'find_files',
  'diff_files',
]);

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'apply_patch',
  'insert_at_marker',
  'write_artifact',
  'copy_artifact_to_workspace',
]);

export interface DeliverableReadPaceResult {
  output: string;
  shouldAbort: boolean;
  readCount: number;
}

export interface DeliverableReadPaceTrackerOpts {
  targetPath?: string;
  softWarningAt?: number;
  hardAbortAt?: number;
}

export class DeliverableReadPaceTracker {
  private readonly targetPath: string | undefined;
  private readonly softWarningAt: number;
  private readonly hardAbortAt: number;
  private readCount = 0;
  private wrote = false;

  static fromUserText(
    userText: string | undefined,
    intent?: FileTurnIntent,
  ): DeliverableReadPaceTracker | null {
    if (intent?.kind === 'repair-file') return null;
    const text = userText ?? '';
    if (!intent && !isFileDeliverableTurn(text)) return null;
    return new DeliverableReadPaceTracker({ targetPath: intent?.path ?? extractTargetPath(text) });
  }

  constructor(opts: DeliverableReadPaceTrackerOpts = {}) {
    this.targetPath = opts.targetPath?.trim() || undefined;
    this.softWarningAt = opts.softWarningAt ?? DEFAULT_SOFT_READ_WARNING_AT;
    this.hardAbortAt = opts.hardAbortAt ?? DEFAULT_HARD_READ_ABORT_AT;
  }

  recordCall(toolName: string, output: string): DeliverableReadPaceResult {
    const canonicalName = canonicalToolName(toolName);
    if (WRITE_TOOL_NAMES.has(canonicalName)) {
      this.wrote = true;
      return { output, shouldAbort: false, readCount: this.readCount };
    }
    if (this.wrote || !READ_ONLY_TOOL_NAMES.has(canonicalName)) {
      return { output, shouldAbort: false, readCount: this.readCount };
    }

    this.readCount += 1;
    if (this.readCount >= this.hardAbortAt) {
      return {
        output: `${truncateHardAbortOutput(output)}\n\n${this.warningText('hard')}`,
        shouldAbort: true,
        readCount: this.readCount,
      };
    }
    if (this.readCount >= this.softWarningAt) {
      return {
        output: `${output}\n\n${this.warningText('soft')}`,
        shouldAbort: false,
        readCount: this.readCount,
      };
    }
    return { output, shouldAbort: false, readCount: this.readCount };
  }

  buildAbortMessage(providerLabel: string): string {
    const pathClause = this.targetPath ? ` \`${this.targetPath}\`` : '';
    const call = this.targetPath
      ? `write_file({ path: "${this.targetPath}", content: <draft from the files you already read> })`
      : 'write_file({ path, content })';
    return `[${providerLabel}] aborting — this file-deliverable turn made ${this.readCount} read-only tool calls without writing the expected file${pathClause}. You have enough context to produce a first draft. Your next message MUST start with \`${call}\`; do not call another read-only tool until the file exists.`;
  }

  /**
   * Plain-language summary for the user-facing failure banner — the
   * counterpart to {@link buildAbortMessage}'s model-facing corrective.
   */
  buildUserMessage(): string {
    const pathClause = this.targetPath ? ` (\`${this.targetPath}\`)` : '';
    return `The model kept gathering context without producing the expected file${pathClause}, so the turn was stopped. Try sending your message again.`;
  }

  /**
   * Build the {@link TurnAbortError} to throw — model-facing corrective on
   * `message`, user-facing summary on `userMessage`. See
   * {@link ToolFailureTracker.buildAbort} for the rationale.
   */
  buildAbort(providerLabel: string): TurnAbortError {
    return new TurnAbortError(this.buildAbortMessage(providerLabel), this.buildUserMessage());
  }

  private warningText(kind: 'soft' | 'hard'): string {
    const pathClause = this.targetPath ? ` at \`${this.targetPath}\`` : '';
    const call = this.targetPath
      ? `write_file({ path: "${this.targetPath}", content: <draft from the files already read> })`
      : 'write_file({ path, content })';
    const lead =
      kind === 'hard'
        ? '[runtime] Read budget exhausted for this file deliverable.'
        : '[runtime] You are near the read budget for this file deliverable.';
    return `${lead} Stop reading and write the expected file${pathClause}. Your next tool call must be \`${call}\`. You can refine it after the file exists.`;
  }
}

function truncateHardAbortOutput(output: string): string {
  if (output.length <= HARD_ABORT_OUTPUT_CHAR_LIMIT) return output;
  return `${output.slice(
    0,
    HARD_ABORT_OUTPUT_CHAR_LIMIT,
  )}\n\n[runtime] Tool output truncated at ${HARD_ABORT_OUTPUT_CHAR_LIMIT} characters because this file-deliverable turn already exceeded its read budget.`;
}

function isFileDeliverableTurn(text: string): boolean {
  return (
    /\bdeliverable expected as a file\b/i.test(text) ||
    isImmediateFileWritePrompt(text, { toolSurfaceIsWriteFileOnly: false })
  );
}

function extractTargetPath(text: string): string | undefined {
  const deliverable = text.match(/\[Deliverable expected as a FILE at `([^`]+)`/i)?.[1];
  if (deliverable) return deliverable;
  const writeFile = text.match(/write_file\s*\(\s*\{\s*path\s*:\s*["'`]([^"'`]+)["'`]/i)?.[1];
  if (writeFile) return writeFile;
  const filePath = text.match(/filePath\s*:\s*["'`]([^"'`]+)["'`]/i)?.[1];
  return filePath;
}
