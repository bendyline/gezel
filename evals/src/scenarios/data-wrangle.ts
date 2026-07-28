import type { GezelClient } from '@bendyline/gezel-client/node';
import {
  contentRevisionToken,
  postMissingDeliverableFeedback,
  postSniffFeedback,
} from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { provisionScenarioGezel } from './helpers.ts';

/**
 * Data-wrangle — precision ETL over deliberately messy CSV fixtures.
 *
 * Axis: data-transformation correctness (scenario #1 in
 * docs/orthogonal-scenarios-2026-06.md). The nearest existing neighbor
 * is bookstore, which tests spec-writing; nothing in the suite tests
 * whether a model can hold a stack of global normalization constraints
 * (encoding, quoting, date conventions, dedup keys, ordering) across a
 * whole transform. There is no creativity escape hatch: the output is
 * right or it is not.
 *
 * The three seeded CSVs are messy on purpose:
 *   - customers_a.csv starts with a UTF-8 BOM (an unstripped BOM corrupts
 *     the header so every `id` from that file goes missing),
 *   - customers_b.csv has quoted names containing commas,
 *   - legacy_export.csv opens with a junk banner line that is not a
 *     header, uses European dotted dates, and carries near-duplicate rows
 *     whose emails differ only in case/whitespace.
 *
 * The grader is behavioral and in-process: it loads out/customers.json
 * and runs eleven sequential property checks (parse, shape, normalization,
 * dedup, ordering, plus golden assertions computed from the seed data
 * and hardcoded below). Checks run in order and STOP at the first
 * failure so feedback names exactly one gap at a time with the
 * offending value — no style regexes anywhere.
 */

const PROJECT_NAME = 'Customer Data Cleanup';
const DEVELOPER_NAME = 'Noor';

export const OUTPUT_PATH = 'out/customers.json';
const CUSTOMERS_A_PATH = 'data/raw/customers_a.csv';
const CUSTOMERS_B_PATH = 'data/raw/customers_b.csv';
const LEGACY_EXPORT_PATH = 'data/raw/legacy_export.csv';

// ─────────────────────────────────────────────────────────────────────
// Seed fixtures. 60 data rows across three files; 4 of them are
// near-duplicates (same email after lowercase+trim), so the normalized
// output has exactly 56 records. The goldens below were computed from
// this data with a reference ETL (and the test re-derives them
// independently — if the seed and the goldens ever drift, the test
// fails loudly).

/** UTF-8 BOM + US dates (MM/DD/YYYY). A-001 is the alice dedup pair's OLDER half. */
export const CUSTOMERS_A_CSV = `\uFEFFid,name,email,signup_date
A-001,Alice Archer,alice.archer@example.com,03/14/2024
A-002,Ben Box,ben.box@example.com,07/02/2023
A-003,Cara Diaz,cara.diaz@example.com,11/30/2024
A-004,Dev Patel,dev.patel@example.com,01/05/2025
A-005,Elif Yilmaz,elif.yilmaz@example.com,09/17/2023
A-006,Frank Mota,frank.mota@example.com,04/22/2024
A-007,Gina Rossi,gina.rossi@example.com,12/08/2023
A-008,Hugo Lindt,hugo.lindt@example.com,06/19/2025
A-009,Iris Chen,iris.chen@example.com,02/27/2024
A-010,Jonas Falk,jonas.falk@example.com,10/03/2024
A-011,Kira Holt,kira.holt@example.com,05/11/2023
A-012,Leo Brandt,leo.brandt@example.com,08/29/2024
A-013,Mona Idris,mona.idris@example.com,03/06/2025
A-014,Nils Okafor,nils.okafor@example.com,07/24/2023
A-015,Outi Salo,outi.salo@example.com,11/15/2024
A-016,Petra Voss,petra.voss@example.com,01/31/2024
A-017,Quinn Marsh,quinn.marsh@example.com,09/09/2025
A-018,Rafael Cruz,rafael.cruz@example.com,04/01/2023
A-019,Sana Iqbal,sana.iqbal@example.com,12/20/2024
A-020,Tomas Hejl,tomas.hejl@example.com,06/07/2024
`;

/** ISO dates; quoted names containing commas (B-003 is a golden row). */
export const CUSTOMERS_B_CSV = `id,name,email,signup_date
B-001,Uma Devi,uma.devi@example.com,2024-02-18
B-002,Viktor Lund,viktor.lund@example.com,2023-10-26
B-003,"Smith, Jr., Robert",robert.smith@example.com,2025-08-21
B-004,Wendy Park,wendy.park@example.com,2024-06-12
B-005,Xenia Petrov,xenia.petrov@example.com,2023-03-09
B-006,Yusuf Demir,yusuf.demir@example.com,2025-01-28
B-007,Zoe Quill,zoe.quill@example.com,2024-09-04
B-008,"O'Hara, Aidan",aidan.ohara@example.com,2023-12-13
B-009,Bram Visser,bram.visser@example.com,2024-07-30
B-010,Carmen Soto,carmen.soto@example.com,2025-05-16
B-011,Dara Nolan,dara.nolan@example.com,2023-08-02
B-012,Emil Wagner,emil.wagner@example.com,2024-12-25
B-013,Freya Holm,freya.holm@example.com,2025-03-19
B-014,Gleb Sokolov,gleb.sokolov@example.com,2023-06-21
B-015,Hana Sato,hana.sato@example.com,2024-10-10
B-016,Ivo Kovac,ivo.kovac@example.com,2025-07-07
B-017,Jade Lemoine,jade.lemoine@example.com,2023-04-15
B-018,"Keller, MD, Sofia",sofia.keller@example.com,2024-01-09
B-019,Liam Byrne,liam.byrne@example.com,2025-11-23
B-020,Mira Anand,mira.anand@example.com,2023-09-27
`;

