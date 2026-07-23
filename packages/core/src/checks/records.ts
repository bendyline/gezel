import type { CheckResult } from './types.js';

/**
 * Structured-data checks — tables and record schemas.
 *
 * `recordSchema` generalizes data-wrangle's `verifyCustomersJson`
 * (evals/src/scenarios/data-wrangle.ts): a JSON array or CSV whose rows
 * validate against a declared field shape, with the same first-failure
 * discipline (name exactly one gap, with the offending value). `tableShape`
 * is the Markdown-table sibling for reports/comparisons/plans.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO yyyy-mm-dd AND a real calendar date (ported from data-wrangle). */
export function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parts = value.split('-').map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const d = parts[2] ?? 0;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Built-in cell/field types, or any other string is treated as a regex
 * source the value must match. Returns `detail` describing the mismatch.
 */
export type CellType =
  | 'string'
  | 'nonempty'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'iso-date'
  | 'email'
  | (string & {});

function checkCellType(value: string, type: CellType): CheckResult {
  switch (type) {
    case 'string':
    case 'nonempty':
      return value.length > 0 ? { ok: true, detail: '' } : { ok: false, detail: 'empty value' };
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `"${value}" is not a number` };
    case 'integer':
      return /^-?\d+$/.test(value)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `"${value}" is not an integer` };
    case 'boolean':
      return /^(true|false)$/i.test(value)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `"${value}" is not a boolean` };
    case 'date':
    case 'iso-date':
      return isRealIsoDate(value)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `"${value}" is not an ISO yyyy-mm-dd date` };
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `"${value}" is not an email` };
    default: {
      let re: RegExp | null = null;
      try {
        re = new RegExp(type);
      } catch {
        return { ok: false, detail: `invalid column type /${type}/` };
      }
      return re.test(value)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `"${value}" does not match /${type}/` };
    }
  }
}

// ─── Markdown tables ──────────────────────────────────────────────────

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/** Parse the first GitHub-flavored Markdown table (header row, a `|---|`
 *  delimiter row, then contiguous body rows). Returns null if none. */
export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i];
    const delim = lines[i + 1];
    if (!header || !header.includes('|') || !delim || !isDelimiterRow(delim)) continue;
    const headers = splitTableRow(header);
    if (headers.length === 0) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const l = lines[j];
      if (!l || l.trim() === '' || !l.includes('|')) break;
      rows.push(splitTableRow(l));
    }
    return { headers, rows };
  }
  return null;
}

export interface TableShapeSpec {
  /** Header names that must be present (case-insensitive). */
  requiredColumns?: string[];
  /** Minimum body-row count. */
  minRows?: number;
  /** Per-column value type (built-in CellType or a regex source). */
  columnTypes?: Record<string, CellType>;
}

export interface TableShapeResult extends CheckResult {
  headers: string[];
  rowCount: number;
}

/** Validate the first Markdown table in `text`: required header set, row
 *  floor, and per-column value types. */
export function tableShape(text: string, spec: TableShapeSpec): TableShapeResult {
  const table = parseMarkdownTable(text);
  if (!table) {
    return {
      ok: false,
      detail: 'no Markdown table found — provide a "| header | … |" row with a "|---|" delimiter.',
      headers: [],
      rowCount: 0,
    };
  }
  const headersLower = table.headers.map((h) => h.toLowerCase());
  const base = { headers: table.headers, rowCount: table.rows.length };

  for (const col of spec.requiredColumns ?? []) {
    if (!headersLower.includes(col.toLowerCase())) {
      return {
        ok: false,
        detail: `table is missing required column "${col}" — found: ${table.headers.join(', ')}.`,
        ...base,
      };
    }
  }

  const minRows = spec.minRows ?? 0;
  if (table.rows.length < minRows) {
    return {
      ok: false,
      detail: `table has ${table.rows.length} row(s), need ≥ ${minRows}.`,
      ...base,
    };
  }

  for (const [col, type] of Object.entries(spec.columnTypes ?? {})) {
    const idx = headersLower.indexOf(col.toLowerCase());
    if (idx === -1) {
      return { ok: false, detail: `column-type check names unknown column "${col}".`, ...base };
    }
    for (let r = 0; r < table.rows.length; r++) {
      const cell = (table.rows[r]?.[idx] ?? '').trim();
      const v = checkCellType(cell, type);
      if (!v.ok) {
        return { ok: false, detail: `row ${r + 1} column "${col}": ${v.detail}`, ...base };
      }
    }
  }

  return {
    ok: true,
    detail: `table has ${table.headers.length} column(s) and ${table.rows.length} row(s)`,
    ...base,
  };
}

// ─── CSV + record schemas ─────────────────────────────────────────────

