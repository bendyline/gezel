import type { McpServerSpec } from '../mcp-bridge.js';
import { isGezelMcp } from './gezel-mcp-small-model.js';
import type { McpToolWrapper } from './types.js';

const SOURCE_EXT_RE = /\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md)$/i;

export const SourceWriteGuard: McpToolWrapper = {
  id: 'source-write-guard',
  matches(spec: McpServerSpec): boolean {
    return isGezelMcp(spec);
  },
  async preProcess(toolName, args, ctx) {
    if (toolName !== 'writeFile' && toolName !== 'replaceLines') return { kind: 'allow' };
    const path = typeof args.path === 'string' ? args.path : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (!path || !SOURCE_EXT_RE.test(path) || content.length === 0) return { kind: 'allow' };

    let normalizedContent = pathLooksHtml(path) ? normalizeHtmlScriptBody(content) : content;
    const existing = await readExistingFile(ctx, path);

    // replaceLines is normally the safer, surgical edit surface, but a model
    // can still use an oversized range to clobber the entire file. Apply the
    // same short-overwrite protection when the requested range covers all of
    // the existing source, while leaving genuinely focused replacements open.
    if (toolName === 'replaceLines') {
      if (
        existing &&
        replaceLinesCoversWholeFile(existing, args) &&
        looksLikeDestructiveShortOverwrite(existing, normalizedContent) &&
        !replacementRepairsInvalidTypedFile(path, existing, normalizedContent)
      ) {
        return {
          kind: 'reject',
          error: `ERROR: Refusing to replace all of \`${path}\` with ${normalizedContent.length} bytes via \`replaceLines\` (existing file is ${existing.length} bytes). Use a focused line range for the small change, or send the complete replacement file without placeholders.`,
        };
      }
      return normalizedContent === content
        ? { kind: 'allow' }
        : { kind: 'allow', args: { ...args, content: normalizedContent } };
    }

    if (pathLooksHtml(path) && existing) {
      normalizedContent =
        repairHtmlScriptFragmentWrite(normalizedContent, existing) ??
        repairHtmlScriptPatchFragmentWrite(normalizedContent, existing) ??
        normalizedContent;
      const unrepairedFragment = extractScriptFragment(normalizedContent);
      if (
        !looksLikeFullHtml(normalizedContent) &&
        unrepairedFragment &&
        looksLikeJavaScriptPatchFragment(unrepairedFragment)
      ) {
        return {
          kind: 'reject',
          error: `ERROR: Refusing to replace \`${path}\` with a JavaScript fragment. Send a complete HTML file with the corrected <script> block, or a patch fragment that repairs the existing file into parseable HTML.`,
        };
      }
    }

    const truncatedHtml = pathLooksHtml(path) ? describeTruncatedHtml(normalizedContent) : null;
    if (truncatedHtml) {
      return {
        kind: 'reject',
        error: `ERROR: Refusing to write \`${path}\` because the content looks truncated (${truncatedHtml}). Call \`writeFile\` again with the complete file contents in one tool call.`,
      };
    }

    if (
      existing &&
      looksLikeDestructiveShortOverwrite(existing, normalizedContent) &&
      !(pathLooksHtml(path) && looksLikeIntentionalHtmlModuleShell(normalizedContent)) &&
      !replacementRepairsInvalidTypedFile(path, existing, normalizedContent)
    ) {
      return {
        kind: 'reject',
        error: `ERROR: Refusing to replace \`${path}\` with a much shorter source file (${normalizedContent.length} bytes vs existing ${existing.length} bytes). If this is intentional, rewrite the complete file; otherwise use a focused edit tool.`,
      };
    }

    // Same-file clobber guard — OFF BY DEFAULT (it backfired on e4b; see the
    // verdict above the helpers). When enabled via GEZEL_SAME_FILE_REWRITE_GUARD,
    // a full rewrite of an existing substantial file that mostly matches disk
    // is rejected with a concrete `replaceInFile` directive so a sibling fix
    // in the same file can't be reverted.
    if (
      existing &&
      sameFileRewriteGuardEnabled() &&
      REWRITE_GUARD_TIERS.has(ctx.modelTier) &&
      looksLikeFullRewriteOfSmallChange(existing, normalizedContent)
    ) {
      return {
        kind: 'reject',
        error: buildReplaceInFileRedirect(path, existing, normalizedContent),
      };
    }

    if (normalizedContent !== content) {
      return { kind: 'allow', args: { ...args, content: normalizedContent } };
    }

    return { kind: 'allow' };
  },
};

