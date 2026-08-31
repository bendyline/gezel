import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckRunner } from './duck.js';
import {
  MAX_SQL_LENGTH,
  SqlRejectedError,
  assertReadOnlyStatement,
  lexicalCheck,
  parserCheck,
} from './statement-guard.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';

/**
 * The payload that defeats the row-limit wrapper. Run against the engine
 * unguarded, `SELECT * FROM (<this>) LIMIT 5` closes the wrapper's
 * parenthesis, attaches a database, and creates a file on disk.
 */
const WRAPPER_INJECTION =
  "SELECT 1) ; ATTACH '/tmp/gezel-guard-injection.db' AS w; SELECT * FROM (SELECT 1";

describe('lexicalCheck', () => {
  it.each([
    'SELECT 1',
    'select route from t',
    '  WITH c AS (SELECT 1) SELECT * FROM c  ',
    'FROM t WHERE x > 1',
    'DESCRIBE SELECT 1',
    'SUMMARIZE SELECT 1',
    'SELECT 1;',
    '-- a leading comment\nSELECT 1',
    '/* block */ SELECT 1',
  ])('accepts %j', (sql) => {
    expect(() => lexicalCheck(sql)).not.toThrow();
  });

  it('drops a single trailing semicolon but keeps the statement', () => {
    expect(lexicalCheck('SELECT 1;  ').normalized).toBe('SELECT 1');
  });

  it.each([
    ['INSERT INTO t VALUES (1)', /read-only/],
    ['UPDATE t SET x = 1', /read-only/],
    ['DELETE FROM t', /read-only/],
    ['CREATE TABLE t(x INT)', /produced by the connector/],
    ['DROP TABLE t', /produced by the connector/],
    ["ATTACH '/tmp/x.db' AS w", /attaching databases/],
    ["COPY (SELECT 1) TO '/tmp/x.csv'", /writing files/],
    ['INSTALL httpfs', /extensions cannot be installed/],
    ['SET memory_limit=$$1GB$$', /settings are fixed/],
    ['PRAGMA database_list', /describe_table/],
    ['EXPLAIN ANALYZE SELECT 1', /EXPLAIN ANALYZE executes/],
  ])('rejects %j with an actionable message', (sql, pattern) => {
    expect(() => lexicalCheck(sql)).toThrow(SqlRejectedError);
    expect(() => lexicalCheck(sql)).toThrow(pattern);
  });

  it('rejects a second statement, however it is smuggled', () => {
    for (const sql of [
      'SELECT 1; SELECT 2',
      "SELECT 1;--\nATTACH '/tmp/x.db' AS w",
      "SELECT 1 ; ATTACH '/tmp/x.db' AS w",
    ]) {
      expect(() => lexicalCheck(sql), sql).toThrow(/only one statement/);
    }
  });

  it('does not mistake a semicolon inside a literal for a statement break', () => {
    // The value is data, not structure. Rejecting this would make a whole
    // class of legitimate filters impossible to express.
    expect(() => lexicalCheck("SELECT * FROM t WHERE route = 'a;b'")).not.toThrow();
    expect(() => lexicalCheck(`SELECT * FROM t WHERE "odd;name" = 1`)).not.toThrow();
  });

  it('rejects an empty or oversized query', () => {
    expect(() => lexicalCheck('   ')).toThrow(/empty/);
    expect(() => lexicalCheck(`SELECT ${'x'.repeat(MAX_SQL_LENGTH)}`)).toThrow(/limit is/);
  });
});

describe.runIf(hasRealDuckdb())('parserCheck (real engine)', () => {
  let dir: string;
  let runner: DuckRunner;
  let opts: { allowedDirectories: string[]; timeoutMs: number };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-guard-'));
    await writeFile(join(dir, 'placeholder'), '');
    runner = new DuckRunner({ binaryPath: findRealDuckdb() as string });
    opts = { allowedDirectories: [dir], timeoutMs: 30_000 };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm('/tmp/gezel-guard-injection.db', { force: true }).catch(() => {});
  });

  it.each(['SELECT 1', 'WITH c AS (SELECT 1 AS v) SELECT v FROM c', 'FROM (SELECT 1 AS a)'])(
    'accepts the read-only statement %j',
    async (sql) => {
      await expect(parserCheck(sql, runner, opts)).resolves.toBeUndefined();
    },
  );

  it('rejects a CTE that fronts a mutation — the case a leading-keyword check misses', async () => {
    // Verified against the engine: this form really does execute the insert,
    // so `WITH` says nothing about what follows it.
    await expect(
      parserCheck('WITH c AS (SELECT 1 AS v) INSERT INTO t SELECT v FROM c', runner, opts),
    ).rejects.toThrow(/only read-only SELECT queries/);
  });

  it('rejects two statements even when both are selects', async () => {
    await expect(parserCheck('SELECT 1; SELECT 2', runner, opts)).rejects.toThrow(
      /only one statement/,
    );
  });

  it('rejects the payload that defeats the row-limit wrapper, and creates nothing', async () => {
    await expect(parserCheck(WRAPPER_INJECTION, runner, opts)).rejects.toThrow(SqlRejectedError);
    // Validation parses without executing, so the guard itself is inert.
    expect(existsSync('/tmp/gezel-guard-injection.db')).toBe(false);
  });

  it('refuses the statement when validation itself fails, rather than running it unchecked', async () => {
    const broken = {
      runTrusted: async () => {
        throw new Error('engine unavailable');
      },
    };
    await expect(parserCheck('SELECT 1', broken, opts)).rejects.toThrow(/was not run/);
  });

  it('assertReadOnlyStatement returns the normalized statement', async () => {
    await expect(assertReadOnlyStatement('  SELECT 1;  ', runner, opts)).resolves.toBe('SELECT 1');
  });
});

/**
 * The claim the guard exists to support, demonstrated rather than asserted:
 * unguarded, the wrapper injection writes a file; guarded, it does not.
 */
describe.runIf(hasRealDuckdb())('the guard is what stops the write', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm('/tmp/gezel-guard-injection.db', { force: true }).catch(() => {});
  });

  it('blocks a payload that the lockdown prelude alone allows through', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-guard-proof-'));
    const runner = new DuckRunner({ binaryPath: findRealDuckdb() as string });
    const opts = { allowedDirectories: [dir, '/tmp'], timeoutMs: 30_000 };

    // Unguarded: the wrapper's parenthesis is closed and the smuggled ATTACH
    // runs, inside a directory the prelude permits. The runner still refuses
    // the *result* — three statements emit three concatenated JSON arrays,
    // which is not parseable — but by then the file exists. Rejecting
    // unparseable output is useful defence in depth and no substitute for the
    // guard: the side effect happened before anything was read back.
    await runner
      .runTrusted(`SELECT * FROM (${WRAPPER_INJECTION}) LIMIT 5`, opts)
      .catch((err: unknown) => {
        expect(String(err)).toMatch(/not JSON/);
      });
    expect(existsSync('/tmp/gezel-guard-injection.db')).toBe(true);
    await rm('/tmp/gezel-guard-injection.db', { force: true });

    // Guarded: refused before the engine ever sees it.
    await expect(assertReadOnlyStatement(WRAPPER_INJECTION, runner, opts)).rejects.toThrow(
      SqlRejectedError,
    );
    expect(existsSync('/tmp/gezel-guard-injection.db')).toBe(false);
  });
});
