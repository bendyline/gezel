import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { readStoredZip } from '../fixtures/office-documents.ts';
import {
  buildDocxFromMarkdown,
  buildPptxFromMarkdown,
  parseMarkdownBlocks,
  plainInline,
  segmentSlides,
} from './markdown-office.ts';

/** Shaped like the approved decks powerpoint-deck's `write` step produces. */
const DECK = `---
squisq-theme: plain
---
# Boreal Desk Returns Pilot Review
- Pilot demonstrated **significant operational gains** (source: \`source/brief.md\`)
- Improved response efficiency

# Pilot Scope
- Pilot coverage: **18 SKUs** (source: \`source/brief.md\`)

# Refund Leakage & "Grounding"
Preventable refund leakage fell from **14.2% to 8.9%**.

| Metric | Before | After |
|---|---|---|
| Median first response | 18 hours | 6 hours |

# Next Actions
1. Implement **automated status emails**
2. Provide barcode-exception training
   - weekly Finance exception export

# Sources
- [Boreal brief](https://example.test/boreal_(pilot)) (source: \`source/brief.md\`)
`;

const TITLES = [
  'Boreal Desk Returns Pilot Review',
  'Pilot Scope',
  'Refund Leakage & "Grounding"',
  'Next Actions',
  'Sources',
];

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The title-placeholder text of every slide, in presentation order. */
function slideTitles(entries: Map<string, string>): string[] {
  const presentation = entries.get('ppt/presentation.xml') ?? '';
  const count = presentation.match(/<p:sldId /g)?.length ?? 0;
  return Array.from({ length: count }, (_, index) => {
    const slide = entries.get(`ppt/slides/slide${index + 1}.xml`) ?? '';
    const title = /<p:ph type="title"\/>[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/.exec(slide);
    return decodeXml(title?.[1] ?? '');
  });
}

describe('parseMarkdownBlocks', () => {
  it('reads the block shapes a deck is made of', () => {
    const blocks = parseMarkdownBlocks(
      [
        '# Title #',
        'Setext two',
        '----------',
        '- one',
        '  continued',
        '  - nested',
        '3. ordered',
        '> quoted **text**',
        '***',
        '```',
        '# not a heading',
        '```',
        'a | b',
        '--|--',
        '1 | 2 \\| 3',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'heading', depth: 1, text: 'Title' },
      { kind: 'heading', depth: 2, text: 'Setext two' },
      { kind: 'listItem', ordered: false, level: 0, text: 'one continued' },
      { kind: 'listItem', ordered: false, level: 1, text: 'nested' },
      { kind: 'listItem', ordered: true, level: 0, text: 'ordered' },
      { kind: 'paragraph', text: 'quoted **text**' },
      { kind: 'code', lines: ['# not a heading'] },
      {
        kind: 'table',
        rows: [
          ['a', 'b'],
          ['1', '2 | 3'],
        ],
      },
    ]);
  });

  it('drops leading YAML frontmatter but keeps a later thematic break out of the text', () => {
    const blocks = parseMarkdownBlocks('---\ntitle: x\n---\n# One\ntext\n\n---\n\n# Two\n');
    expect(blocks).toEqual([
      { kind: 'heading', depth: 1, text: 'One' },
      { kind: 'paragraph', text: 'text' },
      { kind: 'heading', depth: 1, text: 'Two' },
    ]);
  });

  it('does not read a hashtag or a C# title as a heading marker', () => {
    expect(parseMarkdownBlocks('#hashtag\n\n# Learn C#')).toEqual([
      { kind: 'paragraph', text: '#hashtag' },
      { kind: 'heading', depth: 1, text: 'Learn C#' },
    ]);
  });
});

describe('segmentSlides', () => {
  const blocks = parseMarkdownBlocks('Preamble\n\n# A\n## A.1\ntext\n# B\n');

  it('splits on H1 when asked, keeping H2s as body', () => {
    const slides = segmentSlides(blocks, 'h1');
    expect(slides.map((slide) => slide.title)).toEqual([null, 'A', 'B']);
    expect(slides[1]!.body).toEqual([
      { kind: 'heading', depth: 2, text: 'A.1' },
      { kind: 'paragraph', text: 'text' },
    ]);
  });

  it("defaults to squisq's own h2 break, like the real converter", () => {
    expect(segmentSlides(blocks).map((slide) => slide.title)).toEqual([null, 'A', 'A.1', 'B']);
  });
});

