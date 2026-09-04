import { markdownToTiptap } from '@bendyline/squisq-editor-react';
import { markdownDocToXlsx } from '@bendyline/squisq-formats/xlsx';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { describe, expect, it } from 'vitest';
import { createDataReferenceContainer } from './data-reference-container.js';
import {
  chooseOutsideInSource,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  supportsOutsideInMarkdownEditing,
  withOutsideInMarkdownEditing,
  withOutsideInMetadata,
} from './outside-in.js';

describe('outside-in project documents', () => {
  it('maps a rendered filename to its hidden editable companion', () => {
    const layout = resolveOutsideInLayout('decks/Tucson.pptx');
    expect(layout).toMatchObject({
      targetPath: 'decks/Tucson.pptx',
      format: 'pptx',
      companionDirectory: 'decks/Tucson_files',
      markdownPath: 'decks/Tucson_files/tucson.md',
      backupPath: 'decks/Tucson_files/.original/original.pptx',
    });
    expect(chooseOutsideInSource(layout!, ['decks/Tucson_files/hand-authored.md'])).toBe(
      'decks/Tucson_files/hand-authored.md',
    );
  });

  it('imports HTML into linked Markdown and exports against the shared player', async () => {
    const layout = resolveOutsideInLayout('history/battle-of-britain.html')!;
    const imported = await importOutsideInDocument(
      new TextEncoder().encode('<h1>Battle of Britain</h1>'),
      layout,
    );
    expect(imported.markdown).toContain('squisq-output: ../battle-of-britain.html');
    expect(imported.markdown).toContain('# Battle of Britain');
    expect(isOutsideInMarkdownEditingEnabled(imported.markdown)).toBe(false);

    const rendered = await renderOutsideInDocument(
      withOutsideInMarkdownEditing(`${imported.markdown}\n\n![Map](map.png)\n`, layout),
      layout,
      new MemoryContentContainer(),
      '../_squisq/squisq-player.js',
    );
    const html = new TextDecoder().decode(rendered.bytes);
    expect(html).toContain('<script src="../_squisq/squisq-player.js"></script>');
    expect(html).toContain('battle-of-britain_files/map.png');
  });

  it('imports a large CSV through the threshold-aware data sidecar container', async () => {
    const layout = resolveOutsideInLayout('catalogs/pg_catalog.csv')!;
    expect(layout).toMatchObject({
      format: 'csv',
      companionDirectory: 'catalogs/pg_catalog_files',
      markdownPath: 'catalogs/pg_catalog_files/pg-catalog.md',
    });
    const rows = ['id,title'];
    for (let i = 0; i < 101; i += 1) rows.push(`${i},Title ${i}`);
    const source = `${rows.join('\n')}\n`;

    const imported = await importOutsideInDocument(new TextEncoder().encode(source), layout);

    expect(imported.markdown).toContain('{[dataTable src=');
    expect(imported.markdown).not.toContain('| id | title |');
    const sidecar = await imported.container.readFile('pg-catalog_files/data/pg_catalog.csv');
    expect(new TextDecoder().decode(sidecar!)).toBe(source);
    expect(supportsOutsideInMarkdownEditing(layout.format)).toBe(false);
  });

  it('keeps a small CSV inline without creating a data sidecar', async () => {
    const layout = resolveOutsideInLayout('sales.csv')!;
    const imported = await importOutsideInDocument(
      new TextEncoder().encode('region,total\nNorth,120\nSouth,95\n'),
      layout,
    );

    expect(imported.markdown).toContain('| region | total |');
    expect(imported.markdown).not.toContain('{[dataTable src=');
    expect((await imported.container.listFiles()).map((entry) => entry.path)).toEqual(['sales.md']);
  });

  it('round-trips numbered CSV sidecar paths with spaces and underscores', async () => {
    const layout = resolveOutsideInLayout('pg_catalog 2.csv')!;
    const rows = ['id,title'];
    for (let i = 0; i < 101; i += 1) rows.push(`${i},Title ${i}`);

    const imported = await importOutsideInDocument(
      new TextEncoder().encode(`${rows.join('\n')}\n`),
      layout,
    );
    const document = parseMarkdown(imported.markdown);
    const heading = document.children.find((node) => node.type === 'heading');
    const paragraph = document.children.find((node) => node.type === 'paragraph');
    const link = paragraph?.children.find((node) => node.type === 'link');
    const physicalPath = 'pg-catalog-2_files/data/pg_catalog 2.csv';
    const referencePath = 'pg-catalog-2_files/data/pg_catalog%202.csv';

    // The editor bridge preserves CommonMark's angle brackets in href values.
    // URI-safe destinations keep the `.csv` suffix recognizable by Squisq's
    // data-card extension, while the container maps back to the real filename.
    expect(heading?.templateAnnotation?.params?.src).toBe(referencePath);
    expect(link?.url).toBe(referencePath);
    expect(document.frontmatter?.['squisq-output']).toBe('../pg_catalog 2.csv');
    expect(imported.markdown).toContain('squisq-output: ../pg_catalog 2.csv');
    expect(imported.markdown).not.toContain('squisq-output: ../pg\\_catalog 2.csv');
    expect(imported.markdown).not.toContain('](<');
    expect(markdownToTiptap(imported.markdown)).toContain(
      'href="pg-catalog-2_files/data/pg_catalog%202.csv"',
    );
    expect(await imported.container.exists(physicalPath)).toBe(true);

    const referenceContainer = createDataReferenceContainer(imported.container);
    expect(await referenceContainer.exists(referencePath)).toBe(true);
    expect(await referenceContainer.readFile(referencePath)).not.toBeNull();
    expect(
      (await referenceContainer.listFiles()).some((entry) => entry.path === referencePath),
    ).toBe(true);
  });

  it('repairs an existing angle-bracket CSV fallback link when reopened', () => {
    const layout = resolveOutsideInLayout('pg_catalog 2.csv')!;
    const source = `---
squisq-outside-in: 1
squisq-output: ../pg_catalog 2.csv
squisq-output-format: csv
---

# pg_catalog 2 {[dataTable src="pg-catalog-2_files/data/pg_catalog 2.csv"]}

[pg_catalog 2.csv](<pg-catalog-2_files/data/pg_catalog 2.csv>)
`;

    const repaired = withOutsideInMetadata(source, layout);

    expect(repaired).toContain('pg-catalog-2_files/data/pg_catalog%202.csv');
    expect(repaired).not.toContain('](<');
    expect(markdownToTiptap(repaired)).toContain(
      'href="pg-catalog-2_files/data/pg_catalog%202.csv"',
    );
  });

  it('threads the XLSX source name into a threshold-spilled workbook sidecar', async () => {
    const rows = [
      '## Transactions {[dataTable sheet=Data anchor=A1]}',
      '',
      '| id | amount |',
      '| -- | ------ |',
    ];
    for (let i = 0; i < 101; i += 1) rows.push(`| T${i} | ${i * 3} |`);
    const workbook = await markdownDocToXlsx(parseMarkdown(`${rows.join('\n')}\n`));
    const layout = resolveOutsideInLayout('reports/Q3 Report.xlsx')!;

    const imported = await importOutsideInDocument(workbook, layout);

    expect(imported.markdown).toContain('{[dataTable src=');
    expect(imported.markdown).toContain('q3-report_files/data/Q3%20Report.xlsx');
    expect(
      (await imported.container.readFile('q3-report_files/data/Q3 Report.xlsx'))?.byteLength,
    ).toBe(workbook.byteLength);
    expect(supportsOutsideInMarkdownEditing(layout.format)).toBe(true);
  });
});
