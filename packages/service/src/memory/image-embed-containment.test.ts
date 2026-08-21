/**
 * Governance containment for the image-embed stack (lane A of image search).
 *
 * The promise: image bytes and visual vectors are provably local-only. The
 * enrichment layer's two cloud escape hatches (Night Shift model override,
 * Boekwachter frontmatter pin) both flow through resolveEnrichTarget /
 * buildEnrichDeps — so the image stack must never (transitively) import
 * provider code, chat code, or the enrich-target resolver. This test pins the
 * import graph: if someone wires the image path into a model-routing seam,
 * it fails with the offending edge named.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_MODULES = [
  'memory/image-embeddings.ts',
  'memory/image-embed-worker.ts',
  'memory/image-embed-core.ts',
  'memory/image-pixels.ts',
];

// A module whose resolved repo path matches any of these is a containment
// breach: providers/ and chat/ hold every model-routing and credential
// surface; enrich.ts owns resolveEnrichTarget/buildEnrichDeps.
const FORBIDDEN = [/[\\/]providers[\\/]/, /[\\/]chat[\\/]/, /[\\/]index-store[\\/]enrich\.ts$/];

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

describe('image-embed import-graph containment', () => {
  it('never reaches provider, chat, or enrich-target code', () => {
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
      'image-embed modules must stay upstream of every model-routing seam',
    ).toEqual([]);
    // Sanity: the walk actually traversed the stack (not vacuously green).
    expect(visited.size).toBeGreaterThan(ENTRY_MODULES.length);
  });

  it('keeps bounded file reads and in-process inference test-only', () => {
    const pixels = readFileSync(resolve(srcRoot, 'memory/image-pixels.ts'), 'utf8');
    const imageCore = readFileSync(resolve(srcRoot, 'memory/image-embed-core.ts'), 'utf8');
    const faceCore = readFileSync(resolve(srcRoot, 'memory/face-embed-core.ts'), 'utf8');
    const host = readFileSync(resolve(srcRoot, 'memory/image-embeddings.ts'), 'utf8');

    expect(pixels).toContain('export async function readBoundedImageFile');
    expect(imageCore).toContain('readBoundedImageFile(job.path)');
    expect(faceCore).toContain('readBoundedImageFile(job.path)');
    expect(imageCore).not.toMatch(/\breadFile\s*\(/);
    expect(faceCore).not.toMatch(/\breadFile\s*\(/);
    expect(host).toContain('const allowTestFallback = Boolean(process.env.VITEST)');
    expect(host).toContain('if (!allowTestFallback)');
    expect(host).not.toMatch(/falling back to in-process|retrying in-process/i);
  });
});
