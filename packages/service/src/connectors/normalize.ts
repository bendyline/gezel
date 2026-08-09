/**
 * The normalization spectrum — one dispatcher, three kinds. Called from inside a
 * generic driver's `fetchRecord` (so "normalization lives in the adapter" stays
 * true) to turn a raw source record into the canonical `NormalizedRecord` the
 * shared writer consumes:
 *
 *   - `mapping`  — declarative field paths → record (tidy JSON tool/API output)
 *   - `script`   — a sandboxed SDK script maps raw → record fields (messy sources)
 *   - `native`   — pass-through; the native adapter already built the record
 *
 * The writer stays normalize-agnostic; this is the shared dispatch, not per-type
 * code. `native` never reaches here (native adapters return the record directly).
 */

import type { NormalizedRecord } from './types.js';
import { sha8, slug } from './writer.js';

export type NormalizeSpec =
  | { kind: 'native' }
  | { kind: 'mapping'; map: Record<string, unknown> }
  | { kind: 'script'; script: string };

export interface NormalizeCtx {
  /** Connector type id → the record's `scanOrigin` + quarantine namespace. */
  namespace: string;
  /** Runs a normalize script (raw → record fields); injected by the adapter. */
  runScript?: (scriptName: string, raw: unknown) => Promise<Record<string, unknown>>;
}

/** The intermediate the mapping/script kinds resolve to before a record is built. */
interface RecordFields {
  id?: unknown;
  title?: unknown;
  group?: unknown;
  date?: unknown;
  body?: unknown;
  frontmatter?: Record<string, unknown>;
}

/**
 * Newest-first ordering key for a record ref: epoch millis of its timestamp.
 * Without one, the engine's sort preserves source order — fine for sources
 * that order results themselves, silently wrong under the backfill cap
 * otherwise.
 */
export function ordinalKeyFromTs(ts: unknown): { ordinalKey: number } | Record<string, never> {
  if (typeof ts !== 'string') return {};
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? { ordinalKey: ms } : {};
}

/** Tiny JSONPath-lite: `$.a.b.c` (dot paths from the root). */
export function jget(raw: unknown, path: unknown): unknown {
  if (typeof path !== 'string' || !path.startsWith('$')) return undefined;
  const parts = path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let cur: unknown = raw;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export async function applyNormalize(
  spec: NormalizeSpec,
  raw: unknown,
  ctx: NormalizeCtx,
): Promise<NormalizedRecord> {
  if (spec.kind === 'native') return raw as NormalizedRecord;
  if (spec.kind === 'script') {
    if (!ctx.runScript) throw new Error('script normalize requires a script runner in the context');
    return buildRecord((await ctx.runScript(spec.script, raw)) as RecordFields, ctx.namespace);
  }
  // mapping: resolve declared paths against the raw record.
  const map = spec.map as {
    id?: string;
    title?: string;
    group?: string;
    timestamp?: string;
    body?: string;
    frontmatter?: Record<string, string>;
  };
  const frontmatter: Record<string, unknown> = {};
  for (const [k, path] of Object.entries(map.frontmatter ?? {})) {
    const v = jget(raw, path);
    if (v != null) frontmatter[k] = v;
  }
  return buildRecord(
    {
      id: map.id ? jget(raw, map.id) : undefined,
      title: map.title ? jget(raw, map.title) : undefined,
      group: map.group ? jget(raw, map.group) : undefined,
      date: map.timestamp ? jget(raw, map.timestamp) : undefined,
      body: map.body ? jget(raw, map.body) : raw,
      frontmatter,
    },
    ctx.namespace,
  );
}

function buildRecord(fields: RecordFields, namespace: string): NormalizedRecord {
  const id = fields.id != null ? String(fields.id) : sha8(JSON.stringify(fields));
  const title = fields.title != null ? String(fields.title) : id;
  // `group` is optional adapter partitioning below the engine-owned scope
  // level; ungrouped records land at the scope root (no filler directory).
  const group = fields.group != null ? slug(String(fields.group)) : undefined;
  const frontmatter: Record<string, string> = { direction: 'inbound' };
  if (fields.title != null) frontmatter.title = title;
  if (fields.date != null) frontmatter.date = String(fields.date);
  for (const [k, v] of Object.entries(fields.frontmatter ?? {})) {
    if (v != null) frontmatter[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  const body =
    typeof fields.body === 'string'
      ? fields.body
      : fields.body != null
        ? JSON.stringify(fields.body, null, 2)
        : '';
  return {
    recordId: id,
    dirSegments: group ? [group] : [],
    fileStem: slug(title || id),
    frontmatter,
    bodyMarkdown: body,
    scanOrigin: namespace,
    quarantineNamespace: namespace,
    quarantineLabel: title || id,
  };
}
