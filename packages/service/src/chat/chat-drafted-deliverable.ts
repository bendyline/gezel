/**
 * Detectors for a deliverable the model wrote into its chat reply instead of
 * to disk: a whole source file pasted into a fenced block, or a structured
 * markdown report as bare prose. Both stay quiet once a write landed this
 * turn, and each pairs with the re-prompt that names the path to save.
 */
import { salvageCodeBlocks } from '../providers/code-block-salvage.js';

/** Write-shaped tool names — a successful call to any of these means the
 *  turn actually touched a file, so the chat-coded-file nudge stays quiet. */
const CHAT_CODED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'insert_at_marker',
  'write_artifact',
]);

/**
 * Minimum content length (chars) of a fenced code block before it counts
 * as "a file the model chat-coded" rather than an illustrative snippet.
 * A real single-file deliverable runs to thousands of chars; a two-line
 * example in an explanation sits well under this. Conservative so the
 * nudge never fires on a legitimate inline snippet.
 */
const CHAT_CODED_MIN_CHARS = 600;

/**
 * Detect the "chat-coded a file but never called `write_file`" failure:
 * the assistant pasted a whole file's worth of source into a fenced code
 * block in chat, but no write landed this turn. Verbose local models
 * (qwen3.6 a3b) drift into this — they "draft" the file in prose instead
 * of the `write_file` argument, the {@link RambleDetector} now lets the
 * block complete (fenced-code-block awareness), but the model can still
 * finish the turn without ever calling the tool. Returns the inferred
 * target path (from {@link salvageCodeBlocks}' filename hint / default-
 * for-lang) so the nudge can name it, or null when nothing qualifies.
 *
 * Distinct from {@link detectUnsavedFileClaim}: that fires on a *claim*
 * ("saved to X") with no write; this fires on the *content* itself
 * (a big code block) with no write and no claim. Gated on block size so
 * an inline illustration never trips it; the caller additionally gates
 * on `write_file` being available so it only nudges build-capable roles.
 */
export function detectChatCodedFileWithoutWrite(
  content: string,
  toolCalls: ReadonlyArray<{ name: string; success: boolean }> | undefined,
): { path: string } | null {
  const wrote = (toolCalls ?? []).some((tc) => tc.success && CHAT_CODED_WRITE_TOOLS.has(tc.name));
  if (wrote) return null;
  const blocks = salvageCodeBlocks(content);
  if (blocks.length === 0) return null;
  // The largest block is the file; smaller ones are snippets within the
  // same reply (a CSS rule, an SVG fragment) — not the deliverable.
  let best = blocks[0]!;
  for (const b of blocks) {
    if (b.content.length > best.content.length) best = b;
  }
  if (best.content.length < CHAT_CODED_MIN_CHARS) return null;
  return { path: best.filename };
}

/** Re-prompt for {@link detectChatCodedFileWithoutWrite}: tell the model
 *  it drafted the file in chat and must call `write_file` to land it. */
export function buildChatCodedFileNudge(path: string): string {
  return `You wrote the full contents of \`${path}\` in a code block in chat, but you never called \`write_file\` — so nothing was saved to disk. Code in a chat bubble can't run; a file on disk can. Call \`write_file({ path: "${path}", content: <the exact contents you just wrote> })\` NOW — draft the content inside the tool argument, don't paste the file in chat again. Do not claim it's saved until that write lands.`;
}

/**
 * Minimum non-whitespace length of the fence-stripped markdown before a
 * chat reply counts as "a report the model wrote in chat instead of to
 * disk". A genuine structured deliverable (postmortem, analysis, plan)
 * runs well past this; a couple of headed sentences in an ordinary reply
 * sit under it. Conservative so the nudge never fires on normal prose.
 */
const PROSE_DELIVERABLE_MIN_CHARS = 800;

/**
 * Strip fenced code blocks so the prose-deliverable heuristic measures
 * only the markdown surrounding them. A whole file pasted into a fence is
 * {@link detectChatCodedFileWithoutWrite}'s domain — removing fences here
 * is what keeps a reply that is mostly one big code block from tripping
 * the prose detector too.
 */
function stripFencedBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
}

/** A `text` or `markdown` fence holds a document, not code, so the draft
 *  inside is what gets measured. Code fences are still stripped. */
