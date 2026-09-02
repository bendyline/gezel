import { type ExpectedDeliverable, MANAGED_WORKSPACE_WRITE_SETTING_LABEL } from '@bendyline/gezel';
import {
  extractExplicitFileEditTools,
  extractSingleFileSourceRepairTargetPath,
} from '../providers/direct-file-work-prompt.js';
import {
  isExpectedBinaryDocumentDeliverablePath,
  isExpectedImageDeliverablePath,
} from './deliverable-paths.js';

/** Render the per-message instruction for a file-shaped deliverable. */
export function formatExpectedDeliverableAnnotation(
  deliverable: ExpectedDeliverable | undefined,
  fileEditsDisabled = false,
  requestText?: string,
): string {
  if (!deliverable || deliverable.kind !== 'file') return '';
  if (fileEditsDisabled) {
    return `\n\n[Note: this recipient's built-in workspace file tools are read-only, so it cannot write this deliverable. Do not call \`write_file\` or claim the file was saved — reply that this session is blocked until "${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" is enabled in Project → Settings. Provider-native sessions such as Codex may have separate access.]`;
  }
  const path = deliverable.filePath?.trim();
  const pathClause = path
    ? `at \`${path}\``
    : 'at a workspace-relative path (default: `<topic>-analysis.md`)';
  if (path && isExpectedImageDeliverablePath(path)) {
    return `\n\n[Deliverable expected as an IMAGE FILE at \`${path}\`. Your first assistant action should be the tool call \`generate_image({ prompt, saveAs: "${path}" })\`; the image tool writes the PNG/JPG/WebP bytes to disk. Reply in chat with the path + a 2-sentence precis — do NOT call \`write_file({ path, content })\` for binary image bytes and do NOT paste base64 or prose as the deliverable.]`;
  }
  if (path && isExpectedBinaryDocumentDeliverablePath(path)) {
    return `\n\n[Deliverable expected as a REAL BINARY DOCUMENT OR MEDIA FILE at \`${path}\`. Preserve that exact format — a markdown outline, HTML page, or similarly named text file is not the deliverable. Use the installed DocBlocks production tools/craftbook: author the source as Markdown, call \`convert_document\` for the requested target, visually inspect with \`preview_document\` when layout or frames matter, then persist with \`save_artifact\`. Do NOT hand-build HTML/OOXML or call \`write_file\` with prose or base64 for this binary file. If those production tools are not on your roster, reply that the exact-format deliverable is blocked instead of silently substituting another format.]`;
  }
  const explicitEditTools = extractExplicitFileEditTools(requestText);
  if (explicitEditTools.length > 0) {
    const formattedTools = explicitEditTools.map((tool) => `\`${tool}\``).join(' and ');
    const appendOnly =
      explicitEditTools.length === 1 &&
      explicitEditTools[0] === 'append_to_file' &&
      isExplicitAppendOnlyRequest(requestText);
    const editInstruction = appendOnly
      ? 'This is an append-only update of an existing file. Follow the request exactly: your first file mutation must use `append_to_file`; do not call `write_file`, replace the existing contents, or turn the requested append into a whole-file rewrite.'
      : `The request explicitly names the existing-file edit surface ${formattedTools}. Follow its stated tool order and fallback rules exactly; do not replace that surgical surface with generic \`write_file\`-first creation guidance.`;
    return `\n\n[Deliverable expected as a FILE ${pathClause}. ${editInstruction} Reply in chat with the path + a 2-sentence precis — do NOT paste the full deliverable into chat.]`;
  }
  if (path && isExpectedDataDeliverablePath(path)) {
    return `\n\n[Deliverable expected as a DERIVED DATA FILE at \`${path}\`. Do not hand-type the rows — compute them: write a small Node script that reads the input files with fs.readFileSync and writes \`${path}\` with fs.writeFileSync, then execute it. Prefer the \`derive_file\` tool ({ script, outputPath: "${path}" }); otherwise write_file the script to scripts/derive.mjs and run it with \`run_nodejs_script\`. Reply in chat with the path + row count — do NOT paste the data into chat.]`;
  }
  const repairTarget = extractSingleFileSourceRepairTargetPath(requestText);
  const focusedExistingRepair =
    path !== undefined &&
    repairTarget !== null &&
    normalizeExpectedDeliverablePath(path) === normalizeExpectedDeliverablePath(repairTarget);
  if (focusedExistingRepair) {
    return `\n\n[Deliverable expected as a FILE at \`${path}\`. This is a focused repair of an existing source file, not a fresh-file create. Read \`${path}\` if its current contents are not already in context, then make the smallest concrete edit with \`replace_in_file\` or \`replace_lines\`. Preserve already-working behavior; use \`write_file\` only if a targeted edit is explicitly rejected or the file is missing. Reply in chat with the path + a 2-sentence precis — do NOT paste the full deliverable into chat.]`;
  }
  const singleFileHtmlClause =
    path && /(?:^|\/)index\.html$/i.test(path)
      ? ' This is a single-file HTML deliverable: put CSS in `<style>` and JavaScript in one inline `<script>` inside that same HTML file. Do NOT create or rely on `script.js`, `styles.css`, external assets, a build step, or a second source file unless the asker explicitly named one.'
      : '';
  return `\n\n[Deliverable expected as a FILE ${pathClause}. Your first assistant action should be the tool call \`write_file({ path, content })\`; draft inside the tool argument, not in chat.${singleFileHtmlClause} Reply in chat with the path + a 2-sentence precis — do NOT paste the full deliverable into chat.]`;
}

export function normalizeExpectedDeliverablePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^workspace\//i, '')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function isExplicitAppendOnlyRequest(requestText: string | undefined): boolean {
  const text = (requestText ?? '').trim();
  return (
    /\bappend[-\s]?only\b/i.test(text) ||
    /\b(?:first|next)\s+(?:assistant\s+)?(?:action|tool\s+call|mutation)\s+(?:must|should)\s+(?:start\s+with|be)\s+(?:the\s+tool\s+call\s+)?`?append_to_file`?\b/i.test(
      text,
    ) ||
    /\b(?:do\s+not|don't|must\s+not|never|avoid)\s+(?:call|use|invoke)\s+`?write_file`?\b/i.test(
      text,
    )
  );
}

/** Whether a path names data that should be derived rather than hand-authored. */
export function isExpectedDataDeliverablePath(path: string): boolean {
  return /\.(?:csv|tsv|json|ndjson)$/i.test(path.trim());
}

export function deriveRepairClampEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEZEL_DERIVE_REPAIR_CLAMP === '1';
}

export function buildDeriveRepairClampNudge(filePath: string, failingVerdict: string): string {
  return `${failingVerdict}\n\nYou re-emitted the whole file and it STILL fails the same check. Stop hand-typing rows — a hand-typed data file loses or corrupts fields every time. COMPUTE the output instead: call \`derive_file({ script, outputPath: "${filePath}" })\` with a Node script that reads the input files with \`fs.readFileSync\`, applies the fix, and writes \`${filePath}\` with \`fs.writeFileSync\` (or write that script to \`scripts/derive.mjs\` and run it with \`run_nodejs_script\`). Fix the ONE failing field named above — do not regenerate everything, and do not paste the data into chat.`;
}

export function deriveRepairClampNudge(
  opts: { filePath?: string; failingVerdict: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!deriveRepairClampEnabled(env)) return null;
  const path = opts.filePath?.trim();
  if (!path || !isExpectedDataDeliverablePath(path)) return null;
  return buildDeriveRepairClampNudge(path, opts.failingVerdict);
}
