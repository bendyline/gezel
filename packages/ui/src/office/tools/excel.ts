import {
  MAX_CELLS,
  type PaneTool,
  READ_TIMEOUT_MS,
  ToolInputError,
  WRITE_TIMEOUT_MS,
  readBool,
  readInt,
  readString,
  runSerial,
  toJson,
} from './shared.js';

export type CellValue = string | number | boolean;

export interface RangeData {
  sheet: string;
  address: string;
  rowCount: number;
  columnCount: number;
  values: unknown[][];
  formulas?: unknown[][];
}

export interface SheetSummary {
  name: string;
  visible: boolean;
  usedRange: string | null;
  tables: string[];
}

export interface TableSummary {
  name: string;
  sheet: string;
  address: string;
  headers: unknown[];
  rowCount: number;
}

/** What the Excel tools need from the workbook. Office.js below; a fake in tests. */
export interface ExcelWorkbook {
  listSheets(): Promise<SheetSummary[]>;
  /** Dimensions first, so an oversized range is refused before its values load. */
  measure(target: { sheet?: string; address?: string }): Promise<{
    sheet: string;
    address: string;
    rowCount: number;
    columnCount: number;
  }>;
  read(target: { sheet?: string; address?: string }, includeFormulas: boolean): Promise<RangeData>;
  listTables(): Promise<TableSummary[]>;
  readTable(name: string, maxRows: number): Promise<TableSummary & { rows: unknown[][] }>;
  write(
    target: { sheet?: string; address: string },
    values: CellValue[][],
    asFormulas: boolean,
  ): Promise<{ address: string }>;
}

function rangeFor(
  ctx: Excel.RequestContext,
  target: { sheet?: string; address?: string },
): Excel.Range {
  if (!target.address) return ctx.workbook.getSelectedRange();
  const sheet = target.sheet
    ? ctx.workbook.worksheets.getItem(target.sheet)
    : ctx.workbook.worksheets.getActiveWorksheet();
  return sheet.getRange(target.address);
}

export function officeExcelWorkbook(): ExcelWorkbook {
  return {
    listSheets: () =>
      runSerial(() =>
        Excel.run(async (ctx) => {
          const sheets = ctx.workbook.worksheets;
          sheets.load('items/name,items/visibility');
          await ctx.sync();
          const used = sheets.items.map((s) => {
            const r = s.getUsedRangeOrNullObject(true);
            r.load('address');
            return r;
          });
          const tables = sheets.items.map((s) => {
            s.tables.load('items/name');
            return s.tables;
          });
          await ctx.sync();
          return sheets.items.map((s, i) => ({
            name: s.name,
            visible: s.visibility === Excel.SheetVisibility.visible,
            usedRange: used[i]!.isNullObject ? null : used[i]!.address,
            tables: tables[i]!.items.map((t) => t.name),
          }));
        }),
      ),
    measure: (target) =>
      runSerial(() =>
        Excel.run(async (ctx) => {
          const range = rangeFor(ctx, target);
          range.load('address,rowCount,columnCount');
          range.worksheet.load('name');
          await ctx.sync();
          return {
            sheet: range.worksheet.name,
            address: range.address,
            rowCount: range.rowCount,
            columnCount: range.columnCount,
          };
        }),
      ),
    read: (target, includeFormulas) =>
      runSerial(() =>
        Excel.run(async (ctx) => {
          const range = rangeFor(ctx, target);
          range.load(`address,rowCount,columnCount,values${includeFormulas ? ',formulas' : ''}`);
          range.worksheet.load('name');
          await ctx.sync();
          return {
            sheet: range.worksheet.name,
            address: range.address,
            rowCount: range.rowCount,
            columnCount: range.columnCount,
            values: range.values,
            ...(includeFormulas ? { formulas: range.formulas } : {}),
          };
        }),
      ),
    listTables: () =>
      runSerial(() =>
        Excel.run(async (ctx) => {
          const tables = ctx.workbook.tables;
          tables.load('items/name');
          await ctx.sync();
          const parts = tables.items.map((t) => {
            const sheet = t.worksheet;
            sheet.load('name');
            const range = t.getRange();
            range.load('address');
            const header = t.getHeaderRowRange();
            header.load('values');
            const body = t.getDataBodyRange();
            body.load('rowCount');
            return { t, sheet, range, header, body };
          });
          await ctx.sync();
          return parts.map(({ t, sheet, range, header, body }) => ({
            name: t.name,
            sheet: sheet.name,
            address: range.address,
            headers: header.values[0] ?? [],
            rowCount: body.rowCount,
          }));
        }),
      ),
    readTable: (name, maxRows) =>
      runSerial(() =>
        Excel.run(async (ctx) => {
          const table = ctx.workbook.tables.getItem(name);
          const sheet = table.worksheet;
          sheet.load('name');
          const range = table.getRange();
          range.load('address');
          const header = table.getHeaderRowRange();
          header.load('values');
          const body = table.getDataBodyRange();
          body.load('rowCount');
          await ctx.sync();
          const head =
            body.rowCount > maxRows ? body.getResizedRange(maxRows - body.rowCount, 0) : body;
          head.load('values');
          await ctx.sync();
          return {
            name,
            sheet: sheet.name,
            address: range.address,
            headers: header.values[0] ?? [],
            rowCount: body.rowCount,
            rows: head.values,
          };
        }),
      ),
    write: (target, values, asFormulas) =>
      runSerial(() =>
        Excel.run(async (ctx) => {
          let range = rangeFor(ctx, target);
          range.load('rowCount,columnCount');
          await ctx.sync();
          const rows = values.length;
          const cols = values[0]?.length ?? 0;
          if (range.rowCount === 1 && range.columnCount === 1 && (rows > 1 || cols > 1)) {
            // A single cell names the top-left corner; grow to fit.
            range = range.getResizedRange(rows - 1, cols - 1);
          } else if (range.rowCount !== rows || range.columnCount !== cols) {
            throw new ToolInputError(
              `The range is ${range.rowCount}×${range.columnCount} but the values are ${rows}×${cols}. Give a matching range or just its top-left cell.`,
            );
          }
          if (asFormulas) range.formulas = values as Excel.Range['formulas'];
          else range.values = values as Excel.Range['values'];
          range.load('address');
          await ctx.sync();
          return { address: range.address };
        }),
      ),
  };
}

