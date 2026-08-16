/**
 * Structured file validation for the `validate` MCP tool.
 *
 * Sibling to [source-validation.ts](./source-validation.ts) — but where
 * that module returns a single pass/fail string for `write_file` to gate
 * the write, this module returns a per-check structured result a model
 * can act on. The model calls `validate({ path })`, gets back a typed
 * list of checks (each with name, status, optional location + excerpt +
 * fix hint), and decides what to patch.
 *
 * Design priorities (in order):
 *
 *   1. **The model can act on the output without further reads.** Every
 *      failure carries a 5-line code excerpt with line numbers and an
 *      arrow on the failing line — same shape compilers print. The
 *      model patterns-match this and produces a fix without re-fetching
 *      the file.
 *   2. **Fix hints route to the right tool.** When the failure mode
 *      points at a specific repair (binary corrupted by JSON round-trip
 *      → `copy_artifact_to_workspace`), the hint says so. Closes the
 *      verification-gate loop: the model gathers evidence here, then
 *      cites it back to `set_task_status`.
 *   3. **Passes are one-liners.** Don't waste tokens on success — the
 *      model needs to know what's BROKEN, not what's fine.
 *
 * Dispatch is purely by file extension. Unknown extensions get the
 * `file-non-empty` check and nothing else.
 */

import ts from 'typescript';
import { locateUnterminatedConstruct } from './source-validation.js';

export type ValidateCheck =
  | { ok: true; name: string; detail?: string }
  | { ok: null; name: string; detail: string }
  | {
      ok: false;
      name: string;
      message: string;
      location?: { line: number; col?: number };
      excerpt?: string;
      fixHint?: string;
    };

export interface ValidateResult {
  path: string;
  checks: ValidateCheck[];
}

export interface FileContent {
  /** Present for text-shaped files (html/js/json/css/md). */
  text?: string;
  /** Present for binary-shaped files (png/jpg/webp/svg/pdf/…). */
  bytes?: Uint8Array;
  /** Total bytes on disk regardless of which representation is set. */
  totalBytes: number;
}

/**
 * Pick the validation routine for a path. Returns an empty `checks`
 * array if we have no opinion (e.g. unknown extension); the caller can
 * surface that as "no validators registered for .ext".
 */
export function validateFile(path: string, content: FileContent): ValidateResult {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return { path, checks: validateHtml(path, content) };
  }
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx')
  ) {
    return { path, checks: validateJsTs(path, content) };
  }
  if (lower.endsWith('.json')) {
    return { path, checks: validateJson(path, content) };
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.svg')
  ) {
    return { path, checks: validateImage(path, content) };
  }
  return { path, checks: [fileNonEmptyCheck(content)] };
}

/**
 * Format a `ValidateResult` into the model-facing string. The shape:
 *
 *   validate <path> — PASS | FAIL (X of Y checks failed)
 *
 *   ✗ <check>: <message>
 *       <excerpt>
 *       Fix hint: <hint>
 *
 *   ✓ <check>: <detail or "ok">
 *
 * Failures come first so the model reads them without scrolling.
 */
export function formatValidateResult(result: ValidateResult): string {
  const fails = result.checks.filter((c) => c.ok === false) as Array<ValidateCheck & { ok: false }>;
  const passes = result.checks.filter((c) => c.ok === true) as Array<ValidateCheck & { ok: true }>;
  const skips = result.checks.filter((c) => c.ok === null) as Array<ValidateCheck & { ok: null }>;
  const skipSuffix = skips.length > 0 ? `; ${skips.length} skipped` : '';
  const summary =
    fails.length === 0
      ? `validate ${result.path} — PASS (${passes.length} check${passes.length === 1 ? '' : 's'}${skipSuffix})`
      : `validate ${result.path} — FAIL (${fails.length} of ${fails.length + passes.length} completed check${fails.length + passes.length === 1 ? '' : 's'} failed${skipSuffix})`;
  const lines: string[] = [summary, ''];
  for (const f of fails) {
    const loc = f.location
      ? ` at line ${f.location.line}${f.location.col ? `, col ${f.location.col}` : ''}`
      : '';
    lines.push(`✗ ${f.name}: ${f.message}${loc}`);
    if (f.excerpt) {
      lines.push('    Context:');
      lines.push(f.excerpt);
    }
    if (f.fixHint) {
      lines.push(`    Fix hint: ${f.fixHint}`);
    }
    lines.push('');
  }
  for (const p of passes) {
    lines.push(`✓ ${p.name}${p.detail ? `: ${p.detail}` : ''}`);
  }
  for (const s of skips) {
    lines.push(`- ${s.name}: skipped — ${s.detail}`);
  }
  return lines.join('\n').trimEnd();
}

