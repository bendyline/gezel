import type { ToolEnvelope } from './envelope.js';

const OPEN = '<|tool_call>';
const CLOSE = '<tool_call|>';
const QUOTE = '<|"|>';

/**
 * A reply that is exactly one Gemma 4 native tool call,
 * `<|tool_call>call:name{key:<|"|>text<|"|>}<tool_call|>`. Gemma 4 E4B
 * answered a phone task in its trained format rather than the JSON envelope
 * (Galaxy S26+, 2026-09-27). Strings sit between `<|"|>` tokens and are taken
 * verbatim; keys are bare identifiers. The closing marker may be missing when
 * the reply ended on the call itself. The same arguments in parentheses,
 * `call:list_scripts(project: "…")`, are the same call: E4B wrote that once in
 * the same run.
 */
export function parseGemmaToolCall(text: string): ToolEnvelope | null {
  if (text.length > 128_000) return null;
  let body = text.trim();
  if (!body.startsWith(OPEN)) return null;
  body = body.slice(OPEN.length);
  if (body.endsWith(CLOSE)) body = body.slice(0, -CLOSE.length);
  const head = /^\s*call:([a-z][a-z0-9_]{0,79})\s*(?=[{(])/.exec(body);
  if (!head) return null;
  try {
    const parser = new GemmaParser(body, head[0].length);
    const args = parser.value();
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    if (!parser.atEnd()) return null;
    return { name: head[1]!, arguments: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

class GemmaParser {
  constructor(
    private readonly source: string,
    private index: number,
  ) {}

  atEnd(): boolean {
    this.space();
    return this.index === this.source.length;
  }

  value(): unknown {
    this.space();
    if (this.source.startsWith(QUOTE, this.index)) {
      const end = this.source.indexOf(QUOTE, this.index + QUOTE.length);
      if (end < 0) throw new Error('unterminated');
      const text = this.source.slice(this.index + QUOTE.length, end);
      this.index = end + QUOTE.length;
      return text;
    }
    const char = this.source[this.index];
    if (char === '{') return this.object('}');
    if (char === '(' && this.index > 0 && /\w\s*$/.test(this.source.slice(0, this.index)))
      return this.object(')');
    if (char === '[') return this.list();
    if (char === '"') {
      const match = /^"(?:[^"\\]|\\.)*"/.exec(this.source.slice(this.index));
      if (!match) throw new Error('string');
      this.index += match[0].length;
      return JSON.parse(match[0]) as string;
    }
    const word = /^(?:true|false|null|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
      this.source.slice(this.index),
    )?.[0];
    if (!word) throw new Error('value');
    this.index += word.length;
    return word === 'true'
      ? true
      : word === 'false'
        ? false
        : word === 'null'
          ? null
          : Number(word);
  }

  private object(close: '}' | ')'): Record<string, unknown> {
    this.index++;
    const entries: Record<string, unknown> = {};
    this.space();
    while (!this.take(close)) {
      const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))?.[0];
      if (!key || Object.hasOwn(entries, key)) throw new Error('key');
      this.index += key.length;
      this.space();
      if (!this.take(':')) throw new Error('colon');
      entries[key] = this.value();
      this.space();
      if (!this.take(',')) {
        if (!this.take(close)) throw new Error('object');
        break;
      }
      this.space();
    }
    return entries;
  }

  private list(): unknown[] {
    this.index++;
    const items: unknown[] = [];
    this.space();
    while (!this.take(']')) {
      items.push(this.value());
      this.space();
      if (!this.take(',')) {
        if (!this.take(']')) throw new Error('list');
        break;
      }
      this.space();
    }
    return items;
  }

  private space(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index++;
  }

  private take(char: string): boolean {
    if (this.source[this.index] !== char) return false;
    this.index++;
    return true;
  }
}
