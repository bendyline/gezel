/**
 * Source-syntax validation for `write_file` / `append_to_file` / `write_artifact`.
 *
 * The gemma4-e4b matrix surfaced a class of failure where the
 * model emits a 4 KB HTML page whose inline `<script>` block has a single
 * truncation bug (missing closing brace, dangling `for` keyword) — the
 * file is otherwise complete and the page would render, but the JS
 * doesn't run. The model gets no signal: `write_file` returns success,
 * the trial timer ticks, the eventual sniff finds the broken JS, the
 * trial fails. By the time the model could re-investigate, the turn
 * budget is gone.
 *
 * Returning a parse error from `write_file` as a tool error fixes that
 * loop. It's the same shape a compiler would give: "your code didn't
 * compile, here's the line." The model can then re-emit the file with
 * the fix in the next turn.
 *
 * We validate two file shapes:
 *
 *   - **HTML** (`.html`, `.htm`): extract inline `<script>` bodies and
 *     parse each with `new Function(body)` — V8's syntax checker.
 *     Module-typed scripts (`type="module"`) are skipped because
 *     top-level `import`/`export` is rejected by the function-body
 *     parser; they count toward presence but not parse-strictness.
 *
 *   - **JS / TS** (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`):
 *     parse with `ts.createSourceFile`. The TypeScript compiler API
 *     handles all of those extensions uniformly and reports syntax
 *     errors via `parseDiagnostics`. We intentionally do NOT type-check
 *     — that needs resolved imports and is way out of scope for a
 *     per-write fast-fail. We just want "is the structure parseable?"
 *
 * Everything else (`.css`, `.json`, `.md`, binary, …) is unvalidated.
 * Returning `null` means "I have no opinion, write it."
 *
 * Design notes:
 *
 *   - **Block overwrites** on validation failure. The point is to give
 *     the model the same signal a compiler would while preserving the
 *     previous on-disk content as the last-known-good.
 *   - **Persist first-write HTML drafts** for recoverable failures.
 *     Local models often spend an entire turn emitting a near-complete
 *     page, then need the file on disk so they can read, append, or
 *     surgically repair it instead of starting over.
 *   - **No `force` flag in v1.** If a model legitimately wants to stage
 *     a stub that doesn't yet parse, it can use `write_artifact` (which
 *     skips syntax validation for non-shipping material) or wrap the
 *     incomplete bit in `/* TODO * /` etc. We'll add an override if real
 *     scenarios demand it.
 *   - **Validation runs after the merge** for `append_to_file`, against
 *     the merged file body — the model's append might tail-complete a
 *     prior truncation OR break it further; both cases need the check.
 */

import ts from 'typescript';

export interface SourceValidationOk {
  ok: true;
}

export interface SourceValidationError {
  ok: false;
  /** Short human-friendly summary suitable for the tool-error text. */
  message: string;
  /**
   * Some HTML failures still produce a useful first draft. In that case
   * a first write needs to land the invalid file or the recovery path is
   * impossible; overwrites still preserve the last-known-good file.
   */
  recoverablePartialWrite?: 'truncated-html' | 'invalid-html';
}

export type SourceValidationResult = SourceValidationOk | SourceValidationError;

/**
 * Dispatch on file extension. Returns `null` when the file shape isn't
 * one we validate — caller proceeds with the write.
 *
 * `path` should be the path the tool received (relative to project
 * root). Only the extension is examined; the path is also used in
 * error messages so the model knows which file failed.
 */
export function validateSourceContent(
  path: string,
  content: string,
): SourceValidationResult | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return validateHtmlInlineScripts(path, content);
  }
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx')
  ) {
    return validateJsTsSource(path, content);
  }
  return null;
}

