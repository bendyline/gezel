import { APP_TOOL_NAME_RE } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ExcelWorkbook } from './excel.js';
import { toolsForHost } from './index.js';
import type { PowerPointDeck } from './powerpoint.js';
import { MAX_CELLS } from './shared.js';
import type { WordDocument } from './word.js';

const CONTEXT = {
  callId: 'c',
  sessionId: 's',
  gezelId: 'g',
  projectId: 'p',
  signal: new AbortController().signal,
};
const describeDoc = () => ({
  host: 'Word',
  title: 'Plan.docx',
  path: '/Users/me/Plan.docx',
  projectId: 'p',
  projectName: 'Plans',
  projectReadOnly: true,
  editsEnabled: true,
});

function fakeWord(overrides: Partial<WordDocument> = {}): WordDocument {
  return {
    readSelection: vi.fn(async () => ({
      text: 'Hello',
      paragraphs: [{ text: 'Hello', style: 'Normal' }],
    })),
    readParagraphs: vi.fn(async () =>
      Array.from({ length: 10 }, (_, i) => ({
        text: `Paragraph ${i} `.padEnd(400, 'x'),
        style: 'Normal',
      })),
    ),
    search: vi.fn(async () => ({
      total: 3,
      matches: [{ text: 'plan', paragraph: 'The plan is simple.' }],
    })),
    insert: vi.fn(async () => undefined),
    replaceSelection: vi.fn(async () => undefined),
    ...overrides,
  };
}

