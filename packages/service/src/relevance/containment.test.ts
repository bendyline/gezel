/**
 * The relevance model reads untrusted retrieved text, and the reason it is
 * a cross-encoder rather than a chat model is that a classifier cannot be
 * talked into anything. That holds only while its stack never reaches a
 * provider or chat code — so the import graph is pinned here, the same way
 * the image-embed stack is. A breach names the offending edge.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_MODULES = [
  'relevance/relevance-worker.ts',
  'relevance/relevance-core.ts',
  'relevance/relevance-model.ts',
  'search/relevance-stage.ts',
];

const FORBIDDEN = [/[\\/]providers[\\/]/, /[\\/]chat[\\/]/];

function relativeImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const specs: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) specs.push(m[1]!);
  }
  return specs.filter((s) => s.startsWith('.'));
}

describe('relevance-model import-graph containment', () => {
  it('never reaches provider or chat code', () => {
    const queue = ENTRY_MODULES.map((m) => resolve(srcRoot, m));
    const visited = new Set<string>();
    const edges: Array<{ from: string; to: string }> = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of relativeImports(file)) {
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
        edges.push({ from: file, to: target });
        queue.push(target);
      }
    }
    const breaches = edges.filter((e) => FORBIDDEN.some((rule) => rule.test(e.to)));
    expect(
      breaches.map((b) => `${b.from} -> ${b.to}`),
      'relevance-model modules must stay upstream of every model-routing seam',
    ).toEqual([]);
    expect(visited.size).toBeGreaterThan(ENTRY_MODULES.length);
  });
});