describe('plainInline', () => {
  it('drops markers a converter renders as formatting, keeping citation targets visible', () => {
    expect(plainInline('**18 SKUs** (source: `source/brief.md`)')).toBe(
      '18 SKUs (source: source/brief.md)',
    );
    expect(plainInline('See [the brief](https://example.test/a_(b)) and <https://x.test>')).toBe(
      'See the brief (https://example.test/a_(b)) and https://x.test',
    );
    expect(plainInline('keep snake_case_name and \\*literal\\* stars; *em* and _em_')).toBe(
      'keep snake_case_name and *literal* stars; em and em',
    );
    expect(plainInline('`**not bold**` stays')).toBe('**not bold** stays');
  });
});

describe('buildPptxFromMarkdown', () => {
  const bytes = buildPptxFromMarkdown(DECK, { slideBreak: 'h1' })!;
  const entries = readStoredZip(bytes);

  it('is a real PPTX container with one declared, related slide part per H1', () => {
    expect(verifyBinaryDocumentBytes('deck.pptx', bytes).ok).toBe(true);
    expect(bytes.length).toBeGreaterThan(1_000);
    const types = entries.get('[Content_Types].xml') ?? '';
    const rels = entries.get('ppt/_rels/presentation.xml.rels') ?? '';
    for (let index = 1; index <= TITLES.length; index++) {
      expect(entries.has(`ppt/slides/slide${index}.xml`)).toBe(true);
      expect(types).toContain(`PartName="/ppt/slides/slide${index}.xml"`);
      expect(rels).toContain(`Target="slides/slide${index}.xml"`);
    }
    expect(entries.has(`ppt/slides/slide${TITLES.length + 1}.xml`)).toBe(false);
  });

  it('titles every slide with its source heading, in order, XML-escaped', () => {
    expect(slideTitles(entries)).toEqual(TITLES);
    expect(entries.get('ppt/slides/slide3.xml')).toContain(
      'Refund Leakage &amp; &quot;Grounding&quot;',
    );
  });

  it('carries the body text and tables, not a placeholder', () => {
    const all = [...entries.values()].join('');
    expect(all).not.toContain('Deterministic DocBlocks eval deck');
    expect(entries.get('ppt/slides/slide2.xml')).toContain(
      'Pilot coverage: 18 SKUs (source: source/brief.md)',
    );
    const leakage = entries.get('ppt/slides/slide3.xml') ?? '';
    expect(leakage).toContain('Preventable refund leakage fell from 14.2% to 8.9%.');
    expect(leakage).toContain('<a:tbl>');
    expect(leakage).toContain('<a:t>Median first response</a:t>');
    expect(entries.get('ppt/slides/slide4.xml')).toContain('<a:pPr lvl="1"/>');
  });

  it('is byte-deterministic', () => {
    expect(Buffer.from(buildPptxFromMarkdown(DECK, { slideBreak: 'h1' })!)).toEqual(
      Buffer.from(bytes),
    );
  });

  it('bounds a runaway source instead of ballooning the fixture', () => {
    const huge = Array.from(
      { length: 500 },
      (_, index) => `# Slide ${index}\n${'x'.repeat(5_000)}`,
    ).join('\n\n');
    const entriesOfHuge = readStoredZip(buildPptxFromMarkdown(huge, { slideBreak: 'h1' })!);
    expect(entriesOfHuge.has('ppt/slides/slide200.xml')).toBe(true);
    expect(entriesOfHuge.has('ppt/slides/slide201.xml')).toBe(false);
    expect((entriesOfHuge.get('ppt/slides/slide1.xml') ?? '').length).toBeLessThan(3_000);
  });

  it('has nothing to build from an empty source', () => {
    expect(buildPptxFromMarkdown('---\ntitle: x\n---\n\n   \n')).toBeNull();
    expect(buildDocxFromMarkdown('')).toBeNull();
  });
});

