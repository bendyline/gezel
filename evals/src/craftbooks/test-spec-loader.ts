import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRAFTBOOK_TEST_FILENAME,
  type CraftbookTestSpec,
  compareSemver,
  isSemver,
  parseCraftbookTestSpec,
} from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';

/**
 * Loads every bundled craftbook's `test.json` sidecar straight from the
 * catalog data tree (same direct-disk pattern `catalog.ts` uses for
 * `index.json`). Tolerant parse — a spec written by a newer schema
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

let cache: LoadedCraftbookTestSpec[] | null = null;

export function loadCraftbookTestSpecsSync(): LoadedCraftbookTestSpec[] {
  if (cache) return cache;
  const loaded: LoadedCraftbookTestSpec[] = [];
  for (const shard of safeReaddir(TEMPLATES_ROOT)) {
    const shardDir = join(TEMPLATES_ROOT, shard);
    for (const id of safeReaddir(shardDir)) {
      const versionsDir = join(shardDir, id, 'versions');
      const versions = safeReaddir(versionsDir).filter((name) => isSemver(name));
      if (versions.length === 0) continue;
      versions.sort((a, b) => compareSemver(b, a));
      const version = versions[0]!;
      let raw: string;
      try {
        raw = readFileSync(join(versionsDir, version, CRAFTBOOK_TEST_FILENAME), 'utf8');
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
        hasSpawn: craftbookHasSpawn(join(versionsDir, version)),
      });
    }
  }
  loaded.sort((a, b) => a.craftbookId.localeCompare(b.craftbookId));
  cache = loaded;
  return loaded;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
