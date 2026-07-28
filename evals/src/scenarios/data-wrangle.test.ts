import { describe, expect, it } from 'vitest';
import {
  CUSTOMERS_A_CSV,
  CUSTOMERS_B_CSV,
  DATA_WRANGLE_KICKOFF_MESSAGE,
  DATA_WRANGLE_MISSION_OBJECTIVES,
  DATA_WRANGLE_SIGNALS,
  DATA_WRANGLE_VALIDATOR_MJS,
  DATA_WRANGLE_VALIDATOR_PATH,
  EXPECTED_ROW_COUNT,
  GOLDEN_BOM_ROW,
  GOLDEN_DEDUP_DATES,
  GOLDEN_QUOTED_NAME,
  LEGACY_EXPORT_CSV,
  dataWrangleRepairDirective,
  verifyCustomersJson,
} from './data-wrangle.ts';

/**
 * Unwinnable-grader guard: (a) wrong/partial transforms must FAIL the
 * gate with the right signal named first, and (b) a REFERENCE SOLUTION
 * — derived here with an independent ETL over the exported seed CSVs,
 * never copied from the grader's hardcoded goldens — must PASS. If the
 * seed data and the hardcoded goldens ever drift, these tests fail.
 */

// ─────────────────────────────────────────────────────────────────────
// Independent reference ETL.

/** Minimal RFC-4180-ish line parser: quoted fields, embedded commas, "" escapes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse a seeded CSV: optionally strip the BOM, skip any pre-header junk lines. */
function parseCsv(text: string, opts: { stripBom: boolean }): Array<Record<string, string>> {
  const cleaned = opts.stripBom ? text.replace(/^\uFEFF/, '') : text;
  const lines = cleaned.split('\n').filter((l) => l.trim() !== '');
  const headerIdx = lines.findIndex((l) => l.includes('id,name,email,signup_date'));
  const header = parseCsvLine(lines[headerIdx] ?? '');
  return lines.slice(headerIdx + 1).map((line) => {
    const fields = parseCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, fields[i] ?? '']));
  });
}

const pad2 = (s: string) => s.padStart(2, '0');
const usToIso = (d: string) => {
  const [m = '', day = '', y = ''] = d.split('/');
  return `${y}-${pad2(m)}-${pad2(day)}`;
};
const euToIso = (d: string) => {
  const [day = '', m = '', y = ''] = d.split('.');
  return `${y}-${pad2(m)}-${pad2(day)}`;
};

interface RefRow {
  id: string;
  name: string;
  email: string;
  signupDate: string;
}

interface BuildOpts {
  stripBom?: boolean;
  normalizeEmails?: boolean;
  dedupe?: 'newest' | 'oldest' | 'none';
  sort?: boolean;
}

/** Reference transform with switchable mistakes for the negative tests. */
function buildRows(opts: BuildOpts = {}): RefRow[] {
  const stripBom = opts.stripBom ?? true;
  const normalizeEmails = opts.normalizeEmails ?? true;
  const dedupe = opts.dedupe ?? 'newest';
  const sort = opts.sort ?? true;

  const raw: RefRow[] = [
    ...parseCsv(CUSTOMERS_A_CSV, { stripBom }).map((r) => ({
      id: r.id ?? '',
      name: r.name ?? '',
      email: r.email ?? '',
      signupDate: usToIso(r.signup_date ?? ''),
    })),
    ...parseCsv(CUSTOMERS_B_CSV, { stripBom }).map((r) => ({
      id: r.id ?? '',
      name: r.name ?? '',
      email: r.email ?? '',
      signupDate: r.signup_date ?? '',
    })),
    ...parseCsv(LEGACY_EXPORT_CSV, { stripBom }).map((r) => ({
      id: r.id ?? '',
      name: r.name ?? '',
      email: r.email ?? '',
      signupDate: euToIso(r.signup_date ?? ''),
    })),
  ].map((r) => ({
    ...r,
    email: normalizeEmails ? r.email.trim().toLowerCase() : r.email,
  }));

  let rows = raw;
  if (dedupe !== 'none') {
    const byEmail = new Map<string, RefRow>();
    for (const row of raw) {
      const key = row.email.trim().toLowerCase();
      const prev = byEmail.get(key);
      const keepNew = dedupe === 'newest' ? row.signupDate > (prev?.signupDate ?? '') : false;
      const keepOld = dedupe === 'oldest' ? row.signupDate < (prev?.signupDate ?? '~') : false;
      if (!prev || keepNew || keepOld) byEmail.set(key, row);
    }
    rows = [...byEmail.values()];
  }
  if (sort) rows = [...rows].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return rows;
}

