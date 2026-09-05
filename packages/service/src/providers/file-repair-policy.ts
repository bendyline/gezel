/** Shared read provenance and repair feedback, independent of engine wire formats. */
import { WORKSPACE_READ_MAX_FILES } from '@bendyline/gezel';
import {
  FILE_REPAIR_MUTATION_TOOLS as SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES,
  FILE_REPAIR_READ_TOOLS as SCENARIO_FILE_REPAIR_READ_ONLY_TOOL_NAMES,
  isFileRepairPrompt as isScenarioFileRepairPrompt,
} from './constrained-turn.js';
import { LOCAL_TURN_LIMITS } from './local-turn-policy.js';
const MAX_PREREQUISITE_REPAIR_READ_PATHS = 8;
const PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT = LOCAL_TURN_LIMITS.noProgress;

export function completeWorkspaceReadPaths(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string[] {
  if (output.startsWith('ERROR:') || output.includes('…[tool output truncated:')) return [];
  if (toolName === 'read_file') {
    if (typeof args.path !== 'string') return [];
    const ranged = args.startLine !== undefined || args.endLine !== undefined;
    if (ranged && !/^\[read_file [^\n]* complete\]/.test(output)) return [];
    return [normalizeWorkspacePathForCompare(args.path)];
  }
  if (toolName !== 'read_files') return [];

  const requested: Array<string | undefined> = Array.isArray(args.paths)
    ? args.paths.map((path) => (typeof path === 'string' ? path : undefined))
    : Array.isArray(args.files)
      ? args.files.map((item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).path === 'string'
            ? ((item as Record<string, unknown>).path as string)
            : undefined,
        )
      : [];
  const statusLines = (output.split('\n\n', 1)[0] ?? '').split('\n').slice(1);
  return requested.slice(0, WORKSPACE_READ_MAX_FILES).flatMap((path, index) => {
    if (!path) return [];
    const statusPrefix = `${index + 1} OK `;
    const line = statusLines.find((candidate) => candidate.indexOf(statusPrefix) === 0);
    const complete =
      line?.match(
        /\slines=(?:none|\d+-\d+)\s+totalLines=(?:\?|\d+)(\s+complete)?(?:\s+nextStartLine=\d+)?$/,
      )?.[1] !== undefined;
    return complete ? [normalizeWorkspacePathForCompare(path)] : [];
  });
}

export function extractPrerequisiteRepairReadPaths(prompt: string): string[] {
  if (!isScenarioFileRepairPrompt(prompt)) return [];
  const orderedClause =
    /\bfirst\s+(?:(?:call|use)\s+`?read_file`?\s+(?:on\s+)?|(?:re-)?read\s+)([\s\S]{1,700}?)(?:[.,;]\s*then\s+(?:patch|edit|revise|rewrite|update|write|record|replace|append)|\s+before\s+(?:patching|editing|revising|rewriting|updating|writing|recording|replacing|appending))\b/i.exec(
      prompt,
    )?.[1] ??
    /\bbefore\s+(?:patching|editing|revising|rewriting|updating|writing|recording|replacing|appending)\b[\s,:-]+([\s\S]{1,700}?)(?=[.;]\s*(?:then\s+)?(?:patch|edit|revise|rewrite|update|write|record|replace|append)\b)/i.exec(
      prompt,
    )?.[1];
  if (!orderedClause) return [];

  const paths =
    orderedClause.match(
      /(?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md|csv|tsv|txt|ya?ml)\b/gi,
    ) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeWorkspacePathForCompare(path).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalizeWorkspacePathForCompare(path));
  }
  return unique.length > 0 && unique.length <= MAX_PREREQUISITE_REPAIR_READ_PATHS ? unique : [];
}

export function remainingPrerequisiteRepairReadPaths(
  requiredPaths: readonly string[],
  readPaths: readonly string[],
): string[] {
  const read = new Set(
    readPaths.map((path) => normalizeWorkspacePathForCompare(path).toLowerCase()),
  );
  return requiredPaths.filter(
    (path) => !read.has(normalizeWorkspacePathForCompare(path).toLowerCase()),
  );
}

