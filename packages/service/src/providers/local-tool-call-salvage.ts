/**
 * Tool-call salvage helpers shared across local providers (MLX,
 * llama.cpp, Ollama). Two failure modes covered:
 *
 *   1. **Gemma marker leaks** (mlx-vlm specific). mlx_vlm.server's
 *      chat-template parser only recognizes the canonical
 *      `<|tool_call|>...<tool_call|>` form. Tighter quants of Gemma 4
 *      sometimes emit slight variants (missing pipes, etc.) that
 *      bypass the parser — the structured `tool_calls` event never
 *      fires and the tool never runs. `parseGemmaToolCall` decodes a
 *      body extracted by the `LeakyToolCallStripper` (also
 *      MLX-specific) into a real `{name, arguments}` shape.
 *
 *   2. **Prose-shaped calls** (universal). Small models on any local
 *      engine sometimes treat tool-call emission as a *display*
 *      affordance: they put the call in a markdown code block —
 *      `create_project({ name: "X" })` — instead of issuing a real
 *      function call. Nothing in the structured stream fires, the
 *      user sees the call rendered as decoration, and nothing
 *      happens. `parseProseToolCall` salvages those.
 *
 * Both helpers are deliberately strict: name must lex as an
 * identifier AND be in the caller-provided known-tools set; args
 * must parse to a plain object. Anything else returns null — the
 * caller falls back to the standard "no tool call this turn" path
 * rather than risk silently invoking a fabricated function.
 *
 * The Gemma body format (close-quote shown as `END` so the example
 * doesn't terminate this comment prematurely):
 *
 *   call:NAME{key:<|"|>value END, key2:42}
 *
 * where `<|"|>` is Gemma's special token for the open quote and the
 * close-quote-end-of-string token (the literal star-slash sequence)
 * is the close-quote token.
 */

export interface ParsedGemmaToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Map a small-model tool name to its canonical form when the difference
 * is purely punctuation/case — `createtask` → `create_task`, `getProject`
 * → `get_project`, `LIST_TASKS` → `list_tasks`. Returns the canonical
 * known-tool name, or `null` if no normalize-equivalent match exists.
 *
 * The normalization (lowercase + strip non-alphanumerics) is the same
 * one {@link findClosestToolName} uses, but the comparison is exact —
 * we do NOT alias near-misses. Typos like `geet_project → get_project`
 * still fall through to the explicit "did you mean…?" retry path; those
 * are too risky to fire silently because we'd be picking a tool the
 * model didn't quite ask for. Punctuation/case alone is unambiguous.
 *
 * Empty / whitespace-only input returns null. Direct hits in
 * `knownToolNames` short-circuit so the common path is one Set lookup.
 */
export function resolveToolNameAlias(
  name: string,
  knownToolNames: ReadonlySet<string>,
): string | null {
  if (knownToolNames.has(name)) return name;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wantedNorm = normalize(name);
  if (!wantedNorm) return null;
  for (const candidate of knownToolNames) {
    if (normalize(candidate) === wantedNorm) return candidate;
  }
  return null;
}

/**
 * Parse Gemma 4's NATIVE chat-template tool-call format directly,
 * without going through a JSON.parse rehab pass.
 *
 * Per gemma4-26b's `chat_template.jinja`, an emitted tool call is:
 *
 *     <|tool_call>call:NAME{key1:VALUE1,key2:VALUE2,...}<tool_call|>
 *
 * Where:
 *   - keys are bare identifiers (no quotes) when `escape_keys=False`
 *     (the template default for tool-call args).
 *   - string values are wrapped in the `<|"|>` special-token pair —
 *     literal sequences in the model's output, NOT generic `"` quotes.
 *   - mapping values are `{key:value,...}` (recursive).
 *   - sequence values are `[item,item,...]`.
 *   - booleans/numbers are bare.
 *
 * Critically: string content between `<|"|>...<|"|>` can contain raw
 * newlines, `"`, `\`, and any other character — the format relies on
 * the `<|"|>` delimiter pair, NOT JSON's escape mechanism. That's why
 * the older `parseGemmaToolCall` (which strips `<|"|>`→`"` then runs
 * JSON.parse) reliably fails on multi-line markdown content:
 * unescaped quotes/newlines inside the converted string break the
 * JSON. This parser walks the body char-by-char treating `<|"|>` as
 * the string delimiter, sidestepping JSON entirely.
 *
 * Strict gating: name must lex as an identifier AND be in the
 * caller-provided `knownToolNames` set (after alias resolution).
 * Anything else → null and the caller falls back to the retry-nudge
 * path. Captured by eval gemma4-26b/mlx: the model emits this exact
 * format when asked to write file contents and our salvage chain was
 * dropping it because no parser recognized the shape.
 */
export function parseGemmaNativeToolCall(
  body: string,
  knownToolNames: ReadonlySet<string>,
): ParsedGemmaToolCall | null {
  const text = body.trim();
  // Strip optional `<|tool_call>...<tool_call|>` envelope.
  const inner = text.replace(/^<\|tool_call>\s*/i, '').replace(/\s*<tool_call\|>\s*$/i, '');
  // Envelope: `call:NAME{...}` or `NAME{...}`. Accepts `-` in name for
  // the same reason `parseGemmaToolCall` does (alias resolver
  // normalizes punctuation).
  const m = inner.match(/^\s*(?:call\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\{/);
  if (!m) return null;
  const rawName = m[1]!;
  const name = resolveToolNameAlias(rawName, knownToolNames);
  if (!name) return null;

  const braceStart = inner.indexOf('{', m[0]!.length - 1);
  if (braceStart === -1) return null;
  const parser = new GemmaNativeBodyParser(inner, braceStart);
  const args = parser.readValue();
  if (!isPlainObject(args)) return null;
  return { name, arguments: args };
}

export interface GemmaNativeToolCallSpan extends ParsedGemmaToolCall {
  matchStart: number;
  matchEnd: number;
}

const GEMMA_NATIVE_TOOL_CALL_ENVELOPE_RE = /<\|tool_call>\s*[\s\S]*?<tool_call\|>/gi;

/**
 * Find Gemma 4's native `call:name{...}` tool-call format when the
 * model leaks it as visible text instead of a structured tool call.
 * The parser handles the args; this wrapper adds source spans so
 * providers can strip the raw marker after promoting it.
 */
export function findGemmaNativeToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): GemmaNativeToolCallSpan[] {
  if (!text || knownToolNames.size === 0) return [];
  const out: GemmaNativeToolCallSpan[] = [];
  for (const m of text.matchAll(GEMMA_NATIVE_TOOL_CALL_ENVELOPE_RE)) {
    const raw = m[0]!;
    const parsed = parseGemmaNativeToolCall(raw, knownToolNames);
    if (!parsed) continue;
    out.push({
      ...parsed,
      matchStart: m.index ?? 0,
      matchEnd: (m.index ?? 0) + raw.length,
    });
  }
  if (out.length > 0) return out;

  // Embedded, unterminated envelope: the `<|tool_call>` opener appears
  // mid-text with no closing `<tool_call|>` (the turn ran to EOS mid-call,
  // often after the model echoed instruction prose and slid straight into a
  // malformed `…|<channel|><|tool_call>call:write_file{…` with no boundary).
  // The terminated-envelope regex above can't match (no closer) and the
  // whole-text fallback below anchors the name at `^` (the opener is not at
  // the start), so a real deliverable is silently dropped and the file-work
  // turn aborts. Parse from the LAST opener — parseGemmaNativeToolCall already
  // tolerates a missing closer and an unterminated `<|"|>` string, returning
  // the rest of the buffer as the value. Still strict: the name must resolve
  // in knownToolNames, so this can't fabricate a call out of pure prose.
  // (Wild-caught on gemma4-e4b-q4 / plan-and-estimate.)
  const markerIdx = text.lastIndexOf('<|tool_call>');
  if (markerIdx !== -1) {
    const parsedFromMarker = parseGemmaNativeToolCall(text.slice(markerIdx), knownToolNames);
    if (parsedFromMarker) {
      return [{ ...parsedFromMarker, matchStart: markerIdx, matchEnd: text.length }];
    }
  }

  const parsed = parseGemmaNativeToolCall(text, knownToolNames);
  if (parsed) return [{ ...parsed, matchStart: 0, matchEnd: text.length }];

  const headless = parseHeadlessGemmaNativeSpan(text, knownToolNames);
  return headless ? [headless] : [];
}

// Headless leaked body: llama-server's peg-gemma4 parser consumes the
// `<|tool_call>call:NAME{` prefix and then chokes, streaming the REST of
// the call into `content` — so what reaches us starts directly at the
// first arg key: `content:<|"|>…<|"|>,path:<|"|>x<|"|>}`. No opener, no
// tool name. (Wild-caught on gemma4-e2b-q4 / craftbook-documentation-
// drift-review, cbmx-20260720-195716.) The `<|"|>` token right after the
// key is the load-bearing gate — it never occurs in organic prose.
const HEADLESS_GEMMA_BODY_RE = /^\s*[a-zA-Z_][a-zA-Z0-9_-]*\s*:\s*<\|"\|>/;

// The tool name is gone with the eaten prefix, so it must be inferred —
// only from an EXACT arg-key signature, and only for signatures whose
// mapping is unambiguous. Deliberately tiny: `{path}` alone could be
// read_file/delete_path/stat/make_dir, so it stays out.
const HEADLESS_KEY_SIGNATURES: ReadonlyArray<{ keys: readonly string[]; tool: string }> = [
  { keys: ['content', 'path'], tool: 'write_file' },
];

function parseHeadlessGemmaNativeSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): GemmaNativeToolCallSpan | null {
  if (!HEADLESS_GEMMA_BODY_RE.test(text)) return null;
  const synthetic = `{${text}`;
  const parser = new GemmaNativeBodyParser(synthetic, 0);
  const args = parser.readValue();
  if (!isPlainObject(args)) return null;
  // Require the object to have closed with a real `}` — an EOF-truncated
  // body gives the parser no evidence the arg list was complete, and
  // name inference is already speculative enough without it.
  const end = parser.endPos();
  if (synthetic[end - 1] !== '}') return null;
  const keys = Object.keys(args).sort();
  const signature = HEADLESS_KEY_SIGNATURES.find(
    (sig) => sig.keys.length === keys.length && sig.keys.every((k, i) => k === keys[i]),
  );
  if (!signature) return null;
  const name = resolveToolNameAlias(signature.tool, knownToolNames);
  if (!name) return null;
  return { name, arguments: args, matchStart: 0, matchEnd: end - 1 };
}

export function stripGemmaNativeToolCallsFromText(
  text: string,
  spans: Array<Pick<GemmaNativeToolCallSpan, 'matchStart' | 'matchEnd'>>,
): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.matchStart - b.matchStart)) {
    out += text.slice(cursor, span.matchStart);
    cursor = Math.max(cursor, span.matchEnd);
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Char-by-char parser for Gemma 4's native tool-call argument format.
 * Public types this file already imports.
 */
class GemmaNativeBodyParser {
  private pos: number;
  constructor(
    private readonly text: string,
    startPos: number,
  ) {
    this.pos = startPos;
  }

  endPos(): number {
    return this.pos;
  }

  readValue(): unknown {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === undefined) return null;
    if (ch === '{') return this.readObject();
    if (ch === '[') return this.readArray();
    if (this.text.startsWith('<|"|>', this.pos)) return this.readGemmaString();
    if (ch === '"') return this.readJsonString();
    if (this.text.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.text.startsWith('null', this.pos)) {
      this.pos += 4;
      return null;
    }
    // Number or bare ident-value fallback.
    return this.readBareScalar();
  }

  /** `<|"|>...<|"|>` — content can include any character including
   *  newlines, `"`, `\`. Unterminated string (ramble-truncated) yields
   *  the rest of the buffer; better than dropping the salvage. */
  private readGemmaString(): string {
    this.pos += 5;
    const closer = '<|"|>';
    const end = this.text.indexOf(closer, this.pos);
    if (end === -1) {
      const rest = this.text.slice(this.pos);
      this.pos = this.text.length;
      return rest;
    }
    const value = this.text.slice(this.pos, end);
    this.pos = end + closer.length;
    return value;
  }

  /** Standard JSON string — for the (rare) cases where the model
   *  emits `"..."` directly instead of `<|"|>...<|"|>`. */
  private readJsonString(): string {
    this.pos++; // skip opening "
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === '\\' && this.pos + 1 < this.text.length) {
        const next = this.text[this.pos + 1]!;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    return out;
  }

  private readObject(): Record<string, unknown> {
    this.pos++; // skip {
    const out: Record<string, unknown> = {};
    while (this.pos < this.text.length) {
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === '}') {
        this.pos++;
        return out;
      }
      if (ch === undefined) return out;
      // Key: bare ident OR Gemma-quoted OR JSON-quoted.
      let key: string;
      if (this.text.startsWith('<|"|>', this.pos)) {
        key = this.readGemmaString();
      } else if (ch === '"') {
        key = this.readJsonString();
      } else {
        const m = this.text.slice(this.pos).match(/^([a-zA-Z_][a-zA-Z0-9_-]*)/);
        if (!m) return out;
        key = m[1]!;
        this.pos += m[0]!.length;
      }
      this.skipWs();
      if (this.text[this.pos] !== ':') return out;
      this.pos++;
      const value = this.readValue();
      out[key] = value;
      this.skipWs();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === '}') {
        this.pos++;
        return out;
      }
      return out;
    }
    return out;
  }

  private readArray(): unknown[] {
    this.pos++; // skip [
    const out: unknown[] = [];
    while (this.pos < this.text.length) {
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === ']') {
        this.pos++;
        return out;
      }
      if (ch === undefined) return out;
      out.push(this.readValue());
      this.skipWs();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      return out;
    }
    return out;
  }

  private readBareScalar(): unknown {
    // Consume until comma, brace, bracket, or whitespace.
    const start = this.pos;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === ',' || ch === '}' || ch === ']' || /\s/.test(ch)) break;
      this.pos++;
    }
    const raw = this.text.slice(start, this.pos);
    if (raw.length === 0) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) {
      this.pos++;
    }
  }
}

