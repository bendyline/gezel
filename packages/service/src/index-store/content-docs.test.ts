import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-docs-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-docs-home-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** Build a real .docx via squisq's exporter so we exercise the import path. */
async function makeDocx(md: string): Promise<Uint8Array> {
  const { parseMarkdown } = (await import('@bendyline/squisq/markdown')) as unknown as {
    parseMarkdown: (s: string) => unknown;
  };
  const fmt = (await import('@bendyline/squisq-formats')) as unknown as {
    markdownDocToDocx: (doc: unknown) => Promise<ArrayBuffer>;
  };
  const ab = await fmt.markdownDocToDocx(parseMarkdown(md));
  return new Uint8Array(ab);
}

// Successful document conversion requires a denyNet child, which currently
// has an enforceable OS boundary only through macOS Seatbelt. Windows/Linux
// fail closed before starting the parser; that policy is covered by the
// sandbox-network tests.
describe.runIf(process.platform === 'darwin')('doc-intel: docx conversion + search + read', () => {
  it('converts a .docx, indexes it, and answers search_docs / read_doc_as_markdown', async () => {
    await mkdir(join(dir, 'docs'), { recursive: true });
    const docx = await makeDocx(
      '# Spec\n\nThe widget does **frobnication**.\n\n## Details\n\nMore on frobnication here.\n',
    );
    await writeFile(join(dir, 'docs', 'spec.docx'), docx);

    const stats = await runWorkspaceContentIndex(dir, 'c');
    expect(stats).not.toBeNull();
    expect(stats!.docsConverted).toBe(1);

    const ci = new ContentIndex({ projectWorkspaceDir: async () => dir } as unknown as Store, home);

    const search = await ci.searchDocs('c', 'frobnication');
    expect(search.engine).toBe('fts');
    expect(search.results.length).toBeGreaterThanOrEqual(1);
    expect(search.results[0]?.sourcePath).toBe('docs/spec.docx');
    expect(search.results[0]?.markdownPath).toContain('spec.docx_files');

    const read = await ci.readDocAsMarkdown('c', 'docs/spec.docx');
    expect(read.found).toBe(true);
    expect(read.markdown).toContain('frobnication');
    expect(read.markdownPath).toContain('.gezel/files/docs/spec.docx_files/spec.md');
  });

  it('read_doc_as_markdown converts on demand when not yet indexed', async () => {
    const docx = await makeDocx('# OnDemand\n\nlazy conversion works.\n');
    await writeFile(join(dir, 'note.docx'), docx);
    const ci = new ContentIndex({ projectWorkspaceDir: async () => dir } as unknown as Store, home);
    const read = await ci.readDocAsMarkdown('c', 'note.docx');
    expect(read.found).toBe(true);
    expect(read.markdown).toContain('lazy conversion works');
  });
});
