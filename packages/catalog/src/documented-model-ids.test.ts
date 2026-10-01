import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogService } from './service.js';

/**
 * Model ids quoted in published documentation must exist in the pinned
 * catalog. Gilde content moves independently of this repo, and a copied
 * example that names a missing model fails on its first `ensureModel` call:
 * the app-sdk Quickstart shipped `llama-cpp:qwen3-4b-instruct-q4_k_m`, an id
 * no catalog ever held (2026-09-30 npm ship audit). The checks mirror the
 * daemon's own resolution in packages/service/src/models/ensure.ts.
 */
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

const QUALIFIED_ID = /['"`](llama-cpp|mlx|ds4):([a-z0-9][a-z0-9._-]*)['"`]/g;
const HOST_ENSURE_ID = /ensureModel\(\{\s*model:\s*'([a-z0-9][a-z0-9._-]*)'/g;

const BACKEND_SOURCE = { 'llama-cpp': 'llamaCpp', mlx: 'mlx', ds4: 'ds4' } as const;

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, extension);
    return path.endsWith(extension) && !path.endsWith(`.test${extension}`) ? [path] : [];
  });
}

function documentedFiles(): string[] {
  const packages = join(repoRoot, 'packages');
  const readmes = readdirSync(packages)
    .map((name) => join(packages, name, 'README.md'))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
  return [
    ...readmes,
    ...filesUnder(join(repoRoot, 'docs', 'handboek'), '.md'),
    ...filesUnder(join(packages, 'app-sdk', 'src'), '.ts'),
  ];
}

interface Reference {
  where: string;
  backend: keyof typeof BACKEND_SOURCE | null;
  id: string;
}

function documentedReferences(): Reference[] {
  return documentedFiles().flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const where = relative(repoRoot, file).replaceAll('\\', '/');
    return [
      ...[...text.matchAll(QUALIFIED_ID)].map((m) => ({
        where,
        backend: m[1] as keyof typeof BACKEND_SOURCE,
        id: m[2] as string,
      })),
      ...[...text.matchAll(HOST_ENSURE_ID)].map((m) => ({
        where,
        backend: null,
        id: m[1] as string,
      })),
    ];
  });
}

describe('model ids in published documentation', () => {
  const references = documentedReferences();

  it('finds the app-sdk examples it guards', () => {
    expect(references.some((r) => r.where === 'packages/app-sdk/README.md')).toBe(true);
  });

  it('resolves every documented id through the pinned catalog', async () => {
    const catalog = new CatalogService();
    const problems: string[] = [];
    for (const ref of references) {
      const detail = await catalog.get('chat-model', ref.id).catch(() => null);
      const manifest = detail?.manifest.kind === 'chat-model' ? detail.manifest : null;
      const label = ref.backend ? `${ref.backend}:${ref.id}` : ref.id;
      if (!manifest) {
        problems.push(`${ref.where}: "${label}" is not in the catalog`);
      } else if (ref.backend && !manifest[BACKEND_SOURCE[ref.backend]]) {
        problems.push(`${ref.where}: "${label}" has no ${ref.backend} source`);
      }
    }
    expect(problems).toEqual([]);
  });
});
