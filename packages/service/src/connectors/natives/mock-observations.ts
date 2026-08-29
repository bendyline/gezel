/**
 * A synthetic observation source, registered only under test.
 *
 * This is the `MockProvider` of the observation subsystem: it makes the whole
 * path — bind → sync → NDJSON → seal → compact → query — exercisable with no
 * network, no credential, and no real upstream, and it is what the eval
 * scenario drives. Every real observation adapter that follows re-treads this
 * exact path, so a bug here surfaces once rather than once per source.
 *
 * It also carries the failure modes worth rehearsing, because they are the
 * ones the sync engine's guarantees are written against: a page that reports
 * a rate limit, a page that throws mid-fetch, and a page whose declared row
 * count does not match its payload. Each has a defined consequence — back
 * off, keep the cursor unadvanced, refuse the page — and a mock that can only
 * succeed proves none of them.
 */

import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ConnectorRecord,
  RecordRef,
} from '../types.js';
import { registerNativeAdapter } from '../registry.js';
import { synthRequests } from '../../observations/testing/synth.js';

export const MOCK_OBSERVATIONS_ADAPTER_ID = 'mock-observations';

export interface MockObservationsConfig {
  /** Rows per page. One `RecordRef` is one page, never one row. */
  pageRows?: number;
  /** Pages the source will ever yield, across all passes. */
  totalPages?: number;
  /** Days the generated rows span, which is how many partitions appear. */
  days?: number;
  /** Table slug to write into. */
  table?: string;
  seed?: number;
  /** Page index (0-based) that reports a rate limit instead of data. */
  rateLimitAtPage?: number;
  /** Page index that throws on fetch, to exercise cursor discipline. */
  throwAtPage?: number;
  /** Page index that lies about its row count, to exercise the writer's guard. */
  miscountAtPage?: number;
}

interface MockCursor {
  nextPage: number;
}

function asCursor(raw: unknown): MockCursor {
  const page = (raw as MockCursor | undefined)?.nextPage;
  return { nextPage: typeof page === 'number' && page >= 0 ? page : 0 };
}

class MockObservationsAdapter implements ConnectorAdapter<ConnectorRecord, MockCursor> {
  readonly typeId = MOCK_OBSERVATIONS_ADAPTER_ID;
  private readonly cfg: Required<
    Pick<MockObservationsConfig, 'pageRows' | 'totalPages' | 'days' | 'table' | 'seed'>
  > &
    MockObservationsConfig;

  constructor(binding: ConnectorBindingRef) {
    const cfg = (binding.config ?? {}) as MockObservationsConfig;
    this.cfg = {
      pageRows: cfg.pageRows ?? 100,
      totalPages: cfg.totalPages ?? 3,
      days: cfg.days ?? 3,
      table: cfg.table ?? 'requests',
      seed: cfg.seed ?? 1,
      ...cfg,
    };
  }

  async ensureAuth(): Promise<void> {
    /* no credential: that is the point of a mock source */
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(
    _scope: string,
    cursor: MockCursor | undefined,
    opts?: { limit?: number },
  ): Promise<ChangeBatch<MockCursor>> {
    const { nextPage } = asCursor(cursor);
    if (nextPage >= this.cfg.totalPages) {
      return { records: [], cursor: { nextPage } };
    }
    if (this.cfg.rateLimitAtPage === nextPage) {
      // Cursor unchanged: what the source refused to send must be re-requested.
      return { records: [], cursor: { nextPage }, rateLimited: true };
    }

    const limit = Math.max(1, opts?.limit ?? 500);
    const pages: RecordRef[] = [];
    for (let page = nextPage; page < this.cfg.totalPages && pages.length < limit; page++) {
      pages.push({
        id: `page-${page}`,
        // Ascending with time so the engine's newest-first sort agrees with
        // forward paging rather than fighting it.
        ordinalKey: page,
      });
    }
    const advanced = nextPage + pages.length;
    return {
      records: pages,
      cursor: { nextPage: advanced },
      partial: advanced < this.cfg.totalPages,
    };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<ConnectorRecord> {
    const page = Number(ref.id.replace('page-', ''));
    if (this.cfg.throwAtPage === page) {
      throw new Error(`mock-observations: simulated fetch failure on page ${page}`);
    }
    const rows = synthRequests({
      rows: this.cfg.pageRows,
      // Per-page seed so pages differ but the corpus as a whole is reproducible.
      seed: this.cfg.seed + page,
      days: this.cfg.days,
    });
    return {
      kind: 'observations',
      batches: [
        {
          table: this.cfg.table,
          rows,
          ...(this.cfg.miscountAtPage === page ? { expectedRows: rows.length + 1 } : {}),
        },
      ],
    };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

/**
 * Register the mock source. Called from tests and from the mock-provider boot
 * path — never from an ordinary service start, so it cannot appear in a real
 * user's connector list.
 */
export function registerMockObservationsAdapter(): void {
  registerNativeAdapter(
    MOCK_OBSERVATIONS_ADAPTER_ID,
    async (binding: ConnectorBindingRef, _deps: AdapterDeps) => new MockObservationsAdapter(binding),
  );
}
