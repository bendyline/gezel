import { BUILTIN_TOOLSETS } from '@bendyline/gezel-catalog';

export type PromptToolContractSeverity = 'error' | 'warning';

export interface PromptToolContractFinding {
  severity: PromptToolContractSeverity;
  rule:
    | 'hard-directive-missing-tool'
    | 'directive-missing-tool'
    | 'false-capability-denial'
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

const BUILTIN_TOOL_NAMES = Array.from(
  new Set(BUILTIN_TOOLSETS.flatMap((group) => group.tools)),
).sort((a, b) => b.length - a.length);

const FILE_READ_TOOLS = new Set(['readFile', 'readdir', 'stat', 'search_code', 'search_files']);
const FILE_WRITE_TOOLS = new Set([
  'writeFile',
  'appendToFile',
  'replaceInFile',
  'replaceLines',
  'applyPatch',
  'mkdir',
  'rename',
  'rm',
  'derive_file',
  'generate_image',
]);

const HARD_DIRECTIVE =
  /\b(?:first (?:assistant )?(?:action|tool call)|next (?:assistant )?(?:action|tool call)|begin by|start by|must (?:first )?(?:call|use)|(?:call|use) first|end (?:this|your) turn by (?:calling|using)|then (?:immediately )?(?:call|use)|before (?:anything else|you (?:do|continue))[, ]+(?:call|use))\b/i;
const SOFT_DIRECTIVE =
  /\b(?:call|invoke|use|run|write (?:it|the .{0,40}) (?:with|via)|read (?:it|the .{0,40}) (?:with|via))\b/i;
const NEGATIVE_CONTEXT =
  /\b(?:do not|don't|never|cannot|can't|isn't|aren't|not available|unavailable|removed|no access|not on (?:your|the) (?:roster|tool list)|lack(?:s|ing)?|without)\b/i;
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

function toolMentions(line: string): ToolMention[] {
  const mentions: ToolMention[] = [];
  for (const tool of BUILTIN_TOOL_NAMES) {
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Backticks are the standing prompt convention. Also recognize a bare
    // function-call spelling, but not a bare English word such as "validate"
    // or "stat" that happens to share a tool name.
    const matcher = new RegExp(`(?:\`${escaped}\`|(?<![A-Za-z0-9_])${escaped}\\s*\\()`, 'g');
    for (const match of line.matchAll(matcher)) {
      if (match.index !== undefined) mentions.push({ tool, index: match.index });
    }
  }
  return mentions.sort((a, b) => a.index - b.index);
}

function clauseAround(line: string, index: number): string {
  const before = line.slice(0, index);
  const starts = [before.lastIndexOf('. '), before.lastIndexOf('; '), before.lastIndexOf('! ')];
  const boundary = Math.max(...starts);
  const start = boundary >= 0 ? boundary + 2 : 0;
  const after = line.slice(index);
  const ends = [after.indexOf('. '), after.indexOf('; '), after.indexOf('! ')].filter(
    (value) => value >= 0,
  );
  const end = ends.length > 0 ? index + Math.min(...ends) + 1 : line.length;
  return line.slice(start, end);
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
 * Compare rendered system-prompt prose with the function tools actually
 * exposed to the model. This is deliberately lexical and conservative:
 * hard action-order directives gate CI, while broader imperative mentions
 * are warnings for human review. Negative and explicitly conditional tool
 * references are ignored.
 */
export function lintPromptToolContract(args: {
  prompt: string;
  availableTools: ReadonlySet<string> | ReadonlyArray<string>;
}): PromptToolContractReport {
  const available =
    args.availableTools instanceof Set ? args.availableTools : new Set(args.availableTools);
  const findings: PromptToolContractFinding[] = [];
  const seen = new Set<string>();
  const lines = args.prompt.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const mentions = toolMentions(line);
    if (mentions.length === 0) continue;

    for (const mention of mentions) {
      const { tool } = mention;
      if (available.has(tool)) continue;
      const mentionPrefix = line.slice(Math.max(0, mention.index - 48), mention.index);
      // A tool can be named as provenance or contrast inside a directive
      // aimed at a DIFFERENT tool: "use read_artifact only for
      // list_artifacts results" / "use readFile, not read_artifact".
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