interface InlineScript {
  body: string;
  attrs: string;
  /** 1-based line where the opening tag begins, for error messages. */
  openLine: number;
  /** Absolute char offset of the body start within the HTML, for locating parse errors. */
  bodyStart: number;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;

/**
 * HTML validator — extracts inline scripts and parses each. Also
 * detects "started a `<script>` but never closed it" since that's the
 * dominant truncation pattern for local models (run out of output
 * budget mid-stream).
 */
function validateHtmlInlineScripts(path: string, html: string): SourceValidationResult {
  const opens = (html.match(SCRIPT_OPEN_RE) ?? []).length;
  const closes = (html.match(SCRIPT_CLOSE_RE) ?? []).length;
  if (opens > closes) {
    return {
      ok: false,
      message: `${path}: HTML has ${opens} <script> opening tag(s) but only ${closes} </script> closing tag(s). The script block is unterminated — the file is truncated. Re-emit the full file with a matching </script> close, or use \`append_to_file\` to send just the missing tail starting from where the previous write cut off.`,
      recoverablePartialWrite: 'truncated-html',
    };
  }

  const scripts = extractInlineScripts(html);
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i]!;
    if (s.body.length === 0) continue;
    if (isModuleScript(s.attrs)) continue;
    const parseError = tryParseFunctionBody(s.body);
    if (parseError) {
      const unterminated = locateUnterminatedConstruct(s.body);
      if (unterminated) {
        const at = lineColAt(html, s.bodyStart + unterminated.start);
        return {
          ok: false,
          message: `${path}: inline <script> #${i + 1} opens a ${unterminated.label} at line ${at.line}, col ${at.col} and never closes it, so the rest of the script is swallowed and nothing runs. Add the missing \`${unterminated.closer}\` where that construct should end. The defect is at line ${at.line} — do not edit the last line of the script or the </script> tag, which are correct.`,
          recoverablePartialWrite: 'invalid-html',
        };
      }
      const loc = locateInlineScriptError(html, s.bodyStart, s.body);
      const where = loc ? `at line ${loc.line}, col ${loc.col}` : `(opens near line ${s.openLine})`;
      return {
        ok: false,
        message: `${path}: inline <script> #${i + 1} ${where} failed to parse: ${parseError}. Fix the syntax error at that location and re-emit the file. If the script was truncated mid-statement, you can use \`append_to_file\` to send only the missing tail.`,
        recoverablePartialWrite: 'invalid-html',
      };
    }
  }
  return { ok: true };
}

