import { describe, expect, it } from 'vitest';
import { asScopedCursor, syncWithAdapter } from './manager.js';
import type { ChangeBatch, ConnectorAdapter, NormalizedRecord, RecordRef } from './types.js';
import type { WriteRecordResult } from './writer.js';

/** Per-scope cursor envelope literal, for expectations. */
function scoped(scopes: Record<string, unknown>) {
  return { v: 2, scopes };
}

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
  const dirs: string[] = [];
  const write = async (input: {
    corpusDir: string;
    record: NormalizedRecord;
  }): Promise<WriteRecordResult> => {
    seen.push(input.record.recordId);
    dirs.push(input.corpusDir);
    return { status: statusFor(input.record.recordId) };
  };
  return { write, seen, dirs };
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
    expect(r.cursor).toEqual(scoped({ '': 'C1' })); // clean batch → cursor advances
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
    const r = await syncWithAdapter(adapter, {
      ...base,
      cursor: scoped({ '': 'PRIOR' }),
      write,
    });
    expect(r.errors).toBe(1);
    expect(r.written).toBe(0);
    expect(r.cursor).toEqual(scoped({ '': 'PRIOR' })); // NOT advanced to 'NEXT'
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
    expect(r.cursor).toEqual(scoped({ '': 'C' }));
  });

  it('keeps the whole envelope unadvanced on a hard failure and still closes', async () => {
    const adapter = new FakeAdapter({
      ensureAuth: async () => {
        throw new Error('auth failed');
      },
    });
    const { write } = fakeWriter();
    const r = await syncWithAdapter(adapter, {
      ...base,
      cursor: scoped({ '': 'KEEP' }),
      write,
    });
    expect(r.error).toBe('auth failed');
    expect(r.errors).toBe(1);
    expect(r.cursor).toEqual(scoped({ '': 'KEEP' })); // unadvanced
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
    expect(r.cursor).toEqual(scoped({ '': 'C' })); // no errors → still advances
  });

  it('isolates cursors per scope: a scope only sees the cursor it last returned', async () => {
    const seenCursors: Record<string, unknown[]> = { a: [], b: [] };
    const adapter = new FakeAdapter({
      scopes: ['a', 'b'],
      changes: (scope, cursor) => {
        seenCursors[scope]!.push(cursor);
        return { records: [{ id: `${scope}-1` }], cursor: `cur-${scope}` };
      },
    });
    const { write } = fakeWriter();
    const first = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(first.cursor).toEqual(scoped({ a: 'cur-a', b: 'cur-b' }));

    const again = new FakeAdapter({
      scopes: ['a', 'b'],
      changes: (scope, cursor) => {
        seenCursors[scope]!.push(cursor);
        return { records: [], cursor };
      },
    });
    await syncWithAdapter(again, { ...base, cursor: first.cursor, write });
    expect(seenCursors.a).toEqual([undefined, 'cur-a']);
    expect(seenCursors.b).toEqual([undefined, 'cur-b']);
  });

  it('advances a clean scope even when a later scope fails', async () => {
    const adapter = new FakeAdapter({
      scopes: ['ok', 'bad'],
      changes: (scope) => ({ records: [{ id: `${scope}-1` }], cursor: `cur-${scope}` }),
      fetch: async (scope, ref) => {
        if (scope === 'bad') throw new Error('boom');
        return record(ref.id);
      },
    });
    const { write } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(r.written).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.cursor).toEqual(scoped({ ok: 'cur-ok' })); // 'bad' left unadvanced
  });

  it('continues a scope across partial batches within one pass, bounded', async () => {
    let page = 0;
    const adapter = new FakeAdapter({
      changes: () => {
        page++;
        return {
          records: [{ id: `p${page}` }],
          cursor: `cur-${page}`,
          partial: true, // always claims more — the round cap must stop it
        };
      },
    });
    const { write, seen } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4']); // MAX_PARTIAL_ROUNDS
    expect(r.cursor).toEqual(scoped({ '': 'cur-4' })); // pages already synced stay synced
  });

  it('discards a non-envelope persisted cursor instead of misreading it', async () => {
    const cursors: unknown[] = [];
    const adapter = new FakeAdapter({
      changes: (_scope, cursor) => {
        cursors.push(cursor);
        return { records: [], cursor: 'fresh' };
      },
    });
    const { write } = fakeWriter();
    await syncWithAdapter(adapter, { ...base, cursor: 'legacy-flat', write });
    expect(cursors).toEqual([undefined]);
  });

  it('legacy mode (scopedCursors: false) threads a flat cursor unchanged', async () => {
    const adapter = new FakeAdapter({
      changes: (_scope, cursor) => ({
        records: [],
        cursor: cursor === 'FLAT' ? 'FLAT2' : 'FLAT',
      }),
    });
    const { write } = fakeWriter();
    const r = await syncWithAdapter(adapter, {
      ...base,
      scopedCursors: false,
      cursor: 'FLAT',
      write,
    });
    expect(r.cursor).toBe('FLAT2');
  });

  it('a rate-limited batch stops the pass: its records land, later scopes wait', async () => {
    const listed: string[] = [];
    const adapter = new FakeAdapter({
      scopes: ['a', 'b'],
      changes: (scope) => {
        listed.push(scope);
        return { records: [{ id: `${scope}-1` }], cursor: `cur-${scope}`, rateLimited: true };
      },
    });
    const { write, seen } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(listed).toEqual(['a']); // scope b never listed
    expect(seen).toEqual(['a-1']); // what the source returned was written
    expect(r.rateLimited).toBe(true);
    expect(r.cursor).toEqual(scoped({ a: 'cur-a' })); // persisted, no loss
    expect(adapter.closed).toBe(true);
  });

  it('retries a transient fetch failure without counting an error', async () => {
    let attempts = 0;
    const adapter = new FakeAdapter({
      changes: () => ({ records: [{ id: 'r1' }], cursor: 'C' }),
      fetch: async (_scope, ref) => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('socket hang up');
          throw err;
        }
        return record(ref.id);
      },
    });
    const { write } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(attempts).toBe(3);
    expect(r.written).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.cursor).toEqual(scoped({ '': 'C' }));
  }, 30_000);

  it('prunes a scope only after a clean single-batch full enumeration', async () => {
    const makeAdapter = (batch: Partial<ChangeBatch<unknown>>) =>
      new FakeAdapter({
        changes: () => ({
          records: [{ id: 'kept' }],
          cursor: 'C',
          ...batch,
        }),
      });
    const pruneCalls: { corpusDir: string; keepHashes: Set<string> }[] = [];
    const prune = async (input: { corpusDir: string; keepHashes: Set<string> }) => {
      pruneCalls.push(input);
      return { pruned: 2 };
    };

    // Not enumeratedAll → no prune.
    const { write } = fakeWriter();
    await syncWithAdapter(makeAdapter({}), {
      ...base,
      allowPrune: true,
      cursor: undefined,
      write,
      prune,
    });
    expect(pruneCalls).toHaveLength(0);

    // enumeratedAll but allowPrune off (window type / legacy mail) → no prune.
    await syncWithAdapter(makeAdapter({ enumeratedAll: true }), {
      ...base,
      cursor: undefined,
      write,
      prune,
    });
    expect(pruneCalls).toHaveLength(0);

    // The full gate → prune with the pass's record hashes.
    const r = await syncWithAdapter(makeAdapter({ enumeratedAll: true }), {
      ...base,
      allowPrune: true,
      cursor: undefined,
      write,
      prune,
    });
    expect(pruneCalls).toHaveLength(1);
    expect(pruneCalls[0]!.corpusDir).toBe('c');
    expect(r.pruned).toBe(2);
  });

  it('asScopedCursor round-trips an envelope and rejects everything else', () => {
    expect(asScopedCursor({ v: 2, scopes: { a: 1 } })).toEqual(scoped({ a: 1 }));
    expect(asScopedCursor('flat')).toEqual(scoped({}));
    expect(asScopedCursor({ imap: {} })).toEqual(scoped({}));
    expect(asScopedCursor(null)).toEqual(scoped({}));
  });

  it('joins the slugged scope into the corpus path; the empty scope adds no level', async () => {
    const adapter = new FakeAdapter({
      scopes: ['INBOX/Sub', ''],
      changes: (scope) => ({ records: [{ id: `r-${scope}` }], cursor: undefined }),
    });
    const { write, dirs } = fakeWriter();
    const r = await syncWithAdapter(adapter, { ...base, cursor: undefined, write });
    expect(dirs).toEqual(['c/inbox-sub', 'c']);
    expect(r.scopes).toEqual(['INBOX/Sub', '']);
  });

  it('scopeAsDir: false keeps the legacy adapter-owned layout', async () => {
    const adapter = new FakeAdapter({
      scopes: ['INBOX'],
      changes: () => ({ records: [{ id: 'r1' }], cursor: undefined }),
    });
    const { write, dirs } = fakeWriter();
    await syncWithAdapter(adapter, { ...base, scopeAsDir: false, cursor: undefined, write });
    expect(dirs).toEqual(['c']);
  });
});