/**
 * Junk banner line (not a header), European dotted dates (DD.MM.YYYY),
 * and 4 near-duplicate rows: L-004 (alice, NEWER than A-001), L-009
 * (robert, older than B-003), L-013 (zoe, newer than B-007), L-017
 * (omar, newer than L-002 — an intra-file duplicate).
 */
export const LEGACY_EXPORT_CSV = `LEGACY CRM EXPORT ;; generated by crm-tool 7.2 ;; rows below ;; DO NOT HAND-EDIT
id,name,email,signup_date
L-001,Nadia Saleh,nadia.saleh@example.com,14.05.2024
L-002,Omar Haddad,omar.haddad@example.com,03.02.2023
L-003,Priya Raman,priya.raman@example.com,27.09.2024
L-004,Alice Archer,  Alice.Archer@Example.com ,02.11.2025
L-005,Rosa Marin,rosa.marin@example.com,08.01.2025
L-006,Stefan Beck,stefan.beck@example.com,19.06.2023
L-007,Tariq Aziz,tariq.aziz@example.com,30.10.2024
L-008,Una Floyd,una.floyd@example.com,11.04.2023
L-009,Robert Smith,ROBERT.SMITH@EXAMPLE.COM,15.03.2024
L-010,Vera Lang,vera.lang@example.com,22.08.2025
L-011,Wim DeJong,wim.dejong@example.com,05.12.2023
L-012,Xander Mills,xander.mills@example.com,17.07.2024
L-013,Zoe Quill,Zoe.Quill@example.com ,28.02.2025
L-014,Yara Nasser,yara.nasser@example.com,09.09.2023
L-015,Anders Vik,anders.vik@example.com,21.01.2024
L-016,Bea Castro,bea.castro@example.com,13.11.2023
L-017,Omar Haddad, OMAR.HADDAD@example.com,26.06.2025
L-018,Chloe Brun,chloe.brun@example.com,04.04.2024
L-019,Daan Smit,daan.smit@example.com,18.10.2025
L-020,Elsa Nyman,elsa.nyman@example.com,07.03.2023
`;

// ─────────────────────────────────────────────────────────────────────
// Goldens — computed from the seed data above and hardcoded. The test
// re-derives all of them with an independent reference ETL.

/** 60 seeded rows − 4 near-duplicate emails. */
export const EXPECTED_ROW_COUNT = 56;

/** Full-row golden from the BOM file: an unstripped BOM corrupts the `id` header key. */
export const GOLDEN_BOM_ROW = {
  id: 'A-002',
  name: 'Ben Box',
  email: 'ben.box@example.com',
  signupDate: '2023-07-02',
} as const;

/**
 * Quoted-comma golden: B-003's name must survive intact, and the dedup
 * must keep B-003 (2025-08-21) over legacy L-009 (2024-03-15).
 */
export const GOLDEN_QUOTED_NAME = {
  id: 'B-003',
  email: 'robert.smith@example.com',
  name: 'Smith, Jr., Robert',
  signupDate: '2025-08-21',
} as const;

/**
 * Dedup-newest goldens: each email appears in multiple seed rows; the
 * kept signupDate must be the NEWEST (and the European dotted dates must
 * have been read day-first — 02.11.2025 is November 2nd, not February 11).
 */
export const GOLDEN_DEDUP_DATES: Readonly<Record<string, string>> = {
  'alice.archer@example.com': '2025-11-02',
  'zoe.quill@example.com': '2025-02-28',
  'omar.haddad@example.com': '2025-06-26',
};

// ─────────────────────────────────────────────────────────────────────
// User-shaped task text. Single-sourced: the six normalization rules
// appear verbatim in both the missionObjectives and the kickoff message
// so the two cannot drift (orthogonal-scenarios cleanup rec #4). Every
// signal the grader hard-requires is stated here.

const NORMALIZATION_RULES = [
  `1. Write the result to ${OUTPUT_PATH} as a single JSON array (UTF-8, no BOM).`,
  '2. Each record has exactly four string fields: id, name, email, signupDate — no extra fields. Preserve id and name from the kept source row.',
  '3. email must be lowercased and trimmed of surrounding whitespace.',
  '4. signupDate must be ISO format yyyy-mm-dd. Source formats: customers_a.csv uses US dates' +
    ' MM/DD/YYYY, customers_b.csv is already ISO yyyy-mm-dd, legacy_export.csv uses European' +
    ' dotted dates DD.MM.YYYY (day first).',
  '5. Deduplicate on the normalized (lowercased, trimmed) email: when several rows share an' +
    ' email, keep only the row whose signupDate is NEWEST.',
  '6. Sort the array by email, ascending.',
].join(' ');

