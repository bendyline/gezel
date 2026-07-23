/**
 * Split a gezel script's source into three editable lenses — the
 * imports/comments **preamble**, the `export const meta = defineScript({...})`
 * **statement**, and the script **body** — and put them back together. This
 * powers the three-tab script editor (Raw / Properties / Script) in the UI.
 *
 * The UI cannot reuse the service's TypeScript-AST parser
 * (`packages/service/src/scripts/meta.ts`): that pulls in the `typescript`
 * compiler, which is far too heavy for the browser bundle. Instead this module
 * locates the meta statement with a small string/comment/template-literal-aware
 * scanner and parses the meta object literal with a tiny recursive-descent
 * parser. Both deliberately mirror the semantics of `meta.ts`:
 *   - the FIRST exported `meta` const wins;
 *   - `defineScript(...)` and a trailing `as const` / `satisfies` are unwrapped;
 *   - only literal shapes are accepted (no spreads, computed keys, or calls).
 *
 * The canonical schema (`ScriptMetaSchema`) is the final arbiter — every parse
 * path validates through it, so the form never sees a shape the runtime would
 * reject.
 */

import {
  type ScriptInputField,
  type ScriptMeta,
  ScriptMetaSchema,
  type ScriptOutputField,
} from '../schemas/script.js';

/* ────────────────────────────── Split / stitch ──────────────────────────── */

export interface SplitScriptSource {
  /** Everything before the meta statement: imports + any standalone comments. */
  preamble: string;
  /** Comment block (JSDoc or `//` lines) attached directly above the meta statement, or ''. */
  metaLeadingComment: string;
  /** The `export const meta = ...;` statement text, WITHOUT its leading comment. */
  metaText: string;
  /** Everything after the meta statement — the `const input = ...` body onward. */
  body: string;
  /** False when no meta statement could be located (Properties/Script tabs disable). */
  found: boolean;
}

/**
 * Locate the `export const meta = ...;` statement and split the source around
 * it. Never throws — returns `{ found: false }` with the whole source in
 * `preamble` when no meta statement is present.
 */
export function splitScriptSource(source: string): SplitScriptSource {
  const span = findMetaStatement(source);
  if (!span) {
    return { preamble: source, metaLeadingComment: '', metaText: '', body: '', found: false };
  }
  const before = source.slice(0, span.start);
  const { preamble, comment } = splitLeadingComment(before);
  const metaText = source.slice(span.start, span.end);
  const body = source.slice(span.end);
  return { preamble, metaLeadingComment: comment, metaText, body, found: true };
}

/**
 * Reassemble a full source from its three regions, normalizing the spacing
 * between them to a single blank line. The result always ends in one newline,
 * matching the scaffold output.
 */
export function stitchScriptSource(parts: {
  preamble: string;
  /** The full meta region (leading comment + statement), or just the statement. */
  metaText: string;
  body: string;
}): string {
  const regions = [parts.preamble.trim(), parts.metaText.trim(), parts.body.trim()].filter(
    (s) => s.length > 0,
  );
  return `${regions.join('\n\n')}\n`;
}

/** Join a split's leading comment and statement back into one meta region. */
export function joinMetaRegion(
  split: Pick<SplitScriptSource, 'metaLeadingComment' | 'metaText'>,
): string {
  return split.metaLeadingComment
    ? `${split.metaLeadingComment.trimEnd()}\n${split.metaText}`
    : split.metaText;
}

/**
 * Count the leading lines a full source devotes to "setup" — the preamble
 * (imports + standalone comments) plus the `export const meta = ...;`
 * statement, i.e. everything before the body begins.
 *
 * The Script tab feeds Monaco the WHOLE file (so `gezel`, `meta`, and
 * `InferredInput<typeof meta>` all resolve and type-check) but hides these
 * lines from view, so the user edits only the body. Returns 0 when there's no
 * meta statement — nothing to hide, and the Script tab is disabled anyway.
 */
