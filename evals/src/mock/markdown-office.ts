/**
 * Source-faithful Open XML writers for the eval mock's conversion effects.
 *
 * The DocBlocks mock used to materialize one fixed deck — a single slide
 * titled "Deterministic DocBlocks eval deck" — whatever Markdown the model
 * had asked it to convert. That was harmless while nothing read the saved
 * binary back. powerpoint-deck 1.7.10 added an `evaluate` step that does
 * exactly that (`read_doc_as_markdown` is the real tool, not a mock), found
 * the placeholder instead of the approved slides, reported a content-fidelity
 * FAIL, and routed back to `publish` until the retry-loop verdict: the
 * reviewer was right and the mock was lying. These writers build the file the
 * conversion would have produced, so a readback agrees with the source.
 *
 * Deliberately a small line-based Markdown reader, not a full CommonMark
 * implementation: decks and reports are headings, bullets, short paragraphs,
 * the odd table or code block. What matters is that the slide boundaries and
 * text survive the way squisq's exporter (the converter behind DocBlocks)
 * would carry them, and that the product's importer reads them back.
 */

import { xmlEscape, zipStored } from '../fixtures/office-documents.ts';

/** Heading depths that start a slide — DocBlocks' `slideBreak` target option. */
export type SlideBreak = 'h1' | 'h2' | 'heading';

export type MarkdownBlock =
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'listItem'; ordered: boolean; level: number; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'code'; lines: string[] };

export interface SlideContent {
  /** Null for a preamble slide: content that came before the first break heading. */
  title: string | null;
  body: MarkdownBlock[];
}

