import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Literal sizes, radii and shadows are how the stylesheets drifted from the
// design tokens: 81 font sizes and 39 radii, one reasonable exception at a
// time, until neighboring pages looked like parts from different kits
// (docs/ux.md → "The size scale"). This guard reports the count on every run
// and fails only on a large jump past the baseline, so it catches a new
// habit without blocking an honest exception. When the counts fall, lower
// the baselines.
const SRC = resolve(import.meta.dirname, '..');
// The token definitions themselves, and domain visuals whose values carry
// content (docs/ux.md → "Color").
const EXEMPT = /(^|\/)(foundation\.css|village-and-overview\.css|terminal\.css)$/;

// Counted on 2026-11-06, after the token sweep (from ~540 literal font sizes
// and ~260 literal radii).
const BASELINE = { fontSize: 98, radius: 47, shadow: 30 };
const HEADROOM = 1.5;

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

function countLiterals() {
  const counts = { fontSize: 0, radius: 0, shadow: 0 };
  for (const file of stylesheets(SRC)) {
    if (EXEMPT.test(relative(SRC, file).replace(/\\/g, '/'))) continue;
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of text.matchAll(
      /(^|[;{\s])(font-size|border-radius|box-shadow)\s*:\s*([^;{}]+)/g,
    )) {
      const [, , prop, raw = ''] = match;
      const value = raw.replace(/!important/, '').trim();
      if (value.startsWith('var(')) continue;
      if (prop === 'font-size') {
        if (/^(inherit|initial|unset|\d*\.?\d+(em|%))$/.test(value)) continue;
        counts.fontSize++;
      } else if (prop === 'border-radius') {
        if (/^(0|inherit|50%|999px|9999px)$/.test(value)) continue;
        counts.radius++;
      } else {
        if (value === 'none' || !/rgba?\(|#[0-9a-f]{3,8}\b/i.test(value)) continue;
        counts.shadow++;
      }
    }
  }
  return counts;
}

describe('design token drift', () => {
  it('keeps literal sizes, radii and shadows near their baseline', () => {
    const counts = countLiterals();
    console.info(
      `[token drift] literal font-size ${counts.fontSize} (baseline ${BASELINE.fontSize}), ` +
        `border-radius ${counts.radius} (${BASELINE.radius}), box-shadow ${counts.shadow} (${BASELINE.shadow})`,
    );
    expect(counts.fontSize).toBeLessThanOrEqual(Math.ceil(BASELINE.fontSize * HEADROOM));
    expect(counts.radius).toBeLessThanOrEqual(Math.ceil(BASELINE.radius * HEADROOM));
    expect(counts.shadow).toBeLessThanOrEqual(Math.ceil(BASELINE.shadow * HEADROOM));
  });
});
