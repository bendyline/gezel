/**
 * Deterministic office-document byte writers, shared by the eval mock server
 * (which materializes *output* fixtures) and the scenario fixtures (which seed
 * *source* documents a craftbook must read).
 *
 * Two different jobs, one set of writers on purpose. A source document has to
 * be a real container carrying real extractable text, because the whole point
 * of a PDF/DOCX source scenario is that the model reaches for
 * `read_doc_as_markdown` and the facts it cites come back out of the bytes. A
 * second, parallel writer would drift from the one the mocks use and the
 * scenarios would stop proving anything about the real path.
 *
 * Everything here is byte-deterministic: same input, same output, so a trial
 * that re-seeds a fixture produces an identical file and content hashes are
 * stable across runs.
 */

import { inflateRawSync } from 'node:zlib';

/** Stored (uncompressed) ZIP — the container under every Open XML format. */
export function zipStored(files: Array<[string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const entry of locals) {
    out.set(entry, cursor);
    cursor += entry.length;
  }
  for (const entry of centrals) {
    out.set(entry, cursor);
    cursor += entry.length;
  }
  const end = new DataView(out.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return out;
}

/** Read a {@link zipStored} archive's entries back out, in order — for assertions. */
export function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  let cursor = 0;
  while (cursor + 30 <= bytes.length && view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 18, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    const nameStart = cursor + 30;
    const dataStart = nameStart + nameLength + extraLength;
    out.set(
      decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    );
    cursor = dataStart + size;
  }
  return out;
}

/**
 * Read any ZIP's entries — stored or deflated — through its central
 * directory. Real converters compress their containers, which
 * {@link readStoredZip} cannot read; graders use this one on tool output.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) return out;
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  for (let i = 0; i < count && cursor + 46 <= bytes.length; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Escape the five XML metacharacters. Source briefs contain `&` and quotes. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface DocumentBlock {
  /** `h1`/`h2` map to Word heading styles and to larger PDF type. */
  style: 'h1' | 'h2' | 'p' | 'bullet';
  text: string;
}

/**
 * A Word document carrying real paragraph text.
 *
 * Heading styles are declared inline via `w:pStyle` and the styles part is
 * omitted — Word resolves an unknown style id to Normal, and every extractor
 * we care about reads `w:t` runs regardless. The goal is extractable text in a
 * genuine OOXML container, not a typographically complete document.
 */
export function buildDocx(blocks: readonly DocumentBlock[]): Uint8Array {
  const paragraphs = blocks
    .map((block) => {
      const style =
        block.style === 'h1'
          ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
          : block.style === 'h2'
            ? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'
            : block.style === 'bullet'
              ? '<w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr>'
              : '';
      const text = block.style === 'bullet' ? `• ${block.text}` : block.text;
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
    })
    .join('');
  return zipStored([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
    ],
    [
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ],
  ]);
}

/** PDF strings are parenthesised; the delimiters and backslash need escaping. */
function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A single-page PDF whose text is real content-stream `Tj` operators.
 *
 * Byte offsets in the xref table are computed rather than hardcoded, so edits
 * to the block list cannot silently desync it — the same property the mock's
 * `minimalPdfFixture` relies on, generalized to arbitrary text. Non-ASCII is
 * transliterated rather than embedded, because carrying it correctly needs a
 * font program and this fixture deliberately has none.
 */
export function buildPdf(blocks: readonly DocumentBlock[]): Uint8Array {
  const lines: string[] = [];
  let y = 740;
  for (const block of blocks) {
    const size = block.style === 'h1' ? 18 : block.style === 'h2' ? 14 : 11;
    const text = block.style === 'bullet' ? `- ${block.text}` : block.text;
    y -= size + 8;
    lines.push(`BT /F1 ${size} Tf 60 ${y} Td (${pdfEscape(toLatin1(text))}) Tj ET`);
  }
  const content = lines.join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const header = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  let body = '';
  for (const object of objects) {
    offsets.push(header.length + body.length);
    body += object;
  }
  const xrefStart = header.length + body.length;
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefStart),
    '%%EOF\n',
  ].join('\n');
  // latin1 so the binary comment bytes in the header stay single-byte.
  return Uint8Array.from(`${header}${body}${xref}`, (char) => char.charCodeAt(0) & 0xff);
}

/** Fold the punctuation a brief picks up from editors into ASCII. */
function toLatin1(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '-');
}