/** Bounds so a runaway source cannot balloon a fixture; generous for any real deck. */
const LIMITS = {
  slides: 200,
  blocksPerSlide: 60,
  docxBlocks: 2_000,
  chars: 1_000,
  tableRows: 50,
  tableCols: 12,
  codeLines: 40,
  listLevel: 8,
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const BLOCKQUOTE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const HTML_COMMENT_LINE = /^[ \t]*<!--[\s\S]*-->[ \t]*$/;

/** Split Markdown into the block shapes a converter lays out. */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = stripFrontmatter(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).split(
    '\n',
  );
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let openItem: Extract<MarkdownBlock, { kind: 'listItem' }> | null = null;
  let listIndents: number[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const push = (block: MarkdownBlock) => {
    flush();
    openItem = null;
    listIndents = [];
    blocks.push(block);
  };

  let inQuote = false;

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    // A blockquote's content is laid out like any other content, but entering
    // or leaving one starts a new block rather than continuing the last.
    let quoted = false;
    for (let quote = BLOCKQUOTE.exec(line); quote; quote = BLOCKQUOTE.exec(line)) {
      line = quote[1] ?? '';
      quoted = true;
    }
    if (quoted !== inQuote) {
      flush();
      openItem = null;
      listIndents = [];
      inQuote = quoted;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      for (index++; index < lines.length && !close.test(lines[index]!); index++) {
        body.push(lines[index]!);
      }
      push({ kind: 'code', lines: body });
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      openItem = null;
      continue;
    }
    if (HTML_COMMENT_LINE.test(line)) continue;

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const text = (heading[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '');
      push({ kind: 'heading', depth: heading[1]!.length, text });
      continue;
    }
    if (paragraph.length > 0 && (SETEXT_H1.test(line) || SETEXT_H2.test(line))) {
      const text = paragraph.join(' ');
      paragraph = [];
      push({ kind: 'heading', depth: SETEXT_H1.test(line) ? 1 : 2, text });
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      flush();
      openItem = null;
      listIndents = [];
      continue;
    }
    if (line.includes('|') && TABLE_DELIMITER.test(lines[index + 1] ?? '')) {
      const delimiter = lines[index + 1]!;
      if (delimiter.includes('|')) {
        const rows = [splitTableRow(line)];
        for (index += 2; index < lines.length; index++) {
          const row = lines[index]!;
          if (row.trim().length === 0 || !row.includes('|')) break;
          rows.push(splitTableRow(row));
        }
        index--;
        push({ kind: 'table', rows });
        continue;
      }
    }
    const item = LIST_ITEM.exec(line);
    if (item && !(paragraph.length > 0 && item[3] === undefined)) {
      flush();
      const indent = indentWidth(item[1] ?? '');
      while (listIndents.length > 0 && indent < listIndents[listIndents.length - 1]!) {
        listIndents.pop();
      }
      if (listIndents.length === 0 || indent > listIndents[listIndents.length - 1]!) {
        listIndents.push(indent);
      }
      const block: Extract<MarkdownBlock, { kind: 'listItem' }> = {
        kind: 'listItem',
        ordered: /\d/.test(item[2]!),
        level: Math.min(LIMITS.listLevel, listIndents.length - 1),
        text: item[3] ?? '',
      };
      blocks.push(block);
      openItem = block;
      continue;
    }
    if (openItem && paragraph.length === 0) {
      // Continuation (indented or lazy) of the item on the line above.
      openItem.text = `${openItem.text} ${line.trim()}`.trim();
      continue;
    }
    openItem = null;
    listIndents = [];
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * Group blocks into slides the way squisq's PPTX exporter does: a heading at
 * or above the break depth starts a slide, and anything before the first one
 * becomes an untitled leading slide. The exporter's own default break is
 * `h2`, so a caller that did not ask for `h1` gets `h2` here too.
 */
export function segmentSlides(
  blocks: readonly MarkdownBlock[],
  slideBreak: SlideBreak = 'h2',
): SlideContent[] {
  const maxDepth = slideBreak === 'h1' ? 1 : slideBreak === 'h2' ? 2 : 6;
  const slides: SlideContent[] = [];
  let current: SlideContent | null = null;
  for (const block of blocks) {
    if (block.kind === 'heading' && block.depth <= maxDepth) {
      if (current && (current.title !== null || current.body.length > 0)) slides.push(current);
      current = { title: block.text, body: [] };
      continue;
    }
    current ??= { title: null, body: [] };
    current.body.push(block);
  }
  if (current) slides.push(current);
  return slides;
}

/**
 * The text a converter lays down for an inline Markdown span: emphasis and
 * code markers dropped, images reduced to their alt text. A link keeps its
 * target beside its label, because a deck's citations are links and a
 * reviewer comparing the saved file to its source has to be able to see them.
 */
export function plainInline(text: string): string {
  const protectedSpans: string[] = [];
  const protect = (value: string) => `\u0000${protectedSpans.push(value) - 1}\u0000`;
  const result = text
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) =>
      protect(code.replace(/^ (.*) $/, '$1')),
    )
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_, char: string) => protect(char))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(
      /\[([^\]]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
      (_, label: string, url: string) => (label === url ? url : `${label} (${url})`),
    )
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')
    .replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9_])/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: \u0000 delimits placeholders built above.
    .replace(/\u0000(\d+)\u0000/g, (_, slot: string) => protectedSpans[Number(slot)] ?? '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return truncate(result);
}

/** The slides a PPTX built from this source carries — the one split both the writer and the count use. */
function deckSlides(markdown: string, slideBreak: SlideBreak | undefined): SlideContent[] {
  return segmentSlides(parseMarkdownBlocks(markdown), slideBreak).slice(0, LIMITS.slides);
}

/**
 * How many slides {@link buildPptxFromMarkdown} writes for this source, or
 * null when it writes nothing (and the caller falls back to a fixed fixture).
 */
export function pptxSlideCount(
  markdown: string,
  opts: { slideBreak?: SlideBreak } = {},
): number | null {
  const count = deckSlides(markdown, opts.slideBreak).length;
  return count > 0 ? count : null;
}

/** Office formats the mock can build from a Markdown source. */
export type SourceFaithfulFormat = 'pptx' | 'docx';

