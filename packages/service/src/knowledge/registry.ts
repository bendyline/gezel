/**
 * The per-user knowledge registry — `~/.gezel/knowledge/registry.json`, the
 * authoritative record of what THIS user installed and enabled
 * (docs/knowledge-catalogs.md). The manager never scans storage trees and
 * infers state from directory presence; the registry is the truth, and a
 * catalog whose bytes exist but whose entry is gone is just unreferenced
 * disk to prune. Owned by this module — a deliberate Store carve-out like
 * the other feature-owned subtrees (see CLAUDE.md).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KnowledgeCatalogRef, KnowledgeUserRegistry } from '@bendyline/gezel';
import { KnowledgeUserRegistrySchema, createLogger } from '@bendyline/gezel';
import { knowledgeRegistryFile } from '@bendyline/gezel/paths';

const log = createLogger('knowledge');

export type KnowledgeRegistryEntry = KnowledgeUserRegistry['catalogs'][number];

const EMPTY: KnowledgeUserRegistry = { version: 1, catalogs: [] };

export class KnowledgeRegistry {
  private readonly file: string;

  constructor(private readonly home: string) {
    this.file = knowledgeRegistryFile(home);
  }

  read(): KnowledgeUserRegistry {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return structuredClone(EMPTY);
    }
    try {
      return KnowledgeUserRegistrySchema.parse(JSON.parse(raw));
    } catch (err) {
      // A corrupt registry must not brick the daemon: keep the bytes for
      // inspection and start empty. Catalog directories are untouched, so
      // re-adding entries recovers everything.
      log.error(
        `knowledge registry unreadable (${err instanceof Error ? err.message : String(err)}); starting empty`,
      );
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* leave it in place */
      }
      return structuredClone(EMPTY);
    }
  }

  private write(registry: KnowledgeUserRegistry): void {
    const parsed = KnowledgeUserRegistrySchema.parse(registry);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  /** Find an entry by publisher+catalog identity (one entry per catalog id). */
  find(publisherId: string, catalogId: string): KnowledgeRegistryEntry | null {
    return (
      this.read().catalogs.find(
        (c) => c.ref.publisherId === publisherId && c.ref.catalogId === catalogId,
      ) ?? null
    );
  }

  /**
   * Add or replace the entry for this catalog identity. The same-catalogId/
   * different-publisher conflict is rejected here — the `knowledge://` URI
   * carries no publisher, so two publishers cannot share a catalog id.
   */
  upsert(ref: KnowledgeCatalogRef, opts: { enabled?: boolean; autoUpdate?: boolean } = {}): void {
    const registry = this.read();
    const conflict = registry.catalogs.find(
      (c) => c.ref.catalogId === ref.catalogId && c.ref.publisherId !== ref.publisherId,
    );
    if (conflict) {
      throw new Error(
        `catalog id '${ref.catalogId}' is already installed from publisher '${conflict.ref.publisherId}'; remove it before installing the one from '${ref.publisherId}'`,
      );
    }
    const existing = registry.catalogs.find(
      (c) => c.ref.publisherId === ref.publisherId && c.ref.catalogId === ref.catalogId,
    );
    if (existing) {
      existing.ref = ref;
      existing.enabled = opts.enabled ?? existing.enabled;
      if (opts.autoUpdate !== undefined) existing.autoUpdate = opts.autoUpdate;
      existing.disabledReason = undefined;
    } else {
      registry.catalogs.push({
        ref,
        enabled: opts.enabled ?? true,
        addedAt: new Date().toISOString(),
        ...(opts.autoUpdate !== undefined ? { autoUpdate: opts.autoUpdate } : {}),
      });
    }
    this.write(registry);
  }

  setEnabled(publisherId: string, catalogId: string, enabled: boolean): boolean {
    const registry = this.read();
    const entry = registry.catalogs.find(
      (c) => c.ref.publisherId === publisherId && c.ref.catalogId === catalogId,
    );
    if (!entry) return false;
    entry.enabled = enabled;
    if (enabled) entry.disabledReason = undefined;
    this.write(registry);
    return true;
  }

  /** Quarantine: disable with a reason the UI/CLI can show verbatim. */
  quarantine(publisherId: string, catalogId: string, reason: string): boolean {
    const registry = this.read();
    const entry = registry.catalogs.find(
      (c) => c.ref.publisherId === publisherId && c.ref.catalogId === catalogId,
    );
    if (!entry) return false;
    entry.enabled = false;
    entry.disabledReason = reason;
    this.write(registry);
    return true;
  }

  remove(publisherId: string, catalogId: string): KnowledgeRegistryEntry | null {
    const registry = this.read();
    const index = registry.catalogs.findIndex(
      (c) => c.ref.publisherId === publisherId && c.ref.catalogId === catalogId,
    );
    if (index === -1) return null;
    const [removed] = registry.catalogs.splice(index, 1);
    this.write(registry);
    return removed ?? null;
  }
}