export function setupLineSpan(source: string): number {
  const split = splitScriptSource(source);
  if (!split.found) return 0;
  // `body` is a suffix of `source`; everything before it is preamble + meta.
  const headLen = source.length - split.body.length;
  let newlines = 0;
  for (let i = 0; i < headLen; i++) {
    if (source.charCodeAt(i) === 10) newlines++;
  }
  // The meta's terminating `;` sits on line `newlines + 1`. When the body
  // starts on its own line (the scaffold/stitch always inserts a blank line
  // between meta and body), hide through that line so the visible region opens
  // at the body. When a hand-written one-liner puts body text after the `;` on
  // the same line, stop one line short so no body text is hidden.
  return split.body.startsWith('\n') ? newlines + 1 : newlines;
}

/* ─────────────────────── Statement-locating scanner ─────────────────────── */

interface MetaSpan {
  start: number;
  end: number;
}

const META_TOKEN = /export[ \t\r\n]+const[ \t\r\n]+meta\b/y;

/**
 * Scan `source` for the first `export const meta` at brace depth 0 outside any
 * string/comment, then walk its initializer to the terminating `;`. Returns the
 * `[start, end)` byte span of the statement, or null.
 */
function findMetaStatement(source: string): MetaSpan | null {
  const n = source.length;
  let i = 0;
  let depth = 0;
  let metaStart = -1;

  while (i < n) {
    const ch = source[i]!;

    // Comments
    if (ch === '/' && source[i + 1] === '/') {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i);
      continue;
    }
    // Strings & template literals
    if (ch === "'" || ch === '"') {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }

    // Depth tracking
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      i++;
      continue;
    }

    // Terminating semicolon for the meta statement.
    if (metaStart >= 0 && ch === ';' && depth === 0) {
      return { start: metaStart, end: i + 1 };
    }

    // Candidate detection: `export const meta` at depth 0, on a word boundary.
    if (metaStart < 0 && depth === 0 && ch === 'e') {
      const prev = i > 0 ? source[i - 1]! : '';
      if (!isIdentChar(prev)) {
        META_TOKEN.lastIndex = i;
        if (META_TOKEN.test(source)) {
          metaStart = i;
          i = META_TOKEN.lastIndex;
          continue;
        }
      }
    }

    i++;
  }

  // ASI fallback: a meta statement with no trailing `;`. Take to end of source.
  if (metaStart >= 0) return { start: metaStart, end: n };
  return null;
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

function skipLineComment(s: string, from: number): number {
  let j = from + 2;
  while (j < s.length && s[j] !== '\n') j++;
  return j;
}

function skipBlockComment(s: string, from: number): number {
  let j = from + 2;
  while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
  return Math.min(j + 2, s.length);
}

function skipQuoted(s: string, from: number, quote: string): number {
  let j = from + 1; // past opening quote
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    j++;
  }
  return j;
}

function skipTemplate(s: string, from: number): number {
  let j = from + 1; // past opening backtick
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') return j + 1;
    if (c === '$' && s[j + 1] === '{') {
      // Nested expression — recurse via brace matching that respects nested
      // strings/templates.
      j = skipTemplateExpr(s, j + 2);
      continue;
    }
    j++;
  }
  return j;
}