const asJson = (rows: RefRow[]) => JSON.stringify(rows, null, 2);

// ─────────────────────────────────────────────────────────────────────

describe('data-wrangle grader — reference solution PASSES', () => {
  const reference = buildRows();

  it('the independently-derived reference output fires all signals', () => {
    const result = verifyCustomersJson(asJson(reference));
    expect(result.failReason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual([...DATA_WRANGLE_SIGNALS]);
    expect(result.score).toBe(DATA_WRANGLE_SIGNALS.length);
  });

  it('the hardcoded goldens agree with the independent reference ETL', () => {
    expect(reference).toHaveLength(EXPECTED_ROW_COUNT);
    const byEmail = new Map(reference.map((r) => [r.email, r]));
    expect(byEmail.get(GOLDEN_BOM_ROW.email)).toEqual(GOLDEN_BOM_ROW);
    const quoted = byEmail.get(GOLDEN_QUOTED_NAME.email);
    expect(quoted?.name).toBe(GOLDEN_QUOTED_NAME.name);
    expect(quoted?.signupDate).toBe(GOLDEN_QUOTED_NAME.signupDate);
    for (const [email, date] of Object.entries(GOLDEN_DEDUP_DATES)) {
      expect(byEmail.get(email)?.signupDate).toBe(date);
    }
  });
});

describe('data-wrangle grader — seeded/empty state FAILS', () => {
  it('a missing out/customers.json fails parses-as-array', () => {
    const result = verifyCustomersJson(null);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['parses-as-array']);
    expect(result.score).toBe(0);
  });

  it('a non-array JSON document fails parses-as-array', () => {
    const result = verifyCustomersJson('{"customers": []}');
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['parses-as-array']);
  });

  it('invalid JSON reports the parse error', () => {
    const result = verifyCustomersJson('[{"id": "A-001",]');
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['parses-as-array']);
    expect(result.failReason).toMatch(/not valid JSON/);
  });
});

describe('data-wrangle grader — each seeded trap is caught with one named gap', () => {
  it('an unstripped BOM corrupts the customers_a ids and fails row-shape', () => {
    const result = verifyCustomersJson(asJson(buildRows({ stripBom: false })));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['row-shape']);
    expect(result.failReason).toMatch(/"id"/);
  });

  it('skipping email normalization fails emails-normalized with the offending value', () => {
    const result = verifyCustomersJson(asJson(buildRows({ normalizeEmails: false })));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['emails-normalized']);
    expect(result.failReason).toMatch(/not lowercased\+trimmed/);
  });

  it('skipping dedup fails unique-emails naming a duplicated email', () => {
    const result = verifyCustomersJson(asJson(buildRows({ dedupe: 'none' })));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['unique-emails']);
    expect(result.failReason).toMatch(/appears more than once/);
  });

  it('invented rows fail source-ids-preserved before row-count', () => {
    const rows = buildRows()
      .slice(0, 21)
      .map((r, i) => ({ ...r, id: `c${String(i + 1).padStart(3, '0')}` }));
    const result = verifyCustomersJson(asJson(rows));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['source-ids-preserved']);
    expect(result.failReason).toContain('not present in any source CSV row');
  });

  it('rejects fabricated row data that merely borrows valid source ids', () => {
    const rows = buildRows().map((row, index) =>
      index === 0
        ? {
            ...row,
            name: 'Invented Customer',
          }
        : row,
    );
    const result = verifyCustomersJson(asJson(rows));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['source-ids-preserved']);
    expect(result.failReason).toContain('does not exactly match that source row');
  });

  it('dropping a record fails row-count with expected vs actual', () => {
    const rows = buildRows().slice(0, -1);
    const result = verifyCustomersJson(asJson(rows));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['row-count']);
    expect(result.failReason).toContain(`expected exactly ${EXPECTED_ROW_COUNT}`);
  });

  it('an unsorted array fails sorted-by-email naming the offending pair', () => {
    const rows = buildRows();
    const swapped = [...rows];
    const first = swapped[0] as RefRow;
    swapped[0] = swapped[10] as RefRow;
    swapped[10] = first;
    const result = verifyCustomersJson(asJson(swapped));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['sorted-by-email']);
  });

  it('keeping the OLDEST duplicate instead of the newest is caught by a golden', () => {
    // Oldest-wins keeps L-009 ("Robert Smith", 2024-03-15) over B-003,
    // so the quoted-name golden is the first to fire.
    const result = verifyCustomersJson(asJson(buildRows({ dedupe: 'oldest' })));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['golden-quoted-name']);
    expect(result.failReason).toContain(GOLDEN_QUOTED_NAME.email);
  });

  it('US-misreading the European dotted date on the dedup pair fails golden-dedup-newest', () => {
    // 02.11.2025 read month-first gives 2025-02-11 — a valid date, a
    // plausible mistake, and exactly what the golden pins down.
    const rows = buildRows().map((r) =>
      r.email === 'alice.archer@example.com' ? { ...r, signupDate: '2025-02-11' } : r,
    );
    const result = verifyCustomersJson(asJson(rows));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['golden-dedup-newest']);
    expect(result.failReason).toContain('alice.archer@example.com');
    expect(result.failReason).toContain('2025-11-02');
    // B4: the diff list itemizes the exact expected-vs-got pair.
    expect(result.goldenDiffs).toEqual([
      { field: 'alice.archer@example.com signupDate', expected: '2025-11-02', got: '2025-02-11' },
    ]);
  });

  it('a golden failure lists EVERY failing golden field, not just the fail-fast first one', () => {
    // Oldest-wins dedupe breaks the quoted-name golden AND all three
    // dedup-date goldens; the verdict fields stay the fail-fast contract
    // (one signal) while goldenDiffs carries the complete picture.
    const result = verifyCustomersJson(asJson(buildRows({ dedupe: 'oldest' })));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['golden-quoted-name']);
    const fields = (result.goldenDiffs ?? []).map((d) => d.field);
    expect(fields).toContain('robert.smith@example.com signupDate');
    expect(fields).toContain('alice.archer@example.com signupDate');
    expect(fields).toContain('zoe.quill@example.com signupDate');
    expect(fields).toContain('omar.haddad@example.com signupDate');
  });

  it('structural failures carry no golden diff table', () => {
    const rows = buildRows().slice(0, 10);
    const result = verifyCustomersJson(asJson(rows));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['row-count']);
    expect(result.goldenDiffs).toBeUndefined();
  });

  it('extra fields on a record fail row-shape', () => {
    const rows = buildRows().map((r, i) => (i === 0 ? { ...r, source: 'legacy' } : r));
    const result = verifyCustomersJson(JSON.stringify(rows));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toEqual(['row-shape']);
    expect(result.failReason).toMatch(/extra field/);
  });
});