describe('buildDocxFromMarkdown', () => {
  it('is a real DOCX with heading styles, numbered lists, and a numbering part', () => {
    const bytes = buildDocxFromMarkdown(DECK)!;
    expect(verifyBinaryDocumentBytes('report.docx', bytes).ok).toBe(true);
    const entries = readStoredZip(bytes);
    const document = entries.get('word/document.xml') ?? '';
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('Pilot coverage: 18 SKUs (source: source/brief.md)');
    expect(document).toContain('<w:numId w:val="2"/>');
    expect(document).toContain('<w:tbl>');
    expect(entries.get('word/_rels/document.xml.rels')).toContain('Target="numbering.xml"');
    expect(entries.has('word/numbering.xml')).toBe(true);
  });
});

/**
 * Round trip through the importer the product's `read_doc_as_markdown` runs
 * (squisq-formats + squisq's markdown stringifier, the pair
 * packages/service/src/index-store/convert-worker.ts loads), resolved from the
 * service package's own dependency tree so this exercises the same pinned
 * versions. This is the property the evaluate step depends on: what a reviewer
 * reads back out of the saved deck is the deck it approved.
 */
const serviceRequire = createRequire(
  fileURLToPath(new URL('../../../packages/service/package.json', import.meta.url)),
);
function resolveFromService(specifier: string): string | null {
  try {
    return serviceRequire.resolve(specifier);
  } catch {
    return null;
  }
}
const importerPaths = {
  formats: resolveFromService('@bendyline/squisq-formats'),
  markdown: resolveFromService('@bendyline/squisq/markdown'),
  xmldom: resolveFromService('@xmldom/xmldom'),
};
const importerAvailable = Object.values(importerPaths).every((path) => path !== null);

interface ProductImporter {
  pptx(bytes: Uint8Array): Promise<string>;
  docx(bytes: Uint8Array): Promise<string>;
}

async function productImporter(): Promise<ProductImporter> {
  const formats = (await import(pathToFileURL(importerPaths.formats!).href)) as {
    pptxToMarkdownDoc(data: ArrayBuffer): Promise<unknown>;
    docxToMarkdownDoc(data: ArrayBuffer): Promise<unknown>;
  };
  const { stringifyMarkdown } = (await import(pathToFileURL(importerPaths.markdown!).href)) as {
    stringifyMarkdown(doc: unknown): string;
  };
  const { DOMParser } = (await import(pathToFileURL(importerPaths.xmldom!).href)) as {
    DOMParser: unknown;
  };
  const withDomParser = async (run: () => Promise<unknown>): Promise<string> => {
    const g = globalThis as { DOMParser?: unknown };
    const previous = g.DOMParser;
    g.DOMParser = previous ?? DOMParser;
    try {
      return stringifyMarkdown(await run());
    } finally {
      g.DOMParser = previous;
    }
  };
  const buffer = (bytes: Uint8Array) =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return {
    pptx: (bytes) => withDomParser(() => formats.pptxToMarkdownDoc(buffer(bytes))),
    docx: (bytes) => withDomParser(() => formats.docxToMarkdownDoc(buffer(bytes))),
  };
}

describe.skipIf(!importerAvailable)("round trip through the product's document reader", () => {
  it('reads back the same slide titles, in order, with the source facts', async () => {
    const importer = await productImporter();
    // The stringifier escapes `:` and `_` inside URLs; a reviewer reads past that.
    const markdown = (
      await importer.pptx(buildPptxFromMarkdown(DECK, { slideBreak: 'h1' })!)
    ).replace(/\\([:_])/g, '$1');
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(TITLES);
    for (const fact of [
      'Pilot coverage: 18 SKUs',
      'Preventable refund leakage fell from 14.2% to 8.9%.',
      'Implement automated status emails',
      'weekly Finance exception export',
      'Boreal brief (https://example.test/boreal_(pilot))',
    ]) {
      expect(markdown).toContain(fact);
    }
    expect(markdown).toMatch(/\|\s*Median first response\s*\|\s*18 hours\s*\|\s*6 hours\s*\|/);
    expect(markdown).not.toContain('Deterministic DocBlocks eval deck');
  });

  it('reads back a DOCX with the same headings and list items', async () => {
    const importer = await productImporter();
    const markdown = await importer.docx(buildDocxFromMarkdown(DECK)!);
    const headings = [...markdown.matchAll(/^# (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(TITLES);
    expect(markdown).toMatch(/^1\. Implement automated status emails$/m);
    expect(markdown).toMatch(/^- Pilot coverage: 18 SKUs \(source: source\/brief\.md\)$/m);
  });
});