function readValues(args: Record<string, unknown>): CellValue[][] {
  const raw = args.values;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new ToolInputError('"values" must be a non-empty array of rows.');
  const width = Array.isArray(raw[0]) ? raw[0].length : -1;
  if (width <= 0)
    throw new ToolInputError('"values" must be an array of rows, each an array of cells.');
  const rows: CellValue[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new ToolInputError('Every row in "values" must have the same number of cells.');
    }
    rows.push(
      row.map((cell) => {
        if (cell === null || cell === undefined) return '';
        if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean')
          return cell;
        throw new ToolInputError('Cells must be text, numbers, or true/false.');
      }),
    );
  }
  if (rows.length * width > MAX_CELLS) {
    throw new ToolInputError(
      `That is ${rows.length * width} cells; write at most ${MAX_CELLS} at a time.`,
    );
  }
  return rows;
}

async function readCapped(
  book: ExcelWorkbook,
  target: { sheet?: string; address?: string },
  includeFormulas: boolean,
): Promise<string> {
  const size = await book.measure(target);
  const cells = size.rowCount * size.columnCount;
  if (cells > MAX_CELLS) {
    return toJson({
      sheet: size.sheet,
      address: size.address,
      rowCount: size.rowCount,
      columnCount: size.columnCount,
      tooLarge: true,
      message: `That range has ${cells} cells; read at most ${MAX_CELLS} at a time by asking for a smaller address.`,
    });
  }
  return toJson(await book.read(target, includeFormulas));
}

const RANGE_SCHEMA = {
  sheet: { type: 'string', description: 'Worksheet name. Default: the active sheet.' },
  address: { type: 'string', description: 'A1 address like "B2:D20", or a named range.' },
};

export function excelTools(book: ExcelWorkbook): PaneTool[] {
  return [
    {
      name: 'sheet_list',
      description:
        'List the worksheets in the open Excel workbook, with each used range and the tables on it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: READ_TIMEOUT_MS,
      requires: { set: 'ExcelApi', version: '1.4' },
      handler: async () => toJson({ sheets: await book.listSheets() }),
    },
    {
      name: 'sheet_read_selection',
      description: `Read the cells the user has selected in Excel: values, and formulas when asked. At most ${MAX_CELLS} cells.`,
      inputSchema: {
        type: 'object',
        properties: { includeFormulas: { type: 'boolean' } },
        additionalProperties: false,
      },
      timeoutMs: READ_TIMEOUT_MS,
      handler: async (args) => readCapped(book, {}, readBool(args, 'includeFormulas', false)),
    },
    {
      name: 'sheet_read_range',
      description: `Read a range of cells from the open Excel workbook. At most ${MAX_CELLS} cells per read.`,
      inputSchema: {
        type: 'object',
        properties: { ...RANGE_SCHEMA, includeFormulas: { type: 'boolean' } },
        required: ['address'],
        additionalProperties: false,
      },
      timeoutMs: READ_TIMEOUT_MS,
      handler: async (args) => {
        const address = readString(args, 'address', { required: true, max: 255 })!;
        const sheet = readString(args, 'sheet', { max: 255 });
        return readCapped(
          book,
          { ...(sheet ? { sheet } : {}), address },
          readBool(args, 'includeFormulas', false),
        );
      },
    },
    {
      name: 'sheet_describe_table',
      description:
        'Describe the Excel tables in the workbook. Without a name, lists every table with its headers and size; with a name, also returns its first rows.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Table name. Omit to list them all.' },
          maxRows: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Rows to return with a name. Default 50.',
          },
        },
        additionalProperties: false,
      },
      timeoutMs: READ_TIMEOUT_MS,
      handler: async (args) => {
        const name = readString(args, 'name', { max: 255 });
        if (!name) return toJson({ tables: await book.listTables() });
        const maxRows = readInt(args, 'maxRows', { min: 1, max: 200, fallback: 50 });
        return toJson(await book.readTable(name, maxRows));
      },
    },
    {
      name: 'sheet_write_range',
      description: `Write values (or formulas) into the open Excel workbook. Give the full range, or just its top-left cell. At most ${MAX_CELLS} cells.`,
      inputSchema: {
        type: 'object',
        properties: {
          ...RANGE_SCHEMA,
          values: {
            type: 'array',
            description: 'Rows of cells, e.g. [["Name","Total"],["North",120]].',
            items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
          },
          asFormulas: {
            type: 'boolean',
            description: 'Treat strings starting with "=" as formulas.',
          },
        },
        required: ['address', 'values'],
        additionalProperties: false,
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      write: true,
      handler: async (args) => {
        const address = readString(args, 'address', { required: true, max: 255 })!;
        const sheet = readString(args, 'sheet', { max: 255 });
        const values = readValues(args);
        const written = await book.write(
          { ...(sheet ? { sheet } : {}), address },
          values,
          readBool(args, 'asFormulas', false),
        );
        return toJson({
          written: true,
          address: written.address,
          rows: values.length,
          columns: values[0]!.length,
        });
      },
    },
  ];
}
