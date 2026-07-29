import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ParsedYamlFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Parse YAML frontmatter from an in-memory markdown string.
 *
 * This intentionally has no path/Buffer overload and no filesystem access.
 * Frontmatter is a document codec in Gezel; callers own all I/O.
 */
export function parseYamlFrontmatter(source: string): ParsedYamlFrontmatter {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!opening) return { data: {}, content: source };

  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(source);
  if (!end) throw new Error('YAML frontmatter is missing its closing delimiter');

  const yamlText = source.slice(opening[0].length, end.index);
  const value = parseYaml(yamlText, {
    prettyErrors: false,
    uniqueKeys: true,
  }) as unknown;
  if (value === null || value === undefined) {
    return { data: {}, content: source.slice(closing.lastIndex) };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('YAML frontmatter must contain a mapping');
  }
  return {
    data: value as Record<string, unknown>,
    content: source.slice(closing.lastIndex),
  };
}

/** Serialize an object and markdown body using conventional YAML fences. */
export function stringifyYamlFrontmatter(content: string, data: Record<string, unknown>): string {
  const yaml = stringifyYaml(data, {
    lineWidth: 0,
    minContentWidth: 0,
  });
  return `---\n${yaml}---\n${content || '\n'}`;
}

/** Parse a standalone YAML mapping without introducing fake frontmatter. */
export function parseYamlMapping(source: string): Record<string, unknown> {
  if (source.trim().length === 0) return {};
  const value = parseYaml(source, {
    prettyErrors: false,
    uniqueKeys: true,
  }) as unknown;
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('YAML block must contain a mapping');
  }
  return value as Record<string, unknown>;
}

/** Serialize a standalone YAML mapping with one trailing newline. */
export function stringifyYamlMapping(data: Record<string, unknown>): string {
  return stringifyYaml(data, {
    lineWidth: 0,
    minContentWidth: 0,
  });
}
