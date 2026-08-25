import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRAFTBOOK_TEST_FILENAME,
  type CraftbookTestSpec,
  parseCraftbookTestSpec,
} from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';

/**
 * Loads every active bundled craftbook's `test.json` sidecar straight from
 * the catalog index. The index is the runtime source of truth: walking the
 * data tree also finds fully-yanked historical books that the product cannot
 * resolve, leaving stale eval specs for catalog entries that no longer exist.
 *
 * Tolerant parse — a spec written by a newer schema
 * author still loads here; the STRICT gate lives in catalog CI
 * (`packages/catalog/src/craftbook-test-specs.test.ts`), which fails the
 * build on any invalid or missing spec, so a warn below should never
 * survive to a landed tree.
 */

export interface LoadedCraftbookTestSpec {
  craftbookId: string;
  version: string;
  spec: CraftbookTestSpec;
  /**
   * True when the book's `craftbook.json` carries a declarative `spawn`
   * block (it is a per-item fanout host). The eval harness runs these as a
   * real craftbook TASK so the runtime drives the steps + the fanout,
   * rather than the freehand direct-worker path. See scenario.ts.
   */
  hasSpawn: boolean;
}

/** The recipe sidecar next to each version's `test.json`. */
const CRAFTBOOK_FILENAME = 'craftbook.json';

interface CraftbookIndexFile {
  entries: Array<{
    manifest: {
      id: string;
      version: string;
    };
  }>;
}

/** Best-effort read of a book version's `spawn` presence — never throws. */
function craftbookHasSpawn(versionDir: string): boolean {
  try {
    const raw = readFileSync(join(versionDir, CRAFTBOOK_FILENAME), 'utf8');
    const doc = JSON.parse(raw) as { spawn?: unknown };
    return !!doc && typeof doc === 'object' && doc.spawn != null;
  } catch {
    return false;
  }
}

const TEMPLATES_ROOT = join(gildeDataDir(), 'craftbook-templates');
const CATALOG_INDEX_PATH = join(TEMPLATES_ROOT, 'index.json');

let cache: LoadedCraftbookTestSpec[] | null = null;

export function loadCraftbookTestSpecsSync(): LoadedCraftbookTestSpec[] {
  if (cache) return cache;
  const loaded: LoadedCraftbookTestSpec[] = [];
  let index: CraftbookIndexFile;
  try {
    index = JSON.parse(readFileSync(CATALOG_INDEX_PATH, 'utf8')) as CraftbookIndexFile;
  } catch (err) {
    console.warn(
      `[craftbook-test-specs] cannot read catalog index: ${err instanceof Error ? err.message : String(err)}`,
    );
    cache = loaded;
    return loaded;
  }
  for (const { manifest } of index.entries) {
    const { id, version } = manifest;
    const versionDir = join(TEMPLATES_ROOT, id.slice(0, 2), id, 'versions', version);
    let raw: string;
    try {
      raw = readFileSync(join(versionDir, CRAFTBOOK_TEST_FILENAME), 'utf8');
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn(`[craftbook-test-specs] ${id}@${version}: test.json is not valid JSON`);
      continue;
    }
    const parsed = parseCraftbookTestSpec(json, { mode: 'tolerant' });
    if (!parsed.ok) {
      console.warn(`[craftbook-test-specs] ${id}@${version}: ${parsed.errors[0]}`);
      continue;
    }
    loaded.push({
      craftbookId: id,
      version,
      spec: parsed.spec,
      hasSpawn: craftbookHasSpawn(versionDir),
    });
  }
  loaded.sort((a, b) => a.craftbookId.localeCompare(b.craftbookId));
  cache = loaded;
  return loaded;
}
