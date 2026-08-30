import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Craftbook } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

/**
 * A stored craftbook must come back the way it went in.
 *
 * It did not. The local-template writer and the project-local writer were
 * hand-maintained copies of the same field list and had drifted: the local
 * pair dropped `triggers`, `toolsets`, `connectors`, `hooks`, `paramSchema`,
 * `command` and `requirements`, and neither pair carried `spawn`.
 *
 * That mattered because `craftbook_write(create: true)` — the tool the
 * authoring prompts steer every model to — routes to the LOCAL writer. A
 * model could author a parameterized or fanning-out recipe, get a 201, and
 * read back a book with the declaration gone. Both writers now share
 * `craftbookVersionManifest` / `craftbookFieldsFromVersionManifest`, and
 * these tests pin the behaviour on both paths.
 */

const FANOUT_BOOK: Craftbook = {
  id: 'store-roundtrip-book',
  name: 'Store Roundtrip Book',
  description: 'Declares every persisted field.',
  version: '1.0.0',
  entryStepId: 'host',
  triggers: ['sweep the stores'],
  command: 'store-sweep',
  toolsets: [{ toolsetId: 'builtin.workspace-fs-read' }],
  connectors: [{ typeId: 'github' }],
  requirements: [{ kind: 'github' }],
  recommends: [{ kind: 'external-services' }],
  runModes: { scheduled: 'supported', nightShift: 'recommended' },
  paramSchema: { type: 'object', properties: { region: { type: 'string' } } },
  hooks: [{ phase: 'PreToolUse', matcher: 'write_file', script: { name: 'guard' } }],
  scripts: { guard: 'export {};\n' },
  diffpackCapable: true,
  capabilityFloor: 'medium',
  spawn: {
    overFile: 'data/stores.json',
    entryStepId: 'child',
    steps: [{ id: 'child', name: 'One store', prompt: 'Write out/{{slug}}.md', terminal: true }],
  },
  steps: [
    { id: 'host', name: 'Fan out', prompt: 'Read the store list.', spawnFanout: true, next: 'end' },
    { id: 'end', name: 'End', prompt: 'Done.', terminal: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Fields whose loss is silent — the write succeeds and the recipe misbehaves later. */
const PERSISTED_FIELDS = [
  'triggers',
  'command',
  'toolsets',
  'connectors',
  'requirements',
  'recommends',
  'runModes',
  'paramSchema',
  'hooks',
  'spawn',
  'diffpackCapable',
  'capabilityFloor',
] as const;

describe('craftbook persistence round-trip', () => {
  let home: string;
  let store: Store;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-craftbook-store-'));
    store = new Store({ home });
    await store.ensureLayout();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('local templates keep every declared field — this is the path craftbook_write uses', async () => {
    await store.writeLocalCraftbookTemplate(FANOUT_BOOK);
    const read = await store.getLocalCraftbookTemplate(FANOUT_BOOK.id);
    expect(read).not.toBeNull();
    if (!read) return;

    const dropped = PERSISTED_FIELDS.filter((field) => read[field] === undefined);
    expect(
      dropped,
      `writeLocalCraftbookTemplate dropped: ${dropped.join(', ')} — add them to craftbookVersionManifest AND craftbookFieldsFromVersionManifest`,
    ).toEqual([]);

    // The fanout by value, not merely by presence: a spawn block that
    // survives as `{}` is the same outage with a passing presence check.
    expect(read.spawn).toEqual(FANOUT_BOOK.spawn);
    expect(read.paramSchema).toEqual(FANOUT_BOOK.paramSchema);
    // Inline gate-script SOURCE, not just the name. A craftbook-scope gate
    // ref resolves against the task snapshot's scripts map and falls back to
    // a project path that does not exist for a local template, so losing the
    // source here surfaces as a bare ENOENT on the gate — checked because a
    // frontier run hit exactly that shape and it had to be ruled out.
    expect(read.scripts).toEqual(FANOUT_BOOK.scripts);
  });

  it('project-local craftbooks keep the same field set', async () => {
    const project = await store.createProject({ name: 'Roundtrip Project' });
    await store.writeProjectCraftbook(project.id, FANOUT_BOOK);
    const read = await store.getProjectCraftbook(project.id, FANOUT_BOOK.id);
    expect(read).not.toBeNull();
    if (!read) return;

    const dropped = PERSISTED_FIELDS.filter((field) => read[field] === undefined);
    expect(dropped, `writeProjectCraftbook dropped: ${dropped.join(', ')}`).toEqual([]);
    expect(read.spawn).toEqual(FANOUT_BOOK.spawn);
  });

  it('the two storage paths agree, so where a book lands cannot change what it is', async () => {
    const project = await store.createProject({ name: 'Agreement Project' });
    await store.writeLocalCraftbookTemplate(FANOUT_BOOK);
    await store.writeProjectCraftbook(project.id, FANOUT_BOOK);
    const local = await store.getLocalCraftbookTemplate(FANOUT_BOOK.id);
    const scoped = await store.getProjectCraftbook(project.id, FANOUT_BOOK.id);
    expect(local).not.toBeNull();
    expect(scoped).not.toBeNull();
    for (const field of PERSISTED_FIELDS) {
      expect(local?.[field], `field "${field}" differs between the two storage paths`).toEqual(
        scoped?.[field],
      );
    }
  });
});