export function runtimePageCheckToValidateCheck(check: {
  ran: boolean;
  ok?: boolean;
  errors?: string[];
  reason?: string;
}): ValidateCheck {
  if (!check.ran || check.ok === undefined) {
    return {
      ok: null,
      name: 'runtime-load',
      detail: check.reason ?? 'headless browser produced no verdict',
    };
  }
  if (check.ok) {
    return { ok: true, name: 'runtime-load', detail: 'page loaded headlessly without errors' };
  }
  return {
    ok: false,
    name: 'runtime-load',
    message: (check.errors ?? []).join('; ') || 'page failed its headless runtime check',
    fixHint:
      'fix the reported runtime error, then call `validate` again. Do not install a separate static server; the validator already loads workspace HTML through the scoped preview server.',
  };
}

// ── Common helpers ───────────────────────────────────────────────

function fileNonEmptyCheck(content: FileContent): ValidateCheck {
  if (content.totalBytes === 0) {
    return {
      ok: false,
      name: 'file-non-empty',
      message: 'file is empty (0 bytes)',
      fixHint:
        'write the intended content with `write_file` (or `copy_artifact_to_workspace` if the source is in the artifacts drawer).',
    };
  }
  return { ok: true, name: 'file-non-empty', detail: `${content.totalBytes} bytes` };
}

/**
 * Render `context` lines on either side of `targetLine` (1-based) with
 * a line-number gutter and a `←` arrow on the target. Mirrors what
 * compilers print so models pattern-match the shape and produce a
 * patch.
 */
function buildExcerpt(text: string, targetLine: number, context = 2): string {
  const lines = text.split('\n');
  if (lines.length === 0) return '';
  const start = Math.max(0, targetLine - 1 - context);
  const end = Math.min(lines.length - 1, targetLine - 1 + context);
  const width = String(end + 1).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const num = String(i + 1).padStart(width);
    const arrow = i + 1 === targetLine ? '    ← here' : '';
    out.push(`      ${num} | ${lines[i] ?? ''}${arrow}`);
  }
  return out.join('\n');
}

// ── HTML ─────────────────────────────────────────────────────────

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;

interface InlineScriptForLint {
  body: string;
  attrs: string;
  openLine: number;
}

/**
 * Markup that does nothing without JavaScript. A page carrying one of
 * these and no `<script>` at all is not a static page — it is a page
 * whose code is missing.
 *
 * This exists because `script-tag-present` reported PASS with the detail
 * "no inline scripts (valid for a static page)" for a game whose entire
 * engine had been dropped on a retry: a `<canvas>`, a full HUD, and zero
 * lines of JS. The gezel read that PASS as proof the page worked and
 * reported "clean headless load" to the user.
 */
const INERT_WITHOUT_SCRIPT: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /<canvas\b/i, what: '<canvas> element' },
  {
    re: /\son(?:click|change|input|submit|keydown|keyup|keypress|mousedown|mouseup|mousemove|mouseover|mouseout|touchstart|touchend|touchmove|load|focus|blur|error|scroll|resize)\s*=/i,
    what: 'inline event-handler attribute',
  },
];

function inertMarkupWithoutScript(html: string): { what: string; line: number } | null {
  for (const { re, what } of INERT_WITHOUT_SCRIPT) {
    const m = re.exec(html);
    if (m) return { what, line: (html.slice(0, m.index).match(/\n/g)?.length ?? 0) + 1 };
  }
  return null;
}