export function parseGemmaToolCall(
  body: string,
  knownToolNames: ReadonlySet<string>,
): ParsedGemmaToolCall | null {
  const cleaned = stripGemmaSpecialTokens(body);
  // Envelope: optional whitespace, optional `call:` prefix, name, then
  // an optionally parens-wrapped `{...}` args block. The `call:` prefix
  // is what Gemma puts there; older variants might omit it entirely
  // (just `name{args}`), so the colon match is optional. The optional
  // `(` / `)` accepts the function-call shape `name({args})` that
  // Gemma 4 26B emits when it's been trained on JS-style call syntax —
  // wild-caught from `start_project({about: "...", ...})` bodies the
  // strict `name{args}` regex was rejecting. The name accepts hyphens
  // too — the model sometimes emits `create-task` for `create_task`;
  // the alias resolver normalizes both shapes against `knownToolNames`.
  const envelope = cleaned.match(
    /^\s*(?:call\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(?\s*(\{[\s\S]*\})\s*\)?\s*$/,
  );
  if (!envelope) return null;
  const rawName = envelope[1]!;
  const argsRaw = envelope[2]!;
  const name = resolveToolNameAlias(rawName, knownToolNames);
  if (!name) return null;

  // Same JSON-rehab pipeline the prose-call salvager already uses
  // (lines 273 / 288 / 1061 in this file). Without these passes,
  // Gemma's `{key: 'value', other: 1,}` shape — single quotes,
  // trailing comma, bare-key — was failing JSON.parse and landing
  // in `unrepairedBodies`, which surfaced as a user-visible
  // "malformed syntax" warning. The four rehab passes are
  // string-aware so they don't corrupt legitimate values.
  //
  // `escapeControlCharsInStrings` is the pass that catches multi-line
  // string values — Gemma frequently writes `missionObjectives: "- A\n
  // - B\n- C"` with literal newlines inside the quoted body. JSON
  // forbids unescaped control characters inside strings, so without
  // this pass any tool call with a multi-paragraph arg fails to parse.
  // Applied last so it sees fully-double-quoted strings (post
  // `singleToDoubleQuotes`).
  const argsJson = escapeControlCharsInStrings(
    stripTrailingCommas(quoteBareKeys(singleToDoubleQuotes(argsRaw))),
  );
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (!isPlainObject(args)) return null;
  return { name, arguments: args };
}

/**
 * Best-effort description of WHY a body failed to parse, for the
 * corrective message we feed back into the model. Keeps the prompt
 * actionable instead of a generic "malformed".
 */
export function describeMalformation(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'The tool-call body was empty.';
  const cleaned = stripGemmaSpecialTokens(trimmed);
  // Scrub channel / reasoning markup before echoing the body in the
  // corrective message. Without this, a Gemma 4 turn that wraps the
  // malformed body in `<|channel|>commentary<|message|>...<|end|>` or
  // similar gpt-oss-style markup feeds its own bad shape back through
  // the retry — the model sees its own markup quoted in the system
  // message and copies the pattern on the next attempt instead of
  // converting to a structured call. Strip first, then truncate.
  const echoSafe = cleaned
    .replace(/<\|?\/?channel\|?>/gi, '')
    .replace(/<\|message\|>/gi, '')
    .replace(/<\|end\|>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?reasoning>/gi, '')
    .trim();
  if (!/^\s*(?:call\s*:\s*)?[a-zA-Z_][a-zA-Z0-9_]*\s*\{/.test(cleaned)) {
    return `The body didn't start with a recognizable function name + arg block — the runtime expects \`name{json}\` shape (e.g. \`write_file{"path":"index.html","content":"..."}\`). Got: "${truncate(echoSafe, 80)}".`;
  }
  if (!/\}\s*$/.test(cleaned)) {
    return `The argument block was missing its closing brace. Got: "${truncate(echoSafe, 80)}".`;
  }
  return `The argument block didn't parse as JSON. Got: "${truncate(echoSafe, 80)}".`;
}

/**
 * Salvage a "prose-shaped" tool call from streamed assistant text.
 *
 * Small models (especially Gemma 4 4B) sometimes treat tool-call
 * emission as a *display* affordance — they put the call in a markdown
 * code block or inline code span instead of issuing a real
 * function-call tokens. The text streams through the stripper
 * unchanged (no `<|tool_call|>` markers present), so neither the SSE
 * `tool_calls` event nor the leak-strip + repair path fires. The user
 * sees "create_project({ name: 'X' })" rendered as text and the
 * project never gets created.
 *
 * This helper scans the final assistant content for the shape
 * `name(args)` where `name` is in the caller-provided known-tools set
 * and `args` is a JSON-ish object literal. When it finds one — and
 * the args block parses cleanly — it returns the parsed call. The
 * MLX provider promotes the salvage into a real tool call and runs
 * the next loop iteration.
 *
 * Strict gating prevents prose-as-call false positives:
 *   - Tool name must lex as an identifier AND be in `knownToolNames`.
 *   - Args must parse as a plain object (after `quoteBareKeys`).
 *   - Returns at most one call per text — multiple prose-shaped
 *     calls in one turn are rare and ambiguous; the model can chain
 *     them across turns.
 *
 * Returns null when nothing matches; the caller falls through to the
 * standard "no tool call this turn" path.
 */
export function parseProseToolCall(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ParsedGemmaToolCall | null {
  const span = findProseToolCallSpan(text, knownToolNames);
  if (!span) return null;
  return { name: span.name, arguments: span.arguments };
}

/**
 * Lower-level variant of {@link parseProseToolCall} that ALSO returns
 * the `[start, end)` source-range covering the salvaged call (from the
 * leading function name through the closing `)`). Callers need this to
 * strip the prose body from visible content after promoting it into a
 * structured tool call — without stripping, the user sees the call
 * rendered as a code block AND the tool runs, which reads as duplicate
 * weirdness.
 *
 * Two shapes are recognized:
 *   1. `name({ ... })` — args are a JSON-ish object literal. Brace-
 *      balanced so nested braces inside string values don't confuse
 *      the matcher.
 *   2. `name()` — empty parens, no args. Many MCP tools (`list_*`,
 *      most read-only getters) take no arguments, and Qwen + Gemma
 *      variants frequently emit them as bare prose calls.
 *
 * Strict gating in both shapes: name must lex as an identifier AND be
 * in `knownToolNames`. The empty-paren variant is doubly gated by
 * the known-tools set — without it any English text containing
 * `something()` could match.
 */
export function findProseToolCallSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ProseToolCallSpan | null {
  return findProseToolCallSpans(text, knownToolNames)[0] ?? null;
}

export interface ProseToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
}

/**
 * Walk the entire text and return every prose-shaped tool call we can
 * recognize. Multi-result variant of {@link findProseToolCallSpan} —
 * Qwen and friends often chain three or four bare calls in a single
 * code fence, and the previous single-result helper silently dropped
 * everything past the first.
 *
 * Three argument shapes are recognized for each call:
 *   1. `name()` — empty parens, no args.
 *   2. `name({ key: value, … })` — JS object literal.
 *   3. `name(key: value, key2: value2)` — Python-style keyword args
 *      with `:`. Wrapped in `{…}` and re-parsed.
 *   4. `name(key=value, key2=value2)` — Python `=` style. The `=`s
 *      get rewritten to `:` (in string-aware fashion) and the args
 *      are wrapped + re-parsed.
 *
 * Strict gating applies to all shapes: name must be in the known-tools
 * set, args must parse as a plain object. Mismatches are skipped, not
 * promoted as fabricated calls.
 */
export function findProseToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ProseToolCallSpan[] {
  const out: ProseToolCallSpan[] = [];
  if (!text) return out;
  const PREFIX_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  PREFIX_RE.lastIndex = 0;
  let cursor = 0;
  while (true) {
    const m = PREFIX_RE.exec(text);
    if (m === null) break;
    if (m.index < cursor) continue;
    const rawName = m[1]!;
    // Resolve aliases (`createtask` → `create_task`) so small models
    // that drop the underscore or use camelCase still get their call
    // through. Strictly punctuation/case — typos still fall through
    // to the "did you mean" retry.
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    const start = m.index;
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingCloseParen(text, openParenIdx);
    if (closeParenIdx < 0) continue;
    const inside = text.slice(openParenIdx + 1, closeParenIdx);
    const args = parseProseArgs(inside);
    if (!args) continue;
    const end = closeParenIdx + 1;
    out.push({ name, arguments: args, start, end });
    cursor = end;
    PREFIX_RE.lastIndex = end;
  }
  return out;
}

/**
 * Parse the text between a tool call's parens (`(<here>)`) into a
 * plain object. Returns null when nothing parses. Walks through up to
 * four progressively-more-forgiving stages:
 *
 *   1. Object-literal as-is — `{key: "value"}` after the usual
 *      Gemma-token strip + single→double quotes + bare-key quoting.
 *   2. Object-literal with control-char escaping — same as (1) but
 *      `escapeControlCharsInStrings` runs over the JSON. Recovers
 *      multi-line content where the model emitted raw `\n` /
 *      `\r` / `\t` inside string values (common when the chat-
 *      template includes the model's reasoning trace verbatim).
 *   3. Object-literal with unescaped-quote rebalance — walks the
 *      key→value boundary structure and re-escapes stray `"` chars
 *      inside HTML/JS content (the model writes `<tag class="x">`
 *      instead of `<tag class=\"x\">`). Common on Gemma 4 26B's
 *      write_file / write_artifact calls with HTML payloads.
 *   4. Python-style kwargs — `key=value, key2=value2` rewritten to
 *      `{key:value,…}` and JSON.parse'd.
 *
 * Each stage runs ONLY if all earlier stages failed. Strict gating:
 * a parse result must be a plain object; arrays/primitives/null all
 * count as failure and we fall through.
 */
function parseProseArgs(inside: string): Record<string, unknown> | null {
  const trimmed = inside.trim();
  if (trimmed.length === 0) return {};
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    // Stage 1: standard fixups.
    const base = quoteBareKeys(singleToDoubleQuotes(stripGemmaSpecialTokens(trimmed)));
    try {
      const parsed = JSON.parse(base);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      /* fall through to escape-control stage */
    }
    // Stage 2: also escape raw control chars inside strings. JSON
    // forbids literal `\n` / `\r` / `\t` in string values, but small
    // models stream multi-line markdown / HTML / code content without
    // escaping it. The helper is string-aware so it doesn't touch
    // whitespace OUTSIDE string boundaries.
    const escaped = escapeControlCharsInStrings(base);
    if (escaped !== base) {
      try {
        const parsed = JSON.parse(escaped);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        /* fall through to unescaped-quote rebalance */
      }
    }
    // Stage 3: rebalance unescaped `"` inside string values. Models
    // writing HTML/JS often emit `class="foo"` instead of
    // `class=\"foo\"` — JSON.parse sees a string close mid-content
    // and chokes. {@link rebalanceUnescapedQuotes} walks the
    // key/value boundary structure and re-escapes anything between
    // a string opener and the NEXT structurally-valid delimiter
    // (comma at top level, closing brace).
    const rebalanced = rebalanceUnescapedQuotes(escaped);
    if (rebalanced !== escaped) {
      try {
        const parsed = JSON.parse(rebalanced);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        /* fall through to kwarg attempt */
      }
    }
  }
  // Stage 4: Python-style kwargs. Rewrite `key=value` → `key:value`
  // (string-aware), wrap in `{…}`, and re-run stages 1-3 over the
  // result. Conservative: the rewrite only fires for bare-ident +
  // `=` not followed by another `=`, so Python comparisons `a == b`
  // survive untouched. Both `name(scope: "x")` and `name(scope="x")`
  // reach JSON.parse as `{"scope":"x"}`.
  const colonized = pythonAssignToColon(trimmed);
  const wrapped = `{${colonized}}`;
  const base = quoteBareKeys(singleToDoubleQuotes(stripGemmaSpecialTokens(wrapped)));
  try {
    const parsed = JSON.parse(base);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* fall through to escape-control retry */
  }
  const escaped = escapeControlCharsInStrings(base);
  if (escaped !== base) {
    try {
      const parsed = JSON.parse(escaped);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      /* not a recognizable shape */
    }
  }
  return null;
}

/**
 * Re-escape unescaped `"` chars that appear inside JSON string values.
 *
 * The motivating shape (wild-caught on Gemma 4 26B `write_file` calls):
 *
 *   {"path": "index.html", "content": "<!DOCTYPE html>
 *   <html lang="en">
 *   ...
 *   "}
 *
 * Naive JSON.parse sees `"<!DOCTYPE html>` open a string, scans for the
 * next `"`, hits `<html lang="`, thinks the string ended at `lang=`,
 * and bails on the rest. The escapeControlCharsInStrings helper has the
 * same blind spot — once it falls out of its in-string state on the
 * spurious `"`, all subsequent newlines look like top-level whitespace.
 *
 * The fix: walk top-level object structure (key, colon, value, comma,
 * key, …) and for each value that's a string, anchor on the OPENING
 * `"` and scan forward looking for the FIRST `"` that's followed by a
 * structural delimiter (comma at top level, or closing brace, modulo
 * whitespace). Every `"` we pass before that gets escaped to `\"`.
 *
 * Returns the input unchanged when:
 *   - it doesn't start with `{` (not an object body)
 *   - it parses without rebalancing (no work needed)
 *   - the structure can't be walked confidently (gives up rather than
 *     corrupting)
 */
function rebalanceUnescapedQuotes(body: string): string {
  if (!body.startsWith('{')) return body;
  // Cheap pre-check: if JSON.parse already accepts it, skip the
  // (potentially expensive) walk.
  try {
    JSON.parse(body);
    return body;
  } catch {
    /* needs rebalancing */
  }

  const out: string[] = [];
  let i = 0;
  out.push(body[i]!); // leading `{`
  i++;

  while (i < body.length) {
    // Skip whitespace at top-level.
    while (i < body.length && /\s/.test(body[i]!)) {
      out.push(body[i]!);
      i++;
    }
    if (i >= body.length) break;
    // Allow trailing `}` to terminate cleanly.
    if (body[i] === '}') {
      out.push('}');
      i++;
      // Pass through whatever trails (closing `}`, EOF). The caller
      // already trimmed and verified `}` is the last char.
      while (i < body.length) {
        out.push(body[i]!);
        i++;
      }
      return out.join('');
    }
    // Expect a key — either `"key"` or a bare identifier the upstream
    // quoter has already wrapped. Either way, find the `:` that
    // separates key from value.
    const colonIdx = findStructuralColon(body, i);
    if (colonIdx < 0) return body; // give up; structure unrecognizable
    // Copy key + colon verbatim.
    for (let k = i; k <= colonIdx; k++) out.push(body[k]!);
    i = colonIdx + 1;
    // Skip whitespace between `:` and value.
    while (i < body.length && /\s/.test(body[i]!)) {
      out.push(body[i]!);
      i++;
    }
    if (i >= body.length) break;
    // Three value shapes we care about here:
    //   - `"..."` string — the case we rebalance
    //   - `{...}` nested object — copy with balanced braces
    //   - `[...]` array — copy with balanced brackets
    //   - primitive (number, true, false, null) — copy until comma/brace
    if (body[i] === '"') {
      const endIdx = findUnescapedQuoteBoundary(body, i);
      if (endIdx < 0) return body; // give up
      // Copy opener.
      out.push('"');
      // Re-escape every unescaped `"` between i+1 and endIdx exclusive.
      for (let k = i + 1; k < endIdx; k++) {
        const ch = body[k]!;
        if (ch === '"') {
          // Stray internal quote — escape it.
          out.push('\\"');
        } else if (ch === '\\' && k + 1 < body.length) {
          out.push(ch);
          out.push(body[k + 1]!);
          k++;
        } else {
          out.push(ch);
        }
      }
      out.push('"');
      i = endIdx + 1;
    } else if (body[i] === '{' || body[i] === '[') {
      const closer = body[i] === '{' ? '}' : ']';
      const endIdx = findMatchingBracket(body, i, body[i]!, closer);
      if (endIdx < 0) return body;
      for (let k = i; k <= endIdx; k++) out.push(body[k]!);
      i = endIdx + 1;
    } else {
      // Primitive — copy until comma or closing brace at top level.
      while (i < body.length && body[i] !== ',' && body[i] !== '}') {
        out.push(body[i]!);
        i++;
      }
    }
    // Skip whitespace.
    while (i < body.length && /\s/.test(body[i]!)) {
      out.push(body[i]!);
      i++;
    }
    if (i < body.length && body[i] === ',') {
      out.push(',');
      i++;
    }
  }
  return out.join('');
}