export const DATA_WRANGLE_MISSION_OBJECTIVES = [
  `Normalize the three raw CSV exports under data/raw/ (${CUSTOMERS_A_PATH},`,
  `${CUSTOMERS_B_PATH}, ${LEGACY_EXPORT_PATH}) into one clean ${OUTPUT_PATH} file.`,
  'The exports are messy real-world data: encoding artifacts, quoted fields containing commas,',
  'junk non-data lines, and near-duplicate rows — parse carefully and follow the rules exactly.',
  NORMALIZATION_RULES,
  'Do not modify the files under data/raw/.',
].join(' ');

export const DATA_WRANGLE_KICKOFF_MESSAGE = [
  'Please clean up our customer exports. Read the three CSV files under data/raw/',
  `(${CUSTOMERS_A_PATH}, ${CUSTOMERS_B_PATH}, ${LEGACY_EXPORT_PATH}) and produce the`,
  `normalized ${OUTPUT_PATH}. Paths are relative to the workspace root (no leading`,
  '"workspace/"). Heads up: these are messy real exports — one file starts with an encoding',
  'artifact (UTF-8 BOM), names can be quoted and contain commas, legacy_export.csv opens with',
  'a banner line that is not a header row, and some rows are near-duplicates of each other.',
  `The exact normalization rules: ${NORMALIZATION_RULES}`,
  'Implementation note: if you write a Node script, have the script read the CSV files from disk',
  'with fs.readFileSync and write out/customers.json with fs.writeFileSync. MCP/chat tools like',
  'write_file are not available inside Node scripts. Do not paste line-numbered read_file output',
  'into JavaScript string constants.',
  'A local validator is available: run `node tools/check_customers.mjs` after writing',
  `${OUTPUT_PATH}. It reports parse errors, invented source ids, row-count errors, and sort errors.`,
  'Do not modify the raw CSVs. How you compute the transform is up to you — only the final',
  `${OUTPUT_PATH} file is checked. The checker re-validates the file automatically every few`,
  'seconds and reports the first failing property back to you via chat.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Grader. Pure + in-process (JSON.parse, no spawn) so tests and the
// failure-class backfill can run it with no daemon.

export const DATA_WRANGLE_SIGNALS = [
  'parses-as-array',
  'row-shape',
  'emails-normalized',
  'dates-iso',
  'unique-emails',
  'source-ids-preserved',
  'row-count',
  'sorted-by-email',
  'golden-bom-row',
  'golden-quoted-name',
  'golden-dedup-newest',
] as const;

/** One golden-field mismatch: the exact expected-vs-got pair for repair feedback. */
export interface GoldenDiff {
  /** `<email> <field>` (or `<email> record` when the row is missing entirely). */
  field: string;
  expected: string;
  got: string;
}

export interface CustomersCheckResult {
  ok: boolean;
  signals: string[];
  score: number;
  failReason?: string;
  missingRequiredSignals?: string[];
  /**
   * Present on golden-check failures: EVERY failing golden field across
   * all three golden groups (not just the fail-fast first one), so the
   * repair directive can render a compact expected-vs-got table. The
   * verdict fields above stay byte-identical to the fail-fast contract —
   * sniff keys and historical comparability are untouched.
   */
  goldenDiffs?: GoldenDiff[];
}

const REQUIRED_FIELDS = ['id', 'name', 'email', 'signupDate'] as const;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_ID_RE = /^[ABL]-\d{3}$/;
const SEEDED_SOURCE_IDS = new Set(
  `${CUSTOMERS_A_CSV}\n${CUSTOMERS_B_CSV}\n${LEGACY_EXPORT_CSV}`
    .split('\n')
    .map(
      (line) =>
        line
          .replace(/^\uFEFF/, '')
          .split(',')[0]
          ?.trim() ?? '',
    )
    .filter((id) => SOURCE_ID_RE.test(id)),
);

/**
 * Parse one fixture CSV row without relying on the model's output or on a
 * third-party CSV implementation. The fixtures exercise quoted commas (and
 * may eventually exercise escaped quotes), so `split(',')` is deliberately
 * not sufficient here.
 */
function parseSeedCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function normalizeSeedDate(value: string, format: 'us' | 'iso' | 'eu'): string {
  if (format === 'iso') return value;
  const parts = value.split(format === 'us' ? '/' : '.');
  const year = format === 'us' ? parts[2] : parts[2];
  const month = format === 'us' ? parts[0] : parts[1];
  const day = format === 'us' ? parts[1] : parts[0];
  return `${year}-${month}-${day}`;
}

function sourceRowKeys(csv: string, format: 'us' | 'iso' | 'eu'): string[] {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => line === 'id,name,email,signup_date');
  return lines.slice(headerIndex + 1).map((line) => {
    const [id = '', name = '', rawEmail = '', rawDate = ''] = parseSeedCsvLine(line);
    return JSON.stringify([
      id.trim(),
      name,
      rawEmail.trim().toLowerCase(),
      normalizeSeedDate(rawDate.trim(), format),
    ]);
  });
}