function validateHtml(_path: string, content: FileContent): ValidateCheck[] {
  if (!content.text) {
    return [
      {
        ok: false,
        name: 'file-readable',
        message: 'could not read HTML as text',
        fixHint: 'the file may be corrupted; try writing it again with `write_file`.',
      },
    ];
  }
  const html = content.text;
  const checks: ValidateCheck[] = [fileNonEmptyCheck(content)];

  checks.push(validateHtmlDocumentStructure(html));
  checks.push(validateUniqueHtmlIds(html));

  // script-tag-present
  const opens = (html.match(SCRIPT_OPEN_RE) ?? []).length;
  const closes = (html.match(SCRIPT_CLOSE_RE) ?? []).length;
  if (opens === 0) {
    const inert = inertMarkupWithoutScript(html);
    if (inert) {
      checks.push({
        ok: false,
        name: 'script-tag-present',
        message: `page has a ${inert.what} but no <script> at all — this markup is inert, so nothing on the page can run`,
        location: { line: inert.line },
        excerpt: buildExcerpt(html, inert.line, 2),
        fixHint:
          'the page is missing its JavaScript entirely — a syntax pass on markup alone is not evidence it works. Add the <script> block that drives it, then re-validate.',
      });
      return checks;
    }
    checks.push({
      ok: true,
      name: 'script-tag-present',
      detail: 'no inline scripts (valid for a static page)',
    });
  } else if (opens > closes) {
    checks.push({
      ok: false,
      name: 'script-tag-balanced',
      message: `${opens} <script> opening tag(s) but only ${closes} </script> closing tag(s) — the file is truncated mid-script`,
      fixHint:
        'append the missing </script> close with `append_to_file`, or re-emit the full file with `write_file`.',
    });
    return checks; // script-body check would be misleading on truncated input
  } else {
    checks.push({
      ok: true,
      name: 'script-tag-present',
      detail: `${opens} inline <script> tag(s)`,
    });
  }

  // script-body-parses (each inline <script> body parses as JS)
  let scriptIdx = 0;
  const scripts: InlineScriptForLint[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    scriptIdx += 1;
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (body.length === 0) continue;
    if (/\bsrc\s*=/.test(attrs)) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (typeMatch) {
      const t = typeMatch[1]!.toLowerCase().trim();
      if (t !== 'text/javascript' && t !== 'application/javascript' && t !== 'module') {
        continue;
      }
    }
    const openIdx = m.index ?? 0;
    const openLine = (html.slice(0, openIdx).match(/\n/g)?.length ?? 0) + 1;
    scripts.push({ body, attrs, openLine });
    const parseError = isModuleScript(attrs)
      ? tryParseSource(body, ts.ScriptKind.JS)
      : tryParseFunctionBody(body);
    if (parseError) {
      // An unclosed comment/brace/template consumes the remainder of the
      // script, so every parser can only report end-of-input — which for
      // an inline script is the </script> line. Naming that line sends
      // the model to edit the one line that was correct.
      const unterminated = locateUnterminatedConstruct(body);
      if (unterminated) {
        const before = body.slice(0, unterminated.start);
        const newlines = before.match(/\n/g)?.length ?? 0;
        const fileLine = openLine + newlines;
        const col = newlines > 0 ? unterminated.start - before.lastIndexOf('\n') : undefined;
        checks.push({
          ok: false,
          name: scriptIdx === 1 ? 'script-body-parses' : `script-body-parses[${scriptIdx}]`,
          message: `unterminated ${unterminated.label} — it swallows the rest of the script, so nothing on the page runs`,
          location: { line: fileLine, ...(col ? { col } : {}) },
          excerpt: buildExcerpt(html, fileLine, 2),
          fixHint: `add the missing \`${unterminated.closer}\` where that construct should end. The defect is at line ${fileLine}, not at the end of the script — do not edit or remove the </script> tag.`,
        });
        return checks;
      }
      // V8's error message often includes "line N, col M"; pull it out
      // for a clean location field. Fall back to the script's opening
      // line if the parser didn't surface coordinates.
      const locMatch = parseError.match(/line (\d+)(?:.*?col(?:umn)?\s*(\d+))?/i);
      const scriptInternalLine = locMatch ? Number(locMatch[1]) : 1;
      const col = locMatch?.[2] ? Number(locMatch[2]) : undefined;
      const fileLine = openLine + scriptInternalLine - 1;
      checks.push({
        ok: false,
        name: scriptIdx === 1 ? 'script-body-parses' : `script-body-parses[${scriptIdx}]`,
        message: parseError.replace(/\s+at <anonymous>.*$/s, '').trim(),
        location: { line: fileLine, ...(col ? { col } : {}) },
        excerpt: buildExcerpt(html, fileLine, 2),
        fixHint:
          'fix the syntax error in the inline <script> body. If the script got cut off mid-statement, use `append_to_file` to send only the missing tail.',
      });
      return checks; // first parse error is the one to fix; subsequent are likely cascades
    }
  }
  if (scriptIdx > 0) {
    checks.push({
      ok: true,
      name: 'script-body-parses',
      detail: `${scriptIdx} inline script(s) parse cleanly`,
    });
    checks.push(validateUniqueTopLevelFunctions(scripts));
  }
  return checks;
}

