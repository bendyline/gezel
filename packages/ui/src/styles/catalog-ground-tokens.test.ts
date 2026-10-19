/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOG_GROUND_TONES } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';

const foundation = readFileSync(resolve(import.meta.dirname, 'foundation.css'), 'utf8');
const lightRoot = foundation.match(/^:root \{([\s\S]*?)^\}/m)?.[1] ?? '';
const darkMedia =
  foundation.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)^ {2}\}/m)?.[1] ?? '';
const darkAttribute = foundation.match(/^\[data-theme="dark"\] \{([\s\S]*?)^\}/m)?.[1] ?? '';

describe('catalog ground tokens', () => {
  it('defines every ground tone for light and both dark selectors', () => {
    expect(lightRoot).not.toBe('');
    expect(darkMedia).not.toBe('');
    expect(darkAttribute).not.toBe('');
    for (const tone of CATALOG_GROUND_TONES) {
      const token = new RegExp(`--gezel-ground-${tone}:\\s*#[0-9a-f]{6};`);
      expect(lightRoot, `light ${tone}`).toMatch(token);
      expect(darkMedia, `dark media ${tone}`).toMatch(token);
      expect(darkAttribute, `dark attribute ${tone}`).toMatch(token);
    }
  });

  it('gives both dark selectors the same values', () => {
    for (const tone of CATALOG_GROUND_TONES) {
      const value = (source: string) =>
        source.match(new RegExp(`--gezel-ground-${tone}:\\s*(#[0-9a-f]{6})`))?.[1];
      expect(value(darkMedia), tone).toBe(value(darkAttribute));
      expect(value(darkMedia), tone).not.toBe(value(lightRoot));
    }
  });
});
