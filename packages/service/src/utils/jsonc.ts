/**
 * JSON with comments and trailing commas (tsconfig, VS Code settings) to plain
 * JSON. Strings are copied untouched; an unclosed string or block comment
 * throws, so a truncated file is reported rather than half-read.
 */
export function jsoncToJson(input: string): string {
  let output = '';
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        output += ' ';
        i += 1;
      } else if (char === '\n' || char === '\r') output += char;
      continue;
    }
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      output += char;
    } else if (char === '/' && next === '/') {
      lineComment = true;
      output += ' ';
      i += 1;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      output += ' ';
      i += 1;
    } else {
      output += char;
    }
  }
  if (string || blockComment) throw new Error('Unclosed string or comment.');
  return stripTrailingCommas(output);
}

function stripTrailingCommas(input: string): string {
  let output = '';
  let string = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (next < input.length && /\s/.test(input[next]!)) next += 1;
      if (input[next] === '}' || input[next] === ']') continue;
    }
    output += char;
  }
  return output;
}
