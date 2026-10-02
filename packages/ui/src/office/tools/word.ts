import type { DiagramRenderer } from '../diagram.js';
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

/**
 * A picture that replaces a placeholder paragraph in inserted HTML. Inserting
 * the HTML first and swapping each placeholder after keeps text and pictures
 * in the order they were written, wherever the insert lands.
 */
export interface WordPicture {
  placeholder: string;
  base64: string;
  widthPt: number;
  heightPt: number;
  altText: string;
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
  insert(
    content: string,
    where: InsertWhere,
    html: boolean,
    pictures?: readonly WordPicture[],
  ): Promise<void>;
  replaceSelection(
    content: string,
    html: boolean,
    pictures?: readonly WordPicture[],
  ): Promise<void>;
}

async function placePictures(
  ctx: Word.RequestContext,
  pictures: readonly WordPicture[] = [],
): Promise<void> {
  if (pictures.length === 0) return;
  const found = pictures.map((picture) => {
    const results = ctx.document.body.search(picture.placeholder, { matchCase: true });
    results.load('items');
    return results;
  });
  await ctx.sync();
  pictures.forEach((picture, i) => {
    const range = found[i]!.items[0];
    if (!range) throw new Error('The text went in, but Word lost the place for the diagram.');
    const inline = range.insertInlinePictureFromBase64(picture.base64, Word.InsertLocation.replace);
    inline.width = picture.widthPt;
    inline.height = picture.heightPt;
    inline.altTextDescription = picture.altText;
  });
  await ctx.sync();
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
    insert: (content, where, html, pictures) =>
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
          await placePictures(ctx, pictures);
        }),
      ),
    replaceSelection: (content, html, pictures) =>
      runSerial(() =>
        Word.run(async (ctx) => {
          const selection = ctx.document.getSelection();
          if (html) selection.insertHtml(content, Word.InsertLocation.replace);
          else selection.insertText(content, Word.InsertLocation.replace);
          await ctx.sync();
          await placePictures(ctx, pictures);
        }),
      ),
  };
}

/** Longest Mermaid source one diagram may carry. */
const MAX_DIAGRAM_SOURCE_CHARS = 20_000;

function placeholder(): string {
  return `GEZELDIAGRAM${crypto.randomUUID().replace(/-/g, '')}`;
}

function pictureParagraph(token: string): string {
  return `<p style="text-align:center">${token}</p>`;
}

async function drawPicture(
  render: DiagramRenderer,
  source: string,
  altText: string,
): Promise<{ picture: WordPicture; diagramType: string }> {
  const drawn = await render(source);
  return {
    picture: {
      placeholder: placeholder(),
      base64: drawn.base64,
      widthPt: drawn.widthPt,
      heightPt: drawn.heightPt,
      altText,
    },
    diagramType: drawn.diagramType,
  };
}

/**
 * Text ready for Word. In markdown, a ```mermaid fence becomes a drawn
 * diagram when this Word can take pictures. Every diagram is drawn before
 * anything is inserted, so one that will not draw leaves the document
 * untouched and the model gets Mermaid's message to correct.
 */
async function prepare(
  text: string,
  format: TextFormat,
  render: DiagramRenderer | undefined,
): Promise<{ content: string; html: boolean; pictures: WordPicture[] }> {
  if (format !== 'markdown') return { content: text, html: false, pictures: [] };
  const sources: Array<{ token: string; source: string }> = [];
  const content = markdownToHtml(
    text,
    render
      ? {
          diagram: (source) => {
            const token = placeholder();
            sources.push({ token, source });
            return pictureParagraph(token);
          },
        }
      : {},
  );
  const pictures: WordPicture[] = [];
  for (const { token, source } of sources) {
    const { picture } = await drawPicture(render!, source, 'Diagram');
    pictures.push({ ...picture, placeholder: token });
  }
  return { content, html: true, pictures };
}

/**
 * `render` draws Mermaid diagrams; without it (a Word too old for picture
 * inserts) there is no diagram tool and a ```mermaid fence stays code.
 */
export function wordTools(doc: WordDocument, render?: DiagramRenderer): PaneTool[] {
  const tools: PaneTool[] = [
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
      description: render
        ? 'Insert text into the open Word document at the cursor, the start, or the end. Use format "markdown" for headings, lists (indent to nest), and bold; a ```mermaid block is drawn as a diagram. "plain" inserts the text as is.'
        : 'Insert text into the open Word document at the cursor, the start, or the end. Use format "markdown" for headings, lists (indent to nest), and bold; "plain" inserts the text as is.',
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
        const { content, html, pictures } = await prepare(text, format, render);
        await doc.insert(content, where, html, pictures);
        return toJson({
          inserted: true,
          where,
          characters: text.length,
          ...(pictures.length ? { diagrams: pictures.length } : {}),
        });
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
        const { content, html, pictures } = await prepare(text, format, render);
        await doc.replaceSelection(content, html, pictures);
        return toJson({
          replaced: true,
          characters: text.length,
          ...(pictures.length ? { diagrams: pictures.length } : {}),
        });
      },
    },
  ];
  if (render) {
    tools.push({
      name: 'doc_insert_diagram',
      description:
        'Draw a diagram and insert it into the open Word document as a picture, at the cursor, the start, or the end. Write it in Mermaid: flowchart (also family and org trees), sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, timeline, mindmap, gantt, pie. Use it whenever the user asks for a diagram, chart, tree, or flow. If Mermaid cannot read the source, the error says where; fix it and call again.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_DIAGRAM_SOURCE_CHARS,
            description: 'Mermaid source, without a ``` fence.',
          },
          where: {
            type: 'string',
            enum: ['cursor', 'start', 'end'],
            description: 'Default cursor.',
          },
          title: {
            type: 'string',
            maxLength: 200,
            description: 'What the diagram shows; read aloud by screen readers.',
          },
        },
        required: ['source'],
        additionalProperties: false,
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      write: true,
      async handler(args) {
        const source = readString(args, 'source', {
          required: true,
          max: MAX_DIAGRAM_SOURCE_CHARS,
        })!
          .trim()
          .replace(/^```\s*mermaid\s*\n/i, '')
          .replace(/\n```\s*$/, '');
        const where = readEnum(args, 'where', ['cursor', 'start', 'end'] as const, 'cursor');
        const title = readString(args, 'title', { max: 200 }) ?? 'Diagram';
        const { picture, diagramType } = await drawPicture(render, source, title);
        await doc.insert(pictureParagraph(picture.placeholder), where, true, [picture]);
        return toJson({
          inserted: true,
          where,
          diagramType,
          widthPt: picture.widthPt,
          heightPt: picture.heightPt,
        });
      },
    });
  }
  return tools;
}
