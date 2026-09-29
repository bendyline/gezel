import { markdownToHtml } from '../markdown-to-html.js';
import {
  MAX_INSERT_CHARS,
  type PaneTool,
  READ_TIMEOUT_MS,
  RESULT_CHAR_BUDGET,
  WRITE_TIMEOUT_MS,
  clip,
  readBool,
  readEnum,
  readInt,
  readString,
  runSerial,
  toJson,
} from './shared.js';

export type InsertWhere = 'cursor' | 'start' | 'end';
export type TextFormat = 'plain' | 'markdown';

export interface WordParagraph {
  text: string;
  style: string;
}

/** What the Word tools need from the document. Office.js below; a fake in tests. */
export interface WordDocument {
  readSelection(): Promise<{ text: string; paragraphs: WordParagraph[] }>;
  readParagraphs(): Promise<WordParagraph[]>;
  search(
    query: string,
    matchCase: boolean,
    max: number,
  ): Promise<{ total: number; matches: Array<{ text: string; paragraph: string }> }>;
  insert(content: string, where: InsertWhere, html: boolean): Promise<void>;
  replaceSelection(content: string, html: boolean): Promise<void>;
}

export function officeWordDocument(): WordDocument {
  return {
    readSelection: () =>
      runSerial(() =>
        Word.run(async (ctx) => {
          const selection = ctx.document.getSelection();
          selection.load('text');
          const paragraphs = selection.paragraphs;
          paragraphs.load('items/text,items/style');
          await ctx.sync();
          return {
            text: selection.text,
            paragraphs: paragraphs.items.map((p) => ({ text: p.text, style: p.style })),
          };
        }),
      ),
    readParagraphs: () =>
      runSerial(() =>
        Word.run(async (ctx) => {
          const paragraphs = ctx.document.body.paragraphs;
          paragraphs.load('items/text,items/style');
          await ctx.sync();
          return paragraphs.items.map((p) => ({ text: p.text, style: p.style }));
        }),
      ),
    search: (query, matchCase, max) =>
      runSerial(() =>
        Word.run(async (ctx) => {
          const results = ctx.document.body.search(query, { matchCase });
          results.load('items/text');
          await ctx.sync();
          const picked = results.items.slice(0, max);
          const paragraphs = picked.map((r) => {
            const ps = r.paragraphs;
            ps.load('items/text');
            return ps;
          });
          await ctx.sync();
          return {
            total: results.items.length,
            matches: picked.map((r, i) => ({
              text: r.text,
              paragraph: paragraphs[i]!.items[0]?.text ?? '',
            })),
          };
        }),
      ),
    insert: (content, where, html) =>
      runSerial(() =>
        Word.run(async (ctx) => {
          if (where === 'cursor') {
            const selection = ctx.document.getSelection();
            if (html) selection.insertHtml(content, Word.InsertLocation.end);
            else selection.insertText(content, Word.InsertLocation.end);
          } else {
            const location =
              where === 'start' ? Word.InsertLocation.start : Word.InsertLocation.end;
            const body = ctx.document.body;
            if (html) body.insertHtml(content, location);
            else body.insertText(content, location);
          }
          await ctx.sync();
        }),
      ),
    replaceSelection: (content, html) =>
      runSerial(() =>
        Word.run(async (ctx) => {
          const selection = ctx.document.getSelection();
          if (html) selection.insertHtml(content, Word.InsertLocation.replace);
          else selection.insertText(content, Word.InsertLocation.replace);
          await ctx.sync();
        }),
      ),
  };
}

function prepare(text: string, format: TextFormat): { content: string; html: boolean } {
  return format === 'markdown'
    ? { content: markdownToHtml(text), html: true }
    : { content: text, html: false };
}