function isModuleScript(attrs: string): boolean {
  return /\btype\s*=\s*["']module["']/i.test(attrs);
}

function extractInlineScripts(html: string): InlineScript[] {
  const out: InlineScript[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
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
    const bodyStart = openIdx + (m[0]!.indexOf('>') + 1);
    out.push({ body, attrs, openLine, bodyStart });
  }
  return out;
}

function tryParseFunctionBody(body: string): string | null {
  try {
    new Function(body);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** An opened-but-never-closed construct that swallowed the rest of the source. */
export interface UnterminatedConstruct {
  /** Offset within the parsed body where the construct opens. */
  start: number;
  /** What is unclosed, phrased for the model. */
  label: string;
  /** The token that would close it. */
  closer: string;
}

const DIAG_BLOCK_COMMENT_UNCLOSED = 1010;
const DIAG_TEMPLATE_UNTERMINATED = 1160;
const DIAG_TOKEN_EXPECTED = 1005;

/**
 * Find where an unterminated construct *opens*, when the parser could
 * only report that it ran out of input.
 *
 * This exists because the naive "report the first parse diagnostic"
 * answer is actively harmful for this failure class. An unclosed `/*`,
 * backtick, or brace consumes everything after it, so the parser has
 * nothing to object to until end-of-input — and for an inline script
 * that offset lands on the `</script>` line. A gezel told "fix the
 * syntax error at line N" then edits line N, which is the one line that
 * was correct. Wild-caught on the vampire-survivors session: the model
 * was pointed at `</script>`, deleted it, and turned an unterminated
 * comment into an unterminated script block.
 *
 * Returns null when the first diagnostic already points inside the
 * source — those positions are meaningful and the caller should use
 * them unchanged.
 */
export function locateUnterminatedConstruct(
  body: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.JS,
): UnterminatedConstruct | null {
  const sf = parseFor(body, scriptKind);
  const first = parseDiagnosticsOf(sf)?.[0];
  if (!first || first.start == null) return null;
  if (first.start < body.trimEnd().length) return null;

  if (first.code === DIAG_BLOCK_COMMENT_UNCLOSED) {
    const start = locateTrailingBlockComment(body, scriptKind);
    if (start !== null) return { start, label: 'block comment', closer: '*/' };
  }

  const closer = closerForDiagnostic(first);
  if (!closer) return null;

  // TypeScript points at the matching opener itself for unbalanced
  // braces, which is exact and cheaper than re-parsing.
  const relatedStart = first.relatedInformation?.[0]?.start;
  if (typeof relatedStart === 'number') {
    return { start: relatedStart, label: labelForCloser(closer), closer };
  }

  const start = locateNodeSpanningEnd(body, closer, scriptKind);
  return start === null ? null : { start, label: labelForCloser(closer), closer };
}

function parseFor(source: string, scriptKind: ts.ScriptKind): ts.SourceFile {
  const ext =
    scriptKind === ts.ScriptKind.TSX
      ? 'tsx'
      : scriptKind === ts.ScriptKind.TS
        ? 'ts'
        : scriptKind === ts.ScriptKind.JSX
          ? 'jsx'
          : 'js';
  return ts.createSourceFile(
    `unterminated-probe.${ext}`,
    source,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ false,
    scriptKind,
  );
}

function parseDiagnosticsOf(sf: ts.SourceFile): ts.DiagnosticWithLocation[] | undefined {
  return (sf as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] })
    .parseDiagnostics;
}

function closerForDiagnostic(diag: ts.DiagnosticWithLocation): string | null {
  if (diag.code === DIAG_BLOCK_COMMENT_UNCLOSED) return '*/';
  if (diag.code === DIAG_TEMPLATE_UNTERMINATED) return '`';
  if (diag.code === DIAG_TOKEN_EXPECTED) {
    const text = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
    const quoted = /^'(.{1,2})' expected/.exec(text);
    const token = quoted?.[1];
    return token && ['}', ')', ']'].includes(token) ? token : null;
  }
  return null;
}

function labelForCloser(closer: string): string {
  switch (closer) {
    case '*/':
      return 'block comment';
    case '`':
      return 'template literal';
    case '}':
      return '{ ... } block';
    case ')':
      return '( ... ) group';
    case ']':
      return '[ ... ] list';
    default:
      return 'construct';
  }
}

/**
 * Close the comment, re-parse, and read back the comment range that now
 * ends at EOF. Hand-scanning for the last `/*` would mis-fire on one
 * inside a string or template, and TypeScript's raw scanner desyncs on
 * template literals without parser cooperation.
 */
function locateTrailingBlockComment(body: string, scriptKind: ts.ScriptKind): number | null {
  const repaired = `${body}*/`;
  const sf = parseFor(repaired, scriptKind);
  const ranges = ts.getLeadingCommentRanges(repaired, sf.endOfFileToken.pos) ?? [];
  const trailing = ranges.find((r) => r.end === repaired.length);
  return trailing ? trailing.pos : null;
}

/**
 * Append the missing closer and find the innermost node that then spans
 * to EOF — its start is where the construct opened.
 */
function locateNodeSpanningEnd(
  body: string,
  closer: string,
  scriptKind: ts.ScriptKind,
): number | null {
  const repaired = `${body}${closer}`;
  const sf = parseFor(repaired, scriptKind);
  let best: number | null = null;
  const visit = (node: ts.Node): void => {
    const start = node.getStart(sf);
    if (node.end === repaired.length && start < repaired.length) {
      if (best === null || start > best) best = start;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return best;
}

/**
 * Locate the first syntax error in an inline-script body and translate
 * its position to absolute line/col in the surrounding HTML file, so the
 * tool-error names the exact line the model should edit. `new Function`
 * (the gate above) reports *whether* the body parses but not *where* it
 * broke — its message is a bare "Unexpected token ')'" with no position,
 * which forces a weak model to eyeball the whole script. The TypeScript
 * parser gives a position; we offset it by the body's start in the HTML.
 * Returns null when the parser produces no locatable diagnostic — the
 * caller then falls back to the script's opening line.
 */
function locateInlineScriptError(
  html: string,
  bodyStart: number,
  body: string,
): { line: number; col: number } | null {
  const sf = ts.createSourceFile(
    'inline-script.js',
    body,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ false,
    ts.ScriptKind.JS,
  );
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] })
    .parseDiagnostics;
  if (!diags || diags.length === 0 || diags[0]!.start == null) return null;
  return lineColAt(html, bodyStart + diags[0]!.start);
}

/** 1-based line/col of an absolute character offset within `text`. */
function lineColAt(text: string, pos: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * JS/TS validator — parse with TypeScript's `createSourceFile` and
 * report on `parseDiagnostics`. Uses the right `ScriptKind` per
 * extension so JSX/TSX are accepted.
 *
 * `parseDiagnostics` only contains syntactic problems — missing
 * semicolons after a class member, unterminated strings, mismatched
 * braces, etc. Type errors (`Property 'foo' does not exist`) live in
 * `getSemanticDiagnostics` which we deliberately do not run.
 */
function validateJsTsSource(path: string, source: string): SourceValidationResult {
  const lower = path.toLowerCase();
  const isTypeScriptFile = lower.endsWith('.ts') || lower.endsWith('.tsx');
  const scriptKind = lower.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : lower.endsWith('.ts')
      ? ts.ScriptKind.TS
      : lower.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ true,
    scriptKind,
  );
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] })
    .parseDiagnostics;
  if (diags && diags.length > 0) {
    const unterminated = locateUnterminatedConstruct(source, scriptKind);
    if (unterminated) {
      const { line, character } = sf.getLineAndCharacterOfPosition(unterminated.start);
      return {
        ok: false,
        message: `${path}: opens a ${unterminated.label} at line ${line + 1}, col ${character + 1} and never closes it, so everything after it is swallowed. Add the missing \`${unterminated.closer}\` where that construct should end. The defect is at line ${line + 1}, not at the end of the file.${atomicSourceWriteRejectionRecovery(path)}`,
      };
    }
    return formatSourceDiagnostic(path, sf, diags[0]!);
  }
  const nestedModuleSyntax = findNestedStaticModuleDeclaration(sf);
  if (nestedModuleSyntax) {
    const { line, character } = sf.getLineAndCharacterOfPosition(nestedModuleSyntax.getStart(sf));
    return {
      ok: false,
      message: `${path}: module syntax error at line ${line + 1}, col ${character + 1}: static import/export declarations are only valid at the top level of a module. Move this import/export to the top of the file, or use dynamic import(...) inside functions.${atomicSourceWriteRejectionRecovery(path)}`,
    };
  }
  if (!isTypeScriptFile) {
    const tsOnly = findTypeScriptOnlySyntax(sf);
    if (tsOnly) {
      const { line, character } = sf.getLineAndCharacterOfPosition(tsOnly.node.getStart(sf));
      return {
        ok: false,
        message: `${path}: TypeScript-only syntax (${tsOnly.description}) at line ${line + 1}, col ${character + 1}. This file is JavaScript, so remove the type syntax or use a .ts/.tsx file.${atomicSourceWriteRejectionRecovery(path)}`,
      };
    }
  }
  return { ok: true };
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