/**
 * Minimal RFC-4180-ish CSV parser: quoted fields, embedded commas,
 * escaped double-quotes (""), CRLF, and a leading UTF-8 BOM. Returns a
 * grid of trimmed-on-cell cells (callers trim further as needed).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let started = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (started && (cell.length > 0 || row.length > 0)) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvQuoteError(text: string): string | null {
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          i++;
        } else {
          inQuotes = false;
        }
      }
    } else if (ch === '"') {
      inQuotes = true;
    }
  }
  return inQuotes ? 'CSV has an unclosed quoted field' : null;
}

/**
 * Cheap, dependency-free sniff: does `text` look like a produced DATA
 * deliverable — a non-empty JSON array of records, a comma-delimited
 * table with a header + at least one data row, or a Markdown table —
 * rather than an empty file or the transform *script* that would
 * produce it? This is the data-class analogue of `htmlCompleteSniff`:
 * it answers "is this plausibly the real output", not "is every value
 * correct" (that's {@link recordSchema}'s job, used when a field schema
 * is known). The shared-column-shape requirement on the delimited path
 * keeps a source file accidentally read as CSV (ragged, mostly
 * single-column lines) from passing as data.
 */
export function dataTableSniff(text: string): boolean {
  const stripped = text.replace(/^\uFEFF/, '').trim();
  if (stripped.length === 0) return false;
  // Canonical record-set output: a non-empty top-level JSON array.
  if (stripped[0] === '[') {
    try {
      const parsed = JSON.parse(stripped);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }
  // Markdown table: header row + `|---|` delimiter + ≥1 body row.
  const md = parseMarkdownTable(stripped);
  if (md && md.headers.length > 0 && md.rows.length > 0) return true;
  // Comma-delimited table: a header with ≥2 columns and ≥1 data row that
  // shares the header's column count.
  const grid = parseCsv(stripped).filter((r) => r.some((c) => c.trim().length > 0));
  if (grid.length >= 2) {
    const cols = grid[0]?.length ?? 0;
    if (cols >= 2 && grid.slice(1).some((r) => r.length === cols)) return true;
  }
  return false;
}

export interface CsvShapeSpec {
  /** Header names that must be present exactly. */
  requiredColumns?: string[];
  /** Complete header row, in order. When set, no extra/missing columns are allowed. */
  exactColumns?: string[];
  /** Minimum data-row count, excluding the header row. */
  minRows?: number;
  /** Reject rows whose cell count differs from the header. Defaults to true. */
  consistentColumns?: boolean;
  /** Per-column allowed values. Empty cells are ignored here; use exactColumns/requiredColumns for shape. */
  allowedValues?: Record<string, string[]>;
}

export interface CsvShapeResult extends CheckResult {
  headers: string[];
  rowCount: number;
}

function csvShapeFailure(detail: string, headers: string[] = [], rowCount = 0): CsvShapeResult {
  return { ok: false, detail, headers, rowCount };
}

function summarizeCsvRow(row: string[], max = 180): string {
  const summary = row.map((cell) => cell.trim()).join(' | ');
  return summary.length <= max ? summary : `${summary.slice(0, max - 3)}...`;
}

/** Validate CSV file shape: header, row count, ragged rows, and optional picklist values. */
export function csvShape(text: string | null, spec: CsvShapeSpec): CsvShapeResult {
  if (text === null) {
    return csvShapeFailure('CSV file not found');
  }
  const quoteError = csvQuoteError(text);
  if (quoteError) {
    return csvShapeFailure(quoteError);
  }

  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim().length > 0));
  if (grid.length === 0) {
    return csvShapeFailure('CSV has no rows');
  }
  const headers = (grid[0] ?? []).map((h) => h.trim());
  const dataRows = grid.slice(1);
  const base = { headers, rowCount: dataRows.length };
  if (headers.length === 0 || headers.every((h) => h.length === 0)) {
    return csvShapeFailure('CSV header row is empty', headers, dataRows.length);
  }

  if (spec.exactColumns) {
    const expected = spec.exactColumns;
    const matches =
      headers.length === expected.length &&
      headers.every((header, index) => header === expected[index]);
    if (!matches) {
      return {
        ok: false,
        detail: `CSV header should be exactly: ${expected.join(', ')}; found: ${headers.join(', ')}`,
        ...base,
      };
    }
  }

  for (const column of spec.requiredColumns ?? []) {
    if (!headers.includes(column)) {
      return {
        ok: false,
        detail: `CSV is missing required column "${column}" — found: ${headers.join(', ')}`,
        ...base,
      };
    }
  }

  const minRows = spec.minRows ?? 0;
  if (dataRows.length < minRows) {
    return {
      ok: false,
      detail: `CSV has ${dataRows.length} data row(s), need ≥ ${minRows}`,
      ...base,
    };
  }

  if (spec.consistentColumns ?? true) {
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] ?? [];
      if (row.length !== headers.length) {
        return {
          ok: false,
          detail: `CSV row ${i + 2} has ${row.length} column(s), expected ${headers.length}. Keep empty placeholders as adjacent commas so every row matches the header. Header order: ${headers.join(' | ')}. Row ${i + 2}: ${summarizeCsvRow(row)}`,
          ...base,
        };
      }
    }
  }

  for (const [column, allowedValues] of Object.entries(spec.allowedValues ?? {})) {
    const index = headers.indexOf(column);
    if (index === -1) {
      return {
        ok: false,
        detail: `CSV allowed-values check names unknown column "${column}"`,
        ...base,
      };
    }
    for (let i = 0; i < dataRows.length; i++) {
      const value = (dataRows[i]?.[index] ?? '').trim();
      if (value.length > 0 && !allowedValues.includes(value)) {
        return {
          ok: false,
          detail: `CSV row ${i + 2} column "${column}" has "${value}", expected one of: ${allowedValues.join(', ')}`,
          ...base,
        };
      }
    }
  }

  return {
    ok: true,
    detail: `CSV has ${headers.length} column(s) and ${dataRows.length} data row(s)`,
    ...base,
  };
}