function isModuleScript(attrs: string): boolean {
  return /\btype\s*=\s*["']module["']/i.test(attrs);
}

function validateHtmlDocumentStructure(html: string): ValidateCheck {
  const hasDocumentShell = /<!doctype\s+html\b/i.test(html) || /<html\b/i.test(html);
  if (!hasDocumentShell) {
    return { ok: true, name: 'document-structure', detail: 'HTML fragment' };
  }
  const missing: string[] = [];
  if (/<html\b/i.test(html) && !/<\/html\s*>/i.test(html)) missing.push('</html>');
  if (/<body\b/i.test(html) && !/<\/body\s*>/i.test(html)) missing.push('</body>');
  if (missing.length > 0) {
    return {
      ok: false,
      name: 'document-structure',
      message: `document is missing ${missing.join(' and ')}`,
      fixHint: 'restore the missing closing tag(s); the HTML document appears truncated.',
    };
  }
  return { ok: true, name: 'document-structure', detail: 'document shell closes cleanly' };
}

function validateUniqueHtmlIds(html: string): ValidateCheck {
  const withoutExecutableBodies = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    (match) => match.replace(/[^\n]/g, ' '),
  );
  const seen = new Map<string, number>();
  const idRe = /\bid\s*=\s*(["'])([^"']+)\1/gi;
  for (const match of withoutExecutableBodies.matchAll(idRe)) {
    const id = match[2]!;
    const line = (withoutExecutableBodies.slice(0, match.index).match(/\n/g)?.length ?? 0) + 1;
    const firstLine = seen.get(id);
    if (firstLine !== undefined) {
      return {
        ok: false,
        name: 'dom-ids-unique',
        message: `duplicate id="${id}" (first declared at line ${firstLine})`,
        location: { line },
        excerpt: buildExcerpt(html, line, 2),
        fixHint:
          'give each static DOM element a unique id and update matching JavaScript/CSS references.',
      };
    }
    seen.set(id, line);
  }
  return {
    ok: true,
    name: 'dom-ids-unique',
    detail: `${seen.size} static id${seen.size === 1 ? '' : 's'} checked`,
  };
}

function validateUniqueTopLevelFunctions(scripts: InlineScriptForLint[]): ValidateCheck {
  const seen = new Map<string, number>();
  let count = 0;
  for (const script of scripts) {
    const sf = ts.createSourceFile(
      'inline-script.js',
      script.body,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of sf.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
      count += 1;
      const relative = sf.getLineAndCharacterOfPosition(statement.name.getStart(sf));
      const line = script.openLine + relative.line;
      const name = statement.name.text;
      const firstLine = seen.get(name);
      if (firstLine !== undefined) {
        return {
          ok: false,
          name: 'top-level-functions-unique',
          message: `top-level function "${name}" is declared more than once (first declared at line ${firstLine}); the later declaration silently replaces the earlier one`,
          location: { line, col: relative.character + 1 },
          fixHint:
            'keep one implementation, merge the intended behavior into it, and remove the duplicate declaration.',
        };
      }
      seen.set(name, line);
    }
  }
  return {
    ok: true,
    name: 'top-level-functions-unique',
    detail: `${count} function declaration${count === 1 ? '' : 's'} checked`,
  };
}

function tryParseSource(source: string, scriptKind: ts.ScriptKind): string | null {
  const fileName = scriptKind === ts.ScriptKind.TSX ? 'source.tsx' : 'source.js';
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const diagnostics = output.diagnostics?.filter(
    (diagnostic): diagnostic is ts.DiagnosticWithLocation =>
      diagnostic.category === ts.DiagnosticCategory.Error &&
      diagnostic.file !== undefined &&
      diagnostic.start !== undefined,
  );
  if (!diagnostics || diagnostics.length === 0) return null;
  const first = diagnostics[0]!;
  const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
  const { line, character } = first.file.getLineAndCharacterOfPosition(first.start);
  return `${message} at line ${line + 1}, col ${character + 1}`;
}

function tryParseFunctionBody(body: string): string | null {
  try {
    new Function(body);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── JS / TS ──────────────────────────────────────────────────────

function validateJsTs(path: string, content: FileContent): ValidateCheck[] {
  if (!content.text) {
    return [{ ok: false, name: 'file-readable', message: 'could not read source as text' }];
  }
  const checks: ValidateCheck[] = [fileNonEmptyCheck(content)];
  const lower = path.toLowerCase();
  const scriptKind = lower.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : lower.endsWith('.ts')
      ? ts.ScriptKind.TS
      : lower.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(
    path,
    content.text,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ true,
    scriptKind,
  );
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] })
    .parseDiagnostics;
  if (!diags || diags.length === 0) {
    const nestedModuleSyntax = findNestedStaticModuleDeclaration(sf);
    if (nestedModuleSyntax) {
      const { line, character } = sf.getLineAndCharacterOfPosition(nestedModuleSyntax.getStart(sf));
      checks.push({
        ok: false,
        name: 'module-syntax',
        message: 'static import/export declarations are only valid at the top level of a module',
        location: { line: line + 1, col: character + 1 },
        excerpt: buildExcerpt(content.text, line + 1, 2),
        fixHint:
          'move this import/export to the top of the file, or use dynamic import(...) inside functions.',
      });
      return checks;
    }
    checks.push({
      ok: true,
      name: 'parses',
      detail: `${scriptKind === ts.ScriptKind.TS || scriptKind === ts.ScriptKind.TSX ? 'TypeScript' : 'JavaScript'} parses cleanly`,
    });
    return checks;
  }
  const first = diags[0]!;
  const msg = ts.flattenDiagnosticMessageText(first.messageText, '\n');
  const { line, character } = sf.getLineAndCharacterOfPosition(first.start);
  checks.push({
    ok: false,
    name: 'parses',
    message: msg,
    location: { line: line + 1, col: character + 1 },
    excerpt: buildExcerpt(content.text, line + 1, 2),
    fixHint:
      'fix the syntax error and re-emit. If the file was cut off mid-statement, use `append_to_file` to send only the missing tail.',
  });
  return checks;
}

function findNestedStaticModuleDeclaration(sf: ts.SourceFile): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportAssignment(node)) &&
      node.parent !== sf
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ── JSON ─────────────────────────────────────────────────────────