/**
 * Find the index of the `:` that separates a key from its value at
 * the current top-level position. Skips over `:` chars inside a
 * quoted key (`"key:with:colons"`). Returns -1 if no top-level colon
 * is found.
 */
function findStructuralColon(body: string, start: number): number {
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < body.length) {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ':') return i;
    if (ch === '}' || ch === ',') return -1; // structure ended without finding `:`
  }
  return -1;
}

/**
 * Find the matching close-bracket for a `{...}` or `[...]` opening,
 * tracking strings (with backslash escapes) so brackets inside string
 * values don't perturb depth. Returns -1 when no matching close exists.
 */
function findMatchingBracket(body: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < body.length) {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Given an opening `"` at `openIdx`, scan forward for the closing
 * boundary that genuinely terminates this string value. Heuristic: a
 * `"` is the close ONLY if it's followed (modulo whitespace) by `,`
 * or `}` — i.e., a structural delimiter at the parent object level.
 * Any earlier `"` is treated as content and skipped (the caller
 * re-escapes it).
 *
 * Backslash-escaped `\"` is always treated as content. Returns -1
 * when no plausible boundary is found before EOS.
 */
function findUnescapedQuoteBoundary(body: string, openIdx: number): number {
  for (let i = openIdx + 1; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      i++;
      continue;
    }
    if (ch !== '"') continue;
    // Look ahead past whitespace for `,` or `}` — the structural
    // delimiters that legitimately follow a string value at the top
    // level of an object body.
    let j = i + 1;
    while (j < body.length && /\s/.test(body[j]!)) j++;
    if (j >= body.length) return i; // EOS-trailing string close
    if (body[j] === ',' || body[j] === '}') return i;
    // Otherwise this `"` is content — keep scanning.
  }
  return -1;
}

/**
 * KEY-position variant of {@link findUnescapedQuoteBoundary}. Keys
 * close into `:` (the key-value separator), not `,` / `}`. They also
 * almost never contain unescaped `"` chars in the wild (JSON keys are
 * typically simple identifiers), so a tighter heuristic is fine:
 * find the next unescaped `"` and check it's followed by whitespace
 * + `:`. Treats the EOS case as "truncated mid-key" → returns -1.
 */
function findKeyCloseQuote(body: string, openIdx: number): number {
  for (let i = openIdx + 1; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      i++;
      continue;
    }
    if (ch !== '"') continue;
    let j = i + 1;
    while (j < body.length && /\s/.test(body[j]!)) j++;
    if (j >= body.length) return -1; // truncated — no `:` ever arrived
    if (body[j] === ':') return i;
    // Unexpected char where `:` was expected — treat as content `"`
    // and keep scanning. Conservative: if a malformed key happens
    // to contain a stray `"`, we keep going until we find the real
    // close.
  }
  return -1;
}

/**
 * Walk forward from an open-paren and return the index of its matching
 * close-paren. Tracks string literals (handling backslash escapes) and
 * nested parens / brackets / braces so `name(read({nested: 1}))`
 * balances correctly. Returns -1 when no matching close exists before
 * EOS.
 */
function findMatchingCloseParen(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let stringChar: '"' | "'" | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) {
        i++;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Rewrite Python-style `key=value` assignments to `key:value` for
 * downstream JSON-ish parsing. String-aware so `{ url: "x=y" }` and
 * Python comparisons (`a == b`) survive untouched.
 */
function pythonAssignToColon(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar: '"' | "'" | null = null;
  while (i < input.length) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    const tail = input.slice(i);
    const m = tail.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\s*)=(?!=)/);
    if (m) {
      out += `${m[1]}${m[2]}:`;
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Remove the prose-shaped tool call at the given span from `text`,
 * also peeling off any markdown code-fence that wraps it (so the user
 * doesn't see an empty ```python fence after the call body is gone).
 *
 * The fence-peeling rule: we only strip the leading triple-backtick
 * line if the stripped fence body would be empty (i.e. the call was
 * the only thing inside it). Mixed-content fences ("here's the call,
 * btw also some prose") leave the fence intact — that's prose worth
 * keeping, even if the salvage call is gone.
 */
export function stripProseToolCallFromText(
  text: string,
  span: { start: number; end: number },
): string {
  return collapseBlankRuns(stripProseToolCallNoCollapse(text, span));
}

/**
 * Per-span strip without the trailing whitespace collapse. The
 * collapse can shift offsets within the string, which corrupts the
 * iteration in {@link stripProseToolCallsFromText} when later spans
 * point at the original text. Public callers stripping a single span
 * use {@link stripProseToolCallFromText}; multi-span callers loop
 * through this helper and call `collapseBlankRuns` once at the end.
 */
function stripProseToolCallNoCollapse(text: string, span: { start: number; end: number }): string {
  const before = text.slice(0, span.start);
  const after = text.slice(span.end);
  // If the call was inside ```...```, peel the wrapping fence when
  // the only thing between the fences is whitespace. The regex
  // tolerates multi-line whitespace on both sides so iterative
  // strips of multi-call fences eventually succeed: strip-rightmost-
  // first leaves `\n\n` gaps between earlier calls and the closing
  // fence, which the relaxed `\s*` here folds into the peel.
  const beforeMatch = before.match(/```[a-zA-Z0-9_+-]*\n\s*$/);
  const afterMatch = after.match(/^\s*```/);
  if (beforeMatch && afterMatch) {
    const beforeStripped = before.slice(0, before.length - beforeMatch[0].length);
    const afterStripped = after.slice(afterMatch[0].length);
    return `${beforeStripped}${afterStripped}`;
  }
  return `${before}${after}`;
}

/**
 * Strip every span in `spans` from `text`. Strips right-to-left so
 * earlier offsets stay valid through iterative cuts; the per-span
 * fence-peel still fires on each iteration, and the leftmost call
 * peels the wrapping fence once the prior strips have emptied the
 * body between fences. The final whitespace collapse runs once at
 * the end so per-iteration collapses can't shift offsets out from
 * under remaining spans.
 */
export function stripProseToolCallsFromText(
  text: string,
  spans: Array<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = stripProseToolCallNoCollapse(out, span);
  }
  return collapseBlankRuns(out);
}

function collapseBlankRuns(s: string): string {
  // Trim trailing whitespace on each line, then collapse runs of 3+
  // blank lines into a single blank — stripping a call out of mid-
  // paragraph commonly leaves a 3-newline gash that reads as an
  // accidental section break.
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export interface XmlTagToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
}

// Anchors a candidate tool-use tag: `<NAME ATTRS />` (self-closing) or
// `<NAME ATTRS>...</NAME>` (open/close pair). Only quoted attribute
// values are accepted — bare/unquoted values are too easy to mismatch
// in narrative prose like `<think>I should call X</think>`. Tag and
// attribute names lex as identifiers; everything else is rejected
// before the known-tools gate.
const XML_TAG_RE =
  /<([a-zA-Z_][a-zA-Z0-9_]*)((?:\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>[\s\S]*?<\/\1\s*>)/g;
const XML_ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Coerce an XML attribute string value into the JS shape MCP tools
 * expect. Bare numbers and `true`/`false` get unquoted; everything
 * else stays a string. URLs and paths land here as strings, which
 * is what every relevant tool wants (`browser_navigate`, `read_file`,
 * `write_artifact` all take string args).
 */
function coerceXmlAttrValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Salvage Anthropic-style XML tool-use markup that some local models
 * (notably Qwen 3.6 27B) emit as visible text instead of issuing a
 * structured tool call:
 *
 *   <browser_navigate url="https://example.com" />
 *   <write_artifact path="notes.md" content="..." />
 *
 * Both self-closing (`<NAME ATTRS />`) and open/close (`<NAME ATTRS>...</NAME>`)
 * forms are accepted; the inner text of the open/close form is
 * discarded — Anthropic-style markup encodes args as attributes, not
 * as inner content. Multiple calls in a single turn are returned in
 * source order so the caller can fire all of them and splice the
 * markup out of the visible bubble.
 *
 * Strict gating: tag name must resolve to a known tool (with the same
 * punctuation/case alias resolution the prose path uses), and at
 * least one attribute must be present — a bare `<list_projects />` is
 * accepted (zero args is valid for many read-only tools), but a tag
 * that lex-matches a tool name yet has no attributes AND no args is
 * still salvaged. The `<think>...</think>` reasoning marker is filtered
 * by the known-tools gate (no MCP tool is named `think`), so it
 * never collides.
 */
export function findXmlTagToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): XmlTagToolCallSpan[] {
  if (!text) return [];
  const out: XmlTagToolCallSpan[] = [];
  for (const m of text.matchAll(XML_TAG_RE)) {
    const rawName = m[1]!;
    const attrSegment = m[2] ?? '';
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const am of attrSegment.matchAll(XML_ATTR_RE)) {
      const key = am[1]!;
      const val = am[2] ?? am[3] ?? '';
      args[key] = coerceXmlAttrValue(val);
    }
    out.push({ name, arguments: args, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Single-result variant — returns the first salvageable XML tag tool
 * call or null. Mirrors the {@link findProseToolCallSpan} /
 * {@link parseProseToolCall} split.
 */
export function findXmlTagToolCallSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): XmlTagToolCallSpan | null {
  return findXmlTagToolCallSpans(text, knownToolNames)[0] ?? null;
}

/**
 * Splice every salvaged XML tag span out of visible content. Same
 * shape as {@link stripProseToolCallsFromText}: walk right-to-left so
 * earlier offsets stay valid, then run a single whitespace collapse
 * at the end.
 */
export function stripXmlTagToolCallsFromText(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return collapseBlankRuns(out);
}

// Anthropic-style `<invoke name="X">...</invoke>` markup. Each
// invoke can be wrapped in `<function_calls>...</function_calls>`
// (the canonical shape) but we don't require the wrapper — Qwen 3.6
// has been observed emitting bare `<invoke>` blocks, and salvaging
// either is the same parse. Parameters render as nested
// `<parameter name="K">value</parameter>` elements; empty body
// (zero parameters) is fine for tools that take no args.
const CLAUDE_INVOKE_RE = /<invoke\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\s*>([\s\S]*?)<\/invoke\s*>/g;
const CLAUDE_PARAMETER_RE =
  /<parameter\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\s*>([\s\S]*?)<\/parameter\s*>/g;
// Empty `<function_calls>...</function_calls>` wrapper that's left
// behind after stripping the invokes inside it. We don't anchor on
// it for finding calls (bare `<invoke>` is also valid), but we
// strip the wrapper as part of cleanup so the visible bubble doesn't
// show an empty `<function_calls></function_calls>` shell.
const CLAUDE_FUNCTION_CALLS_WRAPPER_RE = /<function_calls\s*>\s*<\/function_calls\s*>/g;

/**
 * Coerce a `<parameter>` text body the same way XML attributes are
 * coerced — bare numbers and `true`/`false` get unquoted, everything
 * else stays a string. Whitespace is trimmed because the model
 * commonly indents parameter content; tools want the raw value.
 */
function coerceClaudeParameterValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export interface ClaudeInvokeToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
}

/**
 * Salvage Anthropic-style `<invoke name="X">...</invoke>` markup
 * that some local models (notably Qwen 3.6 27B, trained on Claude
 * transcripts) emit as visible text instead of issuing a real tool
 * call. The full canonical shape is:
 *
 *   <function_calls>
 *     <invoke name="browser_snapshot">
 *       <parameter name="ref">page-root</parameter>
 *     </invoke>
 *   </function_calls>
 *
 * but we walk for `<invoke>` directly since the wrapper is optional
 * in the wild (and Qwen sometimes drops it). Parameters become args
 * via `<parameter name="K">value</parameter>`; tools that take no
 * arguments just have empty invoke bodies.
 *
 * Strict gating: tag name must resolve to a known tool. Same alias
 * resolution as the prose / XML-tag paths handles punctuation and
 * case drift (`browserSnapshot` → `browser_snapshot`).
 */
export function findClaudeInvokeToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ClaudeInvokeToolCallSpan[] {
  if (!text) return [];
  const out: ClaudeInvokeToolCallSpan[] = [];
  for (const m of text.matchAll(CLAUDE_INVOKE_RE)) {
    const rawName = m[1]!;
    const body = m[2] ?? '';
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const pm of body.matchAll(CLAUDE_PARAMETER_RE)) {
      const key = pm[1]!;
      const val = pm[2] ?? '';
      args[key] = coerceClaudeParameterValue(val);
    }
    out.push({ name, arguments: args, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function findClaudeInvokeToolCallSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ClaudeInvokeToolCallSpan | null {
  return findClaudeInvokeToolCallSpans(text, knownToolNames)[0] ?? null;
}

/**
 * Splice every salvaged `<invoke>` span out of visible content,
 * then drop any leftover empty `<function_calls></function_calls>`
 * wrappers. Same right-to-left pattern as the other strip helpers
 * so earlier offsets stay valid through iterative cuts.
 */
export function stripClaudeInvokeToolCallsFromText(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  out = out.replace(CLAUDE_FUNCTION_CALLS_WRAPPER_RE, '');
  return collapseBlankRuns(out);
}

// GLM-4.5 / 4.6 native tool-call format. The function name follows the
// `<tool_call>` opener (GLM's chat template emits it on its own line),
// then alternating `<arg_key>K</arg_key>` / `<arg_value>V</arg_value>`
// pairs, closed by `</tool_call>`:
//
//   <tool_call>write_file
//   <arg_key>path</arg_key>
//   <arg_value>notes.md</arg_value>
//   <arg_key>content</arg_key>
//   <arg_value>hello world</arg_value>
//   </tool_call>
//
// Values are free text (newlines, quotes, `<`, `>`) up to the matching
// `</arg_value>`. Distinct from every other shape here: the Hermes path
// keys on `<function=NAME>`, the shell path on `<tool_call>name key="value"`
// (name then end-of-line/next `<tool_call>`), Claude-invoke on
// `<invoke name="X">`. GLM puts the bare name directly after `<tool_call>`
// plus `<arg_key>`/`<arg_value>` children — no `<function=`, no `="`, no
// `<invoke`, so none of them match it.
//
// Wild-caught on laguna-s-2.1-118b (a GLM-4.5-Air derivative) at MLX: the
// model emitted this verbatim as content and every existing parser found
// zero spans, so no tool call ever landed (preflight toolRoundTrip FAIL,
// `prose-salvage found 0 spans`).
const GLM_TOOL_CALL_RE =
  /<tool_call>[ \t\r\n]*([a-zA-Z_][a-zA-Z0-9_.-]*)[ \t\r\n]*([\s\S]*?)<\/tool_call\s*>/g;
const GLM_ARG_PAIR_RE =
  /<arg_key>([\s\S]*?)<\/arg_key>[ \t\r\n]*<arg_value>([\s\S]*?)<\/arg_value>/g;

export interface GlmToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
  /**
   * Stream ended mid-call: the `</tool_call>` closer (or the final
   * `</arg_value>`) never arrived. The captured value is the bytes
   * received before truncation — the caller fires a continuation hint
   * so the model appends the rest rather than re-emitting the whole file.
   */
  truncated?: boolean;
}

/**
 * Coerce a GLM `<arg_value>` body the same way Claude `<parameter>` /
 * shell / XML attribute values are coerced — bare numbers and
 * `true`/`false` get unquoted, everything else stays a trimmed string.
 */
function coerceGlmArgValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseGlmArgPairs(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pm of body.matchAll(GLM_ARG_PAIR_RE)) {
    const key = (pm[1] ?? '').trim();
    if (key) args[key] = coerceGlmArgValue(pm[2] ?? '');
  }
  return args;
}

/**
 * Salvage GLM-native `<tool_call>NAME<arg_key>…</tool_call>` markup that
 * GLM-4.5/4.6-family models (e.g. laguna-s-118b) emit as visible content
 * on the MLX textual path instead of a real `tool_calls` event.
 *
 * Terminated calls are matched by {@link GLM_TOOL_CALL_RE}; a single
 * trailing UNTERMINATED opener (stream ran out mid-call, common on long
 * `write_file` content) is recovered separately — the closed
 * `<arg_key>/<arg_value>` pairs are parsed normally, and a final dangling
 * `<arg_value>` (no closer) contributes its partial value with the span
 * flagged `truncated`.
 *
 * Strict gating: the tool name must resolve through
 * {@link resolveToolNameAlias} to a known tool, and an unterminated
 * opener is only promoted when it yields at least one argument — so stray
 * narration mentioning `<tool_call>` can't fabricate a no-arg call.
 */
export function findGlmToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): GlmToolCallSpan[] {
  if (!text || knownToolNames.size === 0) return [];
  const out: GlmToolCallSpan[] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(GLM_TOOL_CALL_RE)) {
    const name = resolveToolNameAlias(m[1]!, knownToolNames);
    if (!name) continue;
    const end = m.index + m[0].length;
    out.push({ name, arguments: parseGlmArgPairs(m[2] ?? ''), start: m.index, end });
    lastEnd = end;
  }
  // Trailing unterminated opener: `<tool_call>NAME …` after the last
  // closed envelope, with no `</tool_call>` closing it.
  const tailIdx = text.indexOf('<tool_call>', lastEnd);
  if (tailIdx >= 0 && !text.includes('</tool_call>', tailIdx)) {
    const om = /^<tool_call>[ \t\r\n]*([a-zA-Z_][a-zA-Z0-9_.-]*)/.exec(text.slice(tailIdx));
    if (om) {
      const name = resolveToolNameAlias(om[1]!, knownToolNames);
      if (name) {
        const body = text.slice(tailIdx + om[0].length);
        const args = parseGlmArgPairs(body);
        let truncated = false;
        // A final `<arg_value>` opened with no matching `</arg_value>`:
        // capture the partial value so a truncated write_file still lands.
        const lastValOpen = body.lastIndexOf('<arg_value>');
        if (lastValOpen >= 0 && !body.includes('</arg_value>', lastValOpen)) {
          const keyClose = body.lastIndexOf('</arg_key>', lastValOpen);
          const keyOpen = keyClose >= 0 ? body.lastIndexOf('<arg_key>', keyClose) : -1;
          if (keyOpen >= 0) {
            const key = body.slice(keyOpen + '<arg_key>'.length, keyClose).trim();
            if (key) {
              args[key] = coerceGlmArgValue(body.slice(lastValOpen + '<arg_value>'.length));
              truncated = true;
            }
          }
        }
        if (Object.keys(args).length > 0) {
          out.push({ name, arguments: args, start: tailIdx, end: text.length, truncated });
        }
      }
    }
  }
  return out;
}

export function findGlmToolCallSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): GlmToolCallSpan | null {
  return findGlmToolCallSpans(text, knownToolNames)[0] ?? null;
}

/**
 * Splice every salvaged GLM `<tool_call>` span out of visible content.
 * Right-to-left so earlier offsets stay valid through iterative cuts,
 * mirroring the other strip helpers.
 */
export function stripGlmToolCallsFromText(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return collapseBlankRuns(out);
}

// Bare `invoke NAME {json}` — the literal word `invoke`, a tool name, and a
// JSON argument object, with NO angle-bracket markup, parens, or Gemma
// special tokens. Wild-caught on `gemma4-e2b-q4` / MLX: a weak model that
// never emits Gemma's `<|tool_call>` trigger token (so the llguidance grammar
// never engages) narrates the call in this shape instead, e.g.:
//
//   invoke write_file {
//     "path": "preflight.txt",
//     "content": "FLIGHT OK"
//   }
//
// None of the other salvage shapes match (they key on `(`, `<...>`, or Gemma
// tokens), so the call was silently dropped and the turn stalled. The `\b`
// anchors the keyword; `resolveToolNameAlias` + the object-parse gate keep
// prose like "you can invoke write_file to …" (no `{json}` object) from
// false-matching.
const BARE_INVOKE_RE = /\binvoke\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*\{/gi;

export interface BareInvokeToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
}

export function findBareInvokeToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): BareInvokeToolCallSpan[] {
  if (!text || knownToolNames.size === 0) return [];
  const out: BareInvokeToolCallSpan[] = [];
  BARE_INVOKE_RE.lastIndex = 0;
  let cursor = 0;
  while (true) {
    const m = BARE_INVOKE_RE.exec(text);
    if (m === null) break;
    if (m.index < cursor) continue;
    const rawName = m[1]!;
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    // The `{` that the regex matched is the last char of m[0].
    const braceStart = m.index + m[0].length - 1;
    const braceEnd = findMatchingBracket(text, braceStart, '{', '}');
    if (braceEnd < 0) continue;
    const args = parseProseArgs(text.slice(braceStart, braceEnd + 1));
    if (!args) continue;
    const end = braceEnd + 1;
    out.push({ name, arguments: args, start: m.index, end });
    cursor = end;
    BARE_INVOKE_RE.lastIndex = end;
  }
  return out;
}

