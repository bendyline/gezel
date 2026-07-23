/**
 * HTML deliverable checks: truncation detection, inline-script
 * extraction, V8 syntax validation, and the two content sniffs the
 * craftbook runtime uses (`html-complete`, `html-game`).
 *
 * Ported from evals/src/html-validation.ts and the service's
 * chat/step-sniff.ts so all three consumers share one implementation —
 * including the wild-caught failure modes documented inline.
 */

/**
 * Minimum inline JS bytes for an "interactive game" page to count as
 * non-skeleton. matrix calibration: a tight tic-tac-toe game
 * (state, win-detect, click handler, reset) fits cleanly in ~2.5 KB; 4 KB
 * rejected real working games; 2 KB rejects skeletons while letting
 * tight implementations through.
 */
export const MIN_INLINE_JS_BYTES = 2048;

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
// Open-only `<script>` detector — flags "script started but never
// closed" specifically (the dominant local-model truncation pattern:
// the model emits `<script>\nconst game = …` and runs out of output
// budget before `</script>` arrives).
const SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;

/**
 * Count `<script>` openers vs `</script>` closers. When closers <
 * openers the document was truncated mid-script and inline-JS
 * extraction silently dropped a real body.
 */
export function detectUnclosedScript(html: string): {
  opens: number;
  closes: number;
  unclosed: boolean;
} {
  const opens = (html.match(SCRIPT_OPEN_RE) ?? []).length;
  const closes = (html.match(SCRIPT_CLOSE_RE) ?? []).length;
  return { opens, closes, unclosed: opens > closes };
}

export interface InlineScript {
  /** The raw inline JS body (between `<script>` open and close). */
  body: string;
  /** Attribute string after the `<script` tag name (e.g. `type="module"`). */
  attrs: string;
}

/**
 * Every inline `<script>` body in document order. External scripts
 * (`src=`) and non-JS types (JSON-LD etc.) are skipped.
 */
export function extractInlineScripts(html: string): InlineScript[] {
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
    out.push({ body, attrs });
  }
  return out;
}

export interface ScriptValidation {
  /** Sum of `body.length` across all inline non-empty scripts. */
  totalBytes: number;
  /** True iff every script body parses without SyntaxError. */
  allParse: boolean;
  /** Per-script parse status. */
  perScript: Array<{ bytes: number; parses: boolean; error?: string }>;
  /** First parse error encountered, for the failure line. */
  firstError?: string;
}

/**
 * Try-parse each script body via `new Function(body)` — V8's parser.
 * `type="module"` scripts skip the parse (top-level `import` fails under
 * the function-body parser) but still count toward size; a genuinely
 * broken module fails at the runtime-render layer instead.
 */