describe('data-wrangle repair feedback', () => {
  it('tells the model that invalid JSON must be replaced with data, not code', () => {
    const result = verifyCustomersJson('const fs = require("fs");');
    const directive = dataWrangleRepairDirective(result);
    expect(directive).toContain('DATA_WRANGLE_JSON_REPAIR');
    expect(directive).toContain('JSON data only');
    expect(directive).toContain('no JavaScript source');
    expect(directive).toContain('scripts/clean_data.mjs');
    expect(directive).toContain('fs.writeFileSync');
    expect(directive).toContain('fs.readFileSync');
    expect(directive).toContain('line-numbered read_file output');
    expect(directive).toContain('MCP tools like write_file');
    expect(directive).toContain(`node ${DATA_WRANGLE_VALIDATOR_PATH}`);
    expect(directive).toContain('never write script source');
    expect(directive).toContain(`exactly ${EXPECTED_ROW_COUNT}`);
  });

  it('tells the model to rebuild from all raw inputs with a cleaner script on row-count failures', () => {
    const result = verifyCustomersJson(asJson(buildRows().slice(0, -4)));
    const directive = dataWrangleRepairDirective(result);
    expect(directive).toContain('DATA_WRANGLE_COMPLETE_REBUILD');
    expect(directive).toContain('data/raw/customers_a.csv');
    expect(directive).toContain('data/raw/customers_b.csv');
    expect(directive).toContain('data/raw/legacy_export.csv');
    expect(directive).toContain('60 data rows total');
    expect(directive).toContain(`exactly ${EXPECTED_ROW_COUNT} records`);
    expect(directive).toContain('source header signup_date');
    expect(directive).toContain('preserve the id/name');
    expect(directive).toContain('fs.readFileSync/fs.writeFileSync');
    expect(directive).toContain('line-numbered read_file output');
    expect(directive).toContain('MCP tools like write_file');
    expect(directive).toContain(`node ${DATA_WRANGLE_VALIDATOR_PATH}`);
    expect(directive).toContain('write it to scripts/clean_data.mjs');
    expect(directive).toContain('final JSON array only');
    expect(directive).toContain('never put JavaScript source there');
    expect(directive).toContain('Do not reply in prose without running the cleaner');
  });

  it('also requires a scripted rebuild on sort-only failures', () => {
    const rows = buildRows();
    const reversed = [...rows].reverse();
    const result = verifyCustomersJson(asJson(reversed));
    const directive = dataWrangleRepairDirective(result);
    expect(result.missingRequiredSignals).toEqual(['sorted-by-email']);
    expect(directive).toContain('DATA_WRANGLE_COMPLETE_REBUILD');
    expect(directive).toContain('sort by email ascending');
    expect(directive).toContain(`exactly ${EXPECTED_ROW_COUNT} records`);
  });

  it('also requires a scripted rebuild on golden-row failures', () => {
    const rows = buildRows().map((row) =>
      row.email === GOLDEN_BOM_ROW.email ? { ...row, name: 'Box' } : row,
    );
    const result = verifyCustomersJson(asJson(rows));
    const directive = dataWrangleRepairDirective(result);
    expect(result.missingRequiredSignals).toEqual(['golden-bom-row']);
    expect(directive).toContain('DATA_WRANGLE_COMPLETE_REBUILD');
    expect(directive).toContain('preserve quoted comma names');
    expect(directive).toContain('do not hand-edit the JSON');
    // B4: the directive renders the expected-vs-got table for the exact
    // failing golden fields.
    expect(directive).toContain('| field | expected | got |');
    expect(directive).toContain(`| ${GOLDEN_BOM_ROW.email} name | ${GOLDEN_BOM_ROW.name} | Box |`);
    expect(directive).toContain('records not listed already pass');
  });

  it('requires a complete rebuild when output ids were invented', () => {
    const rows = buildRows()
      .slice(0, 21)
      .map((r, i) => ({ ...r, id: `c${String(i + 1).padStart(3, '0')}` }));
    const result = verifyCustomersJson(asJson(rows));
    const directive = dataWrangleRepairDirective(result);
    expect(result.missingRequiredSignals).toEqual(['source-ids-preserved']);
    expect(directive).toContain('DATA_WRANGLE_SOURCE_REBUILD');
    expect(directive).toContain('discard the current');
    expect(directive).toContain('Do not rename invented/sample rows');
    expect(directive).toContain('A-###, B-###, or L-###');
    expect(directive).toContain('No CUST###');
    expect(directive).toContain('fs.readFileSync');
    expect(directive).toContain('fs.writeFileSync');
    expect(directive).toContain('line-numbered read_file output');
    expect(directive).toContain(`node ${DATA_WRANGLE_VALIDATOR_PATH}`);
    expect(directive).toContain('source header signup_date');
  });
});