// Full-row provenance closes the sampled-golden loophole: a 56-row array of
// invented names/emails could previously pass as long as each row reused one
// of the 60 valid source ids. Every emitted tuple must now correspond to an
// actual source row after only the normalization the brief allows.
const SEEDED_SOURCE_ROW_KEYS = new Set([
  ...sourceRowKeys(CUSTOMERS_A_CSV, 'us'),
  ...sourceRowKeys(CUSTOMERS_B_CSV, 'iso'),
  ...sourceRowKeys(LEGACY_EXPORT_CSV, 'eu'),
]);
const SEEDED_SOURCE_ROWS = [...SEEDED_SOURCE_ROW_KEYS].map((key) => {
  const [id, name, email, signupDate] = JSON.parse(key) as [string, string, string, string];
  return { id, name, email, signupDate } satisfies CustomerRow;
});

function customerSourceRowKey(row: CustomerRow): string {
  return JSON.stringify([row.id, row.name, row.email, row.signupDate]);
}

export const DATA_WRANGLE_VALIDATOR_PATH = 'tools/check_customers.mjs';
export const DATA_WRANGLE_VALIDATOR_MJS = [
  "import { readFileSync } from 'node:fs';",
  '',
  "const outputPath = 'out/customers.json';",
  "const sourcePaths = ['data/raw/customers_a.csv', 'data/raw/customers_b.csv', 'data/raw/legacy_export.csv'];",
  `const expectedCount = ${EXPECTED_ROW_COUNT};`,
  'const sourceIds = new Set();',
  'for (const sourcePath of sourcePaths) {',
  "  const text = readFileSync(sourcePath, 'utf8').replace(/^\\uFEFF/, '');",
  '  for (const line of text.split(/\\r?\\n/)) {',
  "    const id = line.split(',')[0]?.trim();",
  '    if (/^[ABL]-\\d{3}$/.test(id)) sourceIds.add(id);',
  '  }',
  '}',
  '',
  'let rows;',
  'try {',
  "  rows = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\\uFEFF/, ''));",
  '} catch (err) {',
  '  console.error(`FAIL parse: ${outputPath} must contain JSON data only (${err.message})`);',
  '  process.exit(1);',
  '}',
  'if (!Array.isArray(rows)) {',
  "  console.error('FAIL parse: out/customers.json must be a top-level array');",
  '  process.exit(1);',
  '}',
  'for (const [index, row] of rows.entries()) {',
  "  for (const field of ['id', 'name', 'email', 'signupDate']) {",
  "    if (typeof row?.[field] !== 'string' || row[field].length === 0) {",
  '      console.error(`FAIL shape: row ${index} is missing string field ${field}`);',
  '      process.exit(1);',
  '    }',
  '  }',
  '  if (!sourceIds.has(row.id)) {',
  '    console.error(`FAIL source id: ${row.id} is not in data/raw; do not invent or rename rows`);',
  '    process.exit(1);',
  '  }',
  '}',
  'if (rows.length !== expectedCount) {',
  '  console.error(`FAIL row count: expected ${expectedCount}, got ${rows.length}`);',
  '  process.exit(1);',
  '}',
  'for (let i = 1; i < rows.length; i++) {',
  '  if (rows[i - 1].email > rows[i].email) {',
  '    console.error(`FAIL sort: ${rows[i - 1].email} comes before ${rows[i].email}`);',
  '    process.exit(1);',
  '  }',
  '}',
  'console.log(`PASS basic customer checks: ${rows.length} source-derived rows`);',
].join('\n');

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parts = value.split('-').map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const d = parts[2] ?? 0;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

interface CustomerRow {
  id: string;
  name: string;
  email: string;
  signupDate: string;
}

/**
 * Validate the model's out/customers.json text. Checks run in a fixed
 * order and STOP at the first failure — feedback names exactly one
 * property at a time, with the offending value, so a small model always
 * has one concrete thing to fix. `null` means the file doesn't exist.
 */