export function isSourceFaithfulFormat(format: unknown): format is SourceFaithfulFormat {
  return format === 'pptx' || format === 'docx';
}

/** The bytes a conversion of this source to `format` produces; null when there is nothing to lay out. */
export function buildDocumentFromMarkdown(
  format: SourceFaithfulFormat,
  markdown: string,
  opts: { slideBreak?: SlideBreak } = {},
): Uint8Array | null {
  return format === 'pptx'
    ? buildPptxFromMarkdown(markdown, opts)
    : buildDocxFromMarkdown(markdown);
}

/**
 * A PPTX whose slides are the source's slides: one `title` placeholder per
 * slide carrying the heading text, one `body` placeholder carrying the rest
 * as one paragraph per bullet/paragraph/line, and tables as real DrawingML
 * tables. Null when the source has no content to lay out.
 */
export function buildPptxFromMarkdown(
  markdown: string,
  opts: { slideBreak?: SlideBreak } = {},
): Uint8Array | null {
  const slides = deckSlides(markdown, opts.slideBreak);
  if (slides.length === 0) return null;
  const slideXml = slides.map((slide) => pptxSlide(slide));
  const slideOverrides = slideXml
    .map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('');
  const slideIds = slideXml
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
    .join('');
  const slideRels = slideXml
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
    )
    .join('');
  return zipStored([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slideOverrides}</Types>`,
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    ],
    [
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${PML_NAMESPACES}><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels}</Relationships>`,
    ],
    ...slideXml.map((xml, index) => [`ppt/slides/slide${index + 1}.xml`, xml] as [string, string]),
  ]);
}

/**
 * A DOCX carrying the source's structure: heading styles Word and the
 * product's importer both recognize, real numbered/bulleted lists backed by a
 * numbering part, tables as `w:tbl`, and code lines in the `Code` style.
 * Null when the source has no content.
 */
export function buildDocxFromMarkdown(markdown: string): Uint8Array | null {
  const blocks = parseMarkdownBlocks(markdown).slice(0, LIMITS.docxBlocks);
  const body = blocks.map((block) => docxBlock(block)).join('');
  if (body.length === 0) return null;
  return zipStored([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WML_NAMESPACE}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ],
    [
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    ],
    ['word/numbering.xml', docxNumbering()],
  ]);
}

const PML_NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const WML_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Slide content width (16:9, half-inch margins) in EMU. */
const SLIDE_CONTENT_WIDTH = 11_277_600;
const TABLE_ROW_HEIGHT = 370_840;