function validateJson(_path: string, content: FileContent): ValidateCheck[] {
  if (!content.text) {
    return [{ ok: false, name: 'file-readable', message: 'could not read JSON as text' }];
  }
  const checks: ValidateCheck[] = [fileNonEmptyCheck(content)];
  try {
    JSON.parse(content.text);
    checks.push({ ok: true, name: 'parses', detail: 'JSON parses cleanly' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Node's JSON.parse errors often include "at position N" — derive
    // a 1-based line/col by counting newlines up to position N.
    const posMatch = msg.match(/at position (\d+)/);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const before = content.text.slice(0, pos);
      const line = (before.match(/\n/g)?.length ?? 0) + 1;
      const lastNl = before.lastIndexOf('\n');
      const col = lastNl < 0 ? pos + 1 : pos - lastNl;
      checks.push({
        ok: false,
        name: 'parses',
        message: msg.replace(/\s+at position \d+/, ''),
        location: { line, col },
        excerpt: buildExcerpt(content.text, line, 2),
      });
    } else {
      checks.push({ ok: false, name: 'parses', message: msg });
    }
  }
  return checks;
}

// ── Images ───────────────────────────────────────────────────────

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG_MAGIC = [0xff, 0xd8, 0xff];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_VP8 = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];

function bytesMatch(actual: Uint8Array, expected: number[], offset = 0): boolean {
  if (actual.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[offset + i] !== expected[i]) return false;
  }
  return true;
}

