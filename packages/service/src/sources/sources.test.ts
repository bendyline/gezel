/**
 * Phase 6 — source adapters. The .eml mail adapter mirrors a message to
 * markdown+frontmatter; indexing the mirror makes it searchable "for free" with
 * headers lifted into metadata.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from '../index-store/content-index.js';
import { runWorkspaceContentIndex } from '../index-store/content-indexer.js';
import { IndexStore } from '../index-store/index-store.js';
import { EmlMailAdapter } from './eml-adapter.js';
import { materializeSource } from './materialize.js';

const EML = [
  'From: Alice <alice@example.com>',
  'To: bob@example.com',
  'Subject: Quarterly frobnication report',
  'Date: Mon, 1 Jun 2026 10:00:00 +0000',
  'Message-ID: <q2-2026@example.com>',
  '',
  'Widget frobnication rose 20% this quarter. Great work team.',
  '',
].join('\n');

let src: string;
let mirror: string;
let home: string;

beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'gezel-src-'));
  mirror = await mkdtemp(join(tmpdir(), 'gezel-mirror-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-src-home-'));
});
afterEach(async () => {
  for (const d of [src, mirror, home]) await rm(d, { recursive: true, force: true });
});

describe('EmlMailAdapter', () => {
  it('parses headers into frontmatter and the body into markdown', async () => {
    await writeFile(join(src, 'msg1.eml'), EML);
    const adapter = new EmlMailAdapter();
    expect(adapter.matches('x.eml')).toBe(true);
    expect(adapter.matches('x.txt')).toBe(false);

    const doc = await adapter.convert(join(src, 'msg1.eml'));
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.from).toContain('alice@example.com');
    expect(doc!.frontmatter.subject).toContain('frobnication');
    expect(doc!.frontmatter.thread).toBe('<q2-2026@example.com>');
    expect(doc!.markdown).toContain('rose 20%');
  });

  it('mirror → index → search makes the email searchable with metadata', async () => {
    await writeFile(join(src, 'msg1.eml'), EML);
    const out = await materializeSource(new EmlMailAdapter(), join(src, 'msg1.eml'), mirror);
    expect(out).not.toBeNull();

    await runWorkspaceContentIndex(mirror, 'mail', join(home, 'artifacts'));

    const ci = new ContentIndex(
      {
        projectWorkspaceDir: async () => mirror,
        projectArtifactsDir: () => join(home, 'artifacts'),
      } as unknown as Store,
      home,
    );
    const search = await ci.searchDocs('mail', 'frobnication');
    expect(search.results.some((r) => r.sourcePath === 'msg1.md')).toBe(true);

    // Headers were lifted into the metadata table.
    const store = (await IndexStore.open(projectLocalIndexDbFile(mirror), {
      collectionId: 'mail',
      kind: 'mail',
      rootPath: mirror,
    }))!;
    const md = store.getMetadata('msg1.md');
    store.close();
    expect(md.from).toContain('alice@example.com');
    expect(md.subject).toContain('frobnication');
  });
});
