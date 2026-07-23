import { describe, expect, it } from 'vitest';
import { applyNormalize } from './normalize.js';
import type { NormalizedRecord } from './types.js';

describe('applyNormalize', () => {
  it('mapping: resolves field paths into a canonical record', async () => {
    const raw = {
      id: 'ISS-1',
      title: 'Fix the thing',
      project: 'Platform',
      updatedAt: '2026-07-01T10:00:00Z',
      description: 'the body',
      state: 'open',
      assignee: { name: 'Ada' },
    };
    const rec = await applyNormalize(
      {
        kind: 'mapping',
        map: {
          id: '$.id',
          title: '$.title',
          group: '$.project',
          timestamp: '$.updatedAt',
          body: '$.description',
          frontmatter: { state: '$.state', assignee: '$.assignee.name' },
        },
      },
      raw,
      { namespace: 'linear-issues' },
    );
    expect(rec.recordId).toBe('ISS-1');
    expect(rec.dirSegments).toEqual(['platform']); // slugged group
    expect(rec.fileStem).toBe('fix-the-thing');
    expect(rec.bodyMarkdown).toBe('the body');
    expect(rec.frontmatter.direction).toBe('inbound');
    expect(rec.frontmatter.title).toBe('Fix the thing');
    expect(rec.frontmatter.date).toBe('2026-07-01T10:00:00Z');
    expect(rec.frontmatter.state).toBe('open');
    expect(rec.frontmatter.assignee).toBe('Ada');
    expect(rec.scanOrigin).toBe('linear-issues');
    expect(rec.quarantineNamespace).toBe('linear-issues');
  });

  it('mapping: missing id falls back to a content hash; missing body serializes raw', async () => {
    const rec = await applyNormalize(
      { kind: 'mapping', map: { title: '$.name' } },
      { name: 'x', other: 1 },
      { namespace: 'ns' },
    );
    expect(rec.recordId).toMatch(/^[0-9a-f]{8}$/);
    expect(rec.bodyMarkdown).toContain('"other": 1'); // serialized raw
  });

  it('native: passes the record through unchanged', async () => {
    const record: NormalizedRecord = {
      recordId: 'r1',
      dirSegments: ['a'],
      fileStem: 'f',
      frontmatter: { direction: 'inbound' },
      bodyMarkdown: 'b',
      scanOrigin: 'mail',
      quarantineNamespace: 'mail',
      quarantineLabel: 'x',
    };
    const out = await applyNormalize({ kind: 'native' }, record, { namespace: 'mail' });
    expect(out).toBe(record);
  });

  it('script: runs the normalize script and builds a record from its fields', async () => {
    const rec = await applyNormalize(
      { kind: 'script', script: 'normalize' },
      { anything: true },
      {
        namespace: 'custom',
        runScript: async () => ({ id: 'S1', title: 'Scripted', body: 'from script' }),
      },
    );
    expect(rec.recordId).toBe('S1');
    expect(rec.fileStem).toBe('scripted');
    expect(rec.bodyMarkdown).toBe('from script');
  });

  it('script: throws without a runner in the context', async () => {
    await expect(
      applyNormalize({ kind: 'script', script: 'x' }, {}, { namespace: 'ns' }),
    ).rejects.toThrow(/script runner/);
  });
});
