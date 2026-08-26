import {
  CANONICAL_TOOL_NAMES,
  RENAMED_TOOLS,
  TOOL_NAME_TOMBSTONES,
  TOOL_REGISTRY,
} from '@bendyline/gezel-mcp';

export type PromptToolContractSeverity = 'error' | 'warning';

export interface PromptToolContractFinding {
  severity: PromptToolContractSeverity;
  rule:
    | 'hard-directive-missing-tool'
    | 'directive-missing-tool'
    | 'false-capability-denial'
    | 'legacy-tool-name'
    | 'removed-tool-name'
    | 'non-model-facing-tool-name'
    | 'unknown-tool-name'
    | 'tool-example-argument-shape'
    | 'tool-example-schema-mismatch';
  tool?: string;
  line: number;
  detail: string;
  excerpt: string;
}

export interface PromptToolContractReport {
  errors: PromptToolContractFinding[];
  warnings: PromptToolContractFinding[];
}

const LEGACY_TOOL_REPLACEMENTS = RENAMED_TOOLS as Readonly<Record<string, string>>;
const REMOVED_TOOL_NAMES = TOOL_NAME_TOMBSTONES as Readonly<
  Record<string, { replacement: string | undefined; reason: string }>
>;
const BUILTIN_TOOL_NAMES = [
  ...CANONICAL_TOOL_NAMES,
  ...Object.keys(RENAMED_TOOLS),
  ...Object.keys(TOOL_NAME_TOMBSTONES),
].sort((a, b) => b.length - a.length);
const BUILTIN_TOOL_NAME_SET = new Set(BUILTIN_TOOL_NAMES);
const NORMALIZED_BUILTIN_TOOL_NAME_SET = new Set(
  BUILTIN_TOOL_NAMES.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, '')),
);
const CANONICAL_TOOL_NAME_SET = new Set<string>(CANONICAL_TOOL_NAMES);
const NON_MODEL_FACING_TOOL_NAMES = new Set<string>(
  Object.values(TOOL_REGISTRY)
    .filter((entry) => !entry.modelFacing)
    .map((entry) => entry.canonicalName),
);

const FILE_READ_TOOLS = new Set([
  'search',
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'search_code',
  'grep_files',
]);
const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'make_dir',
  'rename',
  'delete_path',
  'derive_file',
  'generate_image',
]);

const HARD_DIRECTIVE =
  /\b(?:first (?:assistant )?(?:action|tool call)|next (?:assistant )?(?:action|tool call)|begin by|start by|must (?:first )?(?:call|use)|(?:call|use) first|end (?:this|your) turn by (?:calling|using)|then (?:immediately )?(?:call|use)|before (?:anything else|you (?:do|continue))[, ]+(?:call|use))\b/i;
const SOFT_DIRECTIVE =
  /\b(?:call|invoke|use|run|write (?:it|the .{0,40}) (?:with|via)|read (?:it|the .{0,40}) (?:with|via))\b/i;
const NEGATIVE_CONTEXT =
  /\b(?:do not|don't|never|cannot|can't|isn't|aren't|is not|are not|not available|unavailable|removed|no access|not on (?:your|the) (?:roster|tool list)|lack(?:s|ing)?|without)\b/i;
const CONDITIONAL_CONTEXT =
  /\b(?:if|when|unless)\b.{0,100}\b(?:available|wired|present|on (?:your|the) (?:roster|tool list))\b/i;

function excerpt(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ');
  return compact.length <= 220 ? compact : `${compact.slice(0, 217)}…`;
}

interface ToolMention {
  tool: string;
  index: number;
}

interface ExplicitToolCandidate extends ToolMention {
  syntax: 'backtick' | 'call' | 'bare-directive' | 'named-tool';
  /** Characters the spelling occupies, backticks and `(...)` included. */
  length: number;
}

const AMBIGUOUS_TOMBSTONES = new Set(['Grep', 'Read', 'Edit', 'Agent', 'Bash']);