describe('data-wrangle validator CLI', () => {
  it('is advertised in the kickoff text and checks the key local failure modes', () => {
    expect(DATA_WRANGLE_KICKOFF_MESSAGE).toContain(`node ${DATA_WRANGLE_VALIDATOR_PATH}`);
    expect(DATA_WRANGLE_VALIDATOR_MJS).toContain('FAIL parse');
    expect(DATA_WRANGLE_VALIDATOR_MJS).toContain('FAIL source id');
    expect(DATA_WRANGLE_VALIDATOR_MJS).toContain('FAIL row count');
    expect(DATA_WRANGLE_VALIDATOR_MJS).toContain('FAIL sort');
    expect(DATA_WRANGLE_VALIDATOR_MJS).toContain('PASS basic customer checks');
  });
});

describe('data-wrangle — required signals are satisfiable from the user-shaped text', () => {
  // The de-facto prompt for seeded scenarios is the kickoff + mission
  // text (orthogonal-scenarios cleanup rec #3). Every gated property is
  // stated there, so a model doing exactly what was asked can pass.
  const evidence =
    `${DATA_WRANGLE_KICKOFF_MESSAGE}\n${DATA_WRANGLE_MISSION_OBJECTIVES}`.toLowerCase();

  it.each([
    ['parses-as-array / row shape', /json array/],
    ['exact fields', /exactly four string fields: id, name, email, signupdate/],
    ['emails-normalized', /lowercased and trimmed/],
    ['source id/name preservation', /preserve id and name from the kept source row/],
    ['script runtime boundary', /fs\.readfilesync[\s\S]*fs\.writefilesync/],
    ['no MCP tool calls inside scripts', /write_file are not available inside node scripts/],
    ['no pasted read_file markers', /line-numbered read_file output/],
    ['validator CLI', /node tools\/check_customers\.mjs/],
    ['dates-iso', /yyyy-mm-dd/],
    ['date conventions per file', /mm\/dd\/yyyy[\s\S]*dd\.mm\.yyyy/],
    ['unique-emails / dedup-newest', /deduplicate on the normalized[\s\S]*newest/],
    ['sorted-by-email', /sort the array by email, ascending/],
    ['output path', /out\/customers\.json/],
  ])('%s is stated in the kickoff/mission text', (_name, pattern) => {
    expect(pattern.test(evidence)).toBe(true);
  });
});
