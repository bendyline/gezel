import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SEGMENT_RULES,
  PORTABLE_PATH_RULES,
  type PathRuleCode,
  findPathRuleViolation,
  isReservedWindowsName,
  unresolvedTemplatePlaceholders,
} from './path-rules.js';

const code = (path: string, rules = PORTABLE_PATH_RULES): PathRuleCode | null =>
  findPathRuleViolation(path, rules)?.code ?? null;

describe('findPathRuleViolation, portable preset', () => {
  it.each<[string, PathRuleCode | null]>([
    ['', 'empty'],
    ['a'.repeat(1025), 'too-long'],
    [Array.from({ length: 129 }, () => 'a').join('/'), 'too-deep'],
    [`${'é'.repeat(200)}`, 'segment-too-long'],
    ['a\0b', 'nul'],
    ['a\tb', 'control-char'],
    ['a\\b', 'backslash'],
    ['/etc/passwd', 'absolute'],
    ['C:/x', 'colon'],
    ['a//b', 'empty-segment'],
    ['../up', 'dot-segment'],
    ['./here', 'dot-segment'],
    ['dir/name ', 'trailing-space-or-dot'],
    ['dir/name.', 'trailing-space-or-dot'],
    ['CON', 'reserved-name'],
    ['docs/con.txt', 'reserved-name'],
    ['docs/CON .txt', 'reserved-name'],
    ['out/{{task.dir}}/x.md', 'template-placeholder'],
    ['reports/2026-09-22.md', null],
    ['conference/notes.md', null],
    ['weird {{ but not a token', null],
  ])('%j -> %s', (path, expected) => {
    expect(code(path)).toBe(expected);
  });

  it('accepts the root only when asked', () => {
    expect(code('', { ...PORTABLE_PATH_RULES, allowRoot: true })).toBeNull();
  });
});

describe('findPathRuleViolation, desktop preset', () => {
  it.each<[string, PathRuleCode | null]>([
    ['', null],
    ['a\\b', null],
    ['../up', null],
    ['a//b', null],
    ['a\0b', 'nul'],
    ['\\\\server\\share', 'unc'],
    ['a:b', 'colon'],
    ['x.', 'trailing-space-or-dot'],
    ['x ', 'trailing-space-or-dot'],
    ['CON', 'reserved-name'],
    ['con.txt', 'reserved-name'],
    ['{{task.dir}}', null],
  ])('%j -> %s', (path, expected) => {
    expect(code(path, DESKTOP_SEGMENT_RULES)).toBe(expected);
  });
});

describe('isReservedWindowsName', () => {
  it('ignores the extension and trailing whitespace', () => {
    expect(isReservedWindowsName('CON.txt')).toBe(true);
    expect(isReservedWindowsName('CON .txt')).toBe(true);
    expect(isReservedWindowsName('lpt9')).toBe(true);
    expect(isReservedWindowsName('conference')).toBe(false);
    expect(isReservedWindowsName('')).toBe(false);
  });
});

describe('unresolvedTemplatePlaceholders', () => {
  it('lists each distinct token once', () => {
    expect(unresolvedTemplatePlaceholders('a/{{x}}/{{ y.z }}/{{x}}')).toEqual([
      '{{x}}',
      '{{ y.z }}',
    ]);
    expect(unresolvedTemplatePlaceholders('{{ not a token }}')).toEqual([]);
  });
});
