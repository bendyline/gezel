import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = new Set(builtinModules);

/** Every runtime import reachable from `entry`, following relative modules. */
function reachableImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const pattern =
      /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const match of source.matchAll(pattern)) {
      const specifier = (match[1] ?? match[2]) as string;
      if (specifier.startsWith('.'))
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      else external.add(specifier);
    }
  }
  return external;
}

describe('browser safety', () => {
  for (const entry of ['index.ts', 'sqlite-wasm.ts']) {
    it(`${entry} reaches only the knowledge package's browser entry`, () => {
      const external = [...reachableImports(resolve(here, entry))];
      expect(
        external.filter(
          (specifier) =>
            specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] as string),
        ),
      ).toEqual([]);
      for (const specifier of external)
        expect(specifier).toBe('@bendyline/gezel-knowledge/browser');
    });
  }
});