export function verifyCustomersJson(text: string | null): CustomersCheckResult {
  const signals: string[] = [];
  const fail = (signal: string, failReason: string): CustomersCheckResult => ({
    ok: false,
    signals,
    score: signals.length,
    failReason,
    missingRequiredSignals: [signal],
  });

  // 1. parses-as-array
  if (text === null) {
    return fail('parses-as-array', `${OUTPUT_PATH} does not exist yet`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail('parses-as-array', `${OUTPUT_PATH} is not valid JSON: ${msg.slice(0, 160)}`);
  }
  if (!Array.isArray(parsed)) {
    return fail(
      'parses-as-array',
      `${OUTPUT_PATH} must be a top-level JSON array, got ${typeof parsed}`,
    );
  }
  signals.push('parses-as-array');
  const rows = parsed as Array<Record<string, unknown>>;

  // 2. row-shape — exactly the four string fields, all non-empty.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return fail(
        'row-shape',
        `record ${i} is not an object: ${JSON.stringify(row)?.slice(0, 120)}`,
      );
    }
    for (const field of REQUIRED_FIELDS) {
      const v = row[field];
      if (typeof v !== 'string' || v.length === 0) {
        return fail(
          'row-shape',
          `record ${i} is missing string field "${field}" (got ${JSON.stringify(v)}): ${JSON.stringify(row).slice(0, 160)}`,
        );
      }
    }
    const extra = Object.keys(row).filter(
      (k) => !(REQUIRED_FIELDS as readonly string[]).includes(k),
    );
    if (extra.length > 0) {
      return fail(
        'row-shape',
        `record ${i} has extra field(s) ${extra.join(', ')} — each record must have exactly id, name, email, signupDate`,
      );
    }
  }
  signals.push('row-shape');
  const typed = rows as unknown as CustomerRow[];

  // 3. emails-normalized — lowercase, trimmed, no whitespace.
  for (const row of typed) {
    if (row.email !== row.email.trim().toLowerCase() || /\s/.test(row.email)) {
      return fail(
        'emails-normalized',
        `email ${JSON.stringify(row.email)} is not lowercased+trimmed`,
      );
    }
  }
  signals.push('emails-normalized');

  // 4. dates-iso — yyyy-mm-dd and a real calendar date.
  for (const row of typed) {
    if (!isRealIsoDate(row.signupDate)) {
      return fail(
        'dates-iso',
        `signupDate ${JSON.stringify(row.signupDate)} (email ${row.email}) is not a valid ISO yyyy-mm-dd date`,
      );
    }
  }
  signals.push('dates-iso');

  // 5. unique-emails
  const seen = new Set<string>();
  for (const row of typed) {
    if (seen.has(row.email)) {
      return fail(
        'unique-emails',
        `email ${JSON.stringify(row.email)} appears more than once — dedup is missing`,
      );
    }
    seen.add(row.email);
  }
  signals.push('unique-emails');

  // 6. source-ids-preserved — every full row must be derived from a
  // seeded CSV row, not merely borrow a valid-looking source id.
  for (const row of typed) {
    if (!SEEDED_SOURCE_IDS.has(row.id)) {
      return fail(
        'source-ids-preserved',
        `id ${JSON.stringify(row.id)} is not present in any source CSV row — rebuild from data/raw/ and preserve the id from the kept source row`,
      );
    }
    if (!SEEDED_SOURCE_ROW_KEYS.has(customerSourceRowKey(row))) {
      // Preserve the existing, more specific golden diagnostics for the
      // deliberately planted edge cases. A wrong European date should
      // still say which newest date wins; a damaged quoted/BOM row should
      // still identify that fixture. All other fabricated tuples fail here.
      const knownFullRowGolden =
        row.email === GOLDEN_BOM_ROW.email || row.email === GOLDEN_QUOTED_NAME.email;
      const knownDateGolden =
        row.email in GOLDEN_DEDUP_DATES &&
        SEEDED_SOURCE_ROWS.some(
          (source) =>
            source.id === row.id && source.name === row.name && source.email === row.email,
        );
      if (knownFullRowGolden || knownDateGolden) continue;
      return fail(
        'source-ids-preserved',
        `record with id ${JSON.stringify(row.id)} does not exactly match that source row after the allowed email/date normalization — preserve its source id, name, normalized email, and normalized signupDate together`,
      );
    }
  }
  signals.push('source-ids-preserved');

  // 7. row-count
  if (typed.length !== EXPECTED_ROW_COUNT) {
    return fail(
      'row-count',
      `expected exactly ${EXPECTED_ROW_COUNT} records after dedup, got ${typed.length}`,
    );
  }
  signals.push('row-count');

  // 8. sorted-by-email
  for (let i = 1; i < typed.length; i++) {
    const prev = typed[i - 1] as CustomerRow;
    const cur = typed[i] as CustomerRow;
    if (prev.email > cur.email) {
      return fail(
        'sorted-by-email',
        `records are not sorted by email ascending: ${JSON.stringify(prev.email)} comes before ${JSON.stringify(cur.email)}`,
      );
    }
  }
  signals.push('sorted-by-email');

  const byEmail = new Map(typed.map((r) => [r.email, r]));
  // Evaluated ONCE across all three golden groups so a golden failure
  // carries the complete expected-vs-got picture — the fail-fast checks
  // below still decide the single verdict signal (sniff-key stability).
  const goldenDiffs = collectGoldenDiffs(byEmail);
  const withDiffs = (result: CustomersCheckResult): CustomersCheckResult =>
    goldenDiffs.length > 0 ? { ...result, goldenDiffs } : result;

  // 9. golden-bom-row — the BOM file's rows must have survived with ids intact.
  const bom = byEmail.get(GOLDEN_BOM_ROW.email);
  if (
    !bom ||
    bom.id !== GOLDEN_BOM_ROW.id ||
    bom.name !== GOLDEN_BOM_ROW.name ||
    bom.signupDate !== GOLDEN_BOM_ROW.signupDate
  ) {
    return withDiffs(
      fail(
        'golden-bom-row',
        `the record for ${GOLDEN_BOM_ROW.email} must be exactly ${JSON.stringify(GOLDEN_BOM_ROW)}, got ${JSON.stringify(bom ?? null)}`,
      ),
    );
  }
  signals.push('golden-bom-row');

  // 10. golden-quoted-name — the quoted comma name survives, newest row kept.
  const quoted = byEmail.get(GOLDEN_QUOTED_NAME.email);
  if (
    !quoted ||
    quoted.id !== GOLDEN_QUOTED_NAME.id ||
    quoted.name !== GOLDEN_QUOTED_NAME.name ||
    quoted.signupDate !== GOLDEN_QUOTED_NAME.signupDate
  ) {
    return withDiffs(
      fail(
        'golden-quoted-name',
        `the record for ${GOLDEN_QUOTED_NAME.email} must have name ${JSON.stringify(GOLDEN_QUOTED_NAME.name)} and signupDate ${JSON.stringify(GOLDEN_QUOTED_NAME.signupDate)}, got ${JSON.stringify(quoted ?? null)}`,
      ),
    );
  }
  signals.push('golden-quoted-name');

  // 11. golden-dedup-newest — each dup pair resolved to the newest date.
  for (const [email, expectedDate] of Object.entries(GOLDEN_DEDUP_DATES)) {
    const row = byEmail.get(email);
    if (!row || row.signupDate !== expectedDate) {
      return withDiffs(
        fail(
          'golden-dedup-newest',
          `the record for ${email} must keep the newest signupDate ${expectedDate}, got ${JSON.stringify(row?.signupDate ?? null)}`,
        ),
      );
    }
  }
  signals.push('golden-dedup-newest');

  return { ok: true, signals, score: signals.length };
}

