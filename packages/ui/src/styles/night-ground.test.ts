/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gezelReadingSurfaceForMode } from '../components/chat-theme.js';
import { GEZEL_DARK_SURFACE } from '../components/transform/surfaces.js';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');
const foundation = read('foundation.css');

// The night theme is written twice: for an OS in dark mode, and for a person
// who pinned Dark.
const systemDark =
  foundation.match(
    /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/,
  )?.[1] ?? '';
const pinnedDark = foundation.match(/^\[data-theme="dark"\] \{([\s\S]*?)^\}/m)?.[1] ?? '';

const PAPERS = ['canvas', 'workshop', 'panel', 'inset'] as const;
const INKS = ['ink-muted', 'ink-warm-muted', 'ink-warm-quiet'] as const;

function token(source: string, name: string): string {
  const value = source.match(new RegExp(`--gezel-${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing hexadecimal --gezel-${name} token`);
  return value.toLowerCase();
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

describe('the night ground', () => {
  it('is written the same in both dark blocks', () => {
    for (const name of [...PAPERS.map((paper) => `paper-${paper}`), ...INKS]) {
      expect(token(systemDark, name), name).toBe(token(pinnedDark, name));
    }
  });

  // Charcoal with a trace of warmth. It was walnut until 2026-11-11 (red 7 to
  // 11 above blue): the accent's own hue, so the whole window read brown and
  // the terracotta had nothing to stand out from. Never cool either.
  it('is a dark gray that leans warm, neither walnut nor slate', () => {
    for (const paper of PAPERS) {
      const [red, green, blue] = channels(token(pinnedDark, `paper-${paper}`));
      expect(red, paper).toBeGreaterThanOrEqual(green);
      expect(green, paper).toBeGreaterThanOrEqual(blue);
      expect(red - blue, paper).toBeGreaterThanOrEqual(1);
      expect(red - blue, paper).toBeLessThanOrEqual(4);
    }
  });

  it('steps up from canvas to inset', () => {
    const reds = PAPERS.map((paper) => channels(token(pinnedDark, `paper-${paper}`))[0]);
    expect([...reds].sort((a, b) => a - b)).toEqual(reds);
    expect(new Set(reds).size).toBe(reds.length);
  });

  // Monaco and Squisq take literal colors, so these repeat the tokens.
  it('is repeated exactly where a surface cannot read the tokens', () => {
    const panel = token(pinnedDark, 'paper-panel');
    const inset = token(pinnedDark, 'paper-inset');
    expect(GEZEL_DARK_SURFACE.background).toBe(panel);
    expect(GEZEL_DARK_SURFACE.backgroundLight).toBe(inset);
    expect(GEZEL_DARK_SURFACE.textMuted).toBe(token(pinnedDark, 'ink-muted'));

    const monaco = read('../components/monaco-base.ts');
    const darkTheme = monaco.slice(monaco.indexOf("defineTheme('gezel-dark'"));
    expect(darkTheme).toContain(`'editor.background': '${panel}'`);

    const terminal = read('../components/terminal-editor/terminal-monaco-setup.ts');
    expect(terminal).toContain(`'editor.background': '${inset}'`);
  });

  // Squisq's gezellig preset brings its own walnut page. A reader that
  // names no surface at night paints it inside the app.
  it('gives every reader a surface in both modes', () => {
    expect(gezelReadingSurfaceForMode('dark')).toBe(GEZEL_DARK_SURFACE);
    expect(gezelReadingSurfaceForMode('light').background).toBe('#eeeae1');
  });
});

// By day a quiet wash or a structural hairline is the terracotta on
// parchment. Over charcoal the same wash is a brown surface, so at night the
// tint is a gray and the accent is kept for marks.
describe('the wash tint', () => {
  const lightRoot = foundation.match(/^:root \{([\s\S]*?)^\}/m)?.[1] ?? '';
  const washTint = (source: string) => source.match(/--wash-tint:\s*([^;]+);/)?.[1]?.trim();

  it('is the terracotta by day, so a wash through it is the color it always was', () => {
    expect(washTint(lightRoot)).toBe('var(--gezel-terra)');
    expect(lightRoot).toMatch(/--accent:\s*var\(--gezel-terra\);/);
  });

  it('is the same gray in both dark blocks', () => {
    const night = washTint(pinnedDark) ?? '';
    expect(washTint(systemDark)).toBe(night);
    expect(night).toMatch(/^#[0-9a-f]{6}$/);
    const [red, green, blue] = channels(night);
    expect(red).toBeGreaterThanOrEqual(green);
    expect(green).toBeGreaterThanOrEqual(blue);
    expect(red - blue).toBeLessThanOrEqual(8);
  });

  // A new wash written with the terracotta itself would be brown at night.
  it('carries every quiet wash: none is written with the accent directly', () => {
    const sheets = readdirSync(import.meta.dirname).filter((name) => name.endsWith('.css'));
    const strays: string[] = [];
    for (const sheet of sheets) {
      read(sheet)
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('--selected-bg')) return;
          for (const match of line.matchAll(/rgba\(176,\s*114,\s*76,\s*(0?\.\d+)\)/g)) {
            if (Number(match[1]) <= 0.45) strays.push(`${sheet}:${index + 1} ${match[0]}`);
          }
          for (const match of line.matchAll(
            /color-mix\(in srgb, var\(--accent\) (\d+(?:\.\d+)?)%/g,
          )) {
            if (Number(match[1]) <= 14) strays.push(`${sheet}:${index + 1} ${match[0]}`);
          }
        });
    }
    expect(strays).toEqual([]);
  });
});
