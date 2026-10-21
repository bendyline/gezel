/**
 * Read, add, replace or remove one member of a nested object in a JSON or
 * JSONC file another app owns (`mcpServers.gezel` in Cursor's `mcp.json`,
 * `servers.gezel` in VS Code's), touching only that member's text. Comments,
 * key order, formatting and every other entry survive byte for byte, which a
 * parse-and-reserialize would not.
 */

interface Token {
  kind: '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'literal';
  start: number;
  end: number;
  value?: string;
}

interface Member {
  key: string;
  keyStart: number;
  value: Node;
  /** Index of the comma after this member, when one follows. */
  commaAfter?: number;
}

type Node =
  | { type: 'object'; start: number; end: number; members: Member[] }
  | { type: 'array'; start: number; end: number }
  | { type: 'literal'; start: number; end: number };

export class JsonMemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonMemberError';
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) throw new JsonMemberError('An unterminated comment.');
      i = close + 2;
      continue;
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({ kind: ch as Token['kind'], start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new JsonMemberError('An unterminated string.');
      const raw = text.slice(i, j + 1);
      tokens.push({ kind: 'string', start: i, end: j + 1, value: JSON.parse(raw) as string });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !' \t\n\r{}[]:,/"'.includes(text[j]!)) j++;
    if (j === i) throw new JsonMemberError(`Unexpected character at ${i}.`);
    tokens.push({ kind: 'literal', start: i, end: j });
    i = j;
  }
  return tokens;
}

function parse(text: string): Node | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  let pos = 0;
  const next = (): Token => {
    const token = tokens[pos++];
    if (!token) throw new JsonMemberError('The file ends too early.');
    return token;
  };
  const peek = (): Token | undefined => tokens[pos];

  const value = (): Node => {
    const token = next();
    if (token.kind === '{') {
      const members: Member[] = [];
      while (peek()?.kind !== '}') {
        const key = next();
        if (key.kind !== 'string') throw new JsonMemberError(`Expected a key at ${key.start}.`);
        if (next().kind !== ':') throw new JsonMemberError(`Expected ':' after ${key.value}.`);
        const member: Member = { key: key.value!, keyStart: key.start, value: value() };
        members.push(member);
        if (peek()?.kind === ',') member.commaAfter = next().start;
        else if (peek()?.kind !== '}') throw new JsonMemberError('Expected , or } in an object.');
      }
      return { type: 'object', start: token.start, end: next().end, members };
    }
    if (token.kind === '[') {
      let depth = 1;
      let end = token.end;
      while (depth > 0) {
        const inner = next();
        if (inner.kind === '[' || inner.kind === '{') depth++;
        if (inner.kind === ']' || inner.kind === '}') depth--;
        end = inner.end;
      }
      return { type: 'array', start: token.start, end };
    }
    if (token.kind === 'string' || token.kind === 'literal') {
      return { type: 'literal', start: token.start, end: token.end };
    }
    throw new JsonMemberError(`Unexpected ${token.kind} at ${token.start}.`);
  };

  const root = value();
  if (pos !== tokens.length) throw new JsonMemberError('Unexpected text after the JSON value.');
  return root;
}

