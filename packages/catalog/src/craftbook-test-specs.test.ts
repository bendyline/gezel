import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRAFTBOOK_TEST_FILENAME,
  type CraftbookTestSpec,
  compareSemver,
  isSemver,
  parseCraftbookTestSpec,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

/**
 * CI guard for the per-craftbook eval descriptors (`test.json` sidecars).
 *
 * Present specs must STRICT-parse and pass the cross-checks below — a
 * malformed spec never lands. Since the one-shot migration stamped every
 * book (evals/scripts/generate-test-specs.ts), a missing test.json is a
 * hard failure too: every craftbook ships its eval descriptor.
 */
const REQUIRE_TEST_SPEC = true;

/** Per-file size budget: warn > 64 KB, fail > 128 KB (keeps the data package lean). */
const SIZE_WARN_BYTES = 64 * 1024;
const SIZE_FAIL_BYTES = 128 * 1024;

const templatesRoot = join(gildeDataDir(), 'craftbook-templates');

interface BookRef {
  id: string;
  dir: string;
  latestVersion: string;
}

function discoverBooks(): BookRef[] {
  const books: BookRef[] = [];
  for (const shard of readdirSync(templatesRoot)) {
    const shardDir = join(templatesRoot, shard);
    if (!statSync(shardDir).isDirectory()) continue;
    for (const id of readdirSync(shardDir)) {
      const dir = join(shardDir, id);
      if (!statSync(dir).isDirectory()) continue;
      const versionsDir = join(dir, 'versions');
      let versions: string[];
      try {
        versions = readdirSync(versionsDir).filter((name) => isSemver(name));
      } catch {
        continue;
      }
      if (versions.length === 0) continue;
      versions.sort((a, b) => compareSemver(b, a));
      books.push({ id, dir, latestVersion: versions[0]! });
    }
  }
  return books;
}

function tryReadSpecFile(book: BookRef): { raw: string; path: string } | null {
  const path = join(book.dir, 'versions', book.latestVersion, CRAFTBOOK_TEST_FILENAME);
  try {
    return { raw: readFileSync(path, 'utf8'), path };
  } catch {
    return null;
  }
}

function crossCheckErrors(id: string, spec: CraftbookTestSpec): string[] {
  const errors: string[] = [];
  const deliverablePaths = new Set((spec.success.deliverables ?? []).map((d) => d.path));
  if (deliverablePaths.size > 0 && !deliverablePaths.has(spec.rubric.artifact.path)) {
    errors.push(
      `${id}: rubric.artifact.path "${spec.rubric.artifact.path}" is not among success.deliverables paths`,
    );
  }
  for (const file of spec.setup.files) {
    if (file.path.startsWith('/') || file.path.includes('..')) {
      errors.push(`${id}: setup file path "${file.path}" must be a plain relative path`);
    }
  }
  return errors;
}

describe('craftbook test.json sidecars', () => {
  const books = discoverBooks();

  it('discovers the bundled craftbook corpus', () => {
    expect(books.length).toBeGreaterThan(200);
  });

  it('every PRESENT test.json strict-parses and passes cross-checks', () => {
    const failures: string[] = [];
    const missing: string[] = [];
    let warned = 0;
    for (const book of books) {
      const found = tryReadSpecFile(book);
      if (!found) {
        missing.push(book.id);
        continue;
      }
      if (found.raw.length > SIZE_FAIL_BYTES) {
        failures.push(`${book.id}: test.json is ${found.raw.length} bytes (> ${SIZE_FAIL_BYTES})`);
        continue;
      }
      if (found.raw.length > SIZE_WARN_BYTES) {
        warned++;
        console.warn(
          `[craftbook-test-specs] ${book.id}: test.json is ${found.raw.length} bytes (> ${SIZE_WARN_BYTES} warn budget)`,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(found.raw);
      } catch (err) {
        failures.push(`${book.id}: not valid JSON — ${(err as Error).message}`);
        continue;
      }
      const parsed = parseCraftbookTestSpec(raw, { mode: 'strict' });
      if (!parsed.ok) {
        failures.push(...parsed.errors.slice(0, 5).map((e) => `${book.id}: ${e}`));
        continue;
      }
      failures.push(...crossCheckErrors(book.id, parsed.spec));
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 10).join(', ');
      const line = `[craftbook-test-specs] ${missing.length}/${books.length} books have no ${CRAFTBOOK_TEST_FILENAME} yet (e.g. ${preview})`;
      if (REQUIRE_TEST_SPEC) {
        failures.push(line);
      } else {
        console.warn(line);
      }
    }
    if (warned > 0) {
      console.warn(
        `[craftbook-test-specs] ${warned} spec(s) above the ${SIZE_WARN_BYTES}B warn budget`,
      );
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