export function validateScriptSyntax(scripts: ReadonlyArray<InlineScript>): ScriptValidation {
  const perScript: ScriptValidation['perScript'] = [];
  let totalBytes = 0;
  let allParse = true;
  let firstError: string | undefined;
  for (const s of scripts) {
    const bytes = s.body.length;
    totalBytes += bytes;
    if (bytes === 0) {
      perScript.push({ bytes: 0, parses: true });
      continue;
    }
    const isModule = /\btype\s*=\s*["']module["']/i.test(s.attrs);
    if (isModule) {
      perScript.push({ bytes, parses: true });
      continue;
    }
    try {
      new Function(s.body);
      perScript.push({ bytes, parses: true });
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      // When the body carries TypeScript-only syntax, the raw parser error
      // ("missing ) after argument list") sends the model hunting for a
      // bracket that isn't the problem — it rewrites the same TS-flavored
      // code until the retry loop kills the task. Name the actual mistake
      // so one revision fixes it. Wild-caught (gemma4-31b,
      // both quants): `this.radius!` non-null assertions in a plain
      // <script>, three identical re-writes, trial dead.
      const tsism = detectTypeScriptOnlySyntax(s.body);
      if (tsism) {
        message = `${message} — the script uses TypeScript-only syntax (${tsism}) which browsers cannot parse; rewrite the inline <script> as plain JavaScript (no type annotations, no \`!\` assertions, no \`as\` casts)`;
      }
      perScript.push({ bytes, parses: false, error: message });
      allParse = false;
      if (firstError === undefined) firstError = message;
    }
  }
  return {
    totalBytes,
    allParse,
    perScript,
    ...(firstError !== undefined ? { firstError } : {}),
  };
}

/**
 * Conservative sniff for TypeScript-only constructs inside a script that
 * already FAILED to parse as JavaScript. Only patterns that are never
 * valid JS: postfix non-null assertions, `as` casts before a delimiter,
 * parameter/property type annotations with a following identifier-ish
 * type, and `interface`/`enum` declarations. Returns a short description
 * of the first construct found (with an excerpt), or null.
 */
export function detectTypeScriptOnlySyntax(body: string): string | null {
  const probes: Array<[RegExp, string]> = [
    [/\w[)\]]?!(?=\s*[,);.\]])/, 'a postfix `!` non-null assertion'],
    [/\)\s*as\s+[A-Z]\w*/, 'an `as Type` cast'],
    [/\b(?:private|public|readonly)\s+\w+\s*[:=]/, 'a class property modifier'],
    [/^\s*(?:export\s+)?(?:interface|enum)\s+\w+/m, 'an `interface`/`enum` declaration'],
    [/\(\s*\w+\s*:\s*(?:string|number|boolean|any|\w+\[\])\s*[,)]/, 'a parameter type annotation'],
  ];
  for (const [re, label] of probes) {
    const m = body.match(re);
    if (m) return `${label}, e.g. \`${m[0].trim().slice(0, 40)}\``;
  }
  return null;
}

/** Total trimmed bytes of inline `<script>` bodies. */
export function inlineJsBytes(html: string): number {
  let total = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    total += (m[2] ?? '').trim().length;
  }
  return total;
}

/**
 * Generic "this HTML file isn't truncated": balanced `<script>` tags
 * (the truncation failure mode is an open `<script>` with no closer)
 * AND a closing `</body>` or `</html>`.
 */
export function htmlCompleteSniff(html: string): boolean {
  const lower = html.toLowerCase();
  const opens = (lower.match(/<script\b/g) ?? []).length;
  const closes = (lower.match(/<\/script>/g) ?? []).length;
  const scriptsBalanced = opens === closes;
  const closedDoc = lower.includes('</body>') || lower.includes('</html>');
  return scriptsBalanced && closedDoc;
}

/**
 * "Plausibly a real browser game": a game *surface*, at least one CLOSED
 * script, and non-trivial inline JS (default floor 400 bytes —
 * `advanceWhen.minBytes` guards total size separately).
 *
 * A "surface" is a canvas/SVG render target OR a real animation/tick loop
 * (`requestAnimationFrame`, `setInterval`/`setTimeout`, or a conventional
 * frame function). The loop branch matters: plenty of legitimate games —
 * board games, multi-screen arcade games, anything that animates by
 * mutating the DOM each frame — never touch `<canvas>`. Requiring a
 * canvas held 2 of 3 genuinely-passing DOM arcade games at the build gate
 * gate-liveness run, while the eval grader (which
 * treats render-surface as one optional signal of six) passed all three.
 * The gate must agree with the grader on what "is a game" means — canvas
 * is one way to be a game, not the definition. The closed-script +
 * substantial-JS floors still exclude static pages and truncated stubs.
 */
export function htmlGameSniff(html: string, minJsBytes = 400): boolean {
  const lower = html.toLowerCase();
  const hasRenderTarget = /<canvas\b/.test(lower) || /<svg\b/.test(lower);
  const hasFrameLoop =
    /requestanimationframe\s*\(/.test(lower) ||
    /set(?:interval|timeout)\s*\(/.test(lower) ||
    /\bfunction\s+(?:tick|update|loop|gameloop|gametick|step|render|frame)\b/.test(lower);
  const hasSurface = hasRenderTarget || hasFrameLoop;
  const opens = (lower.match(/<script\b/g) ?? []).length;
  const closes = (lower.match(/<\/script>/g) ?? []).length;
  const scriptClosed = opens > 0 && opens === closes;
  const jsSubstantial = inlineJsBytes(html) >= minJsBytes;
  return hasSurface && scriptClosed && jsSubstantial;
}