function skipTemplateExpr(s: string, from: number): number {
  let j = from;
  let depth = 1;
  while (j < s.length && depth > 0) {
    const c = s[j]!;
    if (c === '/' && s[j + 1] === '/') {
      j = skipLineComment(s, j);
      continue;
    }
    if (c === '/' && s[j + 1] === '*') {
      j = skipBlockComment(s, j);
      continue;
    }
    if (c === "'" || c === '"') {
      j = skipQuoted(s, j, c);
      continue;
    }
    if (c === '`') {
      j = skipTemplate(s, j);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    j++;
  }
  return j;
}

/**
 * Peel a comment block attached directly above the meta statement (no blank
 * line between it and the statement). Mirrors TS `getLeadingCommentRanges`:
 * a comment separated from the statement by a blank line is NOT leading.
 */
function splitLeadingComment(before: string): { preamble: string; comment: string } {
  // A run of `//` lines, then only the meta-line indentation before the end.
  const lineBlock = /\n([ \t]*\/\/[^\n]*(?:\n[ \t]*\/\/[^\n]*)*)\n[ \t]*$/;
  // A single `/* ... */` block, then only the meta-line indentation.
  const blockBlock = /\n([ \t]*\/\*[\s\S]*?\*\/)\n[ \t]*$/;
  const m = lineBlock.exec(before) ?? blockBlock.exec(before);
  if (!m) return { preamble: before, comment: '' };
  return { preamble: before.slice(0, m.index), comment: m[1]! };
}

/* ─────────────────────────── Meta object parsing ────────────────────────── */

/**
 * Parse a meta statement's object literal into a validated `ScriptMeta`. This
 * is the one place the UI reads meta back out of text (after a Raw-tab edit);
 * `initialMeta` from the server covers the initial load.
 */
export function parseMetaObject(
  metaText: string,
): { ok: true; meta: ScriptMeta } | { ok: false; error: string } {
  const braceIdx = metaText.indexOf('{');
  if (braceIdx < 0) return { ok: false, error: 'meta has no object literal' };
  let raw: unknown;
  try {
    raw = new LiteralParser(metaText, braceIdx).parseTopLevel();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const parsed = ScriptMetaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`);
    return { ok: false, error: issues.join('; ') };
  }
  return { ok: true, meta: parsed.data };
}

/**
 * Minimal recursive-descent parser for the JS object-literal subset the meta
 * block uses: objects (identifier or string keys, trailing commas), arrays,
 * single/double/template (no-substitution) strings, numbers, booleans, null,
 * unary minus, and `//` / block comments as whitespace. Rejects anything richer
 * (spreads, computed keys, calls) — matching the service-side extractor.
 */
class LiteralParser {
  private i: number;
  constructor(
    private readonly s: string,
    start: number,
  ) {
    this.i = start;
  }

  parseTopLevel(): unknown {
    const v = this.parseValue();
    return v;
  }

  private parseValue(): unknown {
    this.skipWs();
    const c = this.s[this.i];
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === "'" || c === '"' || c === '`') return this.parseString();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.parseNumber();
    if (this.match('true')) return true;
    if (this.match('false')) return false;
    if (this.match('null')) return null;
    throw new Error(`unexpected token at ${this.i}`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    this.skipWs();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    while (true) {
      this.skipWs();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.parseKey();
      this.skipWs();
      this.expect(':');
      out[key] = this.parseValue();
      this.skipWs();
      const sep = this.s[this.i];
      if (sep === ',') {
        this.i++;
        continue;
      }
      if (sep === '}') {
        this.i++;
        return out;
      }
      throw new Error(`expected ',' or '}' at ${this.i}`);
    }
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    this.skipWs();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    while (true) {
      this.skipWs();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      out.push(this.parseValue());
      this.skipWs();
      const sep = this.s[this.i];
      if (sep === ',') {
        this.i++;
        continue;
      }
      if (sep === ']') {
        this.i++;
        return out;
      }
      throw new Error(`expected ',' or ']' at ${this.i}`);
    }
  }

  private parseKey(): string {
    const c = this.s[this.i];
    if (c === "'" || c === '"' || c === '`') return this.parseString();
    if (c === '[') throw new Error('computed property keys are not allowed in meta');
    // Bare identifier key.
    const start = this.i;
    while (this.i < this.s.length && isIdentChar(this.s[this.i]!)) this.i++;
    if (this.i === start) throw new Error(`expected a key at ${this.i}`);
    return this.s.slice(start, this.i);
  }

  private parseString(): string {
    const quote = this.s[this.i]!;
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '\\') {
        out += unescapeChar(this.s[this.i + 1]!);
        this.i += 2;
        continue;
      }
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c === '$' && quote === '`' && this.s[this.i + 1] === '{') {
        throw new Error('template interpolation is not allowed in meta');
      }
      out += c;
      this.i++;
    }
    throw new Error('unterminated string in meta');
  }

  private parseNumber(): number {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    while (this.i < this.s.length && /[0-9.eE+-]/.test(this.s[this.i]!)) this.i++;
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(n)) throw new Error(`invalid number at ${start}`);
    return n;
  }

  private match(word: string): boolean {
    if (this.s.startsWith(word, this.i) && !isIdentChar(this.s[this.i + word.length] ?? '')) {
      this.i += word.length;
      return true;
    }
    return false;
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.s[this.i] !== ch) throw new Error(`expected '${ch}' at ${this.i}`);
    this.i++;
  }

  private skipWs(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '/' && this.s[this.i + 1] === '/') {
        this.i = skipLineComment(this.s, this.i);
        continue;
      }
      if (c === '/' && this.s[this.i + 1] === '*') {
        this.i = skipBlockComment(this.s, this.i);
        continue;
      }
      return;
    }
  }
}

