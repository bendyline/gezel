/**
 * The gate every model- or user-authored SQL statement passes before it
 * reaches the engine.
 *
 * ── Why this is load-bearing, not defence in depth ───────────────────────
 *
 * `DuckRunner`'s configuration prelude blocks reads outside the corpus,
 * remote URLs, extension installs, and `COPY` to an outside path, and then
 * locks the configuration so a statement cannot re-widen any of it. It does
 * **not** stop a statement from writing *inside* an allowed directory:
 * measured against the pinned engine, `ATTACH '<corpus>/x.db'` followed by
 * `CREATE TABLE` produces a real file. This module is the layer that stops
 * that, so nothing here may be relaxed on the theory that the lockdown
 * already covers writes.
 *
 * ── Three things a lexical check alone gets wrong ─────────────────────────
 *
 * The obvious guard — "the first keyword must be SELECT" — is not enough, and
 * each of these was verified against the pinned engine rather than assumed:
 *
 * 1. `WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c` **executes the
 *    insert**. A leading `WITH` says nothing about what follows it.
 * 2. `EXPLAIN ANALYZE INSERT INTO t VALUES (7)` **executes the insert**.
 *    EXPLAIN is not inert.
 * 3. Wrapping the statement for row-capping — `SELECT * FROM (<sql>) LIMIT n`
 *    — is itself an injection surface. A statement of
 *    `SELECT 1) ; ATTACH '/tmp/x.db' AS w; SELECT * FROM (SELECT 1` closes
 *    the wrapper's parenthesis and smuggles two more statements. Tried
 *    against the engine, it created the file.
 *
 * So the authoritative check is DuckDB's **own parser**, reached through
 * `json_serialize_sql`, which refuses anything that is not a single SELECT
 * ("Only SELECT statements can be serialized to json!") and reports how many
 * statements it parsed. It parses without executing, so validation itself is
 * inert. The lexical pass in front of it exists only to turn the common
 * mistakes into a clear, immediate message instead of a parser error — a
 * model repairs "you cannot INSERT here" far more reliably than "syntax
 * error at or near".
 */

import { type DuckRunOptions, sqlLiteral } from './duck.js';

/** Longest statement accepted. Well past any legitimate analytical query. */
export const MAX_SQL_LENGTH = 20_000;

/**
 * Leading keywords the lexical pass will let through to the parser. The
 * parser is what actually decides; this list only shapes the error message.
 * `FROM` is DuckDB's from-first shorthand (`FROM t WHERE x > 1`), which is
 * read-only and which models do reach for.
 */
const ALLOWED_LEADING = new Set([
  'SELECT',
  'WITH',
  'FROM',
  'TABLE',
  'VALUES',
  'DESCRIBE',
  'SUMMARIZE',
  'PIVOT',
  'UNPIVOT',
]);

/**
 * Leading keywords rejected with a specific message. Not a security boundary —
 * the parser is — but a much better first response than a syntax error.
 */
const EXPLAINED_REJECTIONS: Record<string, string> = {
  INSERT: 'this corpus is read-only; it mirrors an external source',
  UPDATE: 'this corpus is read-only; it mirrors an external source',
  DELETE: 'this corpus is read-only; it mirrors an external source',
  CREATE: 'tables here are produced by the connector, not by queries',
  DROP: 'tables here are produced by the connector, not by queries',
  ALTER: 'tables here are produced by the connector, not by queries',
  ATTACH: 'attaching databases is not permitted',
  DETACH: 'attaching databases is not permitted',
  COPY: 'writing files is not permitted; return rows instead',
  EXPORT: 'writing files is not permitted; return rows instead',
  IMPORT: 'writing files is not permitted; return rows instead',
  INSTALL: 'extensions cannot be installed',
  LOAD: 'extensions cannot be loaded',
  SET: 'engine settings are fixed for this query',
  RESET: 'engine settings are fixed for this query',
  PRAGMA: 'use DESCRIBE or the describe_table tool instead of PRAGMA',
  CALL: 'procedure calls are not permitted',
  EXPLAIN:
    'EXPLAIN is not permitted (EXPLAIN ANALYZE executes its statement); run the query itself',
};

export class SqlRejectedError extends Error {
  readonly code = 'sql-rejected' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SqlRejectedError';
  }
}

