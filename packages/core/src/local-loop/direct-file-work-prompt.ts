/**
 * Extract the intended workspace output from a direct file-work prompt.
 * Chat-side tool clamping and local-provider recovery both consume this
 * helper so additions to the supported wording cannot drift between them.
 */
export function extractDirectFileWorkTargetPath(prompt: string | undefined): string | null {
  const text = (prompt ?? '').trim();
  if (!text) return null;
  return (
    /\[Deliverable expected as a FILE at `([^`]+)`/i.exec(text)?.[1]?.trim() ??
    /\b(?:deliverable|result|output)\s+(?:is|must be|should be|to|at)\s+(?:the\s+)?(?:file\s+)?`?([\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md|csv|txt|ya?ml))`?/i
      .exec(text)?.[1]
      ?.trim() ??
    // In transform-shaped asks the first path after the verb is normally
    // the INPUT ("normalize raw.csv into clean.json"). Resolve the
    // destination before the broad verb→path fallback below so constrained
    // local turns never overwrite the source file by mistake.
    /\b(?:clean(?:\s+up)?|combine|consolidate|convert|deduplicate|derive|extract|merge|normal(?:ize|ise)|parse|transform|wrangle)\b[\s\S]{0,240}?\b(?:into|to|as)\s+(?:the\s+)?(?:(?:result|output|destination)\s+)?(?:file\s+)?`?([\w./-]+\.(?:json|csv|tsv|ndjson|txt|ya?ml|md|html?|css|mjs|cjs|jsx?|tsx?))`?/i
      .exec(text)?.[1]
      ?.trim() ??
    /\b(?:write|produce|create|build|ship|generate|emit|consolidate|derive|extract|transform|normalize)\b[\s\S]{0,120}?`?([\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md|csv|txt|ya?ml))`?/i
      .exec(text)?.[1]
      ?.trim() ??
    /`?([\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md|csv|txt|ya?ml))`?[\s\S]{0,120}?\b(?:write|produce|create|build|ship|finish|consolidate|derive|extract|transform|normalize|edit\s+it\s+in\s+place|write_file|replace_in_file|fs\.writeFileSync)\b/i
      .exec(text)?.[1]
      ?.trim() ??
    null
  );
}

export function hasDirectFileDeliverableWording(prompt: string | undefined): boolean {
  return extractDirectFileWorkTargetPath(prompt) !== null;
}

const MAX_DIRECT_FILE_WORK_PREREQUISITE_READ_PATHS = 8;

const PROMPT_WORKSPACE_PATH_SOURCE = String.raw`(?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md|csv|tsv|ndjson|txt|ya?ml)`;

function normalizePromptWorkspacePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^workspace\//i, '');
}

/**
 * Parse the leading path list in an explicit colon-delimited contract such
 * as "Read all five sources first: a.md, b.md, …". The list parser advances
 * only through separators + paths and stops at the first prose token, so a
 * later incidental file mention cannot silently become a prerequisite.
 */
function extractColonDelimitedPrerequisiteReadPaths(text: string): string[] {
  const header =
    /\b(?:re-?read|read)\s+(?:(?:all|these|the)\s+)?(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine)\s+)?(?:sources?|source\s+files?|inputs?|input\s+files?|files?)\s+first\s*:\s*/i.exec(
      text,
    );
  if (!header) return [];

  const tail = text.slice(header.index + header[0].length);
  const pathAtCursor = new RegExp(`^\`?(${PROMPT_WORKSPACE_PATH_SOURCE})\`?`, 'i');
  const separatorAtCursor = /^(?:\s+|[,;]|[-*•]\s*|\d+[.)]\s*|\band\b\s*)*/i;
  const paths: string[] = [];
  let cursor = 0;

  // Read one beyond the public bound so an overlong list is rejected rather
  // than silently truncating the user's grounding contract.
  while (paths.length <= MAX_DIRECT_FILE_WORK_PREREQUISITE_READ_PATHS) {
    const separator = separatorAtCursor.exec(tail.slice(cursor))?.[0] ?? '';
    cursor += separator.length;
    const path = pathAtCursor.exec(tail.slice(cursor));
    if (!path?.[1]) break;
    paths.push(path[1]);
    cursor += path[0].length;
  }
  return paths;
}

/**
 * Extract a bounded read-before-write contract from a direct file-work ask.
 * Only clauses that explicitly bind named source files to a later deliverable
 * qualify; incidental file mentions must not turn an ordinary create request
 * into a read-only turn.
 */
