import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewritePromptDraftFileRefs } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { extractImageAttachments, findImageRefs } from './image-attachments.js';

describe('findImageRefs', () => {
  it('finds a single attachments/ ref (project-scoped)', () => {
    expect(findImageRefs('here is ![alt](attachments/abc.png)')).toEqual([
      { scope: 'attachments', filename: 'abc.png' },
    ]);
  });

  it('finds a single images/ ref (legacy session-scoped)', () => {
    expect(findImageRefs('here is ![alt](images/abc.png)')).toEqual([
      { scope: 'images', filename: 'abc.png' },
    ]);
  });

  it('finds multiple refs in one message', () => {
    const md = 'one ![a](attachments/x.png) and ![b](images/y.jpg)';
    expect(findImageRefs(md)).toEqual([
      { scope: 'attachments', filename: 'x.png' },
      { scope: 'images', filename: 'y.jpg' },
    ]);
  });

  it('ignores absolute URLs', () => {
    expect(findImageRefs('![a](https://example.com/x.png)')).toEqual([]);
  });

  it('ignores relative paths outside the attachments/ or images/ prefix', () => {
    expect(findImageRefs('![a](assets/x.png)')).toEqual([]);
  });

  it('handles a blank alt', () => {
    expect(findImageRefs('![](attachments/x.png)')).toEqual([
      { scope: 'attachments', filename: 'x.png' },
    ]);
  });
});

describe('extractImageAttachments', () => {
  let tmp: string;
  let store: Store;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gezel-img-'));
    store = new Store({ home: tmp });
    await store.ensureLayout();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('resolves project-scoped attachments/ refs', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    const { relativePath } = await store.writeProjectAttachment('default', bytes, 'image/png');
    expect(relativePath).toMatch(/^attachments\/[\w-]+\.png$/);
    const md = `look: ![](${relativePath})`;
    const atts = await extractImageAttachments(store, 'default', 'any-session', md);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.mimeType).toBe('image/png');
    expect(Buffer.from(atts[0]!.base64, 'base64').toString()).toBe('fake-png-bytes');
  });

  it('still resolves legacy images/ refs from the same-session folder', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    const { relativePath } = await store.writeSessionImage('default', 'sess-1', bytes, 'image/png');
    expect(relativePath).toMatch(/^images\/[\w-]+\.png$/);
    const md = `look: ![](${relativePath})`;
    const atts = await extractImageAttachments(store, 'default', 'sess-1', md);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.mimeType).toBe('image/png');
  });

  it('resolves a composer photo stored in its prompt draft', async () => {
    const draftId = '2026-10-06-0007';
    const name = 'photo-2026-10-06-101500.jpg';
    await store.writeProjectArtifactBinary(
      'default',
      `prompts/${draftId}/message_files/${name}`,
      Buffer.from('fake-jpeg-bytes'),
    );
    const md = rewritePromptDraftFileRefs(
      `What is this?\n\n![Photo](message_files/${name})`,
      draftId,
    );
    expect(findImageRefs(md)).toEqual([
      { scope: 'artifacts', filename: `prompts/${draftId}/message_files/${name}` },
    ]);
    const atts = await extractImageAttachments(store, 'default', 'sess-1', md);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.mimeType).toBe('image/jpeg');
    expect(Buffer.from(atts[0]!.base64, 'base64').toString()).toBe('fake-jpeg-bytes');
  });

  it('silently drops refs that do not resolve', async () => {
    const md = 'bogus ![x](attachments/does-not-exist.png)';
    const atts = await extractImageAttachments(store, 'default', 'sess-1', md);
    expect(atts).toEqual([]);
  });

  it('dedupes the same filename referenced multiple times', async () => {
    const { relativePath } = await store.writeProjectAttachment(
      'default',
      Buffer.from('abc'),
      'image/png',
    );
    const md = `${relativePath} once and ![](${relativePath}) twice ![](${relativePath})`;
    const atts = await extractImageAttachments(store, 'default', 'sess-2', md);
    expect(atts).toHaveLength(1);
  });
});
