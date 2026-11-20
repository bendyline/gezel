import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as browser from './browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = new Set(builtinModules);

/** Every runtime import reachable from `entry`, following relative modules. */
function reachableImports(entry: string): { files: string[]; external: Set<string> } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    // `import type` / `export type` are erased; everything else loads at runtime.
    const pattern =
      /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const match of source.matchAll(pattern)) {
      const specifier = (match[1] ?? match[2]) as string;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      } else {
        external.add(specifier);
      }
    }
  }
  return { files: [...seen], external };
}

describe('browser entry', () => {
  it('reaches no Node built-in', () => {
    const { files, external } = reachableImports(resolve(here, 'browser.ts'));
    expect(files.length).toBeGreaterThan(1);
    const node = [...external].filter(
      (specifier) =>
        specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] as string),
    );
    expect(node).toEqual([]);
    // gezk's root entry is its own browser-safe surface; nothing else is allowed.
    expect([...external].sort()).toEqual(['@bendyline/gezk']);
  });

  it('exports the chunker, the profiles and the FTS query helpers', () => {
    expect(typeof browser.chunkMarkdownProfile).toBe('function');
    expect(browser.MARKDOWN_CHUNKS_2.id).toBe('markdown-chunks@2');
    expect(typeof browser.selectiveFtsQuery).toBe('function');
    expect(browser.QUERY_STOP_WORDS.has('the')).toBe(true);
  });
});
