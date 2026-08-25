import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSpuriousTruncationClaim, purgeSpuriousTruncationReviews } from './review-claims.js';
import { applySchema } from './schema.js';
import { type SqliteDriver, openIndexDatabase } from './sqlite-driver.js';

describe('isSpuriousTruncationClaim', () => {
  it('matches the live false-positive claim shapes', () => {
    const claims = [
      'File is syntactically broken due to truncation mid-array, causing a compile-time error.',
      'File is syntactically broken due to truncation; cannot be parsed or executed.',
      'File is syntactically incomplete; the last function is cut off mid-definition.',
      'The content ends abruptly in the middle of a statement.',
      'Code appears to be incomplete and stops mid-function.',
      'Unterminated template literal at the end of the file.',
      'Unclosed brace suggests the file was cut off.',
    ];
    for (const c of claims) expect(isSpuriousTruncationClaim(c), c).toBe(true);
  });

  it('does not match genuine code-quality issues', () => {
    const genuine = [
      'Incomplete error handling around the network call.',
      'Unclosed file handle leaks on the early-return path.',
      'Handles the edge case where input ends with a newline.',
      'The retry loop terminates without backoff.',
      'Broadly functional, but direct filesystem fallbacks bypass write authorization.',
    ];
    for (const g of genuine) expect(isSpuriousTruncationClaim(g), g).toBe(false);
  });
});

describe('purgeSpuriousTruncationReviews', () => {
  let dir: string;
  let db: SqliteDriver;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-claims-'));
    const opened = await openIndexDatabase(join(dir, 'index.db'));
    expect(opened).not.toBeNull();
    db = opened as SqliteDriver;
    applySchema(db, { vectors: false });
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function seedReview(hash: string, notesMd: string, healthReason: string | null): void {
    db.prepare(
      `INSERT OR REPLACE INTO file_reviews
         (content_hash, collection_id, file_path, notes_md, issues, health, health_reason)
       VALUES (?, 'c', ?, ?, '[]', 2, ?)`,
    ).run(hash, `src/${hash}.ts`, notesMd, healthReason);
  }

  function remaining(): string[] {
    return db
      .prepare('SELECT content_hash FROM file_reviews ORDER BY content_hash')
      .all<{ content_hash: string }>()
      .map((r) => r.content_hash);
  }

  it('deletes only multi-window reviews with truncation-claiming reasons, once', () => {
    const marker = 'Solid module.\n\n_(reviewed in 3 parts)_';
    seedReview('h-false', marker, 'File is truncated mid-array and cannot compile.');
    seedReview('h-clean', marker, 'Ordinary working file with minor smells.');
    // Single-window review claiming truncation: plausibly TRUE — never purged.
    seedReview('h-whole', 'Broken fixture file.', 'File is truncated; cannot be parsed.');

    purgeSpuriousTruncationReviews(db);
    expect(remaining()).toEqual(['h-clean', 'h-whole']);

    // One-shot: a re-seeded matching row survives later opens (the merge
    // filter, not the purge, is the standing defense).
    seedReview('h-false', marker, 'File is truncated mid-array and cannot compile.');
    purgeSpuriousTruncationReviews(db);
    expect(remaining()).toEqual(['h-clean', 'h-false', 'h-whole']);
  });
});