function tools(
  host: 'word' | 'excel' | 'powerpoint',
  opts: {
    edits?: boolean;
    supported?: boolean;
    word?: WordDocument;
    excel?: ExcelWorkbook;
    powerpoint?: PowerPointDeck;
  } = {},
) {
  const list = toolsForHost({
    host,
    edits: opts.edits ?? true,
    describe: describeDoc,
    isSupported: () => opts.supported ?? true,
    adapters: {
      word: opts.word ?? fakeWord(),
      ...(opts.excel ? { excel: opts.excel } : {}),
      ...(opts.powerpoint ? { powerpoint: opts.powerpoint } : {}),
      readSelection: async () => 'selected text',
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = list.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const out = await tool.handler(args, CONTEXT);
    return JSON.parse(String(out));
  };
  return { list, call };
}

describe('tool catalogue', () => {
  it('names every tool within the relay rules and declares object schemas', () => {
    for (const host of ['word', 'excel', 'powerpoint'] as const) {
      for (const tool of tools(host).list) {
        expect(tool.name).toMatch(APP_TOOL_NAME_RE);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.description.length).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('withdraws write tools when edits are off', () => {
    const names = (host: 'word' | 'excel' | 'powerpoint', edits: boolean) =>
      tools(host, { edits }).list.map((t) => t.name);
    expect(names('word', true)).toContain('doc_insert_text');
    expect(names('word', false)).not.toContain('doc_insert_text');
    expect(names('word', false)).not.toContain('doc_replace_selection');
    expect(names('excel', false)).not.toContain('sheet_write_range');
    expect(names('powerpoint', false)).not.toContain('slide_insert');
    expect(names('word', false)).toContain('doc_read');
  });

  it('never offers a tool this Office cannot run', () => {
    const names = tools('powerpoint', { supported: false }).list.map((t) => t.name);
    expect(names).toEqual(['office_describe_document', 'office_read_selection']);
  });
});

describe('common tools', () => {
  it('describe and read the selection in any host', async () => {
    const { call } = tools('excel');
    expect(await call('office_describe_document')).toMatchObject({
      title: 'Plan.docx',
      projectReadOnly: true,
    });
    expect(await call('office_read_selection')).toEqual({
      isEmpty: false,
      text: 'selected text',
      truncated: false,
    });
  });
});

describe('Word tools', () => {
  it('pages through the document by character budget', async () => {
    const { call } = tools('word');
    const first = await call('doc_read', { maxChars: 1000 });
    expect(first.totalParagraphs).toBe(10);
    expect(first.paragraphs.map((p: { index: number }) => p.index)).toEqual([0, 1]);
    expect(first.nextStart).toBe(2);
    const last = await call('doc_read', { start: 9 });
    expect(last.nextStart).toBeNull();
  });

  it('inserts markdown as HTML and plain text as is', async () => {
    const word = fakeWord();
    const { call } = tools('word', { word });
    await call('doc_insert_text', { text: '# Heading', format: 'markdown', where: 'end' });
    expect(word.insert).toHaveBeenCalledWith('<h1>Heading</h1>', 'end', true);
    await call('doc_insert_text', { text: 'plain' });
    expect(word.insert).toHaveBeenLastCalledWith('plain', 'cursor', false);
  });

  it('rejects bad arguments with a message the model can act on', async () => {
    const { list } = tools('word');
    const insert = list.find((t) => t.name === 'doc_insert_text')!;
    await expect(insert.handler({ where: 'middle', text: 'x' }, CONTEXT)).rejects.toThrow(
      /cursor, start, end/,
    );
    await expect(insert.handler({}, CONTEXT)).rejects.toThrow(/"text" is required/);
  });

  it('searches with context', async () => {
    const { call } = tools('word');
    expect(await call('doc_search', { query: 'plan' })).toEqual({
      total: 3,
      matches: [{ index: 0, text: 'plan', paragraph: 'The plan is simple.' }],
    });
  });
});

function fakeExcel(overrides: Partial<ExcelWorkbook> = {}): ExcelWorkbook {
  return {
    listSheets: vi.fn(async () => [
      { name: 'Sheet1', visible: true, usedRange: 'Sheet1!A1:B3', tables: ['Sales'] },
    ]),
    measure: vi.fn(async () => ({
      sheet: 'Sheet1',
      address: 'Sheet1!A1:B2',
      rowCount: 2,
      columnCount: 2,
    })),
    read: vi.fn(async () => ({
      sheet: 'Sheet1',
      address: 'Sheet1!A1:B2',
      rowCount: 2,
      columnCount: 2,
      values: [
        [1, 2],
        [3, 4],
      ],
    })),
    listTables: vi.fn(async () => []),
    readTable: vi.fn(async (name: string) => ({
      name,
      sheet: 'Sheet1',
      address: 'A1:B3',
      headers: ['a', 'b'],
      rowCount: 2,
      rows: [[1, 2]],
    })),
    write: vi.fn(async () => ({ address: 'Sheet1!A1:B2' })),
    ...overrides,
  };
}

describe('Excel tools', () => {
  it('reads a range, refusing oversized ones before loading values', async () => {
    const excel = fakeExcel();
    const { call } = tools('excel', { excel });
    expect(await call('sheet_read_range', { address: 'A1:B2' })).toMatchObject({
      values: [
        [1, 2],
        [3, 4],
      ],
    });

    const big = fakeExcel({
      measure: vi.fn(async () => ({
        sheet: 'Sheet1',
        address: 'A1:Z1000',
        rowCount: 1000,
        columnCount: 26,
      })),
    });
    const res = await tools('excel', { excel: big }).call('sheet_read_range', {
      address: 'A1:Z1000',
    });
    expect(res.tooLarge).toBe(true);
    expect(big.read).not.toHaveBeenCalled();
  });

  it('validates rectangular writes within the cell cap', async () => {
    const excel = fakeExcel();
    const { call, list } = tools('excel', { excel });
    await call('sheet_write_range', {
      address: 'A1',
      values: [
        ['Name', 'Total'],
        ['North', 120],
      ],
    });
    expect(excel.write).toHaveBeenCalledWith(
      { address: 'A1' },
      [
        ['Name', 'Total'],
        ['North', 120],
      ],
      false,
    );
    const write = list.find((t) => t.name === 'sheet_write_range')!;
    await expect(write.handler({ address: 'A1', values: [[1, 2], [3]] }, CONTEXT)).rejects.toThrow(
      /same number of cells/,
    );
    const tooMany = Array.from({ length: MAX_CELLS + 1 }, () => [1]);
    await expect(write.handler({ address: 'A1', values: tooMany }, CONTEXT)).rejects.toThrow(
      /at most/,
    );
    await expect(write.handler({ address: 'A1', values: [[{ x: 1 }]] }, CONTEXT)).rejects.toThrow(
      /text, numbers/,
    );
  });

  it('describes one table with its first rows', async () => {
    const excel = fakeExcel();
    const { call } = tools('excel', { excel });
    await call('sheet_describe_table', { name: 'Sales', maxRows: 10 });
    expect(excel.readTable).toHaveBeenCalledWith('Sales', 10);
  });
});

describe('PowerPoint tools', () => {
  const deck: PowerPointDeck = {
    listSlides: vi.fn(async () => [{ index: 0, id: 's1', title: 'Intro', shapeCount: 2 }]),
    readSlide: vi.fn(async (index: number) =>
      index === 0 ? { index: 0, id: 's1', shapes: [] } : null,
    ),
    insertSlide: vi.fn(async () => ({ index: 1, id: 's2', positioned: true })),
  };

  it('lists, reads, and inserts slides', async () => {
    const { call, list } = tools('powerpoint', { powerpoint: deck });
    expect(await call('slides_list')).toEqual({
      count: 1,
      slides: [{ index: 0, id: 's1', title: 'Intro', shapeCount: 2 }],
    });
    const read = list.find((t) => t.name === 'slide_read')!;
    await expect(read.handler({ index: 5 }, CONTEXT)).rejects.toThrow(/no slide 5/);
    expect(
      await call('slide_insert', { title: 'Next', bullets: ['a', 'b'], afterIndex: 0 }),
    ).toMatchObject({ inserted: true, index: 1 });
    expect(deck.insertSlide).toHaveBeenCalledWith('Next', ['a', 'b'], 0);
  });
});
