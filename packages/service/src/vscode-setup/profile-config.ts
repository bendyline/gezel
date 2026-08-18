export interface VSCodeProviderEntry {
  name?: unknown;
  vendor?: unknown;
  [key: string]: unknown;
}

interface ArrayItem {
  segmentStart: number;
  start: number;
  end: number;
  commaAfter?: number;
}

interface ParsedConfig {
  close: number;
  providers: VSCodeProviderEntry[];
  items: ArrayItem[];
}

export interface VSCodeConfigInspection {
  providers: VSCodeProviderEntry[];
  gezelIndexes: number[];
  gezelProvider?: VSCodeProviderEntry;
}

export function inspectVSCodeConfig(content: string | null): VSCodeConfigInspection {
  if (content === null || content.trim() === '') {
    return { providers: [], gezelIndexes: [] };
  }
  const parsed = parseConfig(content);
  const gezelIndexes = parsed.providers.flatMap((provider, index) =>
    isGezelProvider(provider) ? [index] : [],
  );
  return {
    providers: parsed.providers,
    gezelIndexes,
    gezelProvider: gezelIndexes.length === 1 ? parsed.providers[gezelIndexes[0]!] : undefined,
  };
}

/** Add or replace only Gezel's provider entry, leaving all other raw JSONC intact. */
export function upsertGezelProvider(
  content: string | null,
  provider: VSCodeProviderEntry,
  opts?: { replaceConflict?: boolean },
): string {
  const serialized = indent(JSON.stringify(provider, null, 2), 2);
  if (content === null || content.trim() === '') return `\n[\n${serialized}\n]\n`.slice(1);
  const parsed = parseConfig(content);
  const indexes = parsed.providers.flatMap((entry, index) =>
    isGezelProvider(entry) ? [index] : [],
  );
  if (indexes.length > 1) {
    if (!opts?.replaceConflict) {
      throw new Error('The profile contains more than one Gezel provider entry.');
    }
    let withoutGezel = content;
    while (true) {
      const current = parseConfig(withoutGezel);
      const index = current.providers.findIndex(isGezelProvider);
      if (index === -1) break;
      withoutGezel = removeProviderAt(withoutGezel, current, index);
    }
    return upsertGezelProvider(withoutGezel, provider);
  }
  if (indexes.length === 1) {
    if (!opts?.replaceConflict) {
      throw new Error(
        'The profile already contains a Gezel provider entry that is not managed here.',
      );
    }
    const item = parsed.items[indexes[0]!]!;
    return content.slice(0, item.start) + serialized.trimStart() + content.slice(item.end);
  }
  if (parsed.items.length === 0) {
    return `${content.slice(0, parsed.close)}\n${serialized}\n${content.slice(parsed.close)}`;
  }
  const last = parsed.items.at(-1)!;
  const insertAt = last.commaAfter === undefined ? last.end : last.commaAfter + 1;
  const separator = last.commaAfter === undefined ? ',' : '';
  return `${content.slice(0, insertAt)}${separator}\n${serialized}\n${content.slice(insertAt)}`;
}

/** Remove only Gezel's provider entry; shared profile files are never deleted. */
export function removeGezelProvider(content: string): string {
  const parsed = parseConfig(content);
  const indexes = parsed.providers.flatMap((entry, index) =>
    isGezelProvider(entry) ? [index] : [],
  );
  if (indexes.length === 0) return content;
  if (indexes.length > 1)
    throw new Error('The profile contains more than one Gezel provider entry.');
  return removeProviderAt(content, parsed, indexes[0]!);
}

function removeProviderAt(content: string, parsed: ParsedConfig, index: number): string {
  const item = parsed.items[index]!;
  if (item.commaAfter !== undefined) {
    return content.slice(0, item.segmentStart) + content.slice(item.commaAfter + 1);
  }
  if (index > 0) {
    const previousComma = parsed.items[index - 1]!.commaAfter;
    if (previousComma === undefined) throw new Error('Could not locate the provider separator.');
    return content.slice(0, previousComma) + content.slice(item.end);
  }
  return content.slice(0, item.segmentStart) + content.slice(item.end);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isGezelProvider(provider: VSCodeProviderEntry): boolean {
  return provider.vendor === 'customendpoint' && provider.name === 'Gezel';
}

function parseConfig(content: string): ParsedConfig {
  const start = skipTrivia(content, 0);
  if (content[start] !== '[')
    throw new Error('chatLanguageModels.json must contain a provider array.');
  const items: ArrayItem[] = [];
  let cursor = start + 1;
  while (true) {
    const segmentStart = cursor;
    cursor = skipTrivia(content, cursor);
    if (content[cursor] === ']') {
      const close = cursor;
      if (skipTrivia(content, close + 1) !== content.length) {
        throw new Error('Unexpected content after the provider array.');
      }
      let providers: unknown;
      try {
        providers = JSON.parse(jsoncToJson(content));
      } catch (error) {
        throw new Error(`chatLanguageModels.json is not valid JSONC: ${messageFor(error)}`);
      }
      if (
        !Array.isArray(providers) ||
        providers.some((entry) => !entry || typeof entry !== 'object')
      ) {
        throw new Error('chatLanguageModels.json must contain an array of provider objects.');
      }
      if (providers.length !== items.length) {
        throw new Error('Could not safely map the provider entries in chatLanguageModels.json.');
      }
      return { close, providers: providers as VSCodeProviderEntry[], items };
    }
    if (cursor >= content.length) throw new Error('The provider array is not closed.');
    const startOfValue = cursor;
    const separator = findTopLevelSeparator(content, cursor);
    if (!separator) throw new Error('The provider array is not closed.');
    const item: ArrayItem = {
      segmentStart,
      start: startOfValue,
      end: separator.valueEnd,
      ...(separator.char === ',' ? { commaAfter: separator.index } : {}),
    };
    items.push(item);
    if (separator.char === ']') {
      cursor = separator.index;
    } else {
      cursor = separator.index + 1;
    }
  }
}

function findTopLevelSeparator(
  input: string,
  from: number,
): { index: number; char: ',' | ']'; valueEnd: number } | null {
  let braces = 0;
  let brackets = 0;
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let valueEnd = from;
  for (let i = from; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (string) {
      valueEnd = i + 1;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === '"') {
      string = true;
      valueEnd = i + 1;
    } else if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') {
      if (brackets === 0 && braces === 0) return { index: i, char: ']', valueEnd };
      brackets -= 1;
    } else if (char === ',' && braces === 0 && brackets === 0) {
      return { index: i, char: ',', valueEnd };
    }
    if (!/\s/.test(char)) valueEnd = i + 1;
    if (braces < 0 || brackets < 0) throw new Error('The provider array has mismatched brackets.');
  }
  return null;
}

function skipTrivia(input: string, from: number): number {
  let cursor = from;
  while (cursor < input.length) {
    const char = input[cursor]!;
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '/' && input[cursor + 1] === '/') {
      const newline = input.indexOf('\n', cursor + 2);
      cursor = newline === -1 ? input.length : newline + 1;
      continue;
    }
    if (char === '/' && input[cursor + 1] === '*') {
      const end = input.indexOf('*/', cursor + 2);
      if (end === -1) throw new Error('Unclosed block comment in chatLanguageModels.json.');
      cursor = end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function jsoncToJson(input: string): string {
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

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