export function extractDirectFileWorkPrerequisiteReadPaths(
  prompt: string | undefined,
  targetPath = extractDirectFileWorkTargetPath(prompt),
): string[] {
  const text = (prompt ?? '').trim();
  if (!text) return [];

  const clauses = [
    /\b(?:re-?read|read)\s+([\s\S]{1,500}?)(?=(?:,\s*)?(?:and\s+)?(?:then\s+)?(?:write|produce|create|build|generate|emit|save)\b)/i.exec(
      text,
    )?.[1],
    /\b(?:use|using)\s+(?:the\s+)?(?:supplied\s+)?(?:project\s+)?(?:context|inputs?|sources?|source\s+files?)\s+from\s+([\s\S]{1,300}?)(?=[:;]|\.(?:\s|$)|\b(?:and\s+)?(?:then\s+)?(?:write|produce|create|build|generate|emit|save)\b)/i.exec(
      text,
    )?.[1],
  ].filter((clause): clause is string => !!clause);
  const colonDelimitedPaths = extractColonDelimitedPrerequisiteReadPaths(text);
  if (clauses.length === 0 && colonDelimitedPaths.length === 0) return [];

  const normalizedTarget = targetPath
    ? normalizePromptWorkspacePath(targetPath).toLowerCase()
    : null;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of colonDelimitedPaths) {
    const normalized = normalizePromptWorkspacePath(path);
    const comparable = normalized.toLowerCase();
    if (!normalized || comparable === normalizedTarget || seen.has(comparable)) continue;
    seen.add(comparable);
    unique.push(normalized);
  }
  for (const clause of clauses) {
    const paths = clause.match(new RegExp(`${PROMPT_WORKSPACE_PATH_SOURCE}\\b`, 'gi')) ?? [];
    for (const path of paths) {
      const normalized = normalizePromptWorkspacePath(path);
      const comparable = normalized.toLowerCase();
      if (!normalized || comparable === normalizedTarget || seen.has(comparable)) continue;
      seen.add(comparable);
      unique.push(normalized);
    }
  }

  return unique.length > 0 && unique.length <= MAX_DIRECT_FILE_WORK_PREREQUISITE_READ_PATHS
    ? unique
    : [];
}

export const EXPLICIT_FILE_EDIT_TOOL_NAMES = [
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'insert_at_marker',
  'apply_patch',
] as const;

export type ExplicitFileEditToolName = (typeof EXPLICIT_FILE_EDIT_TOOL_NAMES)[number];

/**
 * Return the existing-file mutation tools that a request affirmatively tells
 * the recipient to use. This intentionally excludes `write_file`: callers use
 * the result to distinguish a surgical/append directive from the generic
 * fresh-file create path.
 *
 * Tool names in negative clauses ("do not call append_to_file") do not count.
 * The positive matcher covers both prose directives ("use replace_lines") and
 * concrete call shapes ("append_to_file({ ... })").
 */
export function extractExplicitFileEditTools(
  prompt: string | undefined,
): ExplicitFileEditToolName[] {
  const text = (prompt ?? '').trim();
  if (!text) return [];

  return EXPLICIT_FILE_EDIT_TOOL_NAMES.filter((tool) => {
    const withoutNegativeMentions = text.replace(
      new RegExp(
        `\\b(?:do\\s+not|don't|never|must\\s+not|avoid)\\s+(?:(?:call|use|invoke)\\s+)?[\\x60]?${tool}[\\x60]?(?:\\s*\\([^)]*\\))?`,
        'gi',
      ),
      '',
    );
    return (
      new RegExp(`\\b${tool}\\s*\\(\\s*\\{`, 'i').test(withoutNegativeMentions) ||
      new RegExp(
        `\\b(?:use|using|via|with|call|invoke|prefer|choose)\\s+(?:(?:a|an|the|only|targeted|surgical)\\s+){0,4}[\\x60]?${tool}[\\x60]?\\b`,
        'i',
      ).test(withoutNegativeMentions) ||
      new RegExp(
        `\\b(?:first|next)\\s+(?:assistant\\s+)?(?:action|tool\\s+call|mutation)\\s+(?:must|should)\\s+(?:start\\s+with|be)\\s+(?:the\\s+tool\\s+call\\s+)?[\\x60]?${tool}[\\x60]?\\b`,
        'i',
      ).test(withoutNegativeMentions)
    );
  });
}

/**
 * Extract the existing source file a localized repair is about. Prefer
 * language that binds a defect to a path over generic read mentions: a
 * black-box acceptance script can be named first while the actual defect is
 * explicitly said to live in another module.
 */
export function extractSingleFileSourceRepairTargetPath(prompt: string | undefined): string | null {
  const text = (prompt ?? '').trim();
  if (!text) return null;
  const boundTarget =
    /\b(?:bug|defect|error|fault|issue|regression)\b[\s\S]{0,60}?\b(?:in|inside|within)\s+`?([\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md))`?/i
      .exec(text)?.[1]
      ?.trim() ??
    /\b(?:fix|repair|debug|patch|correct)\b[\s\S]{0,80}?`?([\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md))`?/i
      .exec(text)?.[1]
      ?.trim() ??
    /\b(?:edit|modify|update|patch)\s+`?([\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md))`?\s+(?:in\s+place|without\s+rewriting|and\s+preserve)\b/i
      .exec(text)?.[1]
      ?.trim() ??
    null;
  if (boundTarget) return boundTarget;

  const readTarget =
    /\bread\s+`?([\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md))`?[\s\S]{0,240}\b(?:bug|defect|fault|few\s+lines?|in\s+place|patch|repair|replace_in_file|replace_lines|syntax\s+fix|parse\s+error)\b/i
      .exec(text)?.[1]
      ?.trim();
  if (!readTarget) return null;
  const protectedPaths = [
    ...text.matchAll(
      /\b(?:leave|keep|preserve|do\s+not\s+(?:modify|edit|change))\s+`?([\w./-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md))`?(?:\s+(?:untouched|unchanged))?/gi,
    ),
  ]
    .map((match) => match[1]?.toLowerCase())
    .filter((path): path is string => !!path);
  return protectedPaths.includes(readTarget.toLowerCase()) ? null : readTarget;
}