function unwrapDocumentFences(content: string): string {
  return content.replace(
    /(^|\n)(`{3,}|~{3,})(?:text|txt|markdown|md)[ \t]*\n([\s\S]*?)(?:\n\2[ \t]*(?=\n|$)|$)/gi,
    '$1$3',
  );
}

/**
 * Floor for a reply that opens with the very file the request asked for.
 * That label is the model saying "this is the deliverable", so neither the
 * heading test nor the 800-char floor applies: MiniCPM5 1B, asked for
 * `plan.md`, answered with a 760-char plan in a `text` fence whose first
 * line was `plan.md`, sections labelled `objective:` rather than `##`, and
 * no detector fired (2026-09-28).
 */
const LABELED_DELIVERABLE_MIN_CHARS = 300;

/**
 * Detect the "wrote a whole report in chat but never saved it" failure:
 * the assistant produced a substantial structured markdown document as
 * its visible reply — an H1 or several headings, hundreds of chars of
 * prose — but no write landed this turn. The bare-markdown twin of
 * {@link detectChatCodedFileWithoutWrite}: that one fires on a fenced
 * code block (a source file); this one fires on the prose document itself
 * (a postmortem, analysis, plan) that a weak local model chatters out
 * over many turns without ever calling `write_file` / `write_artifact`.
 *
 * Returns the inferred workspace path (see {@link inferProseDeliverablePath})
 * or null when the reply isn't a substantial structured document. Code
 * fences are stripped before measuring; the caller additionally gates on
 * a write tool being available (same as the chat-coded detector) so only
 * build-capable roles get nudged.
 */
export function detectProseDeliverableWithoutWrite(
  content: string,
  toolCalls: ReadonlyArray<{ name: string; success: boolean }> | undefined,
  expectedPath?: string,
  requestText?: string,
): { path: string } | null {
  const wrote = (toolCalls ?? []).some((tc) => tc.success && CHAT_CODED_WRITE_TOOLS.has(tc.name));
  if (wrote) return null;
  if (!content) return null;
  const prose = stripFencedBlocks(unwrapDocumentFences(content));
  const nonWhitespace = prose.replace(/\s+/g, '').length;
  if (opensWithAskedFile(prose, expectedPath, requestText)) {
    if (nonWhitespace < LABELED_DELIVERABLE_MIN_CHARS) return null;
  } else {
    const hasH1 = /^#\s+\S/m.test(prose);
    const headingCount = (prose.match(/^#{1,6}\s+\S/gm) ?? []).length;
    if (!hasH1 && headingCount < 2) return null;
    if (nonWhitespace < PROSE_DELIVERABLE_MIN_CHARS) return null;
  }
  return { path: inferProseDeliverablePath(prose, expectedPath, requestText) };
}

const DOCUMENT_PATH = String.raw`[\w./-]+\.(?:md|markdown|txt|rst)`;

/** A document the request asks to be written, e.g. "write the plan as
 *  `plan.md`" or "save it to notes/summary.md". Deliberately requires the
 *  path right after the verb or after as/to/into/called/named: "write a
 *  summary of `notes.md`" names an INPUT, and nudging a write there would
 *  overwrite the user's source. */
const REQUESTED_PATH = new RegExp(
  String.raw`\b(?:write|save|create|produce|draft|store)\b(?:[^\n.]{0,80}?\b(?:as|to|into|called|named)\s+|\s+)[\x60"'*]*(${DOCUMENT_PATH})\b`,
  'i',
);

/** A reply whose opening line is only a filename (`plan.md`, `**plan.md**`,
 *  `# plan.md`) is the model announcing where the document belongs. */
const ANNOUNCED_PATH = new RegExp(
  String.raw`^\s*(?:#+\s*)?[\x60*]*(${DOCUMENT_PATH})[\x60*]*\s*:?\s*$`,
  'i',
);

/**
 * Pick the save path for a chat-only report, most authoritative first: the
 * caller's expected-deliverable path, a document the request named, a
 * filename the reply opened with, a kebab-cased `<h1-title>.md`, and
 * finally `report.md`. The H1 guess used to outrank the request: a 0.8B
 * asked for `plan.md` replied "plan.md\n# Relocation Plan: …", was told to
 * save `relocation-plan-….md`, complied, and the plan the user asked for
 * never existed.
 */
function announcedPath(prose: string): string | undefined {
  const firstLine = prose.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.match(ANNOUNCED_PATH)?.[1];
}

function opensWithAskedFile(prose: string, expectedPath?: string, requestText?: string): boolean {
  const announced = announcedPath(prose)?.toLowerCase();
  const asked = (expectedPath?.trim() || requestText?.match(REQUESTED_PATH)?.[1])?.toLowerCase();
  if (!announced || !asked) return false;
  return asked === announced || asked.endsWith(`/${announced}`);
}

function inferProseDeliverablePath(
  prose: string,
  expectedPath?: string,
  requestText?: string,
): string {
  const expected = expectedPath?.trim();
  if (expected) return expected;
  const requested = requestText?.match(REQUESTED_PATH)?.[1];
  if (requested) return requested;
  const announced = announcedPath(prose);
  if (announced) return announced;
  const h1 = prose.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const kebab = h1
    ? h1
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '')
    : '';
  return kebab ? `${kebab}.md` : 'report.md';
}

/** Re-prompt for {@link detectProseDeliverableWithoutWrite}: tell the
 *  model it wrote the report in chat and must save it to disk now. */
export function buildProseDeliverableNudge(path: string): string {
  return `You wrote a full report as your chat reply, but you never called a write tool — so nothing was saved to disk. A report the user can keep has to live in a file, not a chat bubble. Call \`write_file({ path: "${path}", content: <the exact report you just wrote> })\` (or \`write_artifact\` for a project artifact) NOW — put the content inside the tool argument, don't paste the report in chat again. Do not claim it's saved until that write lands.`;
}
