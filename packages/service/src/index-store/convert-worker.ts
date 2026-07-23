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
 * Protocol — argv[2] = input filename (relative to cwd), argv[3] = extension.
 * Writes `output.md` into cwd on success; prints `OK` / `ERR <message>` and
 * sets a non-zero exit code on failure.
 */

import { readFile, writeFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const inputName = process.argv[2];
  const ext = (process.argv[3] ?? '').toLowerCase();
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
  };
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
