import { describe, expect, it } from 'vitest';
import { craftbookFromDoc, docFromCraftbook, parseCraftbookDoc } from './craftbook-doc.js';
import { CraftbookDocSchema } from './schemas/craftbook-doc.js';
import type { Craftbook } from './schemas/craftbook.js';

/**
 * `docFromCraftbook` promises its output is "guaranteed by construction to
 * be accepted back by `craftbookFromDoc` unchanged". That promise is what
 * makes `craftbook_read` -> edit -> `craftbook_write` a safe loop for a
 * model, and it was false: the two mappers were hand-written field lists
 * that drifted from `CraftbookDocSchema`, silently dropping `spawn`,
 * `commands`, `diffpackCapable` and `capabilityFloor`.
 *
 * The consequence was worse than a rejected write. `craftbook_write`
 * accepted a document declaring a spawn block, returned 201, and persisted
 * a craftbook with no spawn — so a model that read `invoice-run`, changed
 * one prompt, and wrote it back destroyed its fanout and was told it had
 * succeeded.
 *
 * These tests pin the invariant structurally, so a field added to the doc
 * schema fails here until both mappers carry it.
 */

const NOW = '2026-01-01T00:00:00.000Z';

/** Every optional field the doc schema declares, populated. */
const FULL_BOOK: Craftbook = {
  id: 'full-book',
  name: 'Full Book',
  description: 'Exercises every doc-schema field.',
  version: '1.2.3',
  basedOn: { name: 'Upstream', url: 'https://example.invalid/upstream' },
  plan: 'Do the thing.',
  defaultAssignee: { kind: 'gezel', gezelId: 'riley' },
  entryStepId: 'host',
  triggers: ['do the thing'],
  command: 'full-book',
  requirements: [{ kind: 'github' }],
  recommends: [{ kind: 'external-services' }],
  runModes: { scheduled: 'supported', nightShift: 'recommended' },
  toolsets: [{ toolsetId: 'builtin.workspace-fs-read' }],
  commands: [{ scope: 'script', name: 'test' }],
  connectors: [{ typeId: 'github' }],
  paramSchema: { type: 'object', properties: { region: { type: 'string' } } },
  hooks: [{ phase: 'PreToolUse', matcher: 'write_file', script: { name: 'guard' } }],
  scripts: { guard: 'export {};\n' },
  diffpackCapable: true,
  capabilityFloor: 'medium',
  spawn: {
    overFile: 'data/items.json',
    entryStepId: 'child',
    steps: [
      {
        id: 'child',
        name: 'Handle one item',
        prompt: 'Write out/{{slug}}.md',
        terminal: true,
      },
    ],
  },
  steps: [
    { id: 'host', name: 'Fan out', prompt: 'Read the item list.', spawnFanout: true, next: 'done' },
    { id: 'done', name: 'Done', prompt: 'Wrap up.', terminal: true },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

describe('craftbook doc round-trip', () => {
  it('carries every optional doc-schema field back into the runtime craftbook', () => {
    const doc = docFromCraftbook(FULL_BOOK);
    const result = craftbookFromDoc(doc, { id: FULL_BOOK.id, now: NOW, createdAt: NOW });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;

    // The regression that motivated this file: a fanout host must survive
    // read -> write. `spawn` is checked by value, not merely presence.
    expect(result.craftbook.spawn).toEqual(FULL_BOOK.spawn);
    expect(result.craftbook.commands).toEqual(FULL_BOOK.commands);
    expect(result.craftbook.diffpackCapable).toBe(true);
    expect(result.craftbook.capabilityFloor).toBe('medium');
  });

  it('is field-complete against the doc schema, so a new field cannot be forgotten', () => {
    const doc = docFromCraftbook(FULL_BOOK);
    // `releasedAt` and `minGezelVersion` are catalog-publication metadata
    // with no counterpart on the runtime Craftbook, so a runtime book can
    // never source them. Everything else must be emitted.
    const publicationOnly = new Set(['releasedAt', 'minGezelVersion']);
    const declared = Object.keys(CraftbookDocSchema.shape).filter(
      (key) => !publicationOnly.has(key),
    );
    const missing = declared.filter((key) => !(key in doc));
    expect(
      missing,
      `docFromCraftbook drops doc-schema field(s): ${missing.join(', ')} — add them to BOTH mappers`,
    ).toEqual([]);
  });

  it('preserves the whole book across a full read/write/read cycle', () => {
    const once = docFromCraftbook(FULL_BOOK);
    const rebuilt = craftbookFromDoc(once, { id: FULL_BOOK.id, now: NOW, createdAt: NOW });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(docFromCraftbook(rebuilt.craftbook)).toEqual(once);
  });
});

describe('markdown codec round-trip', () => {
  it('carries the whole book through serialize -> parse, fanout included', async () => {
    const { serializeCraftbookDoc, parseCraftbookDoc } = await import('./craftbook-doc.js');
    const doc = docFromCraftbook(FULL_BOOK);
    const markdown = serializeCraftbookDoc(doc, 'markdown');
    const parsed = parseCraftbookDoc(markdown, 'markdown');
    expect(
      parsed.ok,
      parsed.ok ? '' : parsed.errors.map((e) => `${e.where}: ${e.message}`).join(' | '),
    ).toBe(true);
    if (!parsed.ok) return;

    // The markdown arm reported `unknown key "spawn"` and REFUSED the save,
    // so a correctly-authored fanout book failed as malformed. That is worse
    // than the JSON arm's silent drop: it tells the author they were wrong.
    expect(parsed.doc.spawn).toEqual(FULL_BOOK.spawn);
    expect(parsed.doc.commands).toEqual(FULL_BOOK.commands);
    expect(parsed.doc.diffpackCapable).toBe(true);
    expect(parsed.doc.capabilityFloor).toBe('medium');
    expect(parsed.doc.steps.find((s) => s.id === 'host')?.spawnFanout).toBe(true);
  });

  it('rebuilds the same runtime craftbook from the markdown arm as from JSON', async () => {
    const { serializeCraftbookDoc, parseCraftbookDoc } = await import('./craftbook-doc.js');
    const doc = docFromCraftbook(FULL_BOOK);
    const parsed = parseCraftbookDoc(serializeCraftbookDoc(doc, 'markdown'), 'markdown');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const viaMarkdown = craftbookFromDoc(parsed.doc, {
      id: FULL_BOOK.id,
      now: NOW,
      createdAt: NOW,
    });
    const viaJson = craftbookFromDoc(doc, { id: FULL_BOOK.id, now: NOW, createdAt: NOW });
    expect(viaMarkdown.ok && viaJson.ok).toBe(true);
    if (!viaMarkdown.ok || !viaJson.ok) return;
    // One known, benign divergence: a markdown script fence ends at the
    // closing delimiter, so an inline script loses its trailing newline.
    // The source is otherwise byte-identical and semantically unchanged, and
    // the normalization converges after one round rather than compounding.
    // Everything else must match exactly.
    const stripScripts = (book: typeof viaJson.craftbook) => ({
      ...book,
      scripts: Object.fromEntries(
        Object.entries(book.scripts ?? {}).map(([name, src]) => [name, src.trimEnd()]),
      ),
    });
    expect(stripScripts(viaMarkdown.craftbook)).toEqual(stripScripts(viaJson.craftbook));
    expect(viaMarkdown.craftbook.scripts?.guard?.trimEnd()).toBe(
      viaJson.craftbook.scripts?.guard?.trimEnd(),
    );
  });
});

describe('fanout coherence is enforced at write time', () => {
  const base = {
    name: 'Store Health Sweep',
    entryStepId: 'sweep',
    steps: [
      { id: 'sweep', name: 'Sweep', prompt: 'Read the store list.', next: 'wrap' },
      { id: 'wrap', name: 'Wrap', prompt: 'Done.', terminal: true },
    ],
  };
  const spawn = {
    overFile: 'data/stores.json',
    entryStepId: 'one',
    steps: [{ id: 'one', name: 'One', prompt: 'Write out/{{slug}}.md', terminal: true }],
  };
  const build = (doc: unknown) => {
    const parsed = parseCraftbookDoc(JSON.stringify(doc), 'json');
    if (!parsed.ok) return { ok: false as const, errors: parsed.errors };
    return craftbookFromDoc(parsed.doc, { id: 'store-health-sweep', now: NOW });
  };

  // The exact shape claude-sonnet-4-6 wrote on the inaugural frontier run:
  // the trigger marked, the block omitted. It SAVED, reported "2 of 2 steps
  // are gated", and then silently spawned nothing.
  it('rejects a spawnFanout step with no spawn block', () => {
    const result = build({
      ...base,
      steps: [{ ...base.steps[0], spawnFanout: true }, base.steps[1]],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.map((e) => `${e.where}: ${e.message} ${e.fix ?? ''}`).join(' | ');
    expect(text).toMatch(/spawnFanout/);
    expect(text, 'the error must say what to add, not just what is wrong').toMatch(/overFile/);
  });

  it('rejects a spawn block that no step triggers', () => {
    const result = build({ ...base, spawn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/spawnFanout/);
  });

  it('accepts both halves together', () => {
    const result = build({
      ...base,
      spawn,
      steps: [{ ...base.steps[0], spawnFanout: true }, base.steps[1]],
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    expect(result.craftbook.spawn?.overFile).toBe('data/stores.json');
  });

  it('accepts a book with neither', () => {
    expect(build(base).ok).toBe(true);
  });

  // Persisted task snapshots embed their craftbook and are parsed forever.
  // A book authored before this check must stay READABLE, merely inert.
  it('still parses an incoherent book that is already on disk', async () => {
    const { CraftbookSchema } = await import('./schemas/craftbook.js');
    const legacy = {
      id: 'legacy',
      name: 'Legacy',
      entryStepId: 'sweep',
      steps: [
        { id: 'sweep', name: 'Sweep', prompt: 'Read.', spawnFanout: true, next: 'wrap' },
        { id: 'wrap', name: 'Wrap', prompt: 'Done.', terminal: true },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(CraftbookSchema.safeParse(legacy).success).toBe(true);
  });
});