export function stripBareInvokeToolCallsFromText(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return collapseBlankRuns(out);
}

// Shell-style `<tool_call>` lines (no close tag, no JSON envelope) —
// the most degraded form of Qwen's tool-call template. Pattern:
//
//   <tool_call>browser_navigate url="https://..."
//   <tool_call>browser_snapshot
//
// One per line. No closing pipe, no `</tool_call>`, no JSON. Args
// are space-separated `key="value"` pairs (or absent for no-arg
// calls). The opening `<tool_call>` is the only fixed marker.
//
// Why this exists: Qwen 3.6 27B at heavy quant has been observed
// emitting this in the wild after the canonical format
// (`<tool_call>...JSON...</tool_call>`) was closed off via prompt.
// The model retains the opening tag from training but skips the
// JSON wrapper — degrading toward a shell-call shape that's likely
// from another tool-use template it saw during training. Salvaging
// it is the difference between a working chained call and a stalled
// turn the user has to retry.
const SHELL_TOOL_CALL_RE =
  /<tool_call>[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)((?:[ \t]+[a-zA-Z_][a-zA-Z0-9_]*[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'))*)[ \t]*(?=$|\n|<tool_call>)/g;
const SHELL_TOOL_CALL_ARG_RE = /([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/g;

export interface ShellToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
}

/**
 * Coerce a shell-style attribute value the same way XML attributes /
 * Claude `<parameter>` text bodies are coerced — bare numbers and
 * `true`/`false` get unquoted; everything else stays a string.
 */
function coerceShellArgValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Salvage shell-style `<tool_call>name args` markup that some local
 * models (notably Qwen 3.6 27B at aggressive quant) emit when the
 * canonical Qwen `<tool_call>...JSON...</tool_call>` format gets
 * closed off via prompt. Each call is a single line:
 *
 *   <tool_call>browser_navigate url="https://..."
 *   <tool_call>browser_snapshot
 *
 * Multiple calls in a single turn each get their own span. Strict
 * gating: tool name must resolve through `resolveToolNameAlias` to a
 * known tool. The "shell" framing means it cannot be confused with
 * any of the other markup forms — the marker `<tool_call>` (no
 * pipes, no `<invoke>`, no `</tool_call>` close) is unique.
 */
export function findShellToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ShellToolCallSpan[] {
  if (!text) return [];
  const out: ShellToolCallSpan[] = [];
  for (const m of text.matchAll(SHELL_TOOL_CALL_RE)) {
    const rawName = m[1]!;
    const argSegment = m[2] ?? '';
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const am of argSegment.matchAll(SHELL_TOOL_CALL_ARG_RE)) {
      const key = am[1]!;
      const val = am[2] ?? am[3] ?? '';
      args[key] = coerceShellArgValue(val);
    }
    out.push({ name, arguments: args, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function findShellToolCallSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ShellToolCallSpan | null {
  return findShellToolCallSpans(text, knownToolNames)[0] ?? null;
}

/**
 * Splice salvaged shell-style `<tool_call>` lines out of visible
 * content. Same right-to-left pattern as the other strip helpers.
 */
export function stripShellToolCallsFromText(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return collapseBlankRuns(out);
}

// Hermes-2-Pro / Functionary tool-call format. Qwen 3.6 27B has been
// trained on Hermes data alongside its own canonical
// `<tool_call>{json}</tool_call>` template, and at heavy quant it
// mixes the two — wrapping the Hermes shape inside Qwen's outer
// `<tool_call>` envelope. Pattern (with optional `<tool_call>` wrap):
//
//   <tool_call>
//   <function=browser_navigate>
//     <parameter=url>https://example.com</parameter>
//     <parameter=timeout>5000</parameter>
//   </function>
//   </tool_call>
//
// Distinctive feature: the tag itself encodes the name with `=`
// (e.g. `<function=browser_navigate>`) instead of using a `name="..."`
// attribute. Same convention for parameters. Multiline parameter
// bodies are common — we trim the value before passing through the
// known-tools gate.
const HERMES_FUNCTION_RE = /<function=([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)<\/function\s*>/g;
const HERMES_PARAMETER_RE = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)<\/parameter\s*>/g;

export interface HermesFunctionToolCallSpan {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
  /**
   * True iff the lenient parser inferred the span's last parameter
   * value extended past where the stream ended — i.e., no
   * `</parameter>` closer arrived. Strict-parsed spans never set
   * this. The caller (mlx / ollama provider) reads this to attach
   * an "auto-continuation" hint to the tool result so the model
   * knows to call the tool again with the remaining bytes.
   */
  truncated?: boolean;
}

/**
 * Coerce a Hermes-style `<parameter>` body the same way XML attribute
 * values and Claude `<parameter>` bodies are coerced — bare numbers
 * and `true`/`false` get unquoted; everything else stays a string.
 */
function coerceHermesParameterValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Salvage Hermes-2-Pro / Functionary tool-call markup. Wild-caught on
 * Qwen 3.6 27B emitting it INSIDE its canonical `<tool_call>` wrapper
 * — a sign the model has been trained on multiple tool-use corpora
 * and is mixing the outer (Qwen) and inner (Hermes) shapes at heavy
 * quant.
 *
 * We don't anchor on the `<tool_call>` outer wrapper because the
 * Hermes shape is also valid bare. The downstream
 * `stripShellToolCallsFromText` (or just `stripHermesFunctionToolCallsFromText`
 * here) drops the spans; the existing
 * `CLAUDE_FUNCTION_CALLS_WRAPPER_RE` cleanup catches an empty
 * `<function_calls></function_calls>` shell, but Qwen's
 * `<tool_call></tool_call>` shell isn't removed automatically. The
 * stripper below adds a one-liner pattern to clean it up.
 *
 * Strict gating: `<function=NAME>` must resolve to a known tool.
 * Parameter values are trimmed of leading/trailing whitespace
 * because Qwen-Hermes hybrids sometimes wrap the value in newlines:
 *
 *   <parameter=url>
 *   https://example.com
 *   </parameter>
 */
export function findHermesFunctionToolCallSpans(
  text: string,
  knownToolNames: ReadonlySet<string>,
): HermesFunctionToolCallSpan[] {
  if (!text) return [];
  const out: HermesFunctionToolCallSpan[] = [];
  for (const m of text.matchAll(HERMES_FUNCTION_RE)) {
    const rawName = m[1]!;
    const body = m[2] ?? '';
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const pm of body.matchAll(HERMES_PARAMETER_RE)) {
      const key = pm[1]!;
      const val = pm[2] ?? '';
      args[key] = coerceHermesParameterValue(val);
    }
    out.push({ name, arguments: args, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function findHermesFunctionToolCallSpan(
  text: string,
  knownToolNames: ReadonlySet<string>,
): HermesFunctionToolCallSpan | null {
  return findHermesFunctionToolCallSpans(text, knownToolNames)[0] ?? null;
}

// Permissive variant of the Hermes parser used as a fallback when the
// strict regex above finds nothing.
//
// Wild-caught on Qwen 3.6 27B (MLX, tictactoe trials):
// Tamara emits a `<tool_call><function=write_file><parameter=path>…</parameter>
// <parameter=content>` opener and then streams a multi-kilobyte HTML body
// — but the body's `</parameter>` and `</function>` closing tags never
// arrive because the model's `max_tokens` cap (or the stream watchdog)
// trips first. The strict regex above requires those closers, so the
// salvage drops the entire call and the next turn the model claims
// "the write_file call got truncated mid-stream" — fabrication that
// loops the whole trial to a timeout.
//
// Recovery rules:
//   - Open-only `<function=NAME>` is the anchor. Body extends until
//     the FIRST of: `</function>`, `</tool_call>`, next `<function=`,
//     or end-of-string. (Models that leave a stray `</tool_call>` on
//     the outer wrapper but skip the inner `</function>` are common.)
//   - Inside the body, each `<parameter=KEY>` opens a value that runs
//     until the FIRST of: `</parameter>`, next `<parameter=`, or end-of-body.
//   - Empty-body openers (just `<function=NAME>` with no parameters at
//     all) are skipped — a model that emitted only the opener has no
//     real call to salvage and salvaging it would force a downstream
//     "missing required arg" error.
//
// Strict gating: `<function=NAME>` must resolve to a known tool — same
// as the strict variant. The "next <function=" boundary is computed
// before that check so partial truncation of one call doesn't bleed
// into the next call's body.
const HERMES_FUNCTION_OPEN_RE = /<function=([a-zA-Z_][a-zA-Z0-9_]*)\s*>/g;
const HERMES_PARAMETER_OPEN_RE = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)\s*>/g;
const HERMES_FUNCTION_CLOSE_RE = /<\/function\s*>|<\/tool_call\s*>/;
const HERMES_PARAMETER_CLOSE_RE = /<\/parameter\s*>/;

export function findHermesFunctionToolCallSpansLenient(
  text: string,
  knownToolNames: ReadonlySet<string>,
): HermesFunctionToolCallSpan[] {
  if (!text) return [];
  const opens: Array<{ name: string; start: number; bodyStart: number }> = [];
  for (const m of text.matchAll(HERMES_FUNCTION_OPEN_RE)) {
    opens.push({ name: m[1]!, start: m.index, bodyStart: m.index + m[0].length });
  }
  if (opens.length === 0) return [];
  const out: HermesFunctionToolCallSpan[] = [];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i]!;
    const resolved = resolveToolNameAlias(open.name, knownToolNames);
    if (!resolved) continue;
    const nextOpenStart = i + 1 < opens.length ? opens[i + 1]!.start : text.length;
    const after = text.slice(open.bodyStart, nextOpenStart);
    const closerIdx = after.search(HERMES_FUNCTION_CLOSE_RE);
    const bodyEnd = closerIdx === -1 ? after.length : closerIdx;
    const body = after.slice(0, bodyEnd);
    // Parameter list — open-only, value runs to next opener or close.
    const paramOpens: Array<{ name: string; valueStart: number }> = [];
    for (const pm of body.matchAll(HERMES_PARAMETER_OPEN_RE)) {
      paramOpens.push({ name: pm[1]!, valueStart: pm.index + pm[0].length });
    }
    if (paramOpens.length === 0) continue;
    const args: Record<string, unknown> = {};
    let lastParamTruncated = false;
    for (let j = 0; j < paramOpens.length; j++) {
      const pOpen = paramOpens[j]!;
      const isLast = j + 1 >= paramOpens.length;
      const nextValEnd = isLast ? body.length : paramOpens[j + 1]!.valueStart;
      const valChunk = body.slice(pOpen.valueStart, nextValEnd);
      const valCloserIdx = valChunk.search(HERMES_PARAMETER_CLOSE_RE);
      const raw = valCloserIdx === -1 ? valChunk : valChunk.slice(0, valCloserIdx);
      args[pOpen.name] = coerceHermesParameterValue(raw);
      // Truncation signal: the LAST parameter has no `</parameter>`
      // closer AND the surrounding function/tool_call block also had
      // no closer (closerIdx < 0). Either of those alone could be a
      // legitimate edge case (model emitted concise XML with implicit
      // closers); both together is a strong signal the stream ended
      // mid-value — the model never finished writing the body.
      if (isLast && valCloserIdx === -1 && closerIdx === -1) {
        lastParamTruncated = true;
      }
    }
    // Span end includes the matched closer when present, so the
    // stripper doesn't leave dangling `</function>` / `</tool_call>`
    // markers in user-visible text. When there's no closer (the EOF
    // case), the span extends to the start of the next opener — or
    // to the end of the buffer when this is the only call.
    const closeLen = (() => {
      if (closerIdx === -1) return 0;
      const closeMatch = after.slice(closerIdx).match(HERMES_FUNCTION_CLOSE_RE);
      return closeMatch ? closeMatch[0].length : 0;
    })();
    const end = open.bodyStart + bodyEnd + closeLen;
    const span: HermesFunctionToolCallSpan = {
      name: resolved,
      arguments: args,
      start: open.start,
      end,
    };
    if (lastParamTruncated) span.truncated = true;
    out.push(span);
  }
  return out;
}

// Empty `<tool_call>...</tool_call>` wrapper that's left after we
// strip the Hermes `<function>` blocks from inside. Same idea as the
// `<function_calls>` cleanup for the Claude-invoke salvage.
const QWEN_TOOL_CALL_WRAPPER_RE = /<tool_call\s*>\s*<\/tool_call\s*>/g;

/**
 * Splice salvaged Hermes `<function>` blocks out of visible content,
 * then drop any leftover empty `<tool_call></tool_call>` wrappers
 * (Qwen-Hermes hybrids leave these behind once the inner block is
 * gone). Same right-to-left pattern as the other strip helpers so
 * earlier offsets stay valid through iterative cuts.
 */
export function stripHermesFunctionToolCallsFromText(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of sorted) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  out = out.replace(QWEN_TOOL_CALL_WRAPPER_RE, '');
  return collapseBlankRuns(out);
}

/**
 * When the JSON envelope salvager finds a `{tool, args}` shape but
 * the tool name isn't in the known set, this returns the unrecognized
 * name + the closest matching real tool (if any) so the caller can
 * push a "did you mean X?" corrective message back to the model.
 * Without this, a model that emits e.g. `listtasks` (missing the
 * underscore from `list_tasks`) silently leaves the call as visible
 * text — the user sees the JSON, no tool runs, the model doesn't
 * learn from the miss. Returning a suggestion lets the provider seed
 * a follow-up turn that nudges the model toward the right name.
 *
 * Suggestion uses character-level similarity (lowercased + stripped
 * of underscores/hyphens) — strict enough that we don't suggest
 * `read_artifact` when the model said `delete_database`, lenient
 * enough to map `listtasks → list_tasks` and `getProject →
 * get_project`. Returns null when no envelope is present at all
 * (caller falls through to the standard path); returns
 * `{wanted, suggestion: null}` when the envelope was present with
 * an unrecognized name and we couldn't find anything close.
 */
/**
 * Best-effort: pull the function name out of an unrepaired tool-call
 * body so we can name it in corrective messages. Tries the Gemma
 * envelope (`call:NAME{...}` or bare `NAME{...}`), then the JSON
 * envelope (`{"name": "NAME", ...}`). Returns null when no recognizable
 * shape leads with a name token.
 *
 * Used for the budget-exhausted corrective system note — telling the
 * model "you tried to call `start_project` but the call didn't land"
 * is more actionable than "you tried to call something."
 */
export function extractWantedToolName(body: string): string | null {
  const cleaned = stripGemmaSpecialTokens(body);
  const envelope = cleaned.match(/^\s*(?:call\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\{/);
  if (envelope) return envelope[1]!;
  const jsonName = cleaned.match(/"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/);
  if (jsonName) return jsonName[1]!;
  return null;
}

/**
 * Collect distinct wanted tool names across a batch of unrepaired
 * bodies, preserving emission order. When `knownToolNames` is provided,
 * normalize via {@link resolveToolNameAlias} so a `createTask` body
 * resolves to `create_task`. Used by the budget-exhausted corrective
 * note in MLX so the model sees a concrete `\`start_project\`` rather
 * than `<unknown>`.
 */
export function uniqueWantedToolNames(
  bodies: readonly string[],
  knownToolNames?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const body of bodies) {
    const raw = extractWantedToolName(body);
    if (!raw) continue;
    const canonical = knownToolNames ? (resolveToolNameAlias(raw, knownToolNames) ?? raw) : raw;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export function findUnrecognizedToolEnvelope(
  text: string,
  knownToolNames: ReadonlySet<string>,
): {
  wanted: string;
  suggestion: string | null;
  matchStart: number;
  matchEnd: number;
} | null {
  if (!text) return null;
  // Same anchor logic as parseJsonEnvelopeToolCall, but we accept
  // names NOT in the known set and try to suggest one. matchStart /
  // matchEnd are returned so the caller can splice the envelope out of
  // the visible bubble — the user sees a clean retry rather than the
  // botched first attempt with a yellow warning underneath.
  const NAME_KEY = /"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/;
  const ARGS_KEY = /"(?:args|arguments|parameters|input)"\s*:/;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const closeIdx = findMatchingBrace(text, i);
    if (closeIdx < 0) continue;
    const slice = text.slice(i, closeIdx + 1);
    const nameMatch = slice.match(NAME_KEY);
    if (!nameMatch) continue;
    const wanted = nameMatch[1]!;
    // Skip names that the alias resolver would have promoted upstream
    // — the salvage pipeline already converted those to real tool
    // calls. We only flag names that are *genuinely* unknown so the
    // "did you mean…?" retry doesn't fire when nothing went wrong.
    if (resolveToolNameAlias(wanted, knownToolNames) !== null) continue;
    if (!ARGS_KEY.test(slice)) continue;
    const suggestion = findClosestToolName(wanted, knownToolNames);
    return { wanted, suggestion, matchStart: i, matchEnd: closeIdx + 1 };
  }
  return null;
}

/**
 * Sibling to {@link findUnrecognizedToolEnvelope} for the MARKUP tool-call
 * shapes that name the tool directly rather than via a JSON `{tool,args}`
 * envelope:
 *   - `<function=NAME ...>`            (Hermes / Qwen canonical)
 *   - `<function name="NAME">`         (XML attribute variant)
 *   - `<invoke name="NAME">`           (Claude tool-use)
 *
 * Returns the wanted name + a typo suggestion when the name is genuinely
 * unknown (not in the set and not alias-resolvable), else null. The
 * salvage layers that promote these shapes are all gated on
 * `knownToolNames`, so an unknown name leaves NO synthesized call and —
 * before this — NO feedback either: the markup was just stripped and the
 * model believed its call succeeded. Wild-caught: a voorman
 * (no `write_file`) emitted `<function=write_file>` repeatedly; nothing told
 * it the tool wasn't its, so it "completed" a file that never existed.
 */
export function findUnrecognizedFunctionMarkup(
  text: string,
  knownToolNames: ReadonlySet<string>,
): { wanted: string; suggestion: string | null } | null {
  if (!text) return null;
  // Capture allows hyphens so a model's hyphenated variant
  // (`<function=list-tasks>`) reaches the alias resolver intact rather
  // than being truncated to `list` and mis-flagged as unknown.
  const patterns = [
    /<function\s*=\s*([a-zA-Z_][a-zA-Z0-9_-]*)/i,
    /<function\s+name\s*=\s*["']([a-zA-Z_][a-zA-Z0-9_-]*)["']/i,
    /<invoke\s+name\s*=\s*["']([a-zA-Z_][a-zA-Z0-9_-]*)["']/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const wanted = m?.[1];
    if (!wanted) continue;
    // Known or alias-resolvable → the salvage pipeline already handled
    // it (or a sibling parser will); only flag genuinely-unknown names.
    if (resolveToolNameAlias(wanted, knownToolNames) !== null) continue;
    return { wanted, suggestion: findClosestToolName(wanted, knownToolNames) };
  }
  return null;
}

/**
 * Write tools a DELEGATOR role (voorman / meester / planner) characteristically
 * lacks. When one of these is "called" by a role that doesn't have it, the
 * right correction is not "did you mean…?" — it's "you can't write here,
 * delegate."
 */
const DELEGATABLE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
]);

/**
 * Build the corrective `[system]` nudge for a tool-call naming a tool the
 * role doesn't have. Unifies the two cases:
 *
 *   1. A delegator role (no `write_file`) tried to write. The shared
 *      "build X → call write_file" prompt scaffolding pulls every build
 *      turn toward writing even for read-only roles; silently dropping
 *      the markup lets the model fabricate completion. Tell it plainly it
 *      cannot write here and point at blocking delegation via
 *      `message_gezel` — re-pinging the gezel it already assigned the task
 *      to is the intended move.
 *   2. A plain typo / hallucinated name. Fall back to the "did you mean…?"
 *      retry the JSON-envelope path already used.
 */
/**
 * Render up to `max` available tool names as a compact backtick list, so a
 * confused small model can SEE its real options instead of being told to
 * "check the tool list" (which it can't re-open mid-turn). Role-filtered
 * rosters are small (tens of tools), so listing them is cheap and far more
 * actionable than a vague pointer.
 */
export function formatToolMenu(knownToolNames: ReadonlySet<string>, max = 40): string {
  const names = [...knownToolNames];
  if (names.length === 0) return '(no tools available)';
  const shown = names.slice(0, max).map((n) => `\`${n}\``);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

export function buildUnknownToolNudge(
  wanted: string,
  suggestion: string | null,
  knownToolNames: ReadonlySet<string>,
  /**
   * Optional param-name → owning-tool-names index. Lets the nudge catch the
   * single most common small-model miss: naming a PARAMETER as the function
   * (e.g. `description` is an argument of `start_project`, not a tool). Built
   * by the provider from the advertised tool schemas.
   */
  toolParamIndex?: ReadonlyMap<string, readonly string[]>,
): string {
  if (DELEGATABLE_WRITE_TOOLS.has(wanted) && !knownToolNames.has(wanted)) {
    const canDelegate = knownToolNames.has('message_gezel') || knownToolNames.has('ask_specialist');
    if (canDelegate) {
      return `[system] You emitted a \`${wanted}\` call, but \`${wanted}\` is NOT in your tool list — you have no workspace write access in this role, so that markup did NOTHING and no file was written. Do not emit \`${wanted}\` again. To get the file created you must DELEGATE: call \`message_gezel\` targeting the Builder/Developer you already assigned, or call \`ensure_gezel\` for a Builder/Developer first if none exists. Include \`expectedDeliverable: { kind: "file", filePath: "<path>" }\` and a concrete instruction to write the file and reply with its path. Do not call \`ask_specialist\` for file deliverables. Before telling anyone the file is done, confirm it exists with \`list_dir\` / \`read_file\`.`;
    }
    return `[system] You emitted a \`${wanted}\` call, but \`${wanted}\` is NOT in your tool list — you have no workspace write access and no delegation tool in this role, so NO file was written. Tell the user plainly that you cannot create the file yourself and what they should do instead.`;
  }
  // A confident typo match — point straight at it.
  if (suggestion) {
    return `[system] You called the tool \`${wanted}\` but no such tool exists in your tool list. Did you mean \`${suggestion}\`? Please retry using a real tool call (emit it via the tools mechanism, not as text).`;
  }
  // No close match. The dominant failure here is naming an ARGUMENT as the
  // function (e.g. `description` → `start_project`). Detect that and point at
  // the real tool; always enumerate the roster so the model can pick a valid
  // one rather than re-emitting the same invalid name.
  const owners = toolParamIndex?.get(wanted);
  const paramHint =
    owners && owners.length > 0
      ? ` Note: \`${wanted}\` is an ARGUMENT of ${owners
          .slice(0, 3)
          .map((t) => `\`${t}\``)
          .join(
            ' / ',
          )}${owners.length > 3 ? ' (and others)' : ''} — not a tool. Call that tool and pass \`${wanted}\` inside its arguments.`
      : '';
  return `[system] You called \`${wanted}\` but no such tool exists in your tool list.${paramHint} Your available tools are: ${formatToolMenu(knownToolNames)}. Retry by emitting ONE of these as a real function call via the tools mechanism (not as literal text).`;
}

/**
 * Pick the closest known tool name to `wanted`, or null if nothing is
 * close enough. Heuristic — lowercase + strip non-alphanumerics from
 * both sides; if the normalized forms match exactly OR have a small
 * Levenshtein-style distance, return the candidate. Threshold is
 * intentionally tight (1 edit per 4 chars, capped at 3) — the goal
 * is "did you mean the obvious neighbor", not fuzzy search.
 */
function findClosestToolName(wanted: string, knownToolNames: ReadonlySet<string>): string | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wantedNorm = normalize(wanted);
  if (!wantedNorm) return null;
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of knownToolNames) {
    const candNorm = normalize(candidate);
    if (candNorm === wantedNorm) return candidate; // typo in punctuation only
    const dist = editDistance(wantedNorm, candNorm);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  if (best === null) return null;
  // Reject suggestions where the edit distance is too large
  // relative to the original — for a 6-char name we'll suggest up
  // to 1 edit; for 12-char up to 3. Beyond that the suggestion is
  // probably noise.
  const maxAllowed = Math.min(3, Math.floor(wantedNorm.length / 4) || 1);
  return bestDist <= maxAllowed ? best : null;
}

function editDistance(a: string, b: string): number {
  // Iterative Levenshtein — fine for tool-name-length strings (<32).
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Salvage the JSON-envelope shape some local models emit verbatim in
 * their text content instead of issuing a structured `tool_calls`
 * event. Qwen 3.5 (9B) on MLX, Qwen 3.6 on llama-cpp, and a few
 * smaller models on Ollama all have this behavior — they treat
 * tool calls as content the user should *read*, with the call body
 * shaped as a JSON object containing `tool` + `args` keys:
 *
 *   The user wants to list projects. I should use the list_projects tool.
 *
 *   ```json
 *   { "tool": "list_projects", "args": {} }
 *   ```
 *
 * Or sometimes bare without a code fence:
 *
 *   { "tool": "create_project", "args": { "name": "Atari Adventure" } }
 *
 * We scan for the first JSON object containing both `"tool"` and
 * `"args"` (allowing typical alternates `"name"`, `"function"`,
 * `"arguments"`, `"parameters"`, `"input"`), brace-balance to find
 * its end, and parse strictly. Returns null when nothing matches; the
 * caller falls through to the standard "no tool call this turn" path.
 *
 * Strict gating same as the other salvagers: name must be in the
 * caller-supplied known-tools set, args must parse as a plain
 * object.
 */
export function parseJsonEnvelopeToolCall(
  text: string,
  knownToolNames: ReadonlySet<string>,
): (ParsedGemmaToolCall & { matchStart: number; matchEnd: number }) | null {
  if (!text) return null;
  // Anchor on the `"tool"` (or `"name"`/`"function"`) key. We don't
  // require the object's open brace to be at column 0 — many models
  // wrap the JSON in a `\`\`\`json` code fence or in narrative prose.
  // Walk every `{` candidate that's plausibly the start of an
  // envelope; the first one that brace-balances + parses + has a
  // known tool name + an args object wins. `matchStart`/`matchEnd`
  // let the caller splice the envelope out of visible content so the
  // user doesn't see the call-as-text *and* the executed call-as-
  // tool-bubble in the same turn.
  const NAME_KEY = /"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/;
  const ARGS_KEY = /"(?:args|arguments|parameters|input)"\s*:/;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const closeIdx = findMatchingBrace(text, i);
    if (closeIdx < 0) continue;
    const slice = text.slice(i, closeIdx + 1);
    const nameMatch = slice.match(NAME_KEY);
    if (!nameMatch) continue;
    const rawName = nameMatch[1]!;
    // Aliases let small models drop punctuation or use camelCase
    // (`createtask`, `getProject`) and still hit the right tool. Typos
    // remain the "did you mean…?" path's job.
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    if (!ARGS_KEY.test(slice)) continue;
    const cleaned = quoteBareKeys(singleToDoubleQuotes(stripGemmaSpecialTokens(slice)));
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const args =
      (parsed as Record<string, unknown>).args ??
      (parsed as Record<string, unknown>).arguments ??
      (parsed as Record<string, unknown>).parameters ??
      (parsed as Record<string, unknown>).input;
    if (!isPlainObject(args)) continue;
    return { name, arguments: args, matchStart: i, matchEnd: closeIdx + 1 };
  }
  return null;
}

/**
 * Salvage *every* JSON-envelope tool call in the streamed text, in source
 * order. Qwen 3.5/3.6 (and a few smaller models on Ollama / llama.cpp)
 * sometimes chain multiple `{tool, args}` blobs back-to-back inside a
 * single assistant response — narrating "Let me list the projects, then
 * create one, then assign a voorman" while emitting three sequential
 * JSON code fences. The single-result {@link parseJsonEnvelopeToolCall}
 * only promotes the first one; the rest stay as visible text and never
 * fire, leaving the user with a half-finished operation.
 *
 * This walks the text from left to right, emitting each parseable
 * envelope and skipping past it (continuing the scan from `matchEnd`
 * rather than `matchEnd + 1` to handle blobs that sit immediately
 * adjacent). Each result includes the source range so the caller can
 * splice them all out of visible content via {@link stripJsonEnvelopesFromText}.
 *
 * Strict gating same as the singular variant: name must be a known
 * tool, args must parse as a plain object. Envelopes with unrecognized
 * names (typos, fabricated tools) are skipped here — handle those
 * separately via {@link findUnrecognizedToolEnvelopes} so the caller can
 * decide whether to nudge the model with a "did you mean…?" message.
 */
export function parseJsonEnvelopeToolCalls(
  text: string,
  knownToolNames: ReadonlySet<string>,
): Array<ParsedGemmaToolCall & { matchStart: number; matchEnd: number }> {
  if (!text) return [];
  const out: Array<ParsedGemmaToolCall & { matchStart: number; matchEnd: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const slice = text.slice(cursor);
    const parsed = parseJsonEnvelopeToolCall(slice, knownToolNames);
    if (!parsed) break;
    out.push({
      name: parsed.name,
      arguments: parsed.arguments,
      matchStart: parsed.matchStart + cursor,
      matchEnd: parsed.matchEnd + cursor,
    });
    cursor = cursor + parsed.matchEnd;
  }
  return out;
}

/**
 * Detect a *truncated* prose-shaped tool call at the tail of the
 * streamed text — i.e. `name(...` where `name` is a known tool but
 * the args block has no matching closing paren before EOS. Same root
 * cause as {@link findTruncatedJsonEnvelope}: the model burned its
 * output budget on chain-of-thought and got cut off before completing
 * the call. The prose form (`name(args)`) is what `parseProseToolCall`
 * salvages when complete; this catches the leak at the truncation
 * boundary instead of silently dropping it.
 *
 * Returns the truncated tool name and source offset, or null when the
 * tail is clean. The known-tools gate prevents false positives on
 * legitimate prose like "I'd recommend (a) doing X" — those don't
 * contain a known tool name followed by `(`.
 */
export interface TruncatedToolCallMatch {
  /** Canonical tool name (post alias resolution). */
  wanted: string;
  /** Source offset where the call begins (the function name). */
  matchStart: number;
  /**
   * Best-effort args extracted from the partial body. May be a subset
   * of what the model intended (e.g. `path` set + partial `content`
   * up to the EOS truncation point). Empty when nothing parsed.
   * Callers MUST treat string values as potentially truncated — for
   * write-shaped tools, the framework lands the partial content to
   * disk and emits a continuation hint instructing the model to
   * issue `append_to_file` for the remaining bytes.
   */
  partialArgs: Record<string, unknown>;
}

export function findTruncatedProseToolCall(
  text: string,
  knownToolNames: ReadonlySet<string>,
): TruncatedToolCallMatch | null {
  if (!text || knownToolNames.size === 0) return null;
  // Walk forward; for every `name(` where the name is known, if there
  // is no matching close paren before EOS (and no complete brace-
  // balanced args block followed by `)`), flag it. Skip matches that
  // ARE complete — `parseProseToolCall` handles those.
  const PREFIX_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  PREFIX_RE.lastIndex = 0;
  let lastTruncated: TruncatedToolCallMatch | null = null;
  while (true) {
    m = PREFIX_RE.exec(text);
    if (m === null) break;
    const rawName = m[1]!;
    // Resolve aliases so a truncated `createtask({...` still gets
    // flagged as a `create_task` truncation rather than silently
    // dropped because the literal name didn't match.
    const name = resolveToolNameAlias(rawName, knownToolNames);
    if (!name) continue;
    const openBraceIdx = m.index + m[0].length - 1;
    const closeBraceIdx = findMatchingBrace(text, openBraceIdx);
    if (closeBraceIdx < 0) {
      // No matching `}` — definitely truncated mid-args. The body
      // from the open brace to EOS is what was emitted; pass it to
      // the partial-args extractor for best-effort recovery.
      const partialBody = text.slice(openBraceIdx);
      lastTruncated = {
        wanted: name,
        matchStart: m.index,
        partialArgs: extractPartialArgs(partialBody),
      };
      continue;
    }
    // Args block balanced. Did the model close the paren too?
    const afterBrace = text.slice(closeBraceIdx + 1);
    if (!/^\s*\)/.test(afterBrace)) {
      // Args complete but no close paren — also truncated. The brace
      // span IS fully written though, so we can try the regular
      // parser to extract args cleanly.
      const inside = text.slice(openBraceIdx, closeBraceIdx + 1);
      const args = parseProseArgs(inside);
      lastTruncated = {
        wanted: name,
        matchStart: m.index,
        partialArgs: args ?? extractPartialArgs(inside),
      };
    }
    // else: complete call — handled by parseProseToolCall.
  }
  return lastTruncated;
}

/**
 * Detect a *truncated* JSON envelope at the tail of the streamed text —
 * i.e. an opening `{` followed by a `"tool"`/`"name"`/`"function"` key
 * with no matching closing brace before EOS. Happens when the model
 * blows the output-token budget mid-emission, or hits an EOS condition
 * during a chained tool-call run. We can't safely fabricate the missing
 * args, but flagging it lets the caller surface a "the last call was
 * cut off" warning instead of silently dropping it.
 *
 * Returns the wanted tool name (best effort) and the source position
 * where the broken envelope started, or null when no truncation is
 * detected. Walks back-to-front and checks the LAST plausible opening
 * brace — earlier completed envelopes are not considered.
 */
export interface TruncatedJsonEnvelopeMatch {
  /** Tool name extracted from the `name`/`tool`/`function` key, or null when absent. */
  wanted: string | null;
  /** Source offset where the unmatched opening `{` is. */
  matchStart: number;
  /**
   * Best-effort args extracted from the partial body — looks inside
   * the `args`/`arguments`/`parameters`/`input` sub-object if present,
   * else returns top-level keys (excluding the name key itself).
   */
  partialArgs: Record<string, unknown>;
}

export function findTruncatedJsonEnvelope(text: string): TruncatedJsonEnvelopeMatch | null {
  if (!text) return null;
  const NAME_KEY = /"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/;
  // Walk every `{` from left to right, find ones whose matching close
  // doesn't exist (truncated). Among those, only flag if we see a
  // recognizable name-key inside — otherwise it's just an unfinished
  // string, not necessarily a tool call.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const closeIdx = findMatchingBrace(text, i);
    if (closeIdx >= 0) {
      // Skip past completed envelopes — they're handled elsewhere.
      i = closeIdx;
      continue;
    }
    // Unmatched open brace. Is there a tool-name key inside the
    // truncated body? If so, this is a truncated tool call.
    const tail = text.slice(i);
    const m = tail.match(NAME_KEY);
    if (!m) continue;
    // Look for an args sub-object opener (`"args":` or alias). If
    // present, extract partial args from inside that block; else
    // extract from the envelope body (minus the name key).
    const ARGS_OPENER = /"(?:args|arguments|parameters|input)"\s*:\s*\{/;
    const argsMatch = tail.match(ARGS_OPENER);
    let partialArgs: Record<string, unknown> = {};
    if (argsMatch && argsMatch.index !== undefined) {
      // The args sub-object body starts at the `{` inside the match.
      const argsBlockStart = argsMatch.index + argsMatch[0].length - 1;
      const argsPartialBody = tail.slice(argsBlockStart);
      partialArgs = extractPartialArgs(argsPartialBody);
    } else {
      // No sub-object — try the envelope body directly. The name
      // key itself is filtered out by extractPartialArgs since we
      // only collect string-valued keys with content-shaped names.
      partialArgs = extractPartialArgs(tail);
    }
    return { wanted: m[1] ?? null, matchStart: i, partialArgs };
  }
  return null;
}

/**
 * Best-effort extraction of args from a TRUNCATED `{` body. Walks
 * key-by-key looking for `"key": "value"` pairs and accumulates them
 * into a plain object. Stops cleanly at EOS — the last key's value
 * is captured as much as the stream contained, even if its closing
 * `"` never arrived.
 *
 * Used by {@link findTruncatedProseToolCall} and {@link
 * findTruncatedJsonEnvelope} to surface partial `path` + `content`
 * for write-shaped tool calls so the framework can land the partial
 * bytes to disk and emit a continuation hint.
 *
 * Conservative — only string and number values are captured. Nested
 * objects, arrays, booleans, and null are skipped (the truncation
 * boundary is rarely inside one of those anyway, and getting them
 * wrong would corrupt the bytes we land). Returns `{}` when nothing
 * extractable was found.
 */
function extractPartialArgs(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || body[0] !== '{') return out;
  let i = 1; // skip leading `{`
  while (i < body.length) {
    // Skip whitespace + commas between key-value pairs.
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    if (i >= body.length) break;
    if (body[i] === '}') break; // end of object — caller handles
    // Expect `"key"` next. Be flexible: accept bare-identifier
    // keys too (Python-style `key: value`). The downstream
    // consumer doesn't care which shape it came from.
    let key: string | null = null;
    if (body[i] === '"') {
      // Keys are simple — find the next unescaped `"`. Don't reuse
      // findUnescapedQuoteBoundary here because that one expects the
      // close-quote to be followed by `,` or `}` (the value-boundary
      // rule); keys close into `:` which is the opposite case.
      const keyEnd = findKeyCloseQuote(body, i);
      if (keyEnd < 0) break; // truncated mid-key
      key = unescapeJsonString(body.slice(i + 1, keyEnd));
      i = keyEnd + 1;
    } else if (/[a-zA-Z_]/.test(body[i]!)) {
      const start = i;
      while (i < body.length && /[a-zA-Z0-9_]/.test(body[i]!)) i++;
      key = body.slice(start, i);
    } else {
      break; // unrecognized char where a key should be
    }
    // Skip whitespace then expect `:`.
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length || body[i] !== ':') break;
    i++; // consume `:`
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    // Capture the value. String values are the case we care about
    // most — they're where `content` lives for write-shaped tools.
    if (body[i] === '"' || body[i] === "'" || body[i] === '`') {
      const quote = body[i]!;
      const valStart = i + 1;
      // Double-quoted JSON-ish values use the boundary rule (close-quote
      // followed by `,` or `}`) because content commonly contains
      // unescaped `"` mid-string. Single-quoted and template-string
      // JS-object values (`content: `...`) do not have JSON's inner-quote
      // ambiguity, so use the next unescaped matching delimiter.
      const valEnd =
        quote === '"' ? findUnescapedQuoteBoundary(body, i) : findUnescapedStringDelimiter(body, i);
      if (valEnd < 0) {
        // String never closed — capture as much as the model emitted.
        // This is the truncation boundary; the bytes from valStart
        // to end-of-body are what got streamed before EOS.
        const raw = body.slice(valStart);
        out[key] = quote === '"' ? unescapeJsonString(raw) : unescapeJsString(raw);
        return out;
      }
      const raw = body.slice(valStart, valEnd);
      out[key] = quote === '"' ? unescapeJsonString(raw) : unescapeJsString(raw);
      i = valEnd + 1;
      continue;
    }
    if (/[0-9-]/.test(body[i]!)) {
      const start = i;
      while (i < body.length && /[0-9eE.+-]/.test(body[i]!)) i++;
      const numStr = body.slice(start, i);
      const num = Number(numStr);
      if (Number.isFinite(num)) out[key] = num;
      continue;
    }
    if (body.startsWith('true', i)) {
      out[key] = true;
      i += 4;
      continue;
    }
    if (body.startsWith('false', i)) {
      out[key] = false;
      i += 5;
      continue;
    }
    if (body.startsWith('null', i)) {
      out[key] = null;
      i += 4;
      continue;
    }
    // Nested object/array — skip to its matching close (or EOS) and
    // continue. We don't try to recover partial nested structure.
    if (body[i] === '{' || body[i] === '[') {
      const closer = body[i] === '{' ? '}' : ']';
      const closeIdx = findMatchingBracket(body, i, body[i]!, closer);
      if (closeIdx < 0) break; // truncated inside nested — give up
      i = closeIdx + 1;
      continue;
    }
    break; // unrecognized value shape
  }
  return out;
}

function findUnescapedStringDelimiter(body: string, openQuoteIdx: number): number {
  const quote = body[openQuoteIdx];
  if (quote !== "'" && quote !== '`') return -1;
  for (let i = openQuoteIdx + 1; i < body.length; i++) {
    if (body[i] !== quote) continue;
    let backslashes = 0;
    for (let j = i - 1; j > openQuoteIdx && body[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * Reverse JSON's standard escape sequences in a raw string slice —
 * `\n` → newline, `\"` → `"`, etc. The extractor pulls bytes out
 * literally from the streamed text; this turns them back into the
 * string the model intended. Best-effort: unknown sequences (e.g.
 * `\x` non-standard hex) pass through unchanged.
 */
function unescapeJsonString(raw: string): string {
  return unescapeJsString(raw);
}

function unescapeJsString(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch;
      i++;
      continue;
    }
    const next = raw[i + 1]!;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '"':
        out += '"';
        break;
      case "'":
        out += "'";
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'u':
        // \uXXXX — 4 hex digits.
        if (i + 5 < raw.length) {
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
        }
        out += `\\${next}`;
        break;
      default:
        out += `\\${next}`;
    }
    i += 2;
  }
  return out;
}

/**
 * Strip a salvaged JSON envelope and any wrapping markdown code fence
 * from visible assistant content. Without this, a model that emits
 * "I'll call X" + a `\`\`\`json {…} \`\`\`` block reads to the user
 * as a self-narrating chat that ALSO produces a tool bubble — twice
 * the visual surface for one logical action. Trims surrounding fence
 * lines + collapses runs of newlines so the result reads cleanly.
 */
export function stripJsonEnvelopeFromText(
  text: string,
  matchStart: number,
  matchEnd: number,
): string {
  // Walk back from matchStart to capture any opening fence
  // (`\`\`\`json\n` typically) and forward from matchEnd for the
  // closing fence. Keeps the fence lines from staying behind as
  // empty backtick triplets.
  let from = matchStart;
  let to = matchEnd;
  const before = text.slice(0, from);
  const beforeTrimmed = before.replace(/```(?:json|javascript|js)?\s*$/i, '');
  if (beforeTrimmed.length !== before.length) {
    from = beforeTrimmed.length;
  }
  const after = text.slice(to);
  const afterTrimmed = after.replace(/^\s*```/, '');
  if (afterTrimmed.length !== after.length) {
    to = text.length - afterTrimmed.length;
  }
  const stripped = text.slice(0, from) + text.slice(to);
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip many salvaged envelopes (and a trailing truncated one when
 * supplied) from visible assistant content in a single pass. Each
 * range is widened to swallow any wrapping markdown fence the same
 * way {@link stripJsonEnvelopeFromText} does, then all widened ranges
 * are spliced out at once — keeping the original offsets valid.
 *
 * `truncatedFromIndex`, when set, drops everything from that offset to
 * the end of the text — the truncated envelope and whatever fragment
 * was streaming when the model stopped. Without this the user sees the
 * partial JSON blob hanging in the message.
 */
export function stripJsonEnvelopesFromText(
  text: string,
  ranges: ReadonlyArray<{ matchStart: number; matchEnd: number }>,
  truncatedFromIndex?: number,
): string {
  if (ranges.length === 0 && truncatedFromIndex === undefined) return text;
  // Widen each range to include any preceding ```json fence and the
  // matching close fence after.
  type Cut = { from: number; to: number };
  const cuts: Cut[] = [];
  for (const r of ranges) {
    let from = r.matchStart;
    let to = r.matchEnd;
    const before = text.slice(0, from);
    const beforeTrimmed = before.replace(/```(?:json|javascript|js)?\s*$/i, '');
    if (beforeTrimmed.length !== before.length) {
      from = beforeTrimmed.length;
    }
    const after = text.slice(to);
    const afterTrimmed = after.replace(/^\s*```/, '');
    if (afterTrimmed.length !== after.length) {
      to = text.length - afterTrimmed.length;
    }
    cuts.push({ from, to });
  }
  if (truncatedFromIndex !== undefined && truncatedFromIndex >= 0) {
    let from = truncatedFromIndex;
    const before = text.slice(0, from);
    const beforeTrimmed = before.replace(/```(?:json|javascript|js)?\s*$/i, '');
    if (beforeTrimmed.length !== before.length) {
      from = beforeTrimmed.length;
    }
    cuts.push({ from, to: text.length });
  }
  // Apply right-to-left so `from`/`to` stay valid.
  cuts.sort((a, b) => b.from - a.from);
  let out = text;
  for (const cut of cuts) {
    out = out.slice(0, cut.from) + out.slice(cut.to);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * When a turn produced tool calls, the visible text emitted by the
 * model is almost always reasoning preamble — "Let me check the URL",
 * "I should use browser_navigate", "The user wants…" — not content
 * the user cares about. The substantive answer comes after the tool
 * runs (in the next iteration of the tool loop's continuation).
 *
 * Verbose-family models (Qwen, DeepSeek-R1, QwQ, gpt-oss) leak this
 * preamble in plain prose even when told to wrap reasoning in
 * `<think>` tags. This helper drops it.
 *
 * Two trigger modes (any of which folds when the model is verbose-family
 * and the text is non-empty):
 *
 *   - `toolCallsFired` — this iteration produced at least one tool call,
 *     structured OR salvaged. Pre-tool prose ("Let me look at…") is the
 *     reasoning trail that should have been wrapped in `<think>`. Folds.
 *
 *   - `askedQuestionThisTurn` — earlier in this same turn, an
 *     `ask_user_question` call landed successfully. The card IS the
 *     user's notification — anything else the model emits this turn
 *     is decoration on top of it (and usually leaked reasoning like
 *     "I posted a question. Now I need to wait for the user's
 *     answer."). Folds even when this iteration produced no tool
 *     calls, which is the common shape for the wrap-up iteration
 *     after a question.
 *
 * Non-verbose models that emit pre-tool prose are doing so
 * deliberately (e.g., a Llama 70B saying "I'll search and report
 * back" is intentional UX) — keep it. Both triggers gate on
 * `modelLeaksReasoning`.
 *
 * Returns the empty string when the fold applies; the original text
 * otherwise. The caller is expected to commit the returned value.
 *
 * Why drop entirely vs. wrap in `<think>`: wrapping plus the
 * existing `stripReasoningTags` pass would round-trip to the same
 * empty result, and the simpler shape avoids a dead intermediate
 * string lying around in logs/persistence. The per-turn telemetry
 * (token counts, durations) is unaffected — those measure model
 * activity, not visible content.
 */
export function foldPreToolPreamble(opts: {
  text: string;
  toolCallsFired: boolean;
  modelLeaksReasoning: boolean;
  /**
   * True when ask_user_question fired successfully earlier in this
   * same turn. Folds even iterations with no tool calls — the card
   * is the message, anything else is post-question stew.
   */
  askedQuestionThisTurn?: boolean;
}): string {
  if (!opts.modelLeaksReasoning) return opts.text;
  if (!opts.text || !opts.text.trim()) return opts.text;
  if (opts.toolCallsFired) return '';
  if (opts.askedQuestionThisTurn) return '';
  return opts.text;
}

/**
 * Character budget past which a post-action continuation reply from a
 * leaky-reasoning model is treated as rumination rather than a
 * deliberate long answer. Legitimate wrap-ups ("Played e5 — your
 * move!", a short paragraph summarizing what a write_file shipped) sit
 * far below it; the wild-caught failure (gemma4-12b checkers: a 4,000+
 * char board re-derivation as the "one short line of table talk")
 * sits far above.
 */
const POST_ACTION_RUMINATION_CHARS = 700;

/**
 * Fold post-action rumination out of a continuation iteration's reply.
 *
 * `foldPreToolPreamble` handles the iteration that FIRES a tool: its
 * prose is preamble, the substance comes later. This helper handles
 * the iteration AFTER the tool ran — for leaky-reasoning models this
 * is supposed to be the short human-facing wrap-up, but a verbose
 * medium model (wild-caught: gemma4-12b on a checkers turn) re-runs
 * its whole analysis in the visible channel instead: ~1,000 tokens of
 * board re-derivation where "one line of table talk" belonged. The
 * per-iteration ramble detector misses it because a fresh iteration
 * starts against the cold threshold.
 *
 * Strategy: when an action tool already fired earlier in this same
 * turn and the reply blows past {@link POST_ACTION_RUMINATION_CHARS},
 * everything up to the final paragraph is reasoning — return it in
 * `reasoning` (the caller stashes it on the collapsed-expander
 * channel) and keep only the final paragraph visible, and only when
 * it reads like a conclusion (ends in terminal punctuation and is
 * paragraph-short). A tail that is itself mid-analysis or truncated
 * mid-sentence folds entirely; the caller's empty-reply machinery
 * takes over from there.
 *
 * Never fires for non-leaky models, short replies, or turns where no
 * action fired (a genuine long answer to a question keeps its length).
 */
export function foldPostActionRumination(opts: {
  text: string;
  actionFiredEarlierThisTurn: boolean;
  modelLeaksReasoning: boolean;
}): { visible: string; reasoning: string } {
  const { text } = opts;
  if (!opts.modelLeaksReasoning || !opts.actionFiredEarlierThisTurn) {
    return { visible: text, reasoning: '' };
  }
  if (!text || text.trim().length <= POST_ACTION_RUMINATION_CHARS) {
    return { visible: text, reasoning: '' };
  }
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n{2,}/);
  const tail = (paragraphs[paragraphs.length - 1] ?? '').trim();
  const tailLooksConclusive =
    tail.length > 0 &&
    tail.length <= 300 &&
    // Ends like a sentence (or an emoji/quote after one) — a tail cut
    // mid-thought ("If it doesn't list") stays folded.
    /[.!?…)"'”’]\s*(\p{Emoji_Presentation}\s*)*$/u.test(tail);
  if (tailLooksConclusive && paragraphs.length > 1) {
    return { visible: tail, reasoning: paragraphs.slice(0, -1).join('\n\n').trim() };
  }
  return { visible: '', reasoning: trimmed };
}

/**
 * Pull chain-of-thought blocks out of visible content and return both
 * halves. Several small models emit reasoning wrapped in tags expecting
 * the surrounding harness to hide it; without extraction, the user sees
 * the model's internal monologue rendered as the assistant message.
 *
 * Recognized shapes:
 *   - `<think>...</think>` — Qwen 3 family, DeepSeek-R1 distillates.
 *   - `<reasoning>...</reasoning>` — older R1 variants.
 *   - `[THINK]...[/THINK]` — Mistral Medium 3.5 / Magistral special-token shape.
 *   - `<|channel>NAME\n...<channel|>` and `<|channel|>NAME<|message|>...<|end|>`
 *     — gpt-oss style channel markers. Gemma 3/4 picked this shape up
 *     from training data exposure to gpt-oss outputs once routed
 *     through the verbose-family hint that asked for `<think>` tags.
 *     Asymmetric pipe placement (`<|channel>` open, `<channel|>` close)
 *     is the wild-caught pattern; both symmetric and asymmetric variants
 *     are matched.
 *   - Unclosed leading variants of any of the above — a truncated
 *     reasoning trace shouldn't dump everything as visible text.
 *
 * The captured reasoning is returned alongside the cleaned visible
 * text so the chat manager can stash it on `ChatMessage.reasoning`,
 * where the UI renders it behind a collapsed expander instead of
 * throwing it away.
 */
export function extractReasoning(text: string): { visible: string; reasoning: string } {
  if (!text) return { visible: text, reasoning: '' };
  const captured: string[] = [];
  let out = text;
  // gpt-oss canonical channel block: `<|channel|>NAME<|message|>BODY<|end|>`.
  // Strip the channel-name prefix from the captured body so the user
  // sees just the reasoning prose, not "analysis<|message|>...".
  out = out.replace(/<\|channel\|>([\s\S]*?)<\|end\|>/gi, (_m, inner: string) => {
    const m = inner.match(/^[a-zA-Z_][a-zA-Z0-9_-]*\s*<\|message\|>([\s\S]*)$/);
    captured.push(m ? m[1]! : inner);
    return '';
  });
  // Asymmetric channel block: `<|channel>NAME\nBODY<channel|>` (Gemma).
  // Channel name is on the same line as the opener, body follows
  // after a newline. Wild-caught Gemma 4 26B emissions also drop the
  // leading `<|` on the opener (`<channel>thought\n...<channel|>`),
  // so accept both forms on either side of the pair.
  out = out.replace(
    /<\|?\/?channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?[\s\S]*?<\|?\/?channel\|?>/gi,
    (m) => {
      const body = m
        .replace(/^<\|?\/?channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?\s*\n?/i, '')
        .replace(/<\|?\/?channel\|?>$/i, '');
      captured.push(body);
      return '';
    },
  );
  // Closed `<think>` / `<reasoning>` pairs.
  out = out.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/<reasoning>([\s\S]*?)<\/reasoning>/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Closed `[THINK]...[/THINK]` pairs — Mistral Medium 3.5 / Magistral.
  // These are real tokenizer special tokens, so a literal bracket form
  // in user prose is vanishingly rare; we strip case-insensitively.
  out = out.replace(/\[THINK\]([\s\S]*?)\[\/THINK\]/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Leading reasoning ending with </think> — the Qwen 3.6 with
  // `enable_thinking=True` shape. The chat template injects
  // `<think>\n` into the prompt suffix, so the model's emitted
  // output starts mid-reasoning (no opening tag visible) and emits
  // `</think>` before the visible reply. Anchored to start of input
  // (per-iteration content has at most one such block) — drops
  // everything from start up to and including the first `</think>`.
  // Without this anchor, stray `</think>` markers later in the text
  // would also be matched and eat visible content between them.
  out = out.replace(/^([\s\S]*?)<\/think>\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/^([\s\S]*?)<\/reasoning>\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Same leading-only shape for `[/THINK]` — Mistral chat templates that
  // prefill `[THINK]\n` so the model output starts mid-reasoning.
  out = out.replace(/^([\s\S]*?)\[\/THINK\]\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Unclosed leading `<think>...` / `<|channel>...` / `[THINK]...`.
  out = out.replace(/<think>([\s\S]*?)(?:<\/think>|\n\n)/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/\[THINK\]([\s\S]*?)(?:\[\/THINK\]|\n\n)/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(
    /<\|channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?\n([\s\S]*?)(?:<\/?channel\|?>|\n\n)/i,
    (_m, inner: string) => {
      captured.push(inner);
      return '';
    },
  );
  // Stray tags that escaped the above patterns.
  out = out.replace(/<\/?think>/gi, '');
  out = out.replace(/<\/?reasoning>/gi, '');
  out = out.replace(/\[\/?THINK\]/gi, '');
  out = out.replace(/<\|?\/?channel\|?>/gi, '');
  out = out.replace(/<\|message\|>/gi, '');
  out = out.replace(/<\|end\|>/gi, '');
  // Chat-template framing tokens — turn / sequence / tool-response
  // delimiters the model sometimes emits as literal special-token text
  // on tight quants. Wild-caught from gemma4-e4b-q4, which streamed
  // `<eos><|tool_response><eos>` as visible content after firing its
  // tool calls (the detokenizer renders special tokens because
  // `decode()` keeps them). These are pure framing, never reasoning or
  // reply prose, so we drop them silently rather than capture.
  //
  // The tool-CALL markers (`<|tool_call>` / `<tool_call|>`) are
  // deliberately excluded: the streaming LeakyToolCallStripper owns
  // those and needs them intact to salvage tool calls upstream of here.
  out = out.replace(
    /<\|?(?:eos|bos|pad|unk|mask|turn|tool_response|start_of_turn|end_of_turn|im_start|im_end)\|?>/gi,
    '',
  );
  const visible = out.replace(/\n{3,}/g, '\n\n').trim();
  const reasoning = captured
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
  return { visible, reasoning };
}

/**
 * Visible-only convenience wrapper around {@link extractReasoning} —
 * returns just the cleaned text and drops the captured reasoning.
 *
 * Use cases:
 *   - Read-time scrubbing of historical assistant messages before
 *     replaying them to a stateless local provider. Two reasons it
 *     matters: (1) self-feedback — Gemma 4 sees its own past
 *     `<|channel>thought ... <channel|>` blocks in the transcript and
 *     either copies the pattern or misreads them as a system error;
 *     (2) backfill — messages persisted before `extractReasoning`
 *     shipped still have raw markup baked into `content`.
 *   - Anywhere the captured reasoning has already been promoted onto
 *     `ChatMessage.reasoning` (or doesn't need to be promoted at all)
 *     and the caller just wants the visible text.
 *
 * Prefer {@link extractReasoning} when you DO want to keep the
 * captured trace.
 */
export function stripReasoningTags(text: string): string {
  return extractReasoning(text).visible;
}

/**
 * Convert JS-style single-quoted strings to JSON-compatible
 * double-quoted strings, leaving content inside double-quoted
 * strings alone. Small models often emit `{ name: 'X' }` instead of
 * `{ name: "X" }`; without this step `JSON.parse` rejects perfectly
 * valid intent. Inside a single-quoted string, any embedded double
 * quote gets escaped so the resulting JSON parses.
 */
function singleToDoubleQuotes(json: string): string {
  let out = '';
  let i = 0;
  while (i < json.length) {
    const ch = json[i]!;
    if (ch === '"') {
      // Pass through a JSON-style double-quoted string verbatim,
      // including any apostrophes it contains.
      out += ch;
      i++;
      while (i < json.length) {
        const c2 = json[i]!;
        out += c2;
        if (c2 === '\\' && i + 1 < json.length) {
          out += json[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c2 === '"') break;
      }
      continue;
    }
    if (ch === "'") {
      // Convert a single-quoted string into a double-quoted one,
      // escaping any embedded `"` so the result is valid JSON.
      out += '"';
      i++;
      while (i < json.length) {
        const c2 = json[i]!;
        if (c2 === '\\' && i + 1 < json.length) {
          const next = json[i + 1]!;
          // `\'` is a legal escape in Python/JS single-quoted strings but is
          // NOT valid JSON, so copying it through makes `JSON.parse` reject
          // the whole object. An apostrophe needs no escape inside a JSON
          // double-quoted string, so emit it bare. Wild-caught on LFM2.5,
          // whose chat template escapes every `'` in a tool argument: a
          // complete `write_file` carrying ordinary JS (`gameState =
          // \'playing\'`) parsed to zero spans and the deliverable was
          // dropped on the floor.
          out += next === "'" ? "'" : c2 + next;
          i += 2;
          continue;
        }
        if (c2 === "'") {
          out += '"';
          i++;
          break;
        }
        if (c2 === '"') {
          out += '\\"';
          i++;
          continue;
        }
        out += c2;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findMatchingBrace(text: string, openIdx: number): number {
  // Walk forward counting brace depth, ignoring braces inside string
  // literals. Handles backslash-escaped quotes within strings.
  let depth = 0;
  let inString = false;
  let stringChar: '"' | "'" | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) {
        i++;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Escape unescaped control chars (newlines, carriage returns, tabs)
 * that appear inside JSON string literals. JSON forbids literal
 * control chars in strings — they have to be `\n` / `\r` / `\t`. Local
 * models frequently emit multi-line content (markdown bullet lists,
 * paragraph breaks) inside string args; without this pass `JSON.parse`
 * rejects the body and the call lands in `unrepairedBodies`.
 *
 * String-aware: walks character by character, only escapes when inside
 * a `"..."` or `'...'` boundary. Outside strings, newlines stay as
 * literal newlines (they're whitespace JSON allows). Backslash
 * escapes are passed through verbatim so existing `\n` sequences
 * aren't double-escaped.
 *
 * Wild-caught from a Gemma 4 26B `start_project` call where the
 * `missionObjectives` arg was a multi-line bullet list — the body
 * looked perfect but `JSON.parse` failed because the parse pipeline
 * had no step that escaped the embedded newlines.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar: '"' | "'" | null = null;
  while (i < json.length) {
    const ch = json[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < json.length) {
        out += ch + json[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
        out += ch;
        i++;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        i++;
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        i++;
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripGemmaSpecialTokens(body: string): string {
  // `<|"|>` → `"` (literal Gemma special token for the quote glyph).
  // `*/`    → `"` (Gemma's close-quote-end-of-string special token).
  // The substitutions are unambiguous in tool-call body context:
  // both sequences only appear in the leaked-marker space, not in
  // legitimate JSON arg values that the model would write.
  return body.replace(/<\|"\|>/g, '"').replace(/\*\//g, '"');
}

function quoteBareKeys(json: string): string {
  // Quote any bare-identifier key (a sequence of word chars before `:`)
  // that isn't already inside string literals. The replacement is
  // string-aware via a simple state machine — JSON.stringify would
  // happily round-trip already-quoted keys, but a regex that ignores
  // string context can corrupt values like `{"url": "http://x:80"}`
  // (the `x:` would gain double quotes). The state machine sidesteps
  // that.
  let out = '';
  let i = 0;
  let inString = false;
  while (i < json.length) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < json.length) {
        out += json[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    // Bare key candidate: word chars followed by optional whitespace + `:`
    const tail = json.slice(i);
    const m = tail.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (m) {
      out += `"${m[1]}":`;
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Drop trailing commas before `]` or `}` so Gemma's
 * `{key: "v", other: 1,}` shape parses as JSON. The walker is
 * string-aware (mirrors {@link quoteBareKeys}) so a comma inside a
 * legitimate string value never gets touched.
 *
 * Wild-caught: Gemma 4 26B produces `{name: "X", about: "Y",}` on
 * roughly 1 in 5 tool calls — model is mid-token-prediction when it
 * decides to close the args block, the trailing comma slips through.
 * JSON.parse rejects it and the body lands in `unrepairedBodies`.
 */
function stripTrailingCommas(json: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < json.length) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < json.length) {
        out += json[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === ',') {
      // Look ahead past whitespace; if the next non-ws char closes a
      // collection, drop this comma. Otherwise keep it.
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      if (j < json.length && (json[j] === '}' || json[j] === ']')) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Layer 3 — shared "auto-continuation on truncated write-shaped calls"
// helpers consumed by every local provider's tool loop. The MLX
// provider was the first to wire this; this module-level extraction
// gives Ollama and llama-cpp the same behavior without duplicating the
// logic three ways.

/**
 * Tool names that can land partial bytes safely (the call already
 * implies "overwrite or extend a file"). When truncation happens
 * mid-content for one of these, the framework synthesizes the call
 * with the partial bytes received so far and appends a continuation
 * hint to the tool result instructing the model to issue
 * `append_to_file` for the missing tail.
 *
 * Excludes tools whose semantics would be corrupted by partial args
 * (e.g. `read_artifact`, `start_project`, `set_task_status`).
 */
const WRITE_SHAPED_TOOL_NAMES = new Set(['write_file', 'write_artifact', 'append_to_file']);

export interface TruncationSalvageResult {
  /**
   * Synthesized tool call carrying the partial bytes — provider-agnostic
   * shape. `id` is unique per turn iteration; `name` + `argsObject`
   * are what gets passed to the MCP bridge. Providers that prefer a
   * JSON-stringified args form (MLX, llama-cpp) can stringify on the
   * way into their `tool_calls` array.
   *
   * Null when no recoverable truncation was found, or when the
   * truncation isn't on a write-shaped tool, or when partial args
   * lacked the required `path` + `content` strings.
   */
  synthesizedCall: {
    id: string;
    name: string;
    argsObject: { path: string; content: string };
  } | null;
  /**
   * The turn content with the truncated tail removed. When
   * synthesizedCall is non-null, callers should replace turnContent
   * with this so the user doesn't see the partial JSON / prose-call
   * body rendered alongside the actual tool widget.
   */
  strippedContent: string;
  /** Diagnostic — the tool name we found mid-stream. */
  wanted: string | null;
}

/**
 * Detect a truncated write-shaped tool call in the turn content,
 * extract partial args, and produce a synthesized tool_call the
 * provider can feed into its existing tool-execution path.
 *
 * Tries the JSON-envelope detector first (more structurally
 * informative than the prose one), falls back to prose. Gated on:
 *   - tool name being write-shaped (write_file / write_artifact / append_to_file)
 *   - `path` arg present and string
 *   - `content` arg present and string
 *
 * Any other shape returns `{synthesizedCall: null, ...}`. Callers
 * should fall through to the standard warning-only path in that
 * case.
 *
 * `callIdPrefix` should be unique per turn — typically
 * `truncated-salvage-<provider>-<seq>-<turn>` — to keep call ids
 * disjoint across iterations of the tool loop.
 */
export function salvageWriteShapedTruncation(
  turnContent: string,
  knownToolNames: ReadonlySet<string>,
  callIdPrefix: string,
): TruncationSalvageResult {
  const empty: TruncationSalvageResult = {
    synthesizedCall: null,
    strippedContent: turnContent,
    wanted: null,
  };
  if (!turnContent) return empty;

  const envCandidate = findTruncatedJsonEnvelope(turnContent);
  const proseCandidate = findTruncatedProseToolCall(turnContent, knownToolNames);
  const cand = envCandidate?.wanted ? envCandidate : proseCandidate;
  if (!cand?.wanted) {
    return { ...empty, wanted: envCandidate?.wanted ?? proseCandidate?.wanted ?? null };
  }
  if (!WRITE_SHAPED_TOOL_NAMES.has(cand.wanted)) {
    return { ...empty, wanted: cand.wanted };
  }
  if (typeof cand.partialArgs.path !== 'string' || typeof cand.partialArgs.content !== 'string') {
    return { ...empty, wanted: cand.wanted };
  }
  const id = `${callIdPrefix}-0`;
  const strippedContent = turnContent.slice(0, cand.matchStart).trimEnd();
  return {
    synthesizedCall: {
      id,
      name: cand.wanted,
      argsObject: {
        path: cand.partialArgs.path,
        content: cand.partialArgs.content,
      },
    },
    strippedContent,
    wanted: cand.wanted,
  };
}

/**
 * Append a continuation hint to a tool result when the call was
 * tagged as truncated. The hint instructs the model to issue
 * `append_to_file` for the missing tail rather than re-emit the whole
 * file (which would just truncate again on the same byte budget).
 *
 * Idempotent — appends only once even if called multiple times on
 * the same output. Returns the input unchanged when:
 *   - the tool name isn't write-shaped (we'd send a confusing hint)
 *   - the tool result already starts with `ERROR:` (the write
 *     failed; pointing the model at the partial bytes would be
 *     wrong since they didn't land)
 *   - `args.content` isn't a string (nothing to size the byte report
 *     against)
 */
export function appendTruncationHintToToolResult(
  toolResult: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (!WRITE_SHAPED_TOOL_NAMES.has(toolName)) return toolResult;
  if (toolResult.startsWith('ERROR:')) return toolResult;
  if (typeof args.content !== 'string') return toolResult;
  // Idempotency check — the marker phrase below is stable across
  // versions so the test is reliable even when prose wording shifts.
  if (toolResult.includes('[runtime] Your `') && toolResult.includes('was streamed mid-content')) {
    return toolResult;
  }
  const path =
    typeof args.path === 'string'
      ? args.path
      : typeof args.name === 'string'
        ? args.name
        : '(unknown path)';
  const bytes = (args.content as string).length;
  // One large template literal (biome useTemplate/noUnusedTemplateLiteral
  // disallows the multi-line `+` form). Lines stay logically grouped via
  // the `\n` between sentences so the model still reads it as a numbered
  // recovery menu rather than a wall of prose.
  return `${toolResult}\n\n[runtime] Your \`${toolName}\` call for \`${path}\` was streamed mid-content and the closing markup never arrived; the file on disk contains the first ~${bytes} bytes you generated. If that content is incomplete (e.g. unclosed tags, missing JS, truncated CSS), your next message MUST emit ONE of these as its first tool call: (a) \`append_to_file(path="${path}", content="...the rest of the file, starting exactly where the truncated content left off...")\` — preferred for large files since you only need to write the missing tail; (b) \`${toolName}(path="${path}", content="...the FULL replacement content in a leaner form that fits in one stream...")\`. Do not narrate "the call got truncated" — just emit the corrective tool call directly.`;
}

/**
 * Append a recovery hint to a REJECTED write result whose generation hit
 * the per-turn output token cap. Mirror-image of
 * {@link appendTruncationHintToToolResult}: that helper covers the case
 * where partial bytes landed on disk (append the tail); this one covers
 * the case where the write was refused outright (atomic validation kept
 * the previous file), so appending is wrong and re-emitting the full file
 * would just truncate again at the same cap. The only strategy that
 * converges is a sequence of smaller targeted edits.
 *
 * The ds4 shape of this failure: the engine salvages a tool call cut off
 * at the generation cap ("repaired unterminated tool call") and the MCP
 * validator rejects the half-file with a parse error, leaving the model
 * free to burn a full cap-length rewrite per retry unless steered here.
 *
 * Idempotent via the stable `hit the per-turn output token cap` marker.
 * Returns the input unchanged when:
 *   - the tool name isn't write-shaped
 *   - the result is NOT an `ERROR:` (the write landed; nothing to steer)
 *   - `args.content` isn't a string (nothing was truncated)
 */
export function appendCapTruncationHintToRejectedWrite(
  toolResult: string,
  toolName: string,
  args: Record<string, unknown>,
  maxTokens: number | null,
): string {
  if (!WRITE_SHAPED_TOOL_NAMES.has(toolName)) return toolResult;
  if (!toolResult.startsWith('ERROR:')) return toolResult;
  if (typeof args.content !== 'string') return toolResult;
  if (toolResult.includes('hit the per-turn output token cap')) return toolResult;
  const path =
    typeof args.path === 'string'
      ? args.path
      : typeof args.name === 'string'
        ? args.name
        : '(unknown path)';
  const capLabel = maxTokens !== null ? ` (max_tokens=${maxTokens})` : '';
  return `${toolResult}\n\n[runtime] Your \`${toolName}\` call for \`${path}\` hit the per-turn output token cap${capLabel} mid-content — the file body never finished, the write was rejected, and the file on disk is unchanged. Re-emitting the whole file WILL hit the same cap again; do not retry a full rewrite. Apply the change as a sequence of smaller targeted edits instead: \`replace_in_file(path="${path}", find="...", replace="...")\` or \`replace_lines(path="${path}", startLine=N, endLine=M, content="...")\`, using several calls if needed, each well under the cap. Do not narrate the failure — emit the first corrective edit call directly.`;
}

/**
 * Test seam: expose the write-shaped tool name set so providers and
 * tests don't redefine it inconsistently.
 */
export function isWriteShapedToolName(name: string): boolean {
  return WRITE_SHAPED_TOOL_NAMES.has(name);
}