/**
 * Every failing golden FIELD across all three golden groups — one row per
 * mismatch, with the exact expected/got pair. The fail-fast verdict only
 * names the first miss; this table is what stops the "one golden date
 * away" loop (qwen: three rewrites around a single wrong
 * dedupe date because the feedback never itemized it).
 */
function collectGoldenDiffs(byEmail: Map<string, CustomerRow>): GoldenDiff[] {
  const diffs: GoldenDiff[] = [];
  const compare = (
    email: string,
    row: CustomerRow | undefined,
    fields: Partial<Record<'id' | 'name' | 'signupDate', string>>,
  ) => {
    if (!row) {
      diffs.push({
        field: `${email} record`,
        expected: JSON.stringify({ email, ...fields }),
        got: '(missing)',
      });
      return;
    }
    for (const [field, expected] of Object.entries(fields) as Array<
      ['id' | 'name' | 'signupDate', string]
    >) {
      if (row[field] !== expected) {
        diffs.push({ field: `${email} ${field}`, expected, got: row[field] });
      }
    }
  };
  compare(GOLDEN_BOM_ROW.email, byEmail.get(GOLDEN_BOM_ROW.email), {
    id: GOLDEN_BOM_ROW.id,
    name: GOLDEN_BOM_ROW.name,
    signupDate: GOLDEN_BOM_ROW.signupDate,
  });
  compare(GOLDEN_QUOTED_NAME.email, byEmail.get(GOLDEN_QUOTED_NAME.email), {
    id: GOLDEN_QUOTED_NAME.id,
    name: GOLDEN_QUOTED_NAME.name,
    signupDate: GOLDEN_QUOTED_NAME.signupDate,
  });
  for (const [email, expectedDate] of Object.entries(GOLDEN_DEDUP_DATES)) {
    compare(email, byEmail.get(email), { signupDate: expectedDate });
  }
  return diffs;
}

