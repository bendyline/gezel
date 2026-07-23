import { describe, expect, it } from 'vitest';
import { syncWithAdapter } from './manager.js';
import type { ChangeBatch, ConnectorAdapter, NormalizedRecord, RecordRef } from './types.js';
import type { WriteRecordResult } from './writer.js';

function record(id: string): NormalizedRecord {
  return {
    recordId: id,
    dirSegments: [],
    fileStem: id,
    frontmatter: {},
    bodyMarkdown: '',
    scanOrigin: 'email',
    quarantineNamespace: 'fake',
    quarantineLabel: id,
  };
}

interface FakeOpts {
  scopes?: string[];
  changes?: (scope: string, cursor: unknown) => ChangeBatch<unknown>;
  ensureAuth?: () => Promise<void>;
  fetch?: (scope: string, ref: RecordRef) => Promise<NormalizedRecord>;
}

class FakeAdapter implements ConnectorAdapter {
  readonly typeId = 'fake';
  closed = false;
  fetched: string[] = [];
  constructor(private readonly opts: FakeOpts = {}) {}
  async ensureAuth(): Promise<void> {
    if (this.opts.ensureAuth) await this.opts.ensureAuth();
  }
  async listScopes(): Promise<string[]> {
    return this.opts.scopes ?? [''];
  }
  async listChangesSince(scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    return this.opts.changes ? this.opts.changes(scope, cursor) : { records: [], cursor };
  }
  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    this.fetched.push(ref.id);
    return this.opts.fetch ? this.opts.fetch(scope, ref) : record(ref.id);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A fake writer seam so the loop is testable without the filesystem. */
function fakeWriter(statusFor: (id: string) => WriteRecordResult['status'] = () => 'written') {
  const seen: string[] = [];
  const write = async (input: { record: NormalizedRecord }): Promise<WriteRecordResult> => {
    seen.push(input.record.recordId);
    return { status: statusFor(input.record.recordId) };
  };
  return { write, seen };
}

const base = { workspaceDir: '/ws', corpusDir: 'c', backfillLimit: 500 };

describe('syncWithAdapter', () => {
  it('fetches newest-first, bounded by backfillLimit; overflow is counted skipped', async () => {
    const adapter = new FakeAdapter({
      changes: () => ({
        records: [
          { id: 'a', ordinalKey: 1 },
          { id: 'b', ordinalKey: 2 },
          { id: 'c', ordinalKey: 3 },
        ],
        cursor: 'C1',
      }),
    });
    const { write, seen } = fakeWriter();
    const r = await syncWithAdapter(adapter, {
      ...base,
      backfillLimit: 2,
      cursor: undefined,
      write,
    });
    expect(seen).toEqual(['c', 'b']); // newest UID first
    expect(r.written).toBe(2);
    expect(r.skipped).toBe(1); // 'a' overflowed the cap
    expect(r.cursor).toBe('C1'); // clean batch → cursor advances
    expect(adapter.closed).toBe(true);
  });

  it('keeps the prior cursor when a fetch fails (idempotent retry)', async () => {
    const adapter = new FakeAdapter({
      changes: () => ({ records: [{ id: 'a', ordinalKey: 1 }], cursor: 'NEXT' }),
      fetch: async () => {
        throw new Error('boom');
      },
    });
    const { write } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: 'PRIOR', write });
    expect(r.errors).toBe(1);
    expect(r.written).toBe(0);
    expect(r.cursor).toBe('PRIOR'); // NOT advanced to 'NEXT'
    expect(adapter.closed).toBe(true);
  });

  it('counts quarantined vs written', async () => {
    const adapter = new FakeAdapter({
      changes: () => ({
        records: [
          { id: 'clean', ordinalKey: 2 },
          { id: 'evil', ordinalKey: 1 },
        ],
        cursor: 'C',
      }),
    });
    const { write } = fakeWriter((id) => (id === 'evil' ? 'quarantined' : 'written'));
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(r.written).toBe(1);
    expect(r.quarantined).toBe(1);
    expect(r.cursor).toBe('C');
  });

  it('advances each scope independently and closes on a hard failure', async () => {
    const adapter = new FakeAdapter({
      ensureAuth: async () => {
        throw new Error('auth failed');
      },
    });
    const { write } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: 'KEEP', write });
    expect(r.error).toBe('auth failed');
    expect(r.errors).toBe(1);
    expect(r.cursor).toBe('KEEP'); // unadvanced
    expect(adapter.closed).toBe(true); // close() still called
  });

  it('an existing record (writer says "exists") is counted skipped, not written', async () => {
    const adapter = new FakeAdapter({
      changes: () => ({ records: [{ id: 'dup', ordinalKey: 1 }], cursor: 'C' }),
    });
    const { write } = fakeWriter(() => 'exists');
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.cursor).toBe('C'); // no errors → still advances
  });
});
