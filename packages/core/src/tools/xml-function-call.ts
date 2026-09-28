import type { ToolEnvelope } from './envelope.js';

const CALL_OPEN = /^<function\s+name\s*=\s*"([a-z][a-z0-9_]{0,79})"\s*>/;
const CALL_CLOSE = /<\/function\s*>$/;
const PARAM_OPEN = /^\s*<param\s+name\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*>/;
const CDATA_VALUE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/param\s*>/;
const PARAM_CLOSE = /<\/param\s*>/;

function scalar(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * The `<param name="k">v</param>` sequence inside one MiniCPM5 call. A CDATA
 * value is the model saying "this is text": it is kept verbatim and never
 * coerced, so a file whose content is `42` stays a string. Anything but
 * params and whitespace between them makes the body unreadable (null).
 */
export function parseXmlFunctionParams(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let rest = body;
  while (rest.trim()) {
    const head = PARAM_OPEN.exec(rest);
    if (!head) return null;
    rest = rest.slice(head[0].length);
    const cdata = CDATA_VALUE.exec(rest);
    if (cdata) {
      args[head[1]!] = cdata[1]!;
      rest = rest.slice(cdata[0].length);
      continue;
    }
    const end = PARAM_CLOSE.exec(rest);
    if (!end) return null;
    args[head[1]!] = scalar(rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return args;
}

/**
 * A reply that is exactly one MiniCPM5 native tool call,
 * `<function name="x"><param name="k">v</param></function>`, with multi-line
 * or markup-bearing values in CDATA. MiniCPM5's chat template teaches this
 * shape, so a phone run asked for the JSON envelope can still answer in it.
 * The closing tag may be missing when the reply ended on the call itself; a
 * second call, or prose around the call, is not one call and never executes.
 */
export function parseXmlFunctionCall(text: string): ToolEnvelope | null {
  if (text.length > 128_000) return null;
  const trimmed = text.trim();
  const head = CALL_OPEN.exec(trimmed);
  if (!head) return null;
  const args = parseXmlFunctionParams(trimmed.slice(head[0].length).replace(CALL_CLOSE, ''));
  return args ? { name: head[1]!, arguments: args } : null;
}