function unescapeChar(c: string): string {
  switch (c) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case '0':
      return '\0';
    default:
      return c; // \\, \', \", \`, etc.
  }
}

/* ────────────────────────────── Serialization ───────────────────────────── */

/** Escape a value for interpolation inside a single-quoted TS string. */
export function quoteSingle(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ')}'`;
}

const INPUT_KEY_ORDER: Record<ScriptInputField['type'], string[]> = {
  string: ['required', 'default', 'pattern', 'multiline'],
  number: ['required', 'default', 'min', 'max', 'integer'],
  boolean: ['required', 'default'],
  choice: ['required', 'default', 'options'],
  ref: ['required', 'kind'],
  json: ['required', 'default', 'schema'],
};

const OUTPUT_KEY_ORDER: Record<ScriptOutputField['type'], string[]> = {
  string: ['nullable'],
  number: ['nullable'],
  boolean: ['nullable'],
  array: ['itemType'],
  object: ['schema'],
  json: ['schema'],
};

/**
 * Serialize a `ScriptMeta` into a canonical `export const meta =
 * defineScript({...});` block matching the scaffold's formatting (2-space
 * indent, single quotes, trailing commas, descriptors inline).
 *
 * Note: this regenerates the block from data — any hand-written comments or
 * formatting INSIDE `defineScript({...})` are dropped. Callers re-serialize
 * only when the Properties form was actually edited.
 */
export function serializeScriptMeta(meta: ScriptMeta): string {
  const lines: string[] = ['export const meta = defineScript({'];
  lines.push(`  name: ${quoteSingle(meta.name)},`);
  lines.push(`  description: ${quoteSingle(meta.description)},`);
  if (meta.kind !== undefined) lines.push(`  kind: ${quoteSingle(meta.kind)},`);

  if (meta.inputs && Object.keys(meta.inputs).length > 0) {
    lines.push('  inputs: {');
    for (const [name, field] of Object.entries(meta.inputs)) {
      lines.push(`    ${propKey(name)}: ${renderInputDescriptor(field)},`);
    }
    lines.push('  },');
  }

  if (meta.outputs && Object.keys(meta.outputs).length > 0) {
    lines.push('  outputs: {');
    for (const [name, field] of Object.entries(meta.outputs)) {
      lines.push(`    ${propKey(name)}: ${renderOutputDescriptor(field)},`);
    }
    lines.push('  },');
  }

  lines.push(`  requires: ${renderRequires(meta.requires ?? [])},`);
  lines.push('});');
  return lines.join('\n');
}

function renderInputDescriptor(field: ScriptInputField): string {
  const parts: string[] = [
    `type: ${quoteSingle(field.type)}`,
    `description: ${quoteSingle(field.description)}`,
  ];
  const rec = field as unknown as Record<string, unknown>;
  for (const key of INPUT_KEY_ORDER[field.type]) {
    const v = rec[key];
    if (v === undefined) continue;
    parts.push(`${key}: ${renderValue(key, v)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function renderOutputDescriptor(field: ScriptOutputField): string {
  const parts: string[] = [
    `type: ${quoteSingle(field.type)}`,
    `description: ${quoteSingle(field.description)}`,
  ];
  const rec = field as unknown as Record<string, unknown>;
  for (const key of OUTPUT_KEY_ORDER[field.type]) {
    const v = rec[key];
    if (v === undefined) continue;
    parts.push(`${key}: ${renderValue(key, v)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function renderValue(key: string, value: unknown): string {
  if (key === 'options' && Array.isArray(value)) {
    const opts = value.map((o) => {
      const opt = o as { value: string; label?: string };
      return opt.label !== undefined
        ? `{ value: ${quoteSingle(opt.value)}, label: ${quoteSingle(opt.label)} }`
        : `{ value: ${quoteSingle(opt.value)} }`;
    });
    return `[${opts.join(', ')}]`;
  }
  if (typeof value === 'string') return quoteSingle(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  // json `default` / `schema` (unknown) — emit as compact JSON.
  return JSON.stringify(value);
}

function renderRequires(requires: string[]): string {
  if (requires.length === 0) return '[]';
  return `[${requires.map((r) => quoteSingle(r)).join(', ')}]`;
}

/** Emit a bare identifier key when valid, else a quoted string key. */
function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quoteSingle(name);
}

/* ─────────────────────── Meta ⇄ form-value converters ───────────────────── */

/**
 * The Properties form models `inputs`/`outputs` as ARRAYS of descriptors with a
 * synthetic `name` field — because squisq's `JsonEditor` edits one value object,
 * not a name-keyed record. `metaToFormValue` / `formValueToMeta` bridge the two.
 * JSON-valued fields (`default`/`schema` on json/object types) are carried as
 * pretty-printed JSON strings so they survive a round-trip through the form.
 */
export interface MetaInputFormItem {
  name: string;
  type: ScriptInputField['type'];
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  pattern?: string;
  multiline?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  options?: Array<{ value: string; label?: string }>;
  kind?: 'gezel' | 'task' | 'artifact' | 'document';
  defaultJson?: string;
  schemaJson?: string;
}

export interface MetaOutputFormItem {
  name: string;
  type: ScriptOutputField['type'];
  description: string;
  nullable?: boolean;
  itemType?: 'string' | 'number' | 'boolean' | 'object';
  schemaJson?: string;
}

export interface MetaFormValue {
  name: string;
  description: string;
  kind?: 'action' | 'gate';
  inputs: MetaInputFormItem[];
  outputs: MetaOutputFormItem[];
  requires: string[];
}

export function metaToFormValue(meta: ScriptMeta): MetaFormValue {
  return {
    name: meta.name,
    description: meta.description,
    kind: meta.kind,
    requires: [...(meta.requires ?? [])],
    inputs: Object.entries(meta.inputs ?? {}).map(([name, field]) => inputToFormItem(name, field)),
    outputs: Object.entries(meta.outputs ?? {}).map(([name, field]) =>
      outputToFormItem(name, field),
    ),
  };
}

function inputToFormItem(name: string, field: ScriptInputField): MetaInputFormItem {
  const base: MetaInputFormItem = { name, type: field.type, description: field.description };
  if ('required' in field && field.required !== undefined) base.required = field.required;
  switch (field.type) {
    case 'string':
      if (field.default !== undefined) base.default = field.default;
      if (field.pattern !== undefined) base.pattern = field.pattern;
      if (field.multiline !== undefined) base.multiline = field.multiline;
      break;
    case 'number':
      if (field.default !== undefined) base.default = field.default;
      if (field.min !== undefined) base.min = field.min;
      if (field.max !== undefined) base.max = field.max;
      if (field.integer !== undefined) base.integer = field.integer;
      break;
    case 'boolean':
      if (field.default !== undefined) base.default = field.default;
      break;
    case 'choice':
      if (field.default !== undefined) base.default = field.default;
      base.options = field.options.map((o) => ({ ...o }));
      break;
    case 'ref':
      base.kind = field.kind;
      break;
    case 'json':
      if (field.default !== undefined) base.defaultJson = JSON.stringify(field.default, null, 2);
      if (field.schema !== undefined) base.schemaJson = JSON.stringify(field.schema, null, 2);
      break;
  }
  return base;
}

function outputToFormItem(name: string, field: ScriptOutputField): MetaOutputFormItem {
  const base: MetaOutputFormItem = { name, type: field.type, description: field.description };
  switch (field.type) {
    case 'string':
    case 'number':
    case 'boolean':
      if (field.nullable !== undefined) base.nullable = field.nullable;
      break;
    case 'array':
      base.itemType = field.itemType;
      break;
    case 'object':
    case 'json':
      if (field.schema !== undefined) base.schemaJson = JSON.stringify(field.schema, null, 2);
      break;
  }
  return base;
}

/**
 * Rebuild a validated `ScriptMeta` from the form value. Rejects empty/duplicate
 * input or output names, strips keys irrelevant to the chosen `type` (left over
 * after a type switch), then validates through `ScriptMetaSchema`.
 */
export function formValueToMeta(
  v: MetaFormValue,
): { ok: true; meta: ScriptMeta } | { ok: false; issues: string[] } {
  const issues: string[] = [];

  const inputs = collectByName(v.inputs, (item) => formItemToInput(item, issues), 'input', issues);
  const outputs = collectByName(
    v.outputs,
    (item) => formItemToOutput(item, issues),
    'output',
    issues,
  );

  if (issues.length > 0) return { ok: false, issues };

  const candidate: Record<string, unknown> = {
    name: v.name,
    description: v.description,
  };
  if (v.kind) candidate.kind = v.kind;
  if (Object.keys(inputs).length > 0) candidate.inputs = inputs;
  if (Object.keys(outputs).length > 0) candidate.outputs = outputs;
  candidate.requires = v.requires ?? [];

  const parsed = ScriptMetaSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`),
    };
  }
  return { ok: true, meta: parsed.data };
}

function collectByName<T, R>(
  items: T[],
  convert: (item: T) => R | null,
  kind: string,
  issues: string[],
): Record<string, R> {
  const out: Record<string, R> = {};
  for (const item of items) {
    const name = (item as { name?: string }).name?.trim() ?? '';
    if (!name) {
      issues.push(`Every ${kind} needs a name.`);
      continue;
    }
    if (name in out) {
      issues.push(`Duplicate ${kind} name "${name}".`);
      continue;
    }
    const converted = convert(item);
    if (converted !== null) out[name] = converted;
  }
  return out;
}

function formItemToInput(item: MetaInputFormItem, issues: string[]): ScriptInputField | null {
  const base = { type: item.type, description: item.description ?? '' };
  switch (item.type) {
    case 'string':
      return clean({
        ...base,
        required: item.required,
        default: typeof item.default === 'string' ? item.default : undefined,
        pattern: item.pattern,
        multiline: item.multiline,
      }) as ScriptInputField;
    case 'number':
      return clean({
        ...base,
        required: item.required,
        default: typeof item.default === 'number' ? item.default : undefined,
        min: item.min,
        max: item.max,
        integer: item.integer,
      }) as ScriptInputField;
    case 'boolean':
      return clean({
        ...base,
        required: item.required,
        default: typeof item.default === 'boolean' ? item.default : undefined,
      }) as ScriptInputField;
    case 'choice':
      return clean({
        ...base,
        required: item.required,
        default: typeof item.default === 'string' ? item.default : undefined,
        options: (item.options ?? []).filter((o) => o.value).map((o) => clean({ ...o })),
      }) as ScriptInputField;
    case 'ref':
      return clean({ ...base, required: item.required, kind: item.kind }) as ScriptInputField;
    case 'json':
      return clean({
        ...base,
        required: item.required,
        default: parseJsonField(item.defaultJson, `input "${item.name}" default`, issues),
        schema: parseJsonField(item.schemaJson, `input "${item.name}" schema`, issues),
      }) as ScriptInputField;
  }
}

function formItemToOutput(item: MetaOutputFormItem, issues: string[]): ScriptOutputField | null {
  const base = { type: item.type, description: item.description ?? '' };
  switch (item.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return clean({ ...base, nullable: item.nullable }) as ScriptOutputField;
    case 'array':
      return clean({ ...base, itemType: item.itemType }) as ScriptOutputField;
    case 'object':
    case 'json':
      return clean({
        ...base,
        schema: parseJsonField(item.schemaJson, `output "${item.name}" schema`, issues),
      }) as ScriptOutputField;
  }
}

function parseJsonField(text: string | undefined, label: string, issues: string[]): unknown {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    issues.push(`${label} is not valid JSON.`);
    return undefined;
  }
}

/** Drop keys whose value is `undefined` so optional fields stay absent. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}
