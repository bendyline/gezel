/**
 * A model source for engine tests: scopes holding records that are added,
 * edited, deleted and moved between folders, with a change log the adapter
 * reads incrementally, cursors that can expire, and injectable faults. The
 * adapter over it (`ModelAdapter`) behaves the way the contract in
 * connector-standards.md §2 allows, varied by a profile, so the real
 * `syncWithAdapter` and writer can be checked against what the source holds.
 */

import {
  type ChangeBatch,
  type ConnectorAdapter,
  type ListChangesOptions,
  type NormalizedRecord,
  RecordGoneError,
  type RecordRef,
} from '../../types.js';

export interface ModelProfile {
  name: string;
  /** Deletions reach the adapter as tombstones (`removed`). */
  tombstones: boolean;
  /** Records change folders (`recordsMayMove`). */
  moves: boolean;
  /** The adapter returns at most `limit` records with `partial` (else everything at once). */
  honoursLimit: boolean;
}

export interface ModelRecord {
  id: string;
  scope: string;
  dir: string;
  rev: number;
}

interface LogEntry {
  seq: number;
  scope: string;
  id: string;
  deleted: boolean;
}

interface ModelCursor {
  epoch: number;
  seq: number;
  /** Set while a full listing is being paged: how far it got, and from which snapshot. */
  listing?: { offset: number; snapshot: number };
}

export class SourceModel {
  readonly scopes: string[] = ['inbox', 'archive'];
  readonly records = new Map<string, ModelRecord>();
  private readonly log: LogEntry[] = [];
  private seq = 0;
  private nextId = 1;
  /** Bumped by `expireCursor`: cursors from an older epoch are refused. */
  epoch = 0;
  /** Faults the adapter serves before doing its real work. */
  readonly faults = {
    throttleNextList: 0,
    transient: new Map<string, number>(),
    permanent: new Set<string>(),
  };

  add(scope: string, dir: string): string {
    const id = `r${this.nextId++}`;
    this.records.set(id, { id, scope, dir, rev: 1 });
    this.append(scope, id, false);
    return id;
  }

  live(): ModelRecord[] {
    return [...this.records.values()];
  }

  edit(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    r.rev++;
    this.append(r.scope, id, false);
  }

  move(id: string, dir: string): void {
    const r = this.records.get(id);
    if (!r || r.dir === dir) return;
    r.dir = dir;
    r.rev++;
    this.append(r.scope, id, false);
  }

  delete(id: string): void {
    const r = this.records.get(id);
    if (!r) return;
    this.records.delete(id);
    this.append(r.scope, id, true);
  }

  private append(scope: string, id: string, deleted: boolean): void {
    this.log.push({ seq: ++this.seq, scope, id, deleted });
  }

  /** Incremental changes for one scope after `seq`, latest per record, in log order. */
  changesAfter(scope: string, seq: number): LogEntry[] {
    const latest = new Map<string, LogEntry>();
    for (const e of this.log) {
      if (e.scope === scope && e.seq > seq) {
        latest.delete(e.id);
        latest.set(e.id, e);
      }
    }
    return [...latest.values()];
  }

  get head(): number {
    return this.seq;
  }
}

export function modelRecord(r: ModelRecord): NormalizedRecord {
  return {
    recordId: r.id,
    dirSegments: r.dir ? [r.dir] : [],
    fileStem: r.id,
    frontmatter: { title: r.id, rev: String(r.rev), direction: 'inbound' },
    bodyMarkdown: `${r.id} revision ${r.rev}`,
    scanOrigin: 'model',
    quarantineNamespace: 'model',
    quarantineLabel: r.id,
  };
}

/** An adapter over a `SourceModel`, one instance per pass like a real one. */
export class ModelAdapter implements ConnectorAdapter<NormalizedRecord, ModelCursor> {
  readonly typeId = 'model';
  readonly recordsMayMove: boolean;

  constructor(
    private readonly model: SourceModel,
    private readonly profile: ModelProfile,
  ) {
    this.recordsMayMove = profile.moves;
  }

  async ensureAuth(): Promise<void> {}

  async listScopes(): Promise<string[]> {
    return [...this.model.scopes];
  }

  async listChangesSince(
    scope: string,
    cursor: ModelCursor | undefined,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<ModelCursor>> {
    const m = this.model;
    if (m.faults.throttleNextList > 0) {
      m.faults.throttleNextList--;
      return { records: [], cursor: cursor as ModelCursor, rateLimited: true };
    }
    const limit = this.profile.honoursLimit ? Math.max(1, opts?.limit ?? 1_000) : 1_000_000;
    const valid = cursor && cursor.epoch === m.epoch;

    if (!valid || cursor.listing) {
      // A full listing: the scope's live records, paged by id. Changes made
      // while it is paged are in the log after its snapshot.
      const snapshot = valid && cursor.listing ? cursor.listing.snapshot : m.head;
      const offset = valid && cursor.listing ? cursor.listing.offset : 0;
      const all = m
        .live()
        .filter((r) => r.scope === scope)
        .sort((a, b) => a.id.localeCompare(b.id));
      const page = all.slice(offset, offset + limit);
      const end = offset + page.length;
      const refs = page.map((r) => ({ id: r.id }));
      if (end < all.length) {
        return {
          records: refs,
          cursor: { epoch: m.epoch, seq: snapshot, listing: { offset: end, snapshot } },
          partial: true,
          fullListing: { first: offset === 0, last: false },
        };
      }
      return {
        records: refs,
        cursor: { epoch: m.epoch, seq: snapshot },
        ...(offset === 0 ? { enumeratedAll: true } : { fullListing: { first: false, last: true } }),
      };
    }

    const changes = m.changesAfter(scope, cursor.seq);
    const page = changes.slice(0, limit);
    const last = page.at(-1);
    const records: RecordRef[] = page.filter((e) => !e.deleted).map((e) => ({ id: e.id }));
    const removed = this.profile.tombstones ? page.filter((e) => e.deleted).map((e) => e.id) : [];
    return {
      records,
      cursor: { epoch: m.epoch, seq: last ? last.seq : cursor.seq },
      ...(removed.length ? { removed } : {}),
      ...(changes.length > page.length ? { partial: true } : {}),
    };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const m = this.model;
    if (m.faults.permanent.has(ref.id)) throw new Error(`model: ${ref.id} cannot be parsed`);
    const transient = m.faults.transient.get(ref.id) ?? 0;
    if (transient > 0) {
      m.faults.transient.set(ref.id, transient - 1);
      throw new Error('socket hang up');
    }
    const r = m.records.get(ref.id);
    if (!r) throw new RecordGoneError(`${ref.id} was deleted`);
    return modelRecord(r);
  }

  async close(): Promise<void> {}
}