/** Render the same blocks as Markdown — the control arm for source-format A/Bs. */
export function buildMarkdown(blocks: readonly DocumentBlock[]): string {
  return `${blocks
    .map((block) =>
      block.style === 'h1'
        ? `# ${block.text}`
        : block.style === 'h2'
          ? `## ${block.text}`
          : block.style === 'bullet'
            ? `- ${block.text}`
            : block.text,
    )
    .join('\n\n')}\n`;
}

/** The brand values a deck's theme part carries. Colors are six hex digits, no `#`. */
export interface PptxTheme {
  name: string;
  headingFont: string;
  bodyFont: string;
  /** dk1, lt1, dk2, lt2, accent1..accent6, hlink, folHlink — in that order. */
  colors: {
    dark1: string;
    light1: string;
    dark2: string;
    light2: string;
    accents: [string, string, string, string, string, string];
    hyperlink: string;
    followedHyperlink: string;
  };
}

export interface PptxSlide {
  title: string;
  bullets?: readonly string[];
}

const PPTX_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function pptxThemeXml(theme: PptxTheme): string {
  const c = theme.colors;
  const srgb = (tag: string, hex: string) => `<a:${tag}><a:srgbClr val="${hex}"/></a:${tag}>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = `<a:ln w="9525">${solid}</a:ln>`;
  return `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${xmlEscape(theme.name)}"><a:themeElements><a:clrScheme name="${xmlEscape(theme.name)}">${srgb('dk1', c.dark1)}${srgb('lt1', c.light1)}${srgb('dk2', c.dark2)}${srgb('lt2', c.light2)}${c.accents.map((hex, i) => srgb(`accent${i + 1}`, hex)).join('')}${srgb('hlink', c.hyperlink)}${srgb('folHlink', c.followedHyperlink)}</a:clrScheme><a:fontScheme name="${xmlEscape(theme.name)}"><a:majorFont><a:latin typeface="${xmlEscape(theme.headingFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${xmlEscape(theme.bodyFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="${xmlEscape(theme.name)}"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst>${line}${line}${line}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function pptxShape(id: number, name: string, placeholder: string, paragraphs: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${placeholder}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

const PPTX_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

/**
 * A PowerPoint deck with a real master, layout and theme part.
 *
 * The theme is the point: its fonts and colors are what a theme-inference
 * tool reads, so a fixture that invents them gives a scenario values no model
 * can know without opening the file. Slides use title/body placeholders so
 * the text inherits the theme exactly as an authored deck's would.
 */
export function buildPptx(slides: readonly PptxSlide[], theme: PptxTheme): Uint8Array {
  const paragraph = (text: string) =>
    `<a:p><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`;
  const slideXml = (slide: PptxSlide) =>
    `${XML_DECL}<p:sld ${PPTX_NS}><p:cSld><p:spTree>${PPTX_GROUP}${pptxShape(2, 'Title 1', 'type="title"', paragraph(slide.title))}${
      slide.bullets?.length
        ? pptxShape(3, 'Content 2', 'idx="1"', slide.bullets.map(paragraph).join(''))
        : ''
    }</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const slideOverrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('');
  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`,
    ],
    [
      '_rels/.rels',
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    ],
    [
      'ppt/presentation.xml',
      `${XML_DECL}<p:presentation ${PPTX_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`)
        .join(
          '',
        )}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL_NS}/theme" Target="theme/theme1.xml"/>${slides
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 3}" Type="${REL_NS}/slide" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join('')}</Relationships>`,
    ],
    [
      'ppt/slideMasters/slideMaster1.xml',
      `${XML_DECL}<p:sldMaster ${PPTX_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${PPTX_GROUP}${pptxShape(2, 'Title Placeholder 1', 'type="title"', '<a:p><a:endParaRPr lang="en-US"/></a:p>')}${pptxShape(3, 'Text Placeholder 2', 'type="body" idx="1"', '<a:p><a:endParaRPr lang="en-US"/></a:p>')}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`,
    ],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    ],
    [
      'ppt/slideLayouts/slideLayout1.xml',
      `${XML_DECL}<p:sldLayout ${PPTX_NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${PPTX_GROUP}${pptxShape(2, 'Title 1', 'type="title"', '<a:p><a:endParaRPr lang="en-US"/></a:p>')}${pptxShape(3, 'Content Placeholder 2', 'idx="1"', '<a:p><a:endParaRPr lang="en-US"/></a:p>')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    ],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    ],
    ['ppt/theme/theme1.xml', pptxThemeXml(theme)],
    ...slides.flatMap(
      (slide, i): Array<[string, string]> => [
        [`ppt/slides/slide${i + 1}.xml`, slideXml(slide)],
        [
          `ppt/slides/_rels/slide${i + 1}.xml.rels`,
          `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
        ],
      ],
    ),
  ];
  return zipStored(files);
}
