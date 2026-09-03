import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptDraftPathWriteDeniedError } from './project-artifacts-store.js';
import { Store } from './store.js';

/**
 * `artifacts/prompts/` is readable by gezels and writable only by the person
 * whose words they are. The guard is therefore conditional, not absolute: the
 * composer's own uploads travel the same artifact routes, and an
 * unconditional denial would block the user from their own draft.
 */

let home: string;
let store: Store;
const PROJECT = 'default';
const DRAFT = 'prompts/2026-09-03-0001';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-draft-guard-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const gezel = { initiatedByGezel: true };

describe('gezel writes under prompts/', () => {
  it('refuses a text write', async () => {
    await expect(
      store.writeProjectArtifact(PROJECT, `${DRAFT}/message.md`, 'rewritten', gezel),
    ).rejects.toBeInstanceOf(PromptDraftPathWriteDeniedError);
  });

  it('refuses a binary write', async () => {
    await expect(
      store.writeProjectArtifactBinary(
        PROJECT,
        `${DRAFT}/message_files/a.png`,
        Buffer.from('x'),
        gezel,
      ),
    ).rejects.toBeInstanceOf(PromptDraftPathWriteDeniedError);
  });

  it('refuses a delete', async () => {
    await expect(store.deleteProjectArtifact(PROJECT, DRAFT, gezel)).rejects.toBeInstanceOf(
      PromptDraftPathWriteDeniedError,
    );
  });

  it('refuses a mkdir', async () => {
    await expect(
      store.createProjectArtifactFolder(PROJECT, `${DRAFT}/message_files`, gezel),
    ).rejects.toBeInstanceOf(PromptDraftPathWriteDeniedError);
  });

  it('refuses a rename in either direction', async () => {
    await expect(
      store.renameProjectArtifactPath(PROJECT, `${DRAFT}/message.md`, 'notes/stolen.md', gezel),
    ).rejects.toBeInstanceOf(PromptDraftPathWriteDeniedError);
    await expect(
      store.renameProjectArtifactPath(PROJECT, 'notes/a.md', `${DRAFT}/message.md`, gezel),
    ).rejects.toBeInstanceOf(PromptDraftPathWriteDeniedError);
  });

  it('carries a code the route can turn into a 403', async () => {
    const err = await store
      .writeProjectArtifact(PROJECT, `${DRAFT}/message.md`, 'x', gezel)
      .catch((e) => e);
    expect(err.code).toBe('prompt-drafts-readonly');
  });

  it('leaves the rest of the drawer alone', async () => {
    await expect(
      store.writeProjectArtifact(PROJECT, 'reports/prompts-review.md', 'fine', gezel),
    ).resolves.toBeUndefined();
  });
});

describe('the user writing their own draft', () => {
  it('may write text, bytes, folders, and may delete', async () => {
    await store.writeProjectArtifact(PROJECT, `${DRAFT}/message.md`, 'my prompt');
    await store.writeProjectArtifactBinary(
      PROJECT,
      `${DRAFT}/message_files/a.png`,
      Buffer.from('bytes'),
    );
    await store.createProjectArtifactFolder(PROJECT, `${DRAFT}/message_files/nested`);
    const read = await store.readProjectArtifact(PROJECT, `${DRAFT}/message.md`);
    expect(read).toBe('my prompt');
    await expect(store.deleteProjectArtifact(PROJECT, DRAFT)).resolves.toBeUndefined();
  });
});

describe('reading', () => {
  it('stays open to gezels — a draft is readable, just not writable', async () => {
    await store.writeProjectArtifact(PROJECT, `${DRAFT}/message.md`, 'the ask');
    const read = await store.readProjectArtifact(PROJECT, `${DRAFT}/message.md`);
    expect(read).toBe('the ask');
    const listed = await store.listProjectArtifacts(PROJECT);
    expect(listed.some((f) => f.name === 'prompts')).toBe(true);
  });
});