/** Render the golden diffs as a compact markdown table for repair feedback. */
function formatGoldenDiffTable(diffs: readonly GoldenDiff[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const rows = diffs.map((d) => `| ${esc(d.field)} | ${esc(d.expected)} | ${esc(d.got)} |`);
  return [
    'Every failing golden record, expected vs got:',
    '',
    '| field | expected | got |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Fix exactly these fields in the kept rows; records not listed already pass.',
  ].join('\n');
}

export function dataWrangleRepairDirective(result: CustomersCheckResult): string {
  const base = dataWrangleRepairDirectiveBase(result);
  // Golden failures carry the full expected-vs-got table (B4): the model
  // should never have to re-derive WHICH rows are wrong.
  return result.goldenDiffs && result.goldenDiffs.length > 0
    ? `${base}\n\n${formatGoldenDiffTable(result.goldenDiffs)}`
    : base;
}

function dataWrangleRepairDirectiveBase(result: CustomersCheckResult): string {
  const missing = new Set(result.missingRequiredSignals ?? []);
  if (missing.has('parses-as-array')) {
    return [
      `DATA_WRANGLE_JSON_REPAIR: replace ${OUTPUT_PATH} with only the final JSON array.`,
      `The checked file ${OUTPUT_PATH} must begin with "[" and contain JSON data only — no JavaScript source, no markdown fences, no comments, and no logs.`,
      `If you need helper code, put that code in scripts/clean_data.mjs, run it, and have the script write ${OUTPUT_PATH} with fs.writeFileSync; never write script source into ${OUTPUT_PATH}.`,
      'Inside a Node script, read the raw CSV files from disk with fs.readFileSync. Do not paste line-numbered read_file output into string constants, and do not call MCP tools like write_file from inside the script.',
      `After rewriting ${OUTPUT_PATH}, run \`node ${DATA_WRANGLE_VALIDATOR_PATH}\` and use its first FAIL line as the next fix.`,
      `The final array must still be complete: all three raw files, exactly ${EXPECTED_ROW_COUNT} deduped records, sorted by normalized email.`,
    ].join(' ');
  }

  if (missing.has('source-ids-preserved')) {
    return [
      `DATA_WRANGLE_SOURCE_REBUILD: discard the current ${OUTPUT_PATH}; it contains rows that are not from the raw CSVs.`,
      'Do not rename invented/sample rows. Re-read the source files and rebuild from data/raw/ only.',
      'Every output id must be copied from a source id and therefore look like A-###, B-###, or L-###. No CUST###, c###, sequential placeholder, or guessed ids are valid.',
      'If using a Node helper, use fs.readFileSync to read data/raw/*.csv from disk and fs.writeFileSync to write out/customers.json. MCP tools like write_file are not functions inside Node scripts.',
      'Do not paste line-numbered read_file output into script string constants; those line markers are not part of the CSV data.',
      'Use the source columns id, name, email, signup_date. Output the date field as signupDate, but read the source header signup_date.',
      'Skip the legacy banner before parsing legacy_export.csv, strip the BOM from customers_a.csv, preserve quoted comma names from customers_b.csv, then dedupe by normalized email keeping the newest signupDate.',
      `Run \`node ${DATA_WRANGLE_VALIDATOR_PATH}\` after rewriting the file; if it reports FAIL source id, discard the current output again instead of renaming rows.`,
      `Rewrite ${OUTPUT_PATH} only after the rebuilt array has exactly ${EXPECTED_ROW_COUNT} records sorted by email.`,
    ].join(' ');
  }

  const structuralSignals = new Set([
    'row-shape',
    'emails-normalized',
    'dates-iso',
    'unique-emails',
    'source-ids-preserved',
    'row-count',
    'sorted-by-email',
    'golden-bom-row',
    'golden-quoted-name',
    'golden-dedup-newest',
  ]);
  if ([...missing].some((signal) => structuralSignals.has(signal))) {
    return [
      'DATA_WRANGLE_COMPLETE_REBUILD: do not hand-edit the JSON, invent/example rows, or patch one record at a time.',
      `Re-read all three raw inputs (${CUSTOMERS_A_PATH}, ${CUSTOMERS_B_PATH}, ${LEGACY_EXPORT_PATH}) and rebuild ${OUTPUT_PATH} from the sources.`,
      `The seeded inputs contain 60 data rows total and 4 duplicate normalized emails, so the rewritten JSON array must contain exactly ${EXPECTED_ROW_COUNT} records.`,
      'Use a real CSV parse or careful quoted-field parser: strip the BOM from customers_a.csv, preserve quoted comma names in customers_b.csv, skip the banner line in legacy_export.csv, read the source header signup_date, parse legacy dotted dates as DD.MM.YYYY, normalize emails, keep the newest signupDate per normalized email, preserve the id/name from that kept source row, then sort by email ascending.',
      'If using a Node helper, use fs.readFileSync/fs.writeFileSync. Do not paste line-numbered read_file output into a JS string, and do not call MCP tools like write_file from inside Node.',
      `If you create helper code, write it to scripts/clean_data.mjs. The checked deliverable path ${OUTPUT_PATH} is for the final JSON array only; never put JavaScript source there.`,
      `Run \`node ${DATA_WRANGLE_VALIDATOR_PATH}\` after rewriting ${OUTPUT_PATH}.`,
      `After rewriting ${OUTPUT_PATH}, inspect the parsed array length before replying; it must be exactly ${EXPECTED_ROW_COUNT}.`,
      `Do not modify data/raw/. Do not reply in prose without running the cleaner and rewriting ${OUTPUT_PATH}.`,
    ].join(' ');
  }

  return [
    'DATA_WRANGLE_REPAIR: re-check the six normalization rules against the raw CSV inputs and patch the JSON deliverable, not the raw files.',
    `The final ${OUTPUT_PATH} must be a complete JSON array derived from all three source files, deduped by normalized email with newest signupDate kept, then sorted by email.`,
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

/**
 * Path-tolerant deliverable lookup (the bookstore lesson): exact
 * out/customers.json first, then any path ending in /customers.json —
 * content gates are anchored, file placement is not.
 */
async function findCustomersJson(
  client: GezelClient,
  projectId: string,
): Promise<{ text: string; path: string } | null> {
  try {
    const list = await client.listProjectWorkspace(projectId, undefined, true);
    const files = list.files.filter((f) => !f.isDirectory);
    const hit =
      files.find((f) => f.path.toLowerCase() === OUTPUT_PATH) ??
      files.find((f) => f.path.toLowerCase().endsWith('/customers.json')) ??
      files.find((f) => f.path.toLowerCase() === 'customers.json');
    if (!hit) return null;
    const blob = await client.fetchProjectWorkspaceBlob(projectId, hit.path);
    return { text: await blob.text(), path: hit.path };
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Normalize three messy raw customer CSV exports (mixed date formats, encoding artifacts, ' +
        'quoted fields, near-duplicate rows) into one clean, deduplicated out/customers.json ' +
        'following six exact normalization rules.',
      missionObjectives: DATA_WRANGLE_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('data-wrangle setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: CUSTOMERS_A_PATH, content: CUSTOMERS_A_CSV },
    { path: CUSTOMERS_B_PATH, content: CUSTOMERS_B_CSV },
    { path: LEGACY_EXPORT_PATH, content: LEGACY_EXPORT_CSV },
    { path: DATA_WRANGLE_VALIDATOR_PATH, content: DATA_WRANGLE_VALIDATOR_MJS },
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(
    `[scenario:setup] seeded 3 raw CSV fixtures plus ${DATA_WRANGLE_VALIDATOR_PATH} under project ${projectId}`,
  );

  // Pre-recruit the Developer joined to this project (the standard
  // post-migration shape): the eval measures whether the model can hold
  // the normalization rules, not the Meester delegation hops. No
  // hand-written about — the service resolves the shipped role template.
  const dev = await provisionScenarioGezel(ctx, {
    preferredName: DEVELOPER_NAME,
    role: 'Developer',
    label: 'developer',
  });
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${dev.name} to project ${projectId}`);

  await client.sendChatMessage(dev.id, {
    message: DATA_WRANGLE_KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${dev.name} in project ${projectId}`);
}

export const dataWrangleScenario: EvalScenario = {
  id: 'data-wrangle',
  description:
    'Precision ETL: normalize three deliberately messy CSV exports (BOM, quoted commas, mixed ' +
    'US/ISO/European dates, near-duplicate emails, junk banner row) into a deduplicated, sorted ' +
    'out/customers.json per six explicit rules — graded by eleven behavioral property checks with ' +
    'hardcoded goldens.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is normalizing the raw customer CSV exports in the`,
    `"${PROJECT_NAME}" project into a clean out/customers.json. You don't need to do anything —`,
    "just confirm you've seen this note.",
  ].join(' '),
  evidenceTexts: [DATA_WRANGLE_KICKOFF_MESSAGE, DATA_WRANGLE_MISSION_OBJECTIVES],
  // 45-min absolute ceiling (was 20). MLX matrix ALL FIVE
  // models hit the old 20-min ceiling at ~1216s while "forward progress kept
  // happening" — a slow-engine throughput artifact, not a capability fail
  // (throughput-invariance). The 10-min no-progress watchdog below still fails
  // genuine stalls fast, so the higher ceiling only helps trials that are
  // actually advancing.
  timeoutMs: 45 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(ctx.client);
    if (!projectId) {
      logChanged('project', '[scenario] data-wrangle project not present yet');
      return { done: false };
    }

    const found = await findCustomersJson(client, projectId);
    if (!found) {
      logChanged(
        'sniff',
        `[scenario] data-wrangle bytes=0 score=0 signals=none (no ${OUTPUT_PATH} yet)`,
      );
      recordSniff?.({ key: 'data-wrangle', score: 0, bytes: 0 });
      await postMissingDeliverableFeedback(ctx, OUTPUT_PATH, { projectId });
      return { done: false };
    }

    const result = verifyCustomersJson(found.text);
    logChanged(
      'sniff',
      `[scenario] data-wrangle path=${found.path} bytes=${found.text.length} score=${result.score}/${DATA_WRANGLE_SIGNALS.length} signals=${result.signals.join(',') || 'none'}${result.failReason ? ` failReason="${result.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'data-wrangle',
      score: result.score,
      bytes: found.text.length,
      failReason: result.failReason,
    });

    if (result.ok) {
      return {
        done: true,
        success: true,
        reason: `${found.path} passed all ${DATA_WRANGLE_SIGNALS.length} property checks (${result.signals.join(', ')})`,
      };
    }

    await postSniffFeedback(ctx, found.path, result, {
      projectId,
      repairDirective: dataWrangleRepairDirective(result),
      sourceText: found.text,
      // Without a revision token the same one-golden-miss failReason
      // deduped to SILENCE after the first nudge (qwen: one
      // wrong dedupe date, three unaided rewrites). Each materially new
      // revision now re-nudges and feeds the escalation ladder.
      dedupeToken: contentRevisionToken(found.text),
    });
    return { done: false };
  },
};
