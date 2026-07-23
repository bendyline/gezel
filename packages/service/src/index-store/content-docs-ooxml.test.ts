/**
 * End-to-end check that the squisq PPTX importer flows through gezel's document
 * pipeline. The runtime probe keeps this compatible with an older linked
 * squisq checkout while the registry dependency provides the importer normally.
 */

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
  dir = await mkdtemp(join(tmpdir(), 'gezel-pptx-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-pptx-home-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function pptxImportAvailable(): Promise<boolean> {
  try {
    const fmt = (await import('@bendyline/squisq-formats')) as unknown as {
      pptxToMarkdownDoc?: (d: ArrayBuffer) => Promise<unknown>;
    };
    const importer = fmt.pptxToMarkdownDoc;
    if (typeof importer !== 'function') return false;
    // Probe a tiny invalid buffer; the published stub throws "not implemented",
    // the real importer throws a zip/parse error. Distinguish by message.
    await importer(new ArrayBuffer(0));
    return true;
  } catch (err) {
    return !/not yet implemented/i.test(err instanceof Error ? err.message : String(err));
  }
}

async function makePptx(md: string): Promise<Uint8Array> {
  const { parseMarkdown } = (await import('@bendyline/squisq/markdown')) as unknown as {
    parseMarkdown: (s: string) => unknown;
  };
  const fmt = (await import('@bendyline/squisq-formats')) as unknown as {
    markdownDocToPptx: (doc: unknown) => Promise<ArrayBuffer>;
  };
  return new Uint8Array(await fmt.markdownDocToPptx(parseMarkdown(md)));
}

// Like DOCX conversion, this exercises a denyNet parser child and therefore
// runs only where macOS Seatbelt provides the required OS network boundary.
describe.runIf(process.platform === 'darwin')('doc-intel: pptx conversion', () => {
  it('converts a .pptx deck and makes it searchable', async () => {
    if (!(await pptxImportAvailable())) {
      // An older linked squisq checkout may not include the importer yet.
      return;
    }
    await mkdir(join(dir, 'decks'), { recursive: true });
    const pptx = await makePptx(
      '# Roadmap\n\n## Strategy\n\n- prioritize frobnication\n- ship widgets\n',
    );
    await writeFile(join(dir, 'decks', 'plan.pptx'), pptx);

    const stats = await runWorkspaceContentIndex(dir, 'c');
    expect(stats).not.toBeNull();
    expect(stats!.docsConverted).toBe(1);

    const ci = new ContentIndex({ projectWorkspaceDir: async () => dir } as unknown as Store, home);
    const search = await ci.searchDocs('c', 'frobnication');
    expect(search.results.some((r) => r.sourcePath === 'decks/plan.pptx')).toBe(true);

    const read = await ci.readDocAsMarkdown('c', 'decks/plan.pptx');
    expect(read.found).toBe(true);
    expect(read.markdown).toContain('frobnication');
  });
});