/**
 * True for a focused repair of one already-existing source file. These asks
 * often also contain file-deliverable wording, so without this stronger
 * classification the generic direct-file mode reads the file and then
 * collapses to `write_file` only. That is the wrong recovery shape for a
 * one-line defect: preserve the surgical patch tools after the read.
 *
 * Shared by chat-side allowlisting and local-provider mode selection so the
 * manager cannot advertise a repair surface that the provider later narrows
 * back to a whole-file rewrite.
 */
export function isSingleFileSourceRepairRequest(prompt: string | undefined): boolean {
  const text = (prompt ?? '').trim();
  if (!text) return false;
  if (
    !/\b(?:fix|repair|debug|patch|correct)\b/i.test(text) &&
    !/\bmake\s+(?:it|this|the\s+(?:test|check|suite|script))\s+pass\b/i.test(text)
  ) {
    return false;
  }
  if (!extractSingleFileSourceRepairTargetPath(text)) return false;
  return (
    /\b(?:single[-\s]?line|minimal|few\s+lines?|in place|existing|current|do not rewrite|preserve)\b/i.test(
      text,
    ) || /\b(?:bug|defect|syntax error|parse error|does not parse|doesn't parse)\b/i.test(text)
  );
}

/**
 * True when the latest request explicitly asks for a complete whole-file
 * rewrite through `write_file`. Both chat-side tool clamping and local-provider
 * repair loops consume this helper so a directive cannot advertise
 * `write_file` while the provider silently removes it.
 *
 * Keep this semantic rather than marker-based: runtime checks, task gates,
 * and user-authored repair prompts can all request the same recovery shape.
 * Incidental "use write_file to re-emit" fallback prose does not qualify — the
 * request must make the whole-file rewrite (or write_file as the mandatory next
 * call) explicit.
 */
export function hasExplicitFullFileRewriteWording(prompt: string | undefined): boolean {
  const text = (prompt ?? '').trim();
  if (!text || !/\bwrite_file\b/i.test(text)) return false;

  // Contradictory handoffs historically combined a precise "do not rewrite
  // the whole file" repair instruction with a generic deliverable annotation
  // that said the first action should be write_file. Treat the explicit
  // preservation instruction as authoritative. A broad full-rewrite matcher
  // must never invert a negated phrase just because write_file appears later in
  // the prompt.
  if (
    /\b(?:do\s+not|don't|must\s+not|never|avoid)\s+(?:call|use|invoke)\s+`?write_file`?\b/i.test(
      text,
    ) ||
    /\b(?:do\s+not|don't|must\s+not|never|avoid)\s+(?:use\s+`?write_file`?\s+to\s+)?(?:rewrite|re-emit|overwrite|replace)\s+(?:the\s+)?(?:whole|entire|complete|full)(?:[-\s]+file)?\b/i.test(
      text,
    )
  ) {
    return false;
  }

  const namedCompleteRewrite =
    /\b(?:rewrite|re-emit|overwrite|replace)\s+`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md|csv|txt|ya?ml)`?(?:\s+(?:completely|entirely|in\s+full|as\s+(?:one\s+)?complete\s+(?:corrected\s+)?(?:file|version)))?[\s\S]{0,80}\b(?:with|using|via)\s+`?write_file`?\b/i.test(
      text,
    );
  if (namedCompleteRewrite) return true;

  const mandatoryWriteFile =
    /\b(?:your\s+)?(?:first|next)\s+(?:assistant\s+)?(?:action|response|tool\s+call)\s+(?:must|should)\s+(?:start\s+with|be)\s+(?:the\s+tool\s+call\s+)?`?write_file`?\b/i.test(
      text,
    ) || /\bdo\s+not\s+end\s+your\s+turn\s+until\s+`?write_file`?\s+has\s+rewritten\b/i.test(text);
  if (!mandatoryWriteFile) return false;

  if (/full[_-]rewrite/i.test(text)) return true;
  return /\b(?:rewrite|re-emit|overwrite|replace\s+(?:the\s+)?(?:whole|entire)|whole[-\s]file|complete\s+corrected\s+(?:file|version)|one\s+complete\s+(?:file|version))\b/i.test(
    text,
  );
}