/** Strip comments and trailing commas so a JSONC fragment parses as JSON. */
function toJson(fragment: string): string {
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const ch = fragment[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < fragment.length && fragment[j] !== '"') j += fragment[j] === '\\' ? 2 : 1;
      out += fragment.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && fragment[i + 1] === '/') {
      while (i < fragment.length && fragment[i] !== '\n') i++;
    } else if (ch === '/' && fragment[i + 1] === '*') {
      i = fragment.indexOf('*/', i + 2) + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** The indentation one level deeper than `object`'s own line, guessed from its members. */
function memberIndent(text: string, object: Extract<Node, { type: 'object' }>): string {
  const first = object.members[0];
  if (first && text.lastIndexOf('\n', first.keyStart) > object.start) {
    return lineIndent(text, first.keyStart);
  }
  return `${lineIndent(text, object.start)}  `;
}

function serialize(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function insertMember(
  text: string,
  object: Extract<Node, { type: 'object' }>,
  key: string,
  value: unknown,
): string {
  const indent = memberIndent(text, object);
  const entry = `${indent}${JSON.stringify(key)}: ${serialize(value, indent)}`;
  const closeIndent = lineIndent(text, object.end - 1);
  const last = object.members.at(-1);
  if (!last) {
    return `${text.slice(0, object.start + 1)}\n${entry}\n${closeIndent}${text.slice(object.end - 1)}`;
  }
  // After the end of the last member's line, so a trailing comment there
  // stays with the member it was written about.
  const afterValue = last.commaAfter === undefined ? last.value.end : last.commaAfter + 1;
  const newline = text.indexOf('\n', afterValue);
  const lineEnd = newline !== -1 && newline < object.end - 1 ? newline : afterValue;
  if (last.commaAfter !== undefined) {
    return `${text.slice(0, lineEnd)}\n${entry}${text.slice(lineEnd)}`;
  }
  return `${text.slice(0, last.value.end)},${text.slice(last.value.end, lineEnd)}\n${entry}${text.slice(lineEnd)}`;
}

function findObject(
  root: Node | null,
  path: readonly string[],
): {
  parent: Extract<Node, { type: 'object' }> | null;
  member: Member | null;
  missingAt: number;
} {
  if (!root) return { parent: null, member: null, missingAt: 0 };
  if (root.type !== 'object') throw new JsonMemberError('The file is not a JSON object.');
  let parent: Extract<Node, { type: 'object' }> = root;
  for (let depth = 0; depth < path.length; depth++) {
    const member = parent.members.find((m) => m.key === path[depth]);
    if (!member) return { parent, member: null, missingAt: depth };
    if (depth === path.length - 1) return { parent, member, missingAt: -1 };
    if (member.value.type !== 'object') {
      throw new JsonMemberError(`"${path.slice(0, depth + 1).join('.')}" is not an object.`);
    }
    parent = member.value;
  }
  return { parent, member: null, missingAt: path.length };
}

/** The member's value, or undefined when the file or the member is absent. */
export function readJsonMember(content: string | null, path: readonly string[]): unknown {
  if (content === null || content.trim() === '') return undefined;
  const found = findObject(parse(content), path);
  if (!found.member) return undefined;
  return JSON.parse(toJson(content.slice(found.member.value.start, found.member.value.end)));
}

/** Set the member at `path` to `value`, creating the objects above it as needed. */
export function upsertJsonMember(
  content: string | null,
  path: readonly string[],
  value: unknown,
): string {
  if (path.length === 0) throw new JsonMemberError('An empty path.');
  if (content === null || content.trim() === '') {
    const nested = path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
    return `${JSON.stringify(nested, null, 2)}\n`;
  }
  const root = parse(content);
  const found = findObject(root, path);
  if (found.member) {
    const indent = lineIndent(content, found.member.keyStart);
    return (
      content.slice(0, found.member.value.start) +
      serialize(value, indent) +
      content.slice(found.member.value.end)
    );
  }
  const rest = path.slice(found.missingAt);
  const nested = rest.slice(1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  return insertMember(content, found.parent!, rest[0]!, nested);
}

/** Remove the member at `path`; the file is otherwise unchanged. */
export function removeJsonMember(content: string, path: readonly string[]): string {
  const found = findObject(parse(content), path);
  const member = found.member;
  if (!member || !found.parent) return content;
  const members = found.parent.members;
  const index = members.indexOf(member);
  const lineStart = content.lastIndexOf('\n', member.keyStart - 1);
  const from = lineStart > found.parent.start ? lineStart : member.keyStart;
  if (member.commaAfter !== undefined) {
    return content.slice(0, from) + content.slice(member.commaAfter + 1);
  }
  if (index > 0) {
    const previousComma = members[index - 1]!.commaAfter;
    if (previousComma === undefined) throw new JsonMemberError('A missing separator.');
    return content.slice(0, previousComma) + content.slice(member.value.end);
  }
  return content.slice(0, from) + content.slice(member.value.end);
}
