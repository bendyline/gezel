import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Gezel is the product, and Gezel is who does the work (docs/ux.md, Feel).
// "gezel", "gezels" and "gezellen" are not words for a helper in text a
// person reads: a general statement names Gezel, a particular helper goes by
// name, and the roster says crew. The old words crept back one string at a
// time after each sweep: "How your gezellen use it" sat one screen away from
// "Your crew" on a new install. Identifiers, routes, test ids and class names
// keep `gezel`; only prose is checked.
const SRC = resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** String literals and JSX text: the places interface copy lives. */
function proseSegments(source: string): string[] {
  const code = withoutComments(source);
  const quoted = [...code.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2] ?? '');
  const templates = [...code.matchAll(/`((?:\\.|[^`\\])*)`/g)].map((m) => m[1] ?? '');
  // `>…<` also matches the code between two generics (`Map<a, b>; gezels: Map<`),
  // so a segment holding statement punctuation or a property line is not text.
  const jsxText = [...code.matchAll(/>([^<>{}]+)</g)]
    .map((m) => m[1] ?? '')
    .filter((text) => !/[;=|&]/.test(text) && !/\n\s*\w+\??:\s/.test(text));
  return [...quoted, ...templates, ...jsxText];
}

const PLURAL = /(?:^|[\s(“"'—])[Gg]ezel(?:s|len)(?=$|\s|[.,;:!?)”"'](?:\s|$))/;

// The product keeps its name, so "the Gezel app" and "your Gezel install" pass.
const PRODUCT_NOUN =
  /^(?:desktop|apps?|service|daemon|command|cli|extension|install|home|folder|window|website|logo|mcp|sdk|handboek|team|account|icon|tray|update|release|version|build)$/i;
// "a gezel", "this gezel's page", "per-gezel": the noun standing for a helper.
const SINGULAR_AFTER_DETERMINER =
  /\b(?:[Aa]n?|[Tt]he|[Tt]his|[Tt]hat|[Ee]ach|[Ee]very|[Aa]ny|[Aa]nother|[Nn]o|[Ww]hich|[Oo]ne|[Oo]ther|[Nn]ew|[Yy]our|[Tt]heir|[Ii]ts|per)[ -]gezel(?![\w-])(?:\s+(\w+))?/g;
// "Add Gezel", "Ask a gezel": the noun in a control's label.
const SINGULAR_IN_LABEL =
  /\b(?:Add|New|Ask|Choose|Pick|Select|Assign)(?: an?)? [Gg]ezel(?![\w-])(?:\s+(\w+))?/g;

// The product, in phrases the two patterns above would read as a helper: Gezel
// set up inside another app ("Add Gezel to Office?"), and things named for the
// product ("another gezel device", "a gezel local model package").
const PRODUCT_PHRASE =
  /\bAdd Gezel to(?=$| (?:Office|OpenCode|pi)\b)|\bgezel (?:device|server|project|run|source checkout|local model package)\b/g;

function usesSingularForAHelper(text: string): boolean {
  const prose = text.replace(PRODUCT_PHRASE, '');
  return [SINGULAR_AFTER_DETERMINER, SINGULAR_IN_LABEL].some((pattern) =>
    [...prose.matchAll(pattern)].some((match) => !PRODUCT_NOUN.test(match[1] ?? '')),
  );
}

function namesAHelper(segment: string): boolean {
  const text = segment.trim();
  if (/^Gezel(?:s|len)$/.test(text)) return true;
  if (!/\s/.test(text)) return false;
  return PLURAL.test(text) || usesSingularForAHelper(text);
}

describe('owner vocabulary', () => {
  it('finds the helper noun in a sentence and leaves the product and identifiers alone', () => {
    const flagged = (source: string) => proseSegments(source).some(namesAHelper);
    expect(flagged("const hint = 'so gezellen can triage the inbox';")).toBe(true);
    expect(flagged('<Select.Label>Gezels</Select.Label>')).toBe(true);
    expect(flagged('<p>Your gezels.</p>')).toBe(true);
    expect(flagged('<button>+ New gezel</button>')).toBe(true);
    expect(flagged("const label = 'Add Gezel';")).toBe(true);
    expect(flagged("const hint = 'Applies to every gezel using this model.';")).toBe(true);
    expect(flagged('const hint = "Open this gezel\'s page to change it.";')).toBe(true);
    expect(flagged("const hint = 'A per-gezel override wins.';")).toBe(true);

    expect(flagged('className={`two-col gezellen-view ${x}`}')).toBe(false);
    expect(flagged("window.addEventListener('gezel:gezels-changed', roster);")).toBe(false);
    expect(flagged('const gezels = await api.listGezels(); // every gezel here')).toBe(false);
    expect(flagged("const hint = 'Create one in the Gezel desktop app.';")).toBe(false);
    expect(flagged("const hint = 'Build a Gezel app for your team.';")).toBe(false);
    expect(flagged("const title = 'Add Gezel to Office?';")).toBe(false);
    expect(flagged("const title = 'Add Gezel to this project';")).toBe(true);
    expect(flagged("const hint = 'Use the models on another gezel device.';")).toBe(false);
    expect(flagged('<p>Let Gezel run scripts it writes.</p>')).toBe(false);
    expect(flagged('<p>Your crew has three crew members.</p>')).toBe(false);
  });

  it('never calls a helper a gezel in interface text', () => {
    const found = sourceFiles(SRC).flatMap((file) =>
      proseSegments(readFileSync(file, 'utf8'))
        .filter(namesAHelper)
        .map((segment) => `${relative(SRC, file)}: ${segment.trim().slice(0, 80)}`),
    );
    expect(found).toEqual([]);
  });
});