async function readExistingFile(
  ctx: Parameters<NonNullable<McpToolWrapper['preProcess']>>[2],
  path: string,
): Promise<string | null> {
  if (!ctx.hasTool('readFile')) return null;
  try {
    const result = await ctx.callTool('readFile', { path, raw: true });
    return result.text;
  } catch {
    return null;
  }
}

function pathLooksHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

// A broken artifact does not deserve shrink protection. Wild-caught on
// craftbook-audiobook-master-pack (gemma4-e2b): the first writeFile landed
// invalid JSON (missing its opening `{`), and this guard then rejected every
// smaller-but-valid rewrite until the stale-no-write watchdog killed the run
// — the guard was protecting garbage from its own repair. Scope: JSON only,
// because `.json` has an unambiguous in-process validator; `new Function`
// false-positives on ES modules and HTML already has dedicated repair paths
// above. The replacement must itself parse, so this can never be used to
// replace a file (broken or not) with a prose stub.
function replacementRepairsInvalidTypedFile(
  path: string,
  existing: string,
  replacement: string,
): boolean {
  if (!/\.json$/i.test(path)) return false;
  if (isParseableJson(existing)) return false;
  return isParseableJson(replacement);
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeDestructiveShortOverwrite(existing: string, replacement: string): boolean {
  if (existing.length < 200) return false;
  if (existing.trim() === replacement.trim()) return false;
  if (replacement.length < 120) return true;
  // A sub-KiB module can legitimately become much shorter after replacing a
  // verbose representation (generated declarations, JSDoc typedefs, boilerplate)
  // with concise source. At this size the absolute <120-byte fragment check
  // above is the useful safety boundary; a ratio check mistakes complete small
  // modules for destructive clobbers and can deadlock an explicitly requested
  // full rewrite.
  if (existing.length < 1024) return false;

  // This guard is meant to catch obvious clobbers such as "tiny" replacing a
  // real source file. Large single-file apps often get shorter after a repair
  // or refactor; blocking every <50% rewrite traps small models in a loop where
  // they keep producing complete, leaner files that the runtime refuses.
  if (replacement.length >= 4096) return false;
  return replacement.length < Math.floor(existing.length * 0.35);
}

function replaceLinesCoversWholeFile(existing: string, args: Record<string, unknown>): boolean {
  const startLine = typeof args.startLine === 'number' ? args.startLine : Number.NaN;
  const endLine = typeof args.endLine === 'number' ? args.endLine : Number.NaN;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return false;
  const lineCount = Math.max(1, existing.replace(/\r?\n$/, '').split(/\r?\n/).length);
  return startLine <= 1 && endLine >= lineCount;
}

// ── Same-file clobber guard (OFF BY DEFAULT — experimental) ──────────────
//
// The idea: small/medium local models default to a full-file `writeFile`
// even for a localized change, and regenerating the whole file from memory
// silently drops edits already in it. Wild-caught on gemma4-e4b's
// `fix-squisq-bugs` run: two bugs lived in the SAME file, and fixing one via
// a full rewrite reverted the sibling fix, oscillating forever (the
// "same-file clobber"). So: refuse a full rewrite of an existing substantial
// file whose new content mostly matches disk, and hand back a surgical
// `replaceInFile` (which can't touch regions outside its match) so a sibling
// fix can't be reverted.
//
// VERDICT — IT BACKFIRED, so it ships disabled. A controlled N=4 A/B
// (runs/batch-2026-06-06T06-01-38*) scored 0/4 WITH the guard vs
// 1/4 (25%) without, and no guarded trial even reached 4/5 (the baseline
// did). Why: the same co-location that causes the clobber means a single
// `writeFile` fixes BOTH same-file bugs at once — full rewrite is the small
// model's *stronger* modality. Forcing `replaceInFile` splits that into two
// precision edits e4b fumbles (it lands one, not both). The clobber is a
// symptom of a coordination/coherence limit, not the root cause; edit-tool
// shaping doesn't fix it (right-size the model instead). Read-before-rewrite
// wouldn't help either — e4b read the file 9-16×/trial and still dropped the
// fix. Kept behind a flag in case a local model genuinely good at
// `replaceInFile` benefits where the precision tax doesn't bite. Enable with
// `GEZEL_SAME_FILE_REWRITE_GUARD=1`.

const REWRITE_GUARD_TIERS: ReadonlySet<string> = new Set(['tiny', 'small', 'medium']);

/**
 * Off-by-default kill switch. The guard backfired on e4b (see the block
 * above), so it ships disabled; set `GEZEL_SAME_FILE_REWRITE_GUARD=1` to
 * re-enable for experimentation.
 */
function sameFileRewriteGuardEnabled(): boolean {
  const v = process.env.GEZEL_SAME_FILE_REWRITE_GUARD;
  return v === '1' || v?.toLowerCase() === 'true';
}
/** Below this a full rewrite is cheap + safe; don't bother redirecting. */
const REWRITE_GUARD_MIN_BYTES = 800;
const REWRITE_GUARD_MIN_LINES = 25;
/** At/above this fraction of existing lines preserved, the "rewrite" is really a patch. */
const REWRITE_GUARD_PRESERVED_RATIO = 0.65;

function nonEmptyTrimmedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Fraction of `existing`'s non-blank lines (counted with multiplicity) that
 * survive verbatim in `replacement`. ~1.0 = a few lines changed in an
 * otherwise-identical file; low = a genuine overhaul where a patch wouldn't
 * be smaller.
 */
function rewritePreservedFraction(existing: string, replacement: string): number {
  const ex = nonEmptyTrimmedLines(existing);
  if (ex.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const l of nonEmptyTrimmedLines(replacement)) counts.set(l, (counts.get(l) ?? 0) + 1);
  let preserved = 0;
  for (const l of ex) {
    const remaining = counts.get(l) ?? 0;
    if (remaining > 0) {
      preserved += 1;
      counts.set(l, remaining - 1);
    }
  }
  return preserved / ex.length;
}

/**
 * True when a `writeFile` to an existing substantial source file is really a
 * localized change dressed up as a full rewrite. Genuine overhauls (most
 * lines changed), small files, and exact no-op rewrites are left alone.
 */
function looksLikeFullRewriteOfSmallChange(existing: string, replacement: string): boolean {
  if (existing.length < REWRITE_GUARD_MIN_BYTES) return false;
  if (nonEmptyTrimmedLines(existing).length < REWRITE_GUARD_MIN_LINES) return false;
  if (existing.trim() === replacement.trim()) return false; // no-op write — harmless
  return rewritePreservedFraction(existing, replacement) >= REWRITE_GUARD_PRESERVED_RATIO;
}

/**
 * The single contiguous changed region between `existing` and `replacement`,
 * anchored with one line of surrounding context for uniqueness. Returns null
 * when the change spans multiple regions (no clean single find/replace) or is
 * a pure insertion (no `find` anchor to match on).
 */
function singleRegionDiff(
  existing: string,
  replacement: string,
): { find: string; replace: string } | null {
  const ex = existing.split(/\r?\n/);
  const rp = replacement.split(/\r?\n/);
  let p = 0;
  while (p < ex.length && p < rp.length && ex[p] === rp[p]) p += 1;
  let s = 0;
  while (s < ex.length - p && s < rp.length - p && ex[ex.length - 1 - s] === rp[rp.length - 1 - s])
    s += 1;
  const exMiddle = ex.slice(p, ex.length - s);
  const rpMiddle = rp.slice(p, rp.length - s);
  if (exMiddle.length === 0) return null; // pure insertion — no anchor to find
  if (exMiddle.length > 30 || rpMiddle.length > 40) return null; // too large to suggest cleanly
  const before = p > 0 ? (ex[p - 1] ?? null) : null;
  const after = s > 0 ? (ex[ex.length - s] ?? null) : null;
  const join = (mid: string[]): string =>
    [before, ...mid, after].filter((l): l is string => l !== null).join('\n');
  return { find: join(exMiddle), replace: join(rpMiddle) };
}

function buildReplaceInFileRedirect(path: string, existing: string, replacement: string): string {
  const base = `ERROR: Refusing to rewrite the entire file \`${path}\` for a localized change. A full-file \`writeFile\` regenerates the whole file from memory, which silently reverts other edits already in it (a fix in one function gets dropped) and risks truncating a large file. Make this change with \`replaceInFile\`, editing ONLY the lines that change — it leaves the rest of the file untouched.`;
  const diff = singleRegionDiff(existing, replacement);
  if (diff && !diff.find.includes('\n') && !diff.replace.includes('\n')) {
    return `${base}\nFor this change: replaceInFile({ path: ${JSON.stringify(path)}, find: ${JSON.stringify(diff.find)}, replace: ${JSON.stringify(diff.replace)} })`;
  }
  return `${base} If your change touches more than one place, make a separate \`replaceInFile\` call for each — do not rewrite the whole file.`;
}

function describeTruncatedHtml(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return 'empty HTML';
  if (!/[<](?:!doctype|html|head|body|meta|script|style|div|button)\b/i.test(trimmed)) {
    return null;
  }
  if (/<[^>]{1,160}$/i.test(trimmed)) return 'the final HTML tag is incomplete';
  if (/<script\b/i.test(trimmed) && !/<\/script>/i.test(trimmed)) {
    return 'a `<script>` tag is opened but not closed';
  }
  if (
    /^(?:<!doctype html>|<html\b)/i.test(trimmed) &&
    !/<\/html>/i.test(trimmed) &&
    trimmed.length < 512
  ) {
    return 'the document starts as full HTML but ends before `</html>`';
  }
  return null;
}

function normalizeHtmlScriptBody(content: string): string {
  const withClosedFinalTag = normalizeIncompleteFinalClosingTag(content);
  const withMissingTail = normalizeMissingHtmlTail(withClosedFinalTag);
  const withoutTagOpeners = withMissingTail.replace(
    /(<script\b[^>]*>)\s*<(?=\s*(?:async\s+)?(?:function\b|const\b|let\b|var\b|class\b|import\b|document\b|window\b|\())/gi,
    '$1',
  );
  return withoutTagOpeners.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_match: string, open: string, body: string, close: string) => {
      const normalizedBody = body.replace(/\/\/[^\n\r<]*?([}\])]+)\s*$/u, '$1');
      return `${open}${normalizedBody}${close}`;
    },
  );
}