export function wordTools(doc: WordDocument): PaneTool[] {
  return [
    {
      name: 'doc_read_selection',
      description:
        'Read the text the user has selected in the open Word document, with each paragraph and its style. Empty when nothing is selected.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: READ_TIMEOUT_MS,
      async handler() {
        const selection = await doc.readSelection();
        const clipped = clip(selection.text);
        return toJson({
          isEmpty: selection.text.trim().length === 0,
          text: clipped.text,
          truncated: clipped.truncated,
          paragraphs: clipped.truncated ? undefined : selection.paragraphs,
        });
      },
    },
    {
      name: 'doc_read',
      description:
        'Read the open Word document paragraph by paragraph. Returns paragraphs from `start` until about `maxChars` characters, and `nextStart` to continue (null at the end).',
      inputSchema: {
        type: 'object',
        properties: {
          start: {
            type: 'integer',
            minimum: 0,
            description: 'Paragraph index to start at. Default 0.',
          },
          maxChars: {
            type: 'integer',
            minimum: 1000,
            maximum: RESULT_CHAR_BUDGET,
            description: `Character budget for this read. Default ${RESULT_CHAR_BUDGET}.`,
          },
        },
        additionalProperties: false,
      },
      timeoutMs: READ_TIMEOUT_MS,
      async handler(args) {
        const start = readInt(args, 'start', { min: 0, max: 10_000_000, fallback: 0 });
        const budget = readInt(args, 'maxChars', {
          min: 1000,
          max: RESULT_CHAR_BUDGET,
          fallback: RESULT_CHAR_BUDGET,
        });
        const all = await doc.readParagraphs();
        const paragraphs: Array<WordParagraph & { index: number }> = [];
        let used = 0;
        let index = start;
        for (; index < all.length; index++) {
          const p = all[index]!;
          if (paragraphs.length > 0 && used + p.text.length > budget) break;
          const clipped = clip(p.text, budget);
          paragraphs.push({ index, text: clipped.text, style: p.style });
          used += clipped.text.length;
        }
        return toJson({
          totalParagraphs: all.length,
          paragraphs,
          nextStart: index < all.length ? index : null,
        });
      },
    },
    {
      name: 'doc_search',
      description:
        'Find text in the open Word document. Returns each match with the paragraph around it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 255 },
          matchCase: { type: 'boolean' },
          maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      timeoutMs: READ_TIMEOUT_MS,
      async handler(args) {
        const query = readString(args, 'query', { required: true, max: 255 })!;
        const matchCase = readBool(args, 'matchCase', false);
        const max = readInt(args, 'maxResults', { min: 1, max: 50, fallback: 20 });
        const found = await doc.search(query, matchCase, max);
        return toJson({
          total: found.total,
          matches: found.matches.map((m, index) => ({
            index,
            text: m.text,
            paragraph: clip(m.paragraph, 600).text,
          })),
        });
      },
    },
    {
      name: 'doc_insert_text',
      description:
        'Insert text into the open Word document at the cursor, the start, or the end. Use format "markdown" for headings, lists, and bold; "plain" inserts the text as is.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_INSERT_CHARS },
          where: {
            type: 'string',
            enum: ['cursor', 'start', 'end'],
            description: 'Default cursor.',
          },
          format: { type: 'string', enum: ['plain', 'markdown'], description: 'Default plain.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      write: true,
      async handler(args) {
        const text = readString(args, 'text', { required: true, max: MAX_INSERT_CHARS })!;
        const where = readEnum(args, 'where', ['cursor', 'start', 'end'] as const, 'cursor');
        const format = readEnum(args, 'format', ['plain', 'markdown'] as const, 'plain');
        const { content, html } = prepare(text, format);
        await doc.insert(content, where, html);
        return toJson({ inserted: true, where, characters: text.length });
      },
    },
    {
      name: 'doc_replace_selection',
      description:
        'Replace the text the user has selected in the open Word document. Use format "markdown" for headings, lists, and bold.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: MAX_INSERT_CHARS },
          format: { type: 'string', enum: ['plain', 'markdown'] },
        },
        required: ['text'],
        additionalProperties: false,
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      write: true,
      async handler(args) {
        const text = readString(args, 'text', { max: MAX_INSERT_CHARS }) ?? '';
        const format = readEnum(args, 'format', ['plain', 'markdown'] as const, 'plain');
        const { content, html } = prepare(text, format);
        await doc.replaceSelection(content, html);
        return toJson({ replaced: true, characters: text.length });
      },
    },
  ];
}
