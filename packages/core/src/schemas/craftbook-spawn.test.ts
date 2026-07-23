import { describe, expect, it } from 'vitest';
import { parseCraftbookDoc } from '../craftbook-doc.js';
import { CraftbookSchema, CraftbookSpawnSchema, CraftbookStepSchema } from './craftbook.js';

describe('declarative fanout schema', () => {
  it('accepts spawnFanout on a step', () => {
    const step = CraftbookStepSchema.parse({
      id: 'draft',
      name: 'Draft',
      spawnFanout: true,
    });
    expect(step.spawnFanout).toBe(true);
  });

  it('omits spawnFanout when absent (optional)', () => {
    const step = CraftbookStepSchema.parse({ id: 'a', name: 'A' });
    expect(step.spawnFanout).toBeUndefined();
  });

  it('parses a CraftbookSpawn block (overFile + itemsPath + steps)', () => {
    const spawn = CraftbookSpawnSchema.parse({
      overFile: 'notes/billables.json',
      itemsPath: 'items',
      entryStepId: 'draft-invoice',
      steps: [
        {
          id: 'draft-invoice',
          name: 'Draft {{client}}',
          advanceWhen: { file: 'invoices/{{number}}.html', minBytes: 1 },
        },
      ],
    });
    expect(spawn.overFile).toBe('notes/billables.json');
    expect(spawn.itemsPath).toBe('items');
    expect(spawn.steps).toHaveLength(1);
  });

  it('requires at least one spawn step', () => {
    expect(() => CraftbookSpawnSchema.parse({ overFile: 'x.json', steps: [] })).toThrow();
  });

  it('threads spawn through the whole craftbook doc parse', () => {
    const parsed = parseCraftbookDoc(
      JSON.stringify({
        name: 'Fanout Book',
        entryStepId: 'scope',
        steps: [
          { id: 'scope', name: 'Scope', next: 'draft' },
          { id: 'draft', name: 'Draft', spawnFanout: true },
        ],
        spawn: {
          overFile: 'notes/items.json',
          steps: [{ id: 'child', name: 'Child {{k}}' }],
        },
        version: '1.0.0',
        releasedAt: '2026-06-05T00:00:00Z',
      }),
      'json',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    expect(parsed.doc.spawn?.overFile).toBe('notes/items.json');
    expect(parsed.doc.steps.find((s) => s.id === 'draft')?.spawnFanout).toBe(true);
  });

  it('carries spawn onto the runtime Craftbook shape', () => {
    const book = CraftbookSchema.parse({
      id: 'b',
      name: 'B',
      steps: [{ id: 's', name: 'S', spawnFanout: true }],
      entryStepId: 's',
      spawn: {
        overFile: 'notes/items.json',
        steps: [{ id: 'child', name: 'Child' }],
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(book.spawn?.steps[0]?.id).toBe('child');
  });
});
