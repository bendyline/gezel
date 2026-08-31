import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertInSandbox } from '../index-store/sandbox-convert.js';
import {
  canApplyLinuxSystemdSandbox,
  canApplyMacSandbox,
  selectDenyNetBoundary,
} from '../sandbox/runner.js';
import { DuckRunner } from './duck.js';
import { tableRelDir } from './layout.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import { materializeWorkbook } from './workspace-xlsx.js';

/**
 * The real path, with nothing stubbed: a genuine .xlsx on disk → the sandboxed
 * squisq worker → typed NDJSON → Parquet → a SQL answer.
 *
 * The fixture is built with squisq's own exporter rather than checked in as a
 * binary, so it stays readable in review and cannot drift from the importer
 * that reads it back.
 *
 * Skips where the pieces are not installed: a build without the query engine,
 * a squisq older than the typed-table export, or a host with no enforceable
 * network boundary for the sandbox to hold the parser inside. That last one
 * covers Windows, where `runInSandbox` refuses to start a `denyNet` child at
 * all rather than run the parser unsandboxed — so there is nothing here for
 * the test to measure.
 */

let workspace: string;
let artifacts: string;
let duck: DuckRunner;

async function typedTablesAvailable(): Promise<boolean> {
  try {
    const fmt = (await import('@bendyline/squisq-formats')) as unknown as {
      xlsxToTables?: unknown;
      markdownDocToXlsx?: unknown;
    };
    return typeof fmt.xlsxToTables === 'function' && typeof fmt.markdownDocToXlsx === 'function';
  } catch {
    return false;
  }
}

/** True where a `denyNet` child can actually be started — see `wrapForPlatform`. */
async function denyNetSandboxAvailable(): Promise<boolean> {
  const boundary = selectDenyNetBoundary({
    platform: process.platform,
    macSandboxAvailable: process.platform === 'darwin' && (await canApplyMacSandbox()),
    linuxSystemdSandboxAvailable:
      process.platform === 'linux' && (await canApplyLinuxSystemdSandbox()),
  });
  return boundary !== 'unavailable';
}

const canRun =
  hasRealDuckdb() && (await typedTablesAvailable()) && (await denyNetSandboxAvailable());

/**
 * Build a real .xlsx by hand, as OOXML.
 *
 * squisq's own `markdownDocToXlsx` cannot be used for this: markdown has no
 * types, so every cell it writes is a string — verified — and a fixture of
 * text cells could not show that a NUMBER survives the pipeline, which is the
 * claim that matters. So the parts are written directly, with a real numeric
 * cell, a real percent format, and a real date, exactly as Excel would.
 */
async function writeWorkbook(absPath: string): Promise<void> {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  const add = (name: string, body: string) => zip.addFile(name, Buffer.from(body, 'utf8'));

  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      '</Types>',
  );
  add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
  );
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  // Style 1 is a percent format, style 2 a date — the two renderings that
  // destroy information when a reader takes the display text instead.
  add(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="1"><numFmt numFmtId="200" formatCode="0.0%"/></numFmts>` +
      `<cellXfs count="3">` +
      `<xf numFmtId="0"/><xf numFmtId="200" applyNumberFormat="1"/><xf numFmtId="14" applyNumberFormat="1"/>` +
      '</cellXfs></styleSheet>',
  );
  const strings = ['Region', 'Units', 'Share', 'As Of', 'North', 'South'];
  add(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
  );

  // 45874 is 2025-08-05 in Excel's 1900 system (serials past 60 shift by one
  // for the phantom 1900 leap day); 0.15 renders as "15.0%".
  const sheet =
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>` +
    `<c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>` +
    `<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>12</v></c>` +
    `<c r="C2" s="1"><v>0.15</v></c><c r="D2" s="2"><v>45874</v></c></row>` +
    `<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3"><v>9</v></c>` +
    `<c r="C3" s="1"><v>0.095</v></c><c r="D3" s="2"><v>45875</v></c></row>`;
  add(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
  );

  await writeFile(absPath, zip.toBuffer());
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'gezel-xlsx-e2e-ws-'));
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-xlsx-e2e-art-'));
  duck = new DuckRunner({ binaryPath: findRealDuckdb() ?? '/nonexistent/duckdb' });
});
afterEach(async () => {
  for (const dir of [workspace, artifacts]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe.runIf(canRun)('a real workbook becomes a queryable table', () => {
  it('goes from .xlsx on disk to a SQL answer', async () => {
    const absPath = join(workspace, 'plan.xlsx');
    await writeWorkbook(absPath);
    expect(existsSync(absPath)).toBe(true);

    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: { relPath: 'plan.xlsx', absPath, hash: 'h1', size: 4096 },
      // The real sandboxed worker, in its typed mode.
      extract: async (path) => {
        const res = await convertInSandbox(path, 'xlsx', 'tables');
        return { ndjson: res.ndjson ?? null, ...(res.blocked ? { blocked: res.blocked } : {}) };
      },
    });

    expect(result.state, result.reason).toBe('ok');
    expect(result.rows).toBe(2);

    const table = result.tables?.[0] as string;
    const tableRoot = join(artifacts, tableRelDir(result.corpusDir as string, table));
    const rows = await duck.runTrusted<{
      region: string;
      units: number;
      share: number;
      as_of: string;
    }>(
      `SELECT region, units, share, as_of FROM read_parquet('${tableRoot}/*/*.parquet')
        ORDER BY region`,
      { allowedDirectories: [tableRoot] },
    );

    expect(rows.map((r) => r.region)).toEqual(['North', 'South']);
    // The claim the whole data path exists for: the sheet DISPLAYS "15.0%",
    // and what lands is 0.15. Reading the markdown rendering would have given
    // a string a hundred times too large.
    expect(Number(rows[0]?.share)).toBeCloseTo(0.15, 5);
    expect(Number(rows[1]?.share)).toBeCloseTo(0.095, 5);
    // A real number, aggregable.
    expect(Number(rows[0]?.units)).toBe(12);
    // A date serial, arriving as an unambiguous ISO date rather than a
    // locale-formatted string or a bare 45874.
    expect(String(rows[0]?.as_of)).toContain('2025-08-05');

    const [total] = await duck.runTrusted<{ n: number }>(
      `SELECT round(sum(share), 4) AS n FROM read_parquet('${tableRoot}/*/*.parquet')`,
      { allowedDirectories: [tableRoot] },
    );
    expect(Number(total?.n)).toBeCloseTo(0.245, 4);
  }, 90_000);

  it('refuses a file whose bytes are not really a workbook', async () => {
    // The sandbox's polyglot guard, reached through the same call.
    const absPath = join(workspace, 'fake.xlsx');
    await writeFile(absPath, 'this is plainly not a spreadsheet');
    const res = await convertInSandbox(absPath, 'xlsx', 'tables');
    expect(res.blocked).toMatch(/not a valid xlsx/);
    expect(res.ndjson ?? null).toBeNull();
  }, 60_000);
});
