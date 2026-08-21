/**
 * Display rendering for a live `tool_args_delta` fragment.
 *
 * The fragment is raw wire JSON: a file being written arrives as one
 * escaped string value, so the streaming block used to read
 * `Criterion 1: PASS\n- Criterion 2: FAIL\n-…` — literal backslash-n
 * and backslash-quote, the file's own line breaks invisible. What the
 * user is watching is the *file*, so decode the encoding away.
 *
 * Two shapes reach us, and the opening brace tells them apart. While
 * the args still fit under the tail cap the fragment is the whole
 * object so far (`{"path":"a.md","content":"…`) and renders as the
 * same `key: value` blocks the persisted "details" disclosure shows
 * (`renderFullToolArgs` on the service side) — live and committed
 * views of one call should not disagree about its shape. Past the cap
 * the fragment starts mid-string with no key context, so it is decoded
 * as the string body it is.
 *
 * Everything here tolerates a fragment cut anywhere — mid-escape,
 * mid-key, mid-value. A partial parse is the normal case, not an error.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Decode the escape sequence starting at `at` (which must point at a
 * backslash). Returns null when the fragment ends mid-sequence — the
 * caller drops the partial rather than printing half of it.
 */
function decodeEscapeAt(src: string, at: number): { text: string; length: number } | null {
  const next = src[at + 1];
  if (next === undefined) return null;
  if (next === 'u') {
    const hex = src.slice(at + 2, at + 6);
    if (hex.length < 4) return null;
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return { text: String.fromCharCode(Number.parseInt(hex, 16)), length: 6 };
    }
    return { text: '\\u', length: 2 };
  }
  const mapped = SIMPLE_ESCAPES[next];
  // An unknown escape means the model emitted invalid JSON; keep both
  // characters so a stray `\d` in the content survives verbatim.
  return mapped === undefined ? { text: `\\${next}`, length: 2 } : { text: mapped, length: 2 };
}

/** Decode JSON escapes in a fragment that is (or starts) inside a string value. */
export function decodeJsonEscapes(fragment: string): string {
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const ch = fragment[i]!;
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const decoded = decodeEscapeAt(fragment, i);
    if (!decoded) break;
    out += decoded.text;
    i += decoded.length;
  }
  return out;
}

interface ScannedString {
  text: string;
  end: number;
  closed: boolean;
}

/** Read a JSON string whose opening quote sits at `from`. */
function readString(src: string, from: number): ScannedString {
  let out = '';
  let i = from + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') return { text: out, end: i + 1, closed: true };
    if (ch === '\\') {
      const decoded = decodeEscapeAt(src, i);
      if (!decoded) break;
      out += decoded.text;
      i += decoded.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { text: out, end: src.length, closed: false };
}

/**
 * Read a non-string value (number, boolean, null, object, array) as raw
 * text, stopping at the top-level `,` or `}` that ends it.
 */
function readRawValue(src: string, from: number): { text: string; end: number } {
  let depth = 0;
  let inString = false;
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 0) break;
    i += 1;
  }
  return { text: src.slice(from, i).trim(), end: i };
}

export interface ToolArgsField {
  key: string;
  value: string;
}

/**
 * Scan as many complete-or-partial `"key": value` pairs as the fragment
 * carries. Returns null when the fragment does not open an object.
 */
export function scanToolArgsObject(fragment: string): ToolArgsField[] | null {
  let i = 0;
  while (i < fragment.length && /\s/.test(fragment[i]!)) i += 1;
  if (fragment[i] !== '{') return null;
  i += 1;
  const fields: ToolArgsField[] = [];
  while (i < fragment.length) {
    while (i < fragment.length && /[\s,]/.test(fragment[i]!)) i += 1;
    if (i >= fragment.length || fragment[i] === '}') break;
    if (fragment[i] !== '"') break;
    const key = readString(fragment, i);
    i = key.end;
    if (!key.closed) break;
    while (i < fragment.length && /\s/.test(fragment[i]!)) i += 1;
    if (fragment[i] !== ':') break;
    i += 1;
    while (i < fragment.length && /\s/.test(fragment[i]!)) i += 1;
    if (i >= fragment.length) {
      fields.push({ key: key.text, value: '' });
      break;
    }
    if (fragment[i] === '"') {
      const value = readString(fragment, i);
      fields.push({ key: key.text, value: value.text });
      i = value.end;
      continue;
    }
    const value = readRawValue(fragment, i);
    fields.push({ key: key.text, value: value.text });
    i = value.end;
  }
  return fields;
}

/** Same block layout the persisted details disclosure uses. */
function renderFields(fields: ToolArgsField[]): string {
  return fields
    .map(({ key, value }) =>
      value.includes('\n') || value.length > 80 ? `${key}:\n${value}` : `${key}: ${value}`,
    )
    .join('\n\n');
}

/**
 * Turn a streamed tool-args fragment into the text to show the user:
 * the file content as it will land on disk, not its JSON encoding.
 */
export function renderToolArgsFragment(fragment: string): string {
  if (fragment.trim().length === 0) return '';
  const fields = scanToolArgsObject(fragment);
  if (fields && fields.length > 0) return renderFields(fields);
  return decodeJsonEscapes(fragment);
}