function hexHead(bytes: Uint8Array, n = 8): string {
  const slice = bytes.slice(0, n);
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

const BINARY_ROUND_TRIP_HINT =
  'binary content was likely corrupted by `write_file` (which round-trips through a JSON string and breaks non-UTF-8 bytes). Use `copy_artifact_to_workspace` instead to move generated images from the artifacts drawer.';

function validateImage(path: string, content: FileContent): ValidateCheck[] {
  const lower = path.toLowerCase();
  const checks: ValidateCheck[] = [];

  // file-non-empty + bytes-min
  if (content.totalBytes === 0) {
    checks.push({
      ok: false,
      name: 'file-non-empty',
      message: 'file is empty (0 bytes)',
      fixHint: BINARY_ROUND_TRIP_HINT,
    });
    return checks;
  }
  checks.push({ ok: true, name: 'file-non-empty', detail: `${content.totalBytes} bytes` });

  // bytes-min: real raster images aren't tiny. SVGs ARE often tiny
  // (a 60-byte single-shape SVG is completely valid), so skip this
  // check for them — the svg-header check below catches the actual
  // failure mode for text-shaped image files.
  if (!lower.endsWith('.svg')) {
    if (content.totalBytes < 100) {
      checks.push({
        ok: false,
        name: 'bytes-min',
        message: `${content.totalBytes} bytes — too small to be a real image (≥ 100 bytes expected)`,
        fixHint: BINARY_ROUND_TRIP_HINT,
      });
    } else {
      checks.push({ ok: true, name: 'bytes-min', detail: `${content.totalBytes} bytes ≥ 100` });
    }
  }

  // magic-bytes (only checks if we have bytes to look at)
  if (!content.bytes) {
    checks.push({
      ok: false,
      name: 'magic-bytes',
      message: 'image bytes not available to validate header',
      fixHint: 'caller did not provide binary content; this check requires the raw bytes.',
    });
    return checks;
  }

  if (lower.endsWith('.svg')) {
    // SVG is text, not binary; just check it parses as XML-ish.
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(content.bytes.slice(0, 256))
      .trimStart();
    if (head.startsWith('<?xml') || head.startsWith('<svg')) {
      checks.push({ ok: true, name: 'svg-header', detail: 'starts with <?xml or <svg' });
    } else {
      checks.push({
        ok: false,
        name: 'svg-header',
        message: `SVG should start with <?xml or <svg, got: "${head.slice(0, 40)}"`,
        fixHint: BINARY_ROUND_TRIP_HINT,
      });
    }
    return checks;
  }

  let expected: number[];
  let label: string;
  let pass = false;
  if (lower.endsWith('.png')) {
    expected = PNG_MAGIC;
    label = 'PNG';
    pass = bytesMatch(content.bytes, PNG_MAGIC);
  } else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    expected = JPG_MAGIC;
    label = 'JPEG';
    pass = bytesMatch(content.bytes, JPG_MAGIC);
  } else if (lower.endsWith('.webp')) {
    expected = WEBP_RIFF;
    label = 'WebP';
    pass = bytesMatch(content.bytes, WEBP_RIFF) && bytesMatch(content.bytes, WEBP_VP8, 8);
  } else if (lower.endsWith('.gif')) {
    expected = GIF_MAGIC;
    label = 'GIF';
    pass = bytesMatch(content.bytes, GIF_MAGIC);
  } else {
    checks.push({ ok: true, name: 'magic-bytes', detail: 'no validator registered for extension' });
    return checks;
  }

  if (pass) {
    checks.push({
      ok: true,
      name: 'magic-bytes',
      detail: `valid ${label} header`,
    });
  } else {
    const expectedHex = expected.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    checks.push({
      ok: false,
      name: 'magic-bytes',
      message: `not a valid ${label} header. First ${expected.length} bytes: ${hexHead(content.bytes, expected.length)} (expected: ${expectedHex})`,
      fixHint: BINARY_ROUND_TRIP_HINT,
    });
  }
  return checks;
}