export interface RecordFieldSpec {
  name: string;
  /** Value type; omit (or 'string') for any non-empty string. */
  type?: CellType;
  /** Defaults to true. */
  required?: boolean;
}

export interface RecordSchemaSpec {
  fields: RecordFieldSpec[];
  /** Reject rows carrying fields not in `fields`. Defaults to false. */
  allowExtraFields?: boolean;
  minRows?: number;
  /** Field whose values must be unique across all rows. */
  uniqueBy?: string;
  /** 'json' | 'csv' | 'auto' (default 'auto' — sniff by first char). */
  format?: 'json' | 'csv' | 'auto';
}

export interface RecordSchemaResult extends CheckResult {
  rowCount: number;
}

type Record_ = Record<string, unknown>;

/**
 * Validate a JSON array (or CSV) of records against a declared schema.
 * Checks run in a fixed order and STOP at the first failure, naming
 * exactly one gap with the offending value (the data-wrangle discipline).
 * `null` text means the deliverable doesn't exist yet.
 */
export function recordSchema(text: string | null, spec: RecordSchemaSpec): RecordSchemaResult {
  if (text === null) {
    return {
      ok: false,
      detail: 'deliverable not found — write the records file before advancing.',
      rowCount: 0,
    };
  }
  if (spec.fields.length === 0) {
    return { ok: false, detail: 'no fields configured — set the schema "fields".', rowCount: 0 };
  }

  const stripped = text.replace(/^\uFEFF/, '');
  const fmt =
    spec.format && spec.format !== 'auto'
      ? spec.format
      : /^\s*[[{]/.test(stripped)
        ? 'json'
        : 'csv';

  let records: Record_[];
  if (fmt === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `not valid JSON: ${msg.slice(0, 160)}`, rowCount: 0 };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        detail: `expected a top-level JSON array, got ${typeof parsed}`,
        rowCount: 0,
      };
    }
    records = parsed as Record_[];
  } else {
    const grid = parseCsv(text).filter((r) => r.some((c) => c.trim().length > 0));
    if (grid.length === 0) return { ok: false, detail: 'CSV has no rows', rowCount: 0 };
    const headers = (grid[0] ?? []).map((h) => h.trim());
    records = grid.slice(1).map((cells) => {
      const o: Record_ = {};
      headers.forEach((h, i) => {
        o[h] = (cells[i] ?? '').trim();
      });
      return o;
    });
  }

  const fieldNames = spec.fields.map((f) => f.name);
  const allowExtra = spec.allowExtraFields ?? false;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return {
        ok: false,
        detail: `record ${i} is not an object: ${JSON.stringify(row)?.slice(0, 120)}`,
        rowCount: records.length,
      };
    }
    for (const f of spec.fields) {
      const required = f.required !== false;
      const raw = (row as Record_)[f.name];
      const present =
        Object.prototype.hasOwnProperty.call(row, f.name) &&
        raw !== '' &&
        raw !== null &&
        raw !== undefined;
      if (!present) {
        if (required) {
          return {
            ok: false,
            detail: `record ${i} is missing required field "${f.name}"`,
            rowCount: records.length,
          };
        }
        continue;
      }
      if (f.type && f.type !== 'string') {
        const v = checkCellType(String(raw), f.type);
        if (!v.ok) {
          return {
            ok: false,
            detail: `record ${i} field "${f.name}": ${v.detail}`,
            rowCount: records.length,
          };
        }
      }
    }
    if (!allowExtra) {
      const extra = Object.keys(row).filter((k) => !fieldNames.includes(k));
      if (extra.length > 0) {
        return {
          ok: false,
          detail: `record ${i} has unexpected field(s) ${extra.join(', ')} — allowed: ${fieldNames.join(', ')}`,
          rowCount: records.length,
        };
      }
    }
  }

  if (spec.minRows !== undefined && records.length < spec.minRows) {
    return {
      ok: false,
      detail: `${records.length} record(s), need ≥ ${spec.minRows}`,
      rowCount: records.length,
    };
  }

  if (spec.uniqueBy) {
    const seen = new Set<string>();
    for (let i = 0; i < records.length; i++) {
      const key = String((records[i] as Record_)[spec.uniqueBy] ?? '');
      if (seen.has(key)) {
        return {
          ok: false,
          detail: `duplicate ${spec.uniqueBy} "${key}" at record ${i} — values must be unique`,
          rowCount: records.length,
        };
      }
      seen.add(key);
    }
  }

  return {
    ok: true,
    detail: `${records.length} record(s) validate against the schema`,
    rowCount: records.length,
  };
}
