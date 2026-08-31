import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

describe('project accessory files', () => {
  let home: string;
  let store: Store;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-attachments-'));
    store = new Store({ home });
    await store.ensureLayout();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('preserves an unknown upload extension so Markdown is discoverable in the bin', async () => {
    const stored = await store.writeProjectAttachment(
      'default',
      Buffer.from('# Project notes'),
      'application/octet-stream',
      'project_notes.md',
    );

    expect(stored.relativePath).toMatch(/^attachments\/[\w-]+\.md$/);
    const read = await store.readProjectAttachment('default', stored.filename);
    expect(read?.mimeType).toBe('text/markdown');
    await expect(store.listProjectAttachments('default')).resolves.toEqual([
      expect.objectContaining({ filename: stored.filename, mimeType: 'text/markdown' }),
    ]);
  });

  it('uses a known MIME extension even when the provided filename disagrees', async () => {
    const stored = await store.writeProjectAttachment(
      'default',
      Buffer.from('%PDF'),
      'application/pdf',
      'misleading.svg',
    );

    expect(stored.filename).toMatch(/\.pdf$/);
  });
});
