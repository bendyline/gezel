import { parseGemmaToolCall } from './gemma-call.js';
import { parsePythonicToolCall } from './pythonic-call.js';
import { parseXmlFunctionCall } from './xml-function-call.js';

/** Strict completion-only protocol for text engines. Never execute JSON embedded
 * in prose, fenced examples, quoted documents, partial streams, or output cut off
 * by its token limit. */
export interface ToolEnvelope {
  name: string;
  arguments: Record<string, unknown>;
}
export function parseExactToolEnvelope(text: string): ToolEnvelope | null {
  if (text.length > 128_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.name !== 'string' ||
    !/^[a-z][a-z0-9_]{0,79}$/.test(record.name) ||
    !record.arguments ||
    typeof record.arguments !== 'object' ||
    Array.isArray(record.arguments)
  )
    return null;
  return { name: record.name, arguments: record.arguments as Record<string, unknown> };
}

const WHOLE_REPLY_FENCE = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Closes at most two objects or arrays a completion left open at its end.
 * Qwen 3.5 2B on a phone ended a correct `write_file` call with `}` for its
 * arguments and none for the call itself (2026-09-26). Only a completion that
 * stopped on its own reaches this; one cut off by its token limit never does.
 */
function closeUnbalanced(text: string): string | null {
  const open: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') open.push('}');
    else if (char === '[') open.push(']');
    else if (char === '}' || char === ']') {
      if (open.pop() !== char) return null;
    }
  }
  if (quoted || open.length === 0 || open.length > 2) return null;
  return text + open.reverse().join('');
}

/**
 * Drops object members that are a key with no value. Retrying a call whose
 * error listed every parameter, Gemini Nano sent two of them as bare keys,
 * `"allowWriteIn","multiSelect",` (Galaxy S26+, 2026-10-02). A key with no
 * value says nothing, so the call is the same without it.
 */
function dropBareKeys(text: string): string | null {
  const open: string[] = [];
  let expectingKey = false;
  let changed = false;
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char !== '"') {
      if (char === '{' || char === '[') open.push(char);
      else if (char === '}' || char === ']') open.pop();
      if (char === '{') expectingKey = true;
      else if (char === ',') expectingKey = open.at(-1) === '{';
      else if (char === '[' || char === '}' || char === ']' || char === ':') expectingKey = false;
      out += char;
      continue;
    }
    let end = index + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) return null;
    if (expectingKey) {
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] === ',') {
        changed = true;
        index = next;
        continue;
      }
      if (text[next] === '}') {
        changed = true;
        out = out.replace(/,\s*$/, '');
        index = next - 1;
        continue;
      }
      expectingKey = false;
    }
    out += text.slice(index, end + 1);
    index = end;
  }
  return changed ? out : null;
}

/**
 * A whole reply that is a call with its quotes escaped one level too many,
 * `{\"name\":\"make_move\", …}`. Gemini Nano wrote its calls this way on
 * a Galaxy S26+ (2026-10-06), and the reply reached the person as raw JSON.
 * Decoding the one extra level gives the call it meant; anything else stays
 * unparsed.
 */
function unescapeOnce(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\{\s*\\"/.test(trimmed)) return null;
  try {
    const decoded: unknown = JSON.parse(`"${trimmed.replace(/\r?\n/g, '\\n')}"`);
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

function parseWholeEnvelope(text: string): ToolEnvelope | null {
  const exact = parseExactToolEnvelope(text);
  if (exact) return exact;
  const unescaped = unescapeOnce(text);
  if (unescaped !== null) return parseWholeEnvelope(unescaped);
  const closed = closeUnbalanced(text.trim());
  const keyed = dropBareKeys(closed ?? text.trim());
  return (
    (closed ? parseExactToolEnvelope(closed) : null) ??
    (keyed ? parseExactToolEnvelope(keyed) : null) ??
    parsePythonicToolCall(text) ??
    parseGemmaToolCall(text) ??
    parseXmlFunctionCall(text)
  );
}

/**
 * A completion that is nothing but one code fence around the envelope is the
 * same call as the bare object. Small models fence their calls habitually:
 * Apple's on-device model fenced every one, and so did Qwen 3.5 2B on a phone
 * (2026-09). A fence inside prose is an example, and still never executes.
 */
export function parseToolEnvelopeReply(text: string): ToolEnvelope | null {
  const bare = parseWholeEnvelope(text);
  if (bare) return bare;
  const fenced = WHOLE_REPLY_FENCE.exec(text.trim());
  return fenced ? parseWholeEnvelope(fenced[1]!) : null;
}

/** A call's opening, whether its quotes are plain or escaped one level more. */
const CALL_OPENING = /\{\s*\\?"name\\?"\s*:/g;

/**
 * Where a reply's trailing tool call starts when prose comes before it, or -1.
 * Such a call never runs (JSON inside prose may be an example); the loop asks
 * for the call alone instead, and the person never sees the JSON.
 */
export function trailingToolCallStart(text: string): number {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) return -1;
  for (const match of trimmed.matchAll(CALL_OPENING)) {
    if (match.index === 0 || !trimmed.slice(0, match.index).trim()) continue;
    if (parseToolEnvelopeReply(trimmed.slice(match.index))) return match.index;
  }
  return -1;
}

/**
 * A reply as a person should read it: without a tool call written into it.
 * A reply that is nothing but a call, or prose followed by one, keeps only
 * its prose; a call that did not run is not something to show. Only text that
 * parses as a call goes: a reply that is JSON about a person named Alice stays.
 */
export function withoutToolCallText(text: string): string {
  if (parseToolEnvelopeReply(text)) return '';
  const start = trailingToolCallStart(text);
  return start > 0 ? text.trimEnd().slice(0, start).trimEnd() : text;
}