function formatSourceDiagnostic(
  path: string,
  sf: ts.SourceFile,
  first: ts.DiagnosticWithLocation,
): SourceValidationError {
  const msg = ts.flattenDiagnosticMessageText(first.messageText, '\n');
  const { line, character } = sf.getLineAndCharacterOfPosition(first.start);
  return {
    ok: false,
    message: `${path}: syntax error at line ${line + 1}, col ${character + 1}: ${msg}.${atomicSourceWriteRejectionRecovery(path)}`,
  };
}

function atomicSourceWriteRejectionRecovery(path: string): string {
  return ` This write is rejected atomically; no bytes from this call were persisted. THE FILE WAS NOT WRITTEN by this call. Fix the syntax error and call \`write_file\` again with the complete corrected contents for \`${path}\`. Do not use \`append_to_file\`, \`replace_in_file\`, or \`replace_lines\` against this rejected draft.`;
}

function findTypeScriptOnlySyntax(
  sf: ts.SourceFile,
): { node: ts.Node; description: string } | null {
  let found: { node: ts.Node; description: string } | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const description = describeTypeScriptOnlyNode(node);
    if (description) {
      found = { node, description };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function describeTypeScriptOnlyNode(node: ts.Node): string | null {
  if (ts.isNonNullExpression(node)) return 'non-null assertion';
  if (ts.isAsExpression(node)) return 'type assertion';
  if (ts.isTypeAssertionExpression(node)) return 'type assertion';
  if (ts.isSatisfiesExpression(node)) return 'satisfies expression';
  if (ts.isInterfaceDeclaration(node)) return 'interface declaration';
  if (ts.isTypeAliasDeclaration(node)) return 'type alias';
  if (ts.isEnumDeclaration(node)) return 'enum declaration';
  if (ts.isModuleDeclaration(node)) return 'namespace/module declaration';
  if (ts.isImportClause(node) && node.isTypeOnly) return 'type-only import';
  if (ts.isImportSpecifier(node) && node.isTypeOnly) return 'type-only import';
  if (ts.isExportSpecifier(node) && node.isTypeOnly) return 'type-only export';
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return 'type-only export';

  if (hasTypeAnnotation(node)) return 'type annotation';
  if (hasTypeParameters(node)) return 'type parameters';
  if (hasTypeOnlyModifier(node)) return 'TypeScript modifier';
  return null;
}

function hasTypeAnnotation(node: ts.Node): boolean {
  if (!('type' in node)) return false;
  const type = (node as ts.Node & { type?: unknown }).type;
  return !!type && typeof type === 'object' && ts.isTypeNode(type as ts.Node);
}

function hasTypeParameters(node: ts.Node): boolean {
  return (
    'typeParameters' in node &&
    Array.isArray((node as ts.Node & { typeParameters?: unknown }).typeParameters) &&
    ((node as ts.Node & { typeParameters?: unknown[] }).typeParameters?.length ?? 0) > 0
  );
}

function hasTypeOnlyModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some((modifier) =>
      [
        ts.SyntaxKind.AbstractKeyword,
        ts.SyntaxKind.DeclareKeyword,
        ts.SyntaxKind.OverrideKeyword,
        ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword,
        ts.SyntaxKind.PublicKeyword,
        ts.SyntaxKind.ReadonlyKeyword,
      ].includes(modifier.kind),
    ) ?? false
  );
}