export function buildScenarioRepairNoMutationNudge(
  knownToolNames: ReadonlySet<string>,
  context: {
    readOnlyCalls: number;
    readFilePaths: readonly string[];
    failedMutationCalls?: number;
    noMutationNudges?: number;
  } = {
    readOnlyCalls: 0,
    readFilePaths: [],
  },
): string {
  const mutationTools = [...SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES].filter((name) =>
    knownToolNames.has(name),
  );
  const menu =
    mutationTools.length > 0
      ? mutationTools.map((name) => `\`${name}\``).join(', ')
      : '`write_file`';
  if (context.readOnlyCalls > 0) {
    const readPathText =
      context.readFilePaths.length > 0
        ? ` You already read ${context.readFilePaths.map((path) => `\`${path}\``).join(', ')}.`
        : '';
    const failedMutationCalls =
      'failedMutationCalls' in context && typeof context.failedMutationCalls === 'number'
        ? context.failedMutationCalls
        : 0;
    const noMutationNudges =
      'noMutationNudges' in context && typeof context.noMutationNudges === 'number'
        ? context.noMutationNudges
        : 0;
    const mustMutateNow =
      failedMutationCalls > 0 || context.readOnlyCalls >= 2 || noMutationNudges >= 2;
    if (mustMutateNow) {
      let writeInstruction: string;
      if ((failedMutationCalls > 0 || noMutationNudges >= 2) && knownToolNames.has('write_file')) {
        writeInstruction =
          'Your next response must START with `write_file` for the relevant source file with the complete corrected file contents.';
      } else if (knownToolNames.has('replace_lines')) {
        writeInstruction =
          'Your next response must START with `replace_lines` for the smallest relevant line range in the source file.';
      } else if (knownToolNames.has('replace_in_file')) {
        writeInstruction =
          'Your next response must START with `replace_in_file` for the smallest unique source snippet that needs changing.';
      } else if (knownToolNames.has('write_file')) {
        writeInstruction =
          'Your next response must START with `write_file` for the relevant source file with the complete corrected file contents.';
      } else {
        writeInstruction = `Your next response must START with one mutation tool call (${menu}) for the relevant source file.`;
      }
      const failedText =
        failedMutationCalls > 0
          ? ' A previous surgical edit failed, so another guessed patch is unlikely to land.'
          : '';
      return `[system] Your repair turn ended after diagnostic reads/prose but no workspace file changed.${readPathText}${failedText} Do not read again. ${writeInstruction} Do not describe the fix until after that tool succeeds.`;
    }
    const canRead = [...SCENARIO_FILE_REPAIR_READ_ONLY_TOOL_NAMES].some((name) =>
      knownToolNames.has(name),
    );
    const diagnosticAllowance = canRead
      ? ' If those reads did not show the cause, make exactly one more targeted read of the directly related source file that owns the failing behavior, then mutate.'
      : '';
    return `[system] Your repair turn ended after diagnostic reads/prose but no workspace file changed.${readPathText}${diagnosticAllowance} If you already know the cause, your next response must START with one mutation tool call (${menu}) for the relevant source file. Do not describe the fix until after that tool succeeds.`;
  }
  return `[system] Your repair turn ended without changing any workspace file. Read/validate/prose did not fix the failing check. Your next response must START with one mutation tool call (${menu}) for the relevant source file. Do not describe the fix until after that tool succeeds.`;
}

export function buildPrerequisiteRepairReadNudge(context: {
  remainingPaths: readonly string[];
  noProgressNudges: number;
}): string {
  const nextPath = context.remainingPaths[0];
  const remaining = context.remainingPaths.map((path) => `\`${path}\``).join(', ');
  const retry =
    context.noProgressNudges >= PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT
      ? 'This is the final automatic source-read retry.'
      : 'Continue the bounded source-gathering phase now.';
  return `[system] This repair explicitly requires successful source reads before any file mutation. Remaining required source(s): ${remaining}. ${retry} Your next response must START with \`read_file({ path: "${nextPath}" })\`. Do not plan, summarize, or edit the deliverable until every listed read succeeds; after the last required read, the tool surface will switch to file mutations.`;
}

export function buildImmediateFileWriteNoMutationNudge(context: {
  targetPath: string | null;
  noMutationNudges?: number;
}): string {
  const target = context.targetPath
    ? ` The required output file is \`${context.targetPath}\`.`
    : '';
  const retryText =
    (context.noMutationNudges ?? 0) > 1
      ? 'This is the final automatic retry.'
      : 'Retry immediately.';
  return `[system] Your required file-write turn produced no \`write_file\` tool call.${target} ${retryText} Your next response must START with \`write_file\` for the required file, with the complete file contents in the \`content\` argument. Do not describe the result until after that tool succeeds.`;
}

export function normalizeWorkspacePathForCompare(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^workspace\//i, '')
    .replace(/^\.\/+/, '');
}
