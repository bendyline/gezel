import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from './manager.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from './testing/harness.js';
import type { ChangeBatch, ConnectorAdapter, NormalizedRecord, RecordRef } from './types.js';

/**
 * A full listing that names the dates it covers proves absence only inside
 * them, so a `window` type (no mirror pruning) still loses what was deleted
 * while its sync position was expired, and keeps history that aged out.
 */

interface Item {
  id: string;
  date: string;
}

class RangeAdapter implements ConnectorAdapter<NormalizedRecord, unknown> {
  readonly typeId = 'range-fake';
  /** What the next pass lists: `undefined` lists `items` incrementally. */
  listing?: { items: Item[]; within: { start: string; end: string }; perBatch: number };
  items: Item[] = [];
  async ensureAuth(): Promise<void> {}
  async listScopes(): Promise<string[]> {
    return ['events'];
  }
  async listChangesSince(_scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    const ref = (i: Item): RecordRef => ({ id: i.id, raw: i });
    if (!this.listing) return { records: this.items.map(ref), cursor: { n: 1 } };
    const offset =
      typeof (cursor as { offset?: unknown })?.offset === 'number'
        ? (cursor as { offset: number }).offset
        : 0;
    const page = this.listing.items.slice(offset, offset + this.listing.perBatch);
    const next = offset + page.length;
    const last = next >= this.listing.items.length;
    return {
      records: page.map(ref),
      cursor: last ? { n: 2 } : { offset: next },
      ...(last ? {} : { partial: true }),
      fullListing: { first: offset === 0, last, within: this.listing.within },
    };
  }
  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const item = ref.raw as Item;
    return {
      recordId: item.id,
      dirSegments: [],
      fileStem: item.id,
      frontmatter: { title: item.id, date: item.date },
      bodyMarkdown: item.id,
      scanOrigin: 'calendar',
      quarantineNamespace: 'range-fake',
      quarantineLabel: item.id,
    };
  }
  async close(): Promise<void> {}
}

let env: ConnectorTestEnv | null = null;
afterEach(async () => {
  await env?.dispose();
  env = null;
});

describe('a full listing bounded by dates', () => {
  it('removes what is gone inside the range and keeps what is dated outside it', async () => {
    env = await createConnectorTestEnv();
    const adapter = new RangeAdapter();
    adapter.items = [
      { id: 'aged-out', date: '2026-06-01T09:00:00Z' },
      { id: 'kept', date: '2026-09-02T09:00:00Z' },
      { id: 'deleted-meanwhile', date: '2026-09-03T09:00:00Z' },
      { id: 'all-day-kept', date: '2026-09-04' },
    ];
    const opts = {
      storageDir: env.artifactsDir,
      quarantineDir: env.quarantineDir,
      corpusDir: 'data/cal',
      backfillLimit: 10,
    };
    const first = await syncWithAdapter(adapter, { ...opts, cursor: undefined });
    expect(first.written).toBe(4);

    // The sync position expired; the re-list covers September only, over two batches.
    adapter.listing = {
      items: [
        { id: 'kept', date: '2026-09-02T09:00:00Z' },
        { id: 'all-day-kept', date: '2026-09-04' },
        { id: 'new', date: '2026-09-05T09:00:00Z' },
      ],
      within: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
      perBatch: 2,
    };
    const second = await syncWithAdapter(adapter, { ...opts, cursor: first.cursor });
    expect(second.error).toBeUndefined();
    expect(second.pruned).toBe(1);
    const titles = (await readCorpus(env.artifactsDir, 'data/cal')).map((r) => r.frontmatter.title);
    expect(titles.sort()).toEqual(['aged-out', 'all-day-kept', 'kept', 'new']);
  });
});

class ScopesAdapter implements ConnectorAdapter<NormalizedRecord, unknown> {
  readonly typeId = 'scopes-fake';
  constructor(public scopes: string[]) {}
  async ensureAuth(): Promise<void> {}
  async listScopes(): Promise<string[]> {
    return this.scopes;
  }
  async listChangesSince(scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    if (cursor) return { records: [], cursor };
    return { records: [{ id: `${scope}-1`, raw: scope }], cursor: { done: scope } };
  }
  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    return {
      recordId: ref.id,
      dirSegments: [],
      fileStem: ref.id,
      frontmatter: { title: ref.id },
      bodyMarkdown: ref.id,
      scanOrigin: 'calendar',
      quarantineNamespace: 'scopes-fake',
      quarantineLabel: ref.id,
    };
  }
  async close(): Promise<void> {}
}

describe('scopes a settings change removed', () => {
  async function run(allowPrune: boolean) {
    env = await createConnectorTestEnv();
    const adapter = new ScopesAdapter(['north', 'south']);
    const opts = {
      storageDir: env.artifactsDir,
      quarantineDir: env.quarantineDir,
      corpusDir: 'data/s',
      backfillLimit: 10,
      allowPrune,
    };
    const first = await syncWithAdapter(adapter, { ...opts, cursor: undefined });
    adapter.scopes = ['north'];
    // A short listing without a settings change touches nothing.
    const quiet = await syncWithAdapter(adapter, { ...opts, cursor: first.cursor });
    expect(Object.keys((quiet.cursor as { scopes: object }).scopes).sort()).toEqual([
      'north',
      'south',
    ]);
    const marked = { ...(quiet.cursor as object), reconcileScopes: true };
    const after = await syncWithAdapter(adapter, { ...opts, cursor: marked });
    expect(after.error).toBeUndefined();
    expect(Object.keys((after.cursor as { scopes: object }).scopes)).toEqual(['north']);
    expect((after.cursor as { reconcileScopes?: unknown }).reconcileScopes).toBeUndefined();
    return (await readCorpus(env.artifactsDir, 'data/s')).map((r) => r.frontmatter.title).sort();
  }

  it('a mirror loses the dropped scope and its records', async () => {
    expect(await run(true)).toEqual(['north-1']);
  });

  it('a window type keeps the records, which could not be fetched again', async () => {
    expect(await run(false)).toEqual(['north-1', 'south-1']);
  });
});