/**
 * Find explicit tool-shaped spellings that are not already in the registry.
 * This intentionally does not treat every identifier as a tool: unknown names
 * must appear as a standalone backtick token, a function-style call, or a
 * snake_case name in a clause that explicitly tells the model to call/use a
 * tool. That catches stale UI/client methods without interpreting ordinary
 * prose and argument keys such as `startLine` as MCP tools.
 */
function explicitToolCandidates(line: string): ExplicitToolCandidate[] {
  const candidates: ExplicitToolCandidate[] = [];
  const reservedWords = new Set([
    'call',
    'function',
    'function_calls',
    'tool',
    'tool_call',
    'tool_use',
    'tools',
  ]);
  const add = (
    tool: string,
    index: number,
    syntax: ExplicitToolCandidate['syntax'],
    length: number = tool.length,
  ) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tool)) return;
    if (reservedWords.has(tool.toLowerCase())) return;
    const knownName = BUILTIN_TOOL_NAME_SET.has(tool);
    if (syntax === 'named-tool' && !knownName && !tool.includes('_')) return;
    const toolShaped =
      tool.includes('_') ||
      /[a-z][A-Z]/.test(tool) ||
      (tool.includes('-') &&
        NORMALIZED_BUILTIN_TOOL_NAME_SET.has(tool.toLowerCase().replace(/[^a-z0-9]/g, '')));
    if (!toolShaped && !knownName) return;
    candidates.push({ tool, index, syntax, length });
  };

  for (const match of line.matchAll(/`([A-Za-z][A-Za-z0-9_-]*)(?:\s*\([^`]*\))?`/g)) {
    if (match.index !== undefined && match[1]) {
      add(match[1], match.index, 'backtick', match[0].length);
    }
  }
  for (const match of line.matchAll(/(?<![A-Za-z0-9_.`])([A-Za-z][A-Za-z0-9_]*)\(/g)) {
    if (match.index !== undefined && match[1]) add(match[1], match.index, 'call', match[0].length);
  }

  // Models are commonly instructed with plain prose rather than function
  // syntax: "Call missing_project_tool now" / "Use draft_email to reply".
  // Keep this deliberately narrow (an imperative verb followed immediately
  // by one identifier) so ordinary prose and schema-property names do not
  // become tool candidates.
  for (const match of line.matchAll(
    /\b(?:call|invoke|use|run)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]*)\b/gi,
  )) {
    if (match.index !== undefined && match[1]) {
      const tokenOffset = match.index + match[0].lastIndexOf(match[1]);
      const after = line.slice(tokenOffset + match[1].length);
      const knownName = BUILTIN_TOOL_NAMES.includes(match[1]) || match[1] in TOOL_NAME_TOMBSTONES;
      // `localStorage.setItem`, `price_tracker.py`, and `account_name column`
      // are code/data references, not tool invocations. Unknown camelCase
      // words are likewise too ambiguous unless explicit tool syntax names
      // them elsewhere.
      if (/^\s*[./]/.test(after)) continue;
      if (!knownName && !/[_-]/.test(match[1])) continue;
      if (
        !knownName &&
        /^\s+(?:column|field|property|key|value|path|file|script|class|method|function|variable|parameter)\b/i.test(
          after,
        )
      ) {
        continue;
      }
      if (
        AMBIGUOUS_TOMBSTONES.has(match[1]) &&
        /^\s+[A-Z][A-Za-z0-9_-]*\b/.test(after) &&
        !/^\s+(?:MCP\s+)?Tool\b/.test(after)
      ) {
        continue;
      }
      add(match[1], tokenOffset, 'bare-directive');
    }
  }

  // Known removed/foreign names are part of the canonical registry contract,
  // not a second ad-hoc vocabulary in this linter. Ambiguous English words
  // such as Read/Edit/Agent require an explicit "tool" suffix; distinctive
  // coding-agent names can be recognized directly.
  for (const tool of Object.keys(TOOL_NAME_TOMBSTONES)) {
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = AMBIGUOUS_TOMBSTONES.has(tool)
      ? new RegExp(`\\b${escaped}(?=\\s+(?:MCP\\s+)?tool\\b)`, 'g')
      : new RegExp(`\\b${escaped}\\b`, 'g');
    for (const match of line.matchAll(matcher)) {
      if (match.index !== undefined) add(tool, match.index, 'named-tool');
    }
  }

  // Plain prose like "via run_script tool" is common in small-model prompt
  // material. One generic matcher is both more complete (it also catches an
  // unknown named tool) and much cheaper than compiling one regex per known
  // tool for every rendered-prompt line.
  for (const match of line.matchAll(
    /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]*)(?=\s+(?:MCP\s+)?tool\b)/g,
  )) {
    if (match.index !== undefined && match[1]) add(match[1], match.index, 'named-tool');
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => a.index - b.index)
    .filter((candidate) => {
      const key = `${candidate.tool}:${candidate.index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function clauseBounds(line: string, index: number): { start: number; end: number } {
  const before = line.slice(0, index);
  const starts = [before.lastIndexOf('. '), before.lastIndexOf('; '), before.lastIndexOf('! ')];
  const boundary = Math.max(...starts);
  const start = boundary >= 0 ? boundary + 2 : 0;
  const after = line.slice(index);
  const ends = [after.indexOf('. '), after.indexOf('; '), after.indexOf('! ')].filter(
    (value) => value >= 0,
  );
  const end = ends.length > 0 ? index + Math.min(...ends) + 1 : line.length;
  return { start, end };
}

function clauseAround(line: string, index: number): string {
  const { start, end } = clauseBounds(line, index);
  return line.slice(start, end);
}

/**
 * How far past a mention a negation may sit and still be read as negating
 * *that* mention. Long enough for the predicate forms — "` is not
 * available`", "` cannot be used`", "` isn't wired`" — and far short of a
 * trailing benefit clause.
 */
const POST_MENTION_NEGATION_CHARS = 28;

/**
 * Whether a clause negates THIS mention, as opposed to merely containing a
 * negative word somewhere.
 *
 * Scanning the whole clause conflates two different sentences. A negation
 * aimed at a tool sits before it ("do not call `x`", "use `a`, never `b`")
 * or immediately after it as a predicate ("`x` is not available"). A
 * negative word trailing far behind the mention usually belongs to prose
 * about the *result*: the powerpoint-deck publish step said "Call
 * `copy_artifact_to_workspace` … so the user receives the exact requested
 * workspace file **without** a text/binary round-trip", and that stray
 * "without" — 145 characters downstream, describing a benefit — vetoed the
 * only builtin the step mandated. The step-kit clamp then dropped the tool
 * its own procedure told the gezel to call, leaving a turn that could not
 * comply (ADR 0001's failure, arrived at from the opposite direction).
 */
function negatesMention(line: string, candidate: ExplicitToolCandidate): boolean {
  const { start, end } = clauseBounds(line, candidate.index);
  const before = line.slice(start, candidate.index);
  if (NEGATIVE_CONTEXT.test(before)) return true;
  const mentionEnd = Math.min(candidate.index + candidate.length, end);
  return NEGATIVE_CONTEXT.test(
    line.slice(mentionEnd, Math.min(mentionEnd + POST_MENTION_NEGATION_CHARS, end)),
  );
}

function addFinding(
  findings: PromptToolContractFinding[],
  finding: PromptToolContractFinding,
  seen: Set<string>,
): void {
  const key = `${finding.rule}:${finding.tool ?? ''}:${finding.line}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

/**
 * The canonical tools a procedure positively instructs the model to call.
 * Shares the linter's directive classification, so negative ("do not call
 * `github_pr_comment`"), conditional, and contrast ("read_file, not
 * read_artifact") mentions are excluded rather than counted as mandates.
 *
 * Step-scoped tool narrowing consumes this to keep what a craftbook step
 * actually demands: the deliverable-class kit is authored around file work
 * and silently dropped the repo/API tools a step's own first-action
 * directive named, which stranded the turn with no way to comply.
 */
export function promptMandatedTools(prompt: string): Set<string> {
  const mandated = new Set<string>();
  for (const line of prompt.split('\n')) {
    for (const candidate of explicitToolCandidates(line)) {
      const { tool } = candidate;
      if (mandated.has(tool)) continue;
      if (!CANONICAL_TOOL_NAME_SET.has(tool)) continue;
      if (NON_MODEL_FACING_TOOL_NAMES.has(tool)) continue;
      const clause = clauseAround(line, candidate.index);
      // Positional for the negation, whole-clause for the conditional: an
      // availability conditional ("if `x` is wired") governs the whole
      // clause wherever it sits, while a negative word does not.
      if (negatesMention(line, candidate) || CONDITIONAL_CONTEXT.test(clause)) continue;
      const prefix = line.slice(Math.max(0, candidate.index - 48), candidate.index);
      if (/\b(?:not|without|for|from|returned by)\s*`?\s*$/i.test(prefix)) continue;
      if (candidate.syntax === 'bare-directive' || candidate.syntax === 'named-tool') {
        mandated.add(tool);
        continue;
      }
      if (HARD_DIRECTIVE.test(clause) || SOFT_DIRECTIVE.test(clause)) mandated.add(tool);
    }
  }
  return mandated;
}