/** Strip comments and string/identifier literals so keywords can be read. */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      // Replaced by a placeholder so `'; DROP'` inside a literal cannot be
      // read as structure, while adjacency is preserved.
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface LexicalVerdict {
  /** Uppercased leading keyword, when one could be read. */
  leading: string | null;
  /** Statement text with a single trailing semicolon removed. */
  normalized: string;
}

/**
 * The cheap pass. Throws {@link SqlRejectedError} with an actionable message,
 * or returns the normalized statement for the parser pass.
 */
export function lexicalCheck(sql: string): LexicalVerdict {
  const trimmed = sql.trim();
  if (!trimmed) throw new SqlRejectedError('the query is empty');
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new SqlRejectedError(
      `the query is ${trimmed.length} characters; the limit is ${MAX_SQL_LENGTH}`,
    );
  }

  const bare = stripLiteralsAndComments(trimmed);

  // One trailing semicolon is idiomatic and harmless; anything after it is a
  // second statement. The parser check is authoritative, but saying so here
  // gives the model the specific correction.
  const withoutTrailing = bare.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new SqlRejectedError(
      'only one statement may be run at a time; remove everything after the first `;`',
    );
  }

  const match = /[A-Za-z_][A-Za-z0-9_]*/.exec(withoutTrailing);
  const leading = match ? (match[0] as string).toUpperCase() : null;

  if (leading && EXPLAINED_REJECTIONS[leading]) {
    throw new SqlRejectedError(
      `\`${leading}\` is not allowed here — ${EXPLAINED_REJECTIONS[leading]}.`,
    );
  }
  if (leading && !ALLOWED_LEADING.has(leading)) {
    throw new SqlRejectedError(
      `\`${leading}\` is not a readable query; start with SELECT, WITH, FROM, DESCRIBE, or SUMMARIZE.`,
    );
  }

  return { leading, normalized: trimmed.replace(/;\s*$/, '') };
}

/** The slice of the runner the guard needs, so tests can supply their own. */
export interface GuardRunner {
  runTrusted<Row = Record<string, unknown>>(sql: string, opts: DuckRunOptions): Promise<Row[]>;
}

interface SerializeVerdict {
  error: boolean;
  error_message?: string;
  statements?: unknown[];
}

/**
 * The authoritative pass: hand the statement to DuckDB's parser and accept it
 * only if it parses as exactly one SELECT.
 *
 * `json_serialize_sql` parses without executing, so this cannot itself have a
 * side effect — verified by running it on an ATTACH payload and confirming no
 * file appeared.
 */
export async function parserCheck(
  sql: string,
  runner: GuardRunner,
  opts: DuckRunOptions,
): Promise<void> {
  let rows: { verdict?: SerializeVerdict }[];
  try {
    rows = await runner.runTrusted<{ verdict?: SerializeVerdict }>(
      `SELECT json_serialize_sql('${sqlLiteral(sql)}') AS verdict`,
      opts,
    );
  } catch (err) {
    // The validator itself failing is not a licence to run unvalidated SQL.
    throw new SqlRejectedError(
      `the query could not be validated, so it was not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const verdict = rows[0]?.verdict;
  if (!verdict || typeof verdict.error !== 'boolean') {
    throw new SqlRejectedError('the query could not be validated, so it was not run');
  }
  if (verdict.error) {
    const detail = verdict.error_message ?? 'the engine rejected it';
    // The parser's own words for a non-SELECT are opaque out of context.
    const readable = /Only SELECT statements/i.test(detail)
      ? 'only read-only SELECT queries are allowed here'
      : detail;
    throw new SqlRejectedError(`the query was rejected: ${readable}`);
  }
  const count = Array.isArray(verdict.statements) ? verdict.statements.length : 0;
  if (count !== 1) {
    throw new SqlRejectedError(
      `only one statement may be run at a time (the engine parsed ${count})`,
    );
  }
}

/**
 * Full gate. Returns the normalized statement, ready to be wrapped and run.
 *
 * Both passes are required. The lexical one alone misses `WITH … INSERT`; the
 * parser one alone gives worse messages for the common mistakes.
 */
export async function assertReadOnlyStatement(
  sql: string,
  runner: GuardRunner,
  opts: DuckRunOptions,
): Promise<string> {
  const { normalized } = lexicalCheck(sql);
  await parserCheck(normalized, runner, opts);
  return normalized;
}
