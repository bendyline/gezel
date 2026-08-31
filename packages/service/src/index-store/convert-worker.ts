/**
 * Out-of-process document → markdown conversion worker.
 *
 * Spawned by `sandbox-convert.ts` inside the gezel sandbox (separate process,
 * network denied, env scrubbed, fs scoped, memory-capped, timed out). It is the
 * ONLY place a squisq/pdf/OOXML parser touches untrusted attachment bytes, so a
 * parser exploit is contained here and cannot reach the main service process,
 * its secrets, or the network.
 *
 * Deliberately self-contained: it imports only squisq (marked external in
 * tsup, loaded from node_modules at runtime) + the xmldom DOMParser polyfill +
 * node builtins. With no local import graph it runs identically from `src`
 * (dev, via --experimental-strip-types) and `dist` (prod).
 *
 * Protocol — argv[2] = input filename (relative to cwd), argv[3] = extension,
 * argv[4] = mode (`markdown`, the default, or `tables`).
 *
 * `markdown` writes `output.md`: the document rendering, for reading and for
 * full-text search. `tables` writes `output.ndjson`: one JSON object per
 * detected table, carrying each cell's underlying VALUE rather than its
 * display text — because a percent-formatted `0.15` renders as `"15.0%"` and
 * a date renders as text, and nothing doing arithmetic can use either.
 *
 * Both modes print `OK` / `ERR <message>` and set a non-zero exit code on
 * failure.
 */

import { readFile, writeFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const inputName = process.argv[2];
  const ext = (process.argv[3] ?? '').toLowerCase();
  const mode = (process.argv[4] ?? 'markdown').toLowerCase();
  if (!inputName || !ext) {
    process.stdout.write('ERR missing arguments');
    process.exitCode = 2;
    return;
  }

  // squisq's OOXML importers use the browser DOMParser, absent in node.
  const g = globalThis as { DOMParser?: unknown };
  if (!g.DOMParser) {
    const mod = (await import('@xmldom/xmldom')) as unknown as { DOMParser: unknown };
    g.DOMParser = mod.DOMParser;
  }

  const fmt = (await import('@bendyline/squisq-formats')) as unknown as {
    docxToMarkdownDoc?: (data: ArrayBuffer) => Promise<unknown>;
    pdfToMarkdownDoc?: (data: ArrayBuffer) => Promise<unknown>;
    pptxToMarkdownDoc?: (data: ArrayBuffer) => Promise<unknown>;
    xlsxToMarkdownDoc?: (data: ArrayBuffer) => Promise<unknown>;
    xlsxToTables?: (data: ArrayBuffer) => Promise<unknown[]>;
  };

  if (mode === 'tables') {
    if (ext !== 'xlsx') {
      process.stdout.write('ERR table extraction supports xlsx only');
      process.exitCode = 3;
      return;
    }
    if (typeof fmt.xlsxToTables !== 'function') {
      // An older squisq than this build expects. Named explicitly so the
      // failure reads as a version mismatch rather than a broken spreadsheet.
      process.stdout.write('ERR the installed squisq-formats has no xlsxToTables export');
      process.exitCode = 4;
      return;
    }
    const bytes = await readFile(inputName);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const tables = await fmt.xlsxToTables(ab);
    // NDJSON rather than one JSON array: a workbook of any size streams a line
    // at a time on the reading side, and a truncated write costs the last
    // table rather than the whole file.
    const lines = tables.map((table) => JSON.stringify(table)).join('\n');
    await writeFile('output.ndjson', lines ? `${lines}\n` : '', 'utf8');
    process.stdout.write('OK');
    return;
  }
  const { stringifyMarkdown } = (await import('@bendyline/squisq/markdown')) as unknown as {
    stringifyMarkdown: (doc: unknown) => string;
  };

  const importer: Record<string, ((data: ArrayBuffer) => Promise<unknown>) | undefined> = {
    docx: fmt.docxToMarkdownDoc,
    pdf: fmt.pdfToMarkdownDoc,
    pptx: fmt.pptxToMarkdownDoc,
    xlsx: fmt.xlsxToMarkdownDoc,
  };
  const fn = importer[ext];
  if (typeof fn !== 'function') {
    process.stdout.write('ERR unsupported extension');
    process.exitCode = 3;
    return;
  }

  const bytes = await readFile(inputName);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const md = stringifyMarkdown(await fn(ab));
  await writeFile('output.md', md, 'utf8');
  process.stdout.write('OK');
}

main().catch((err) => {
  process.stdout.write(`ERR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