/**
 * Compare rendered system-prompt prose with the function tools actually
 * exposed to the model. This is deliberately lexical and conservative:
 * hard action-order directives gate CI, while broader imperative mentions
 * are warnings for human review. Negative and explicitly conditional tool
 * references are ignored.
 */
export function lintPromptToolContract(args: {
  prompt: string;
  availableTools: ReadonlySet<string> | ReadonlyArray<string>;
  /** Tool descriptions already establish that explicit call-shaped names are tools. */
  toolDescription?: boolean;
  /**
   * The roster is a PREDICTION covering first-party builtins only —
   * third-party bridge tools have no names until the bridge spawns. Set
   * this on the cold path so a truthful mention of an installed
   * toolset's tool (`browser_navigate`) is not reported as unknown; the
   * live-refresh pass lints the same prompt against the real roster.
   */
  partialRoster?: boolean;
}): PromptToolContractReport {
  const available =
    args.availableTools instanceof Set ? args.availableTools : new Set(args.availableTools);
  const findings: PromptToolContractFinding[] = [];
  const seen = new Set<string>();
  const lines = args.prompt.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const candidates = explicitToolCandidates(line);
    const mentions = candidates.filter(
      (candidate) =>
        BUILTIN_TOOL_NAME_SET.has(candidate.tool) &&
        (candidate.syntax === 'backtick' || candidate.syntax === 'call'),
    );

    for (const candidate of candidates) {
      const legacyReplacement = LEGACY_TOOL_REPLACEMENTS[candidate.tool];
      if (legacyReplacement) {
        addFinding(
          findings,
          {
            severity: 'error',
            rule: 'legacy-tool-name',
            tool: candidate.tool,
            line: lineNumber,
            detail: `Model-facing text uses hidden alias \`${candidate.tool}\`; use canonical \`${legacyReplacement}\`.`,
            excerpt: excerpt(clauseAround(line, candidate.index)),
          },
          seen,
        );
        continue;
      }
      const tombstone = REMOVED_TOOL_NAMES[candidate.tool];
      if (tombstone) {
        const clause = clauseAround(line, candidate.index);
        // "Bash" is also the proper name of a shell. A negative prose phrase
        // such as "Do not use Bash" does not teach a callable tool unless it
        // uses explicit tool syntax. Positive "Call Bash" still fails.
        if (
          candidate.tool === 'Bash' &&
          candidate.syntax === 'bare-directive' &&
          NEGATIVE_CONTEXT.test(clause) &&
          !/\bBash\s+(?:MCP\s+)?tool\b/.test(clause)
        ) {
          continue;
        }
        const replacement = tombstone.replacement
          ? ` Use canonical \`${tombstone.replacement}\`.`
          : '';
        addFinding(
          findings,
          {
            severity: 'error',
            rule: 'removed-tool-name',
            tool: candidate.tool,
            line: lineNumber,
            detail: `Model-facing text names non-callable \`${candidate.tool}\` (${tombstone.reason}).${replacement}`,
            excerpt: excerpt(clause),
          },
          seen,
        );
        continue;
      }
      if (NON_MODEL_FACING_TOOL_NAMES.has(candidate.tool)) {
        addFinding(
          findings,
          {
            severity: 'error',
            rule: 'non-model-facing-tool-name',
            tool: candidate.tool,
            line: lineNumber,
            detail: `Model-facing text names compatibility-only tool \`${candidate.tool}\`, which is never exposed to models.`,
            excerpt: excerpt(clauseAround(line, candidate.index)),
          },
          seen,
        );
        continue;
      }
      if (available.has(candidate.tool)) {
        continue;
      }
      const clause = clauseAround(line, candidate.index);
      if (NEGATIVE_CONTEXT.test(clause)) continue;
      if (CANONICAL_TOOL_NAME_SET.has(candidate.tool)) {
        // Backtick/function spellings are also handled by toolMentions below,
        // which preserves the established hard-vs-soft directive policy.
        // A bare imperative is unambiguously executable guidance, so absence
        // from the final roster is always build-blocking.
        if (candidate.syntax === 'bare-directive' || candidate.syntax === 'named-tool') {
          addFinding(
            findings,
            {
              severity: 'error',
              rule: 'hard-directive-missing-tool',
              tool: candidate.tool,
              line: lineNumber,
              detail: `Prompt directly instructs the unavailable tool \`${candidate.tool}\`.`,
              excerpt: excerpt(clause),
            },
            seen,
          );
        }
        continue;
      }
      if (args.partialRoster) continue;
      const before = line.slice(Math.max(0, candidate.index - 120), candidate.index);
      const after = line.slice(candidate.index + candidate.tool.length, candidate.index + 80);
      const associated =
        candidate.syntax === 'named-tool' ||
        candidate.syntax === 'bare-directive' ||
        (args.toolDescription === true && candidate.syntax === 'call') ||
        /\b(?:call|invoke)(?:\s+(?:the|named))?\s*$/i.test(before) ||
        /^\s*(?:MCP\s+)?(?:tool|call)\b/i.test(after);
      if (!associated) continue;
      addFinding(
        findings,
        {
          severity: 'error',
          rule: 'unknown-tool-name',
          tool: candidate.tool,
          line: lineNumber,
          detail: `Model-facing text names \`${candidate.tool}\`, which is absent from the canonical registry and final tool roster.`,
          excerpt: excerpt(clause),
        },
        seen,
      );
    }

    for (const mention of mentions) {
      const { tool } = mention;
      // Alias/tombstone/non-model-facing errors were classified above from
      // the same explicit syntax. This loop only compares canonical calls
      // with the final post-filter roster.
      if (LEGACY_TOOL_REPLACEMENTS[tool] || REMOVED_TOOL_NAMES[tool]) continue;
      if (NON_MODEL_FACING_TOOL_NAMES.has(tool)) continue;
      if (available.has(tool)) continue;
      const mentionPrefix = line.slice(Math.max(0, mention.index - 48), mention.index);
      // A tool can be named as provenance or contrast inside a directive
      // aimed at a DIFFERENT tool: "use read_artifact only for
      // list_artifacts results" / "use read_file, not read_artifact".
      // Those references do not tell the model to call the missing tool.
      if (/\b(?:not|without|for|from|returned by)\s*`?\s*$/i.test(mentionPrefix)) continue;
      const clause = clauseAround(line, mention.index);
      const negative = NEGATIVE_CONTEXT.test(clause);
      const conditional = CONDITIONAL_CONTEXT.test(clause);
      if (!negative && !conditional) {
        if (HARD_DIRECTIVE.test(clause)) {
          addFinding(
            findings,
            {
              severity: 'error',
              rule: 'hard-directive-missing-tool',
              tool,
              line: lineNumber,
              detail: `Prompt makes an action-order directive for unavailable tool \`${tool}\`.`,
              excerpt: excerpt(clause),
            },
            seen,
          );
        } else if (SOFT_DIRECTIVE.test(clause)) {
          addFinding(
            findings,
            {
              severity: 'warning',
              rule: 'directive-missing-tool',
              tool,
              line: lineNumber,
              detail: `Prompt appears to recommend unavailable tool \`${tool}\`.`,
              excerpt: excerpt(clause),
            },
            seen,
          );
        }
      }
    }
  }

  const lower = args.prompt.toLowerCase();
  const hasReadTool = [...FILE_READ_TOOLS].some((tool) => available.has(tool));
  const hasWriteTool = [...FILE_WRITE_TOOLS].some((tool) => available.has(tool));
  const denialRules: Array<{ active: boolean; pattern: RegExp; toolClass: string }> = [
    {
      active: hasReadTool,
      pattern:
        /\b(?:you (?:do not|don't) have|there (?:is|are)|you have) no (?:workspace |file )?(?:read|reading) tools?\b/i,
      toolClass: 'file-read',
    },
    {
      active: hasWriteTool,
      pattern:
        /\b(?:you (?:do not|don't) have|there (?:is|are)|you have) no (?:workspace |file )?(?:write|writing|edit|editing) tools?\b/i,
      toolClass: 'file-write',
    },
    {
      active: hasReadTool || hasWriteTool,
      pattern: /\b(?:you (?:do not|don't) have|there (?:is|are)|you have) no file tools?\b/i,
      toolClass: 'file',
    },
  ];
  for (const rule of denialRules) {
    if (!rule.active) continue;
    const match = rule.pattern.exec(lower);
    if (!match || match.index === undefined) continue;
    const lineNumber = lower.slice(0, match.index).split('\n').length;
    const line = lines[lineNumber - 1] ?? match[0];
    addFinding(
      findings,
      {
        severity: 'error',
        rule: 'false-capability-denial',
        line: lineNumber,
        detail: `Prompt denies ${rule.toolClass} capability even though matching tools are available.`,
        excerpt: excerpt(line),
      },
      seen,
    );
  }

  return {
    errors: findings.filter((finding) => finding.severity === 'error'),
    warnings: findings.filter((finding) => finding.severity === 'warning'),
  };
}

export function formatPromptToolContractFinding(finding: PromptToolContractFinding): string {
  const tool = finding.tool ? ` tool=${finding.tool}` : '';
  return `${finding.severity.toUpperCase()} ${finding.rule}${tool} line=${finding.line}: ${finding.detail} “${finding.excerpt}”`;
}

/**
 * Remove directive lines that contradict the current roster. Used only for
 * model-behavior prompt appendices (cookbooks/hints), whose lines are optional
 * steering rather than identity or task requirements. Standing/user-authored
 * layers are linted and surfaced instead of silently rewritten.
 */
export function filterPromptToolDirectives(args: {
  prompt: string;
  availableTools: ReadonlySet<string> | ReadonlyArray<string>;
}): string {
  const report = lintPromptToolContract(args);
  const rejectedLines = new Set(
    [...report.errors, ...report.warnings].map((finding) => finding.line),
  );
  if (rejectedLines.size === 0) return args.prompt;
  return args.prompt
    .split('\n')
    .filter((_, index) => !rejectedLines.has(index + 1))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

/**
 * Corrective prompts are runtime-authored optional steering. Remove any
 * directive that contradicts the live roster; if nothing actionable remains,
 * fall back to a tool-agnostic correction rather than mandating an absent
 * capability.
 */
export function capabilitySafeCorrectivePrompt(args: {
  prompt: string;
  availableTools: ReadonlySet<string> | ReadonlyArray<string>;
}): string {
  const filtered = filterPromptToolDirectives(args).trim();
  if (filtered) return filtered;
  return (
    'Your previous reply claimed an action succeeded without live evidence. ' +
    'Use only an appropriate action tool visible in your current roster, or explain that the action cannot be performed here. ' +
    'Do not repeat the success claim until an available action returns successfully.'
  );
}
