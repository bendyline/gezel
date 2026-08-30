import { describe, expect, it } from 'vitest';
import {
  type ObservationSourceSpec,
  isObservationNormalize,
  newestTimestamp,
  observationPageRef,
  pageItems,
  toObservationBatches,
} from './observation-normalize.js';

describe('isObservationNormalize', () => {
  it.each([
    [{ kind: 'observations' }, true],
    [{ kind: 'observations', tables: [] }, true],
    [{ kind: 'mapping', map: {} }, false],
    [{ kind: 'native' }, false],
    [undefined, false],
  ])('reads %j as %s', (normalize, expected) => {
    expect(isObservationNormalize(normalize)).toBe(expected);
  });
});

describe('observationPageRef', () => {
  it('wraps a whole page as one ref, ascending with the page index', () => {
    // One ref per row would blow the engine's backfill cap and silently
    // window a large page away; per page, the cap bounds pages instead.
    const ref = observationPageRef([{ a: 1 }, { a: 2 }], 3);
    expect(ref).toMatchObject({ id: 'page-3', ordinalKey: 3 });
    expect(pageItems(ref.raw)).toHaveLength(2);
  });

  it('tolerates a source that returned a bare object instead of a list', () => {
    expect(pageItems({ a: 1 })).toEqual([{ a: 1 }]);
    expect(pageItems(null)).toEqual([]);
    expect(pageItems(undefined)).toEqual([]);
  });
});

describe('toObservationBatches', () => {
  const spec: ObservationSourceSpec = {
    table: 'requests',
    rowMap: { ts: '$.timeStamp', route: '$.uri', latency_ms: '$.timeTaken' },
  };

  it('maps each item onto the declared columns', () => {
    const batches = toObservationBatches(
      [
        { timeStamp: '2026-08-04T10:00:00Z', uri: '/a', timeTaken: 12, ignored: 'x' },
        { timeStamp: '2026-08-04T10:00:01Z', uri: '/b', timeTaken: 30 },
      ],
      spec,
      'fallback',
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.table).toBe('requests');
    expect(batches[0]?.rows).toEqual([
      { ts: '2026-08-04T10:00:00Z', route: '/a', latency_ms: 12 },
      { ts: '2026-08-04T10:00:01Z', route: '/b', latency_ms: 30 },
    ]);
  });

  it('writes an explicit null for a mapped path the source stopped sending', () => {
    // Distinguishable in the data from a column that was never mapped.
    const [batch] = toObservationBatches([{ uri: '/a' }], spec, 'fallback');
    expect(batch?.rows[0]).toEqual({ ts: null, route: '/a', latency_ms: null });
  });

  it('passes items through untouched when no mapping is declared', () => {
    // The right default for an API that already returns flat rows — the
    // writer projects them onto the manifest's columns anyway.
    const [batch] = toObservationBatches([{ a: 1, b: 'x' }], { table: 'raw' }, 'fallback');
    expect(batch?.rows).toEqual([{ a: 1, b: 'x' }]);
  });

  it('splits a multiplexed page into one batch per table', () => {
    // A query API answering "here are your metrics AND your errors" cannot be
    // split into separate refs before the fetch, so it is split here.
    const batches = toObservationBatches(
      [
        { kind: 'metric', v: 1 },
        { kind: 'error', v: 2 },
        { kind: 'metric', v: 3 },
      ],
      { tablePath: '$.kind', rowMap: { v: '$.v' } },
      'fallback',
    );
    expect(batches.map((b) => b.table).sort()).toEqual(['error', 'metric']);
    expect(batches.find((b) => b.table === 'metric')?.rows).toEqual([{ v: 1 }, { v: 3 }]);
  });

  it('falls back to the type id when neither table nor tablePath resolves', () => {
    const [batch] = toObservationBatches([{ a: 1 }], {}, 'my-type');
    expect(batch?.table).toBe('my-type');
  });

  it('carries a fixed partition when the manifest declares one', () => {
    const [batch] = toObservationBatches([{ a: 1 }], { table: 't', partition: '2026-08-04' }, 'x');
    expect(batch?.partition).toBe('2026-08-04');
  });

  it('is an empty list for an empty page rather than a batch of no rows', () => {
    expect(toObservationBatches([], spec, 'fallback')).toEqual([]);
  });
});

describe('newestTimestamp', () => {
  it('derives a window cursor for a source with none of its own', () => {
    expect(
      newestTimestamp(
        [
          { t: '2026-08-01T00:00:00Z' },
          { t: '2026-08-04T00:00:00Z' },
          { t: '2026-08-02T00:00:00Z' },
        ],
        '$.t',
      ),
    ).toBe('2026-08-04T00:00:00Z');
  });

  it('is undefined when no path is declared or nothing matches', () => {
    expect(newestTimestamp([{ t: 'x' }], undefined)).toBeUndefined();
    expect(newestTimestamp([{ other: 1 }], '$.t')).toBeUndefined();
  });
});
