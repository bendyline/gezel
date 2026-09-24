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