function normalizeMissingHtmlTail(content: string): string {
  const trimmed = content.trimEnd();
  if (!/^(?:<!doctype html>|<html\b)/i.test(trimmed)) return content;
  if (!/<script\b/i.test(trimmed) || /<\/script>/i.test(trimmed)) return content;
  if (/<[^>]{1,160}$/i.test(trimmed)) return content;

  const tail = [
    '</script>',
    /<body\b/i.test(trimmed) && !/<\/body>/i.test(trimmed) ? '</body>' : '',
    /<html\b/i.test(trimmed) && !/<\/html>/i.test(trimmed) ? '</html>' : '',
  ].filter(Boolean);
  if (tail.length === 0) return content;
  return `${trimmed}\n${tail.join('\n')}`;
}

function normalizeIncompleteFinalClosingTag(content: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/<\/(?:h|ht|htm|html)$/i, '</html>'],
    [/<\/(?:b|bo|bod|body)$/i, '</body>'],
    [/<\/(?:s|sc|scr|scri|scrip|script)$/i, '</script>'],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(content.trimEnd())) {
      return content.replace(/\s*$/u, '').replace(pattern, replacement);
    }
  }
  return content;
}

function repairHtmlScriptFragmentWrite(content: string, existing: string): string | null {
  if (!looksLikeFullHtml(existing)) return null;
  if (looksLikeFullHtml(content)) return null;

  const fragment = extractScriptFragment(content);
  if (!fragment) return null;
  if (!looksLikeJavaScriptFragment(fragment)) return null;

  const scripts = inlineScriptMatches(existing);
  if (scripts.length !== 1) return null;
  const script = scripts[0]!;
  if (/\bsrc\s*=/i.test(script.attrs)) return null;
  if (/\btype\s*=\s*["']module["']/i.test(script.attrs)) return null;

  const candidate =
    existing.slice(0, script.bodyStart) + fragment.trim() + existing.slice(script.bodyEnd);
  if (!validateHtmlInlineScripts(candidate)) return null;
  return candidate;
}

function repairHtmlScriptPatchFragmentWrite(content: string, existing: string): string | null {
  if (!looksLikeFullHtml(existing)) return null;
  if (looksLikeFullHtml(content)) return null;
  if (validateHtmlInlineScripts(existing)) return null;

  const fragment = extractScriptFragment(content);
  if (!fragment) return null;
  const patch = fragment.trim();
  if (patch.length === 0 || patch.length > 300) return null;
  if (!looksLikeJavaScriptPatchFragment(patch)) return null;

  const scripts = inlineScriptMatches(existing);
  if (scripts.length !== 1) return null;
  const script = scripts[0]!;
  if (/\bsrc\s*=/i.test(script.attrs)) return null;
  if (/\btype\s*=\s*["']module["']/i.test(script.attrs)) return null;

  const body = existing.slice(script.bodyStart, script.bodyEnd);
  const split = splitLinesWithOffsets(body);
  const candidates = new Set<number>([body.length]);
  for (const offset of split.offsets) candidates.add(offset);

  for (const offset of candidates) {
    const candidateBody = insertPatchAt(body, offset, patch);
    const candidateHtml =
      existing.slice(0, script.bodyStart) + candidateBody + existing.slice(script.bodyEnd);
    if (validateHtmlInlineScripts(candidateHtml)) return candidateHtml;
  }

  return null;
}

function extractScriptFragment(content: string): string | null {
  let text = content.trim();
  text = stripCodeFence(text).trim();
  text = text.replace(/^\s*<script\b[^>]*>/i, '').trim();
  text = text
    .replace(/<\/body\s*>\s*$/i, '')
    .replace(/<\/html\s*>\s*$/i, '')
    .trim();
  text = text.replace(/<\/script\s*>\s*$/i, '').trim();
  if (!text) return null;
  if (/<(?:!doctype|html|head|body)\b/i.test(text)) return null;
  return text;
}

function stripCodeFence(text: string): string {
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  return fence?.[1] ?? text;
}

function looksLikeFullHtml(content: string): boolean {
  return /^(?:\s*<!doctype html\b|\s*<html\b)/i.test(content);
}

function looksLikeIntentionalHtmlModuleShell(content: string): boolean {
  if (content.trim().length < 160) return false;
  if (!looksLikeFullHtml(content)) return false;
  if (!validateHtmlInlineScripts(content)) return false;
  return inlineScriptMatches(content).some(
    (script) =>
      /\btype\s*=\s*["']module["']/i.test(script.attrs) && /\bsrc\s*=/i.test(script.attrs),
  );
}

function looksLikeJavaScriptFragment(fragment: string): boolean {
  return (
    /\b(?:const|let|var|function|document|window|addEventListener|querySelector|getElementById)\b/.test(
      fragment,
    ) || /=>/.test(fragment)
  );
}

function looksLikeJavaScriptPatchFragment(fragment: string): boolean {
  return (
    /^[\s\S]*[{}()[\];][\s\S]*$/.test(fragment) ||
    /\b(?:const|let|var|function|document|window|addEventListener|querySelector|getElementById|return)\b/.test(
      fragment,
    ) ||
    /=>/.test(fragment)
  );
}

function splitLinesWithOffsets(text: string): { offsets: number[] } {
  const offsets = [0];
  const re = /\r?\n/g;
  let match = re.exec(text);
  while (match !== null) {
    offsets.push(match.index + match[0].length);
    match = re.exec(text);
  }
  return { offsets };
}

function insertPatchAt(body: string, offset: number, patch: string): string {
  const before = body.slice(0, offset).replace(/\s*$/u, '');
  const after = body.slice(offset).replace(/^\s*/u, '');
  return [before, patch, after].filter((part) => part.length > 0).join('\n');
}

interface InlineScriptMatch {
  attrs: string;
  bodyStart: number;
  bodyEnd: number;
}

function inlineScriptMatches(html: string): InlineScriptMatch[] {
  const out: InlineScriptMatch[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(re)) {
    const full = match[0] ?? '';
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const start = match.index ?? 0;
    const open = full.indexOf('>') + 1;
    out.push({
      attrs,
      bodyStart: start + open,
      bodyEnd: start + open + body.length,
    });
  }
  return out;
}

function validateHtmlInlineScripts(html: string): boolean {
  const opens = (html.match(/<script\b[^>]*>/gi) ?? []).length;
  const closes = (html.match(/<\/script\s*>/gi) ?? []).length;
  if (opens !== closes) return false;
  for (const script of inlineScriptMatches(html)) {
    const body = html.slice(script.bodyStart, script.bodyEnd);
    if (!body.trim()) continue;
    if (/\btype\s*=\s*["']module["']/i.test(script.attrs)) continue;
    try {
      new Function(body);
    } catch {
      return false;
    }
  }
  return true;
}
