import type { ToolEnvelope } from './envelope.js';

/**
 * A reply that is exactly one Python-style tool call, `[name(key=value)]`,
 * as an envelope. LFM2 models call tools the way they were trained and never
 * write the JSON envelope: on a Galaxy S26+ every call LFM2.5 made across
 * seven trials was well formed in this shape, and none ran (2026-09-26).
 *
 * Keyword arguments and Python literals only (strings, numbers, True, False,
 * None, lists, dicts). Anything else, including prose around the call or a
 * second call, is not a call.
 */
export function parsePythonicToolCall(text: string): ToolEnvelope | null {
  if (text.length > 128_000) return null;
  const body = text
    .trim()
    .replace(/^<\|tool_call_start\|>/, '')
    .replace(/<\|tool_call_end\|>$/, '')
    .trim();
  if (!body.startsWith('[') || !body.endsWith(']')) return null;
  try {
    const parser = new PythonicParser(body.slice(1, -1));
    const call = parser.call();
    parser.end();
    return call;
  } catch {
    return null;
  }
}

class PythonicParser {
  private index = 0;
  constructor(private readonly source: string) {}

  call(): ToolEnvelope {
    this.space();
    const name = this.identifier();
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(name)) throw new Error('name');
    this.expect('(');
    const args: Record<string, unknown> = {};
    this.space();
    while (!this.take(')')) {
      const key = this.identifier();
      this.space();
      this.expect('=');
      if (Object.hasOwn(args, key)) throw new Error('duplicate');
      args[key] = this.value();
      this.space();
      if (!this.take(',')) {
        this.expect(')');
        break;
      }
      this.space();
    }
    return { name, arguments: args };
  }

  end(): void {
    this.space();
    this.take(',');
    this.space();
    if (this.index !== this.source.length) throw new Error('trailing');
  }

  private value(): unknown {
    this.space();
    const char = this.source[this.index];
    if (char === "'" || char === '"') return this.string(char);
    if (char === '[') return this.list();
    if (char === '{') return this.dict();
    const word = /^(?:True|False|None|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
      this.source.slice(this.index),
    )?.[0];
    if (!word) throw new Error('value');
    this.index += word.length;
    if (word === 'True') return true;
    if (word === 'False') return false;
    if (word === 'None') return null;
    return Number(word);
  }

  private list(): unknown[] {
    this.expect('[');
    const items: unknown[] = [];
    this.space();
    while (!this.take(']')) {
      items.push(this.value());
      this.space();
      if (!this.take(',')) {
        this.expect(']');
        break;
      }
      this.space();
    }
    return items;
  }

  private dict(): Record<string, unknown> {
    this.expect('{');
    const entries: Record<string, unknown> = {};
    this.space();
    while (!this.take('}')) {
      const quote = this.source[this.index];
      if (quote !== "'" && quote !== '"') throw new Error('key');
      const key = this.string(quote);
      this.space();
      this.expect(':');
      entries[key] = this.value();
      this.space();
      if (!this.take(',')) {
        this.expect('}');
        break;
      }
      this.space();
    }
    return entries;
  }

  private string(quote: string): string {
    this.index++;
    let out = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++]!;
      if (char === quote) return out;
      if (char !== '\\') {
        out += char;
        continue;
      }
      const next = this.source[this.index++];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'u') {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('escape');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 4;
      } else if (next !== undefined) out += next;
    }
    throw new Error('unterminated');
  }

  private identifier(): string {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))?.[0];
    if (!name) throw new Error('identifier');
    this.index += name.length;
    return name;
  }

  private space(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index++;
  }

  private take(char: string): boolean {
    if (this.source[this.index] !== char) return false;
    this.index++;
    return true;
  }

  private expect(char: string): void {
    if (!this.take(char)) throw new Error(`expected ${char}`);
  }
}
