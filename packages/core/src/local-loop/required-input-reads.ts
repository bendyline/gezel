/**
 * Which of a craftbook step's declared inputs (`consumes`) a send has read.
 *
 * A local provider's immediate-write mode narrows the turn to `write_file`
 * alone. That is right for "write index.html" and wrong for a step that
 * writes FROM an earlier step's output: a powerpoint-deck copywriter held
 * write_file and nothing else, wrote eight invented slide titles without
 * ever seeing the outline it was told to follow, and the heading gate paused
 * the task (gemma4-12b, 2026-09-23). The provider holds that mode until every
 * required input has been read in the send; it never blocks the write
 * itself, so a missing input cannot deadlock the step.
 */
import {
  completeWorkspaceReadPaths,
  normalizeWorkspacePathForCompare,
} from './file-repair-policy.js';

export interface RequiredInput {
  path: string;
  artifact: boolean;
}

/** Inputs a successful read call opened, in either drawer. */
export function requiredInputsRead(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): RequiredInput[] {
  if (toolName === 'read_file' || toolName === 'read_files') {
    return completeWorkspaceReadPaths(toolName, args, output).map((path) => ({
      path,
      artifact: false,
    }));
  }
  if (output.startsWith('ERROR:')) return [];
  if (toolName === 'read_artifact' && typeof args.path === 'string') {
    return [{ path: normalizeWorkspacePathForCompare(args.path), artifact: true }];
  }
  if (toolName === 'read_artifacts' && Array.isArray(args.paths)) {
    return args.paths
      .filter((path): path is string => typeof path === 'string')
      .map((path) => ({ path: normalizeWorkspacePathForCompare(path), artifact: true }));
  }
  return [];
}

const READ_VERB = /\b(?:read(?:ing)?|open(?:ing)?)\b/i;
const WRITE_VERB =
  /\b(?:write|writing|create|creating|produce|save|update|updating|generate|draft|build|edit|patch)\b/i;
const NEGATED_READ =
  /\b(?:do not|don't|never|no need to|without|instead of)\s+(?:read(?:ing)?|open(?:ing)?)\b/i;
const QUOTED_FILE = /`([^`\s]+\.[A-Za-z0-9]+)`/g;
const BARE_FILE =
  /(?:^|[\s("',;])((?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md|rst|adoc|csv|tsv|txt|log|diff|patch|ya?ml|toml|xml|svg|py|rb|go|rs|java|c|cpp|h|hpp|sh|sql|pdf|docx|pptx|xlsx))(?=$|[\s,;.!?)"'])/gi;

/**
 * Files a prompt explicitly asks to read ("Read `a.md`, `b.md`, and the
 * stale `c.md`."), held like a step's declared inputs: "read these, then
 * write it now" means now AFTER reading. Only the stretch between a read verb
 * and the next write verb in a sentence counts, so the write target is never
 * mistaken for an input. Wild-caught 2026-09-25: meeting-followup's kickoff
 * ends "Write both files now.", the urgent-write pattern fired on turn 0, and
 * qwen3.8-27b wrote the brief without opening the transcript (4/13, then a
 * repair plateau); the same prompt passed 3/3 first-shot on 2026-08-27.
 */
export function promptReadInputs(prompt: string): RequiredInput[] {
  const inputs = new Map<string, RequiredInput>();
  for (const sentence of prompt.split(/(?<=[.!?])\s+/)) {
    const files = [...sentence.matchAll(QUOTED_FILE), ...sentence.matchAll(BARE_FILE)].sort(
      (a, b) => a.index - b.index,
    );
    // A path such as src/edit.ts is an input, not an instruction verb.
    // Mask references without changing offsets before scanning the prose.
    let prose = sentence;
    for (const file of files) {
      prose =
        prose.slice(0, file.index) +
        ' '.repeat(file[0].length) +
        prose.slice(file.index + file[0].length);
    }
    const read = READ_VERB.exec(prose);
    if (!read || NEGATED_READ.test(prose)) continue;
    const readEnd = read.index + read[0].length;
    const rest = prose.slice(readEnd);
    const writeAt = rest.search(WRITE_VERB);
    const spanEnd = writeAt < 0 ? sentence.length : readEnd + writeAt;
    for (const match of files) {
      if (match.index < readEnd || match.index >= spanEnd) continue;
      const path = normalizeWorkspacePathForCompare(match[1]!);
      inputs.set(path, { path, artifact: false });
    }
  }
  return [...inputs.values()];
}

export function unreadRequiredInputs(
  required: ReadonlyArray<RequiredInput> | undefined,
  read: ReadonlyArray<RequiredInput>,
): RequiredInput[] {
  return (required ?? []).filter((input) => {
    const path = normalizeWorkspacePathForCompare(input.path);
    return !read.some((r) => r.artifact === input.artifact && r.path === path);
  });
}