function pptxSlide(slide: SlideContent): string {
  const shapes: string[] = [];
  let nextId = 2;
  const title = slide.title === null ? '' : plainInline(slide.title);
  if (title) {
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${nextId}" name="Title ${nextId - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${pptxParagraph(title)}</p:txBody></p:sp>`,
    );
    nextId++;
  }
  const body = slide.body.slice(0, LIMITS.blocksPerSlide);
  const paragraphs = body.flatMap((block) => pptxBodyParagraphs(block));
  if (paragraphs.length > 0) {
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${nextId}" name="Content ${nextId - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`,
    );
    nextId++;
  }
  for (const block of body) {
    if (block.kind !== 'table') continue;
    shapes.push(pptxTable(block.rows, nextId));
    nextId++;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${PML_NAMESPACES}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function pptxBodyParagraphs(block: MarkdownBlock): string[] {
  switch (block.kind) {
    case 'heading':
    case 'paragraph': {
      const text = plainInline(block.text);
      return text ? [pptxParagraph(text)] : [];
    }
    case 'listItem': {
      const text = plainInline(block.text);
      return text ? [pptxParagraph(text, block.level)] : [];
    }
    case 'code':
      return codeLines(block.lines).map((line) => pptxParagraph(line));
    case 'table':
      return [];
  }
}

function pptxParagraph(text: string, level = 0): string {
  const pPr = level > 0 ? `<a:pPr lvl="${level}"/>` : '';
  return `<a:p>${pPr}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlText(text)}</a:t></a:r></a:p>`;
}

function pptxTable(rows: readonly string[][], id: number): string {
  const kept = rows.slice(0, LIMITS.tableRows);
  const columns = Math.min(LIMITS.tableCols, Math.max(1, ...kept.map((row) => row.length)));
  const width = Math.floor(SLIDE_CONTENT_WIDTH / columns);
  const grid = `<a:tblGrid>${`<a:gridCol w="${width}"/>`.repeat(columns)}</a:tblGrid>`;
  const body = kept
    .map((row) => {
      const cells = Array.from({ length: columns }, (_, column) => {
        const text = plainInline(row[column] ?? '');
        const paragraph = text ? pptxParagraph(text) : '<a:p><a:endParaRPr lang="en-US"/></a:p>';
        return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph}</a:txBody><a:tcPr/></a:tc>`;
      }).join('');
      return `<a:tr h="${TABLE_ROW_HEIGHT}">${cells}</a:tr>`;
    })
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id - 1}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1600200"/><a:ext cx="${width * columns}" cy="${TABLE_ROW_HEIGHT * kept.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>${grid}${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function docxBlock(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading':
      return docxParagraph(plainInline(block.text), `<w:pStyle w:val="Heading${block.depth}"/>`);
    case 'paragraph':
      return docxParagraph(plainInline(block.text));
    case 'listItem':
      return docxParagraph(
        plainInline(block.text),
        `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`,
      );
    case 'code':
      return codeLines(block.lines)
        .map((line) => docxParagraph(line, '<w:pStyle w:val="Code"/>'))
        .join('');
    case 'table': {
      const rows = block.rows.slice(0, LIMITS.tableRows);
      const columns = Math.min(LIMITS.tableCols, Math.max(1, ...rows.map((row) => row.length)));
      const grid = `<w:tblGrid>${'<w:gridCol w:w="2400"/>'.repeat(columns)}</w:tblGrid>`;
      const body = rows
        .map((row) => {
          const cells = Array.from({ length: columns }, (_, column) => {
            const text = plainInline(row[column] ?? '');
            return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${docxParagraph(text) || '<w:p/>'}</w:tc>`;
          }).join('');
          return `<w:tr>${cells}</w:tr>`;
        })
        .join('');
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}${body}</w:tbl>`;
    }
  }
}

function docxParagraph(text: string, pPr = ''): string {
  if (!text) return '';
  const props = pPr ? `<w:pPr>${pPr}</w:pPr>` : '';
  return `<w:p>${props}<w:r><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`;
}

/** One bullet list (numId 1) and one decimal list (numId 2), nine levels each. */
function docxNumbering(): string {
  const levels = (format: 'bullet' | 'decimal') =>
    Array.from({ length: 9 }, (_, level) => {
      const text = format === 'bullet' ? '•' : `%${level + 1}.`;
      return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${WML_NAMESPACE}"><w:abstractNum w:abstractNumId="0">${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1">${levels('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
}

function codeLines(lines: readonly string[]): string[] {
  return lines
    .slice(0, LIMITS.codeLines)
    .map((line) => truncate(line.replace(/\s+$/, '')))
    .filter((line) => line.trim().length > 0);
}

function splitTableRow(line: string): string[] {
  const trimmed = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width += char === '\t' ? 4 : 1;
  return width;
}

/** A leading `---` fenced block is YAML frontmatter to squisq's parser, never slide content. */
function stripFrontmatter(text: string): string {
  const match = /^---\n(?:[\s\S]*?\n)?---(?:\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function truncate(text: string): string {
  return text.length > LIMITS.chars ? `${text.slice(0, LIMITS.chars - 1)}…` : text;
}

/** Escape, and drop the code points XML 1.0 cannot carry at all. */
function xmlText(text: string): string {
  return xmlEscape(text.replace(XML_FORBIDDEN, '').replace(LONE_SURROGATE, ''));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the code points XML 1.0 forbids.
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
