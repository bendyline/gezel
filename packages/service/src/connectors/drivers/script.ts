/**
 * `script` driver — drives a sandboxed SDK script (or CLI-via-script) as an
 * ingest source. The fetch script runs in the sandbox (`denyNet`); its network
 * goes parent-side via `gezel.http.authed`, keyed to the binding's own secret
 * name `connector-<type>.<bindingId>` (granted at bind time), so the plaintext
 * credential never enters the child. Uses the `{kind:'connector'}` run trigger
 * (auto-exempt from the chat/step exec gate; still capability-stripped under
 * lockdown).
 *
 * Manifest `source`: { fetch?: <scriptName>, inlineFetch?: <ts source>, scope?,
 *   } — the script's output must be `{ records: unknown[]; cursor?: unknown }`.
 */

import type { ConnectorTypeManifest } from '@bendyline/gezel';
import type { ScriptRunner } from '../../scripts/runner.js';
import {
  type ObservationSourceSpec,
  isObservationNormalize,
  observationPageRef,
  toObservationBatches,
} from '../observation-normalize.js';
import { type NormalizeSpec, applyNormalize, jget, ordinalKeyFromTs } from '../normalize.js';
import { connectorCredentialName } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ConnectorRecord,
  NormalizedRecord,
  RecordRef,
} from '../types.js';

interface ScriptSource {
  fetch?: string;
  inlineFetch?: string;
  scope?: 'user' | 'project' | 'craftbook' | 'standard';
  /** Path to the id field inside each record (default `$.id`). */
  idPath?: string;
  /** Path to a record timestamp — drives newest-first ordering under the cap. */
  tsPath?: string;
  /** Tabular sources: table name, column mapping, partition. See
   *  observation-normalize.ts for why this lives in `source`. */
  table?: string;
  tablePath?: string;
  rowMap?: Record<string, string>;
  partition?: string;
}

export class ScriptConnectorAdapter
  implements ConnectorAdapter<NormalizedRecord | ConnectorRecord, unknown>
{
  readonly typeId: string;
  private readonly src: ScriptSource;
  private readonly runner: ScriptRunner;
  private readonly projectId: string;
  /** True when this type declares the tabular corpus shape. */
  private readonly observations: boolean;
  /** Page counter for sources whose cursor is not itself a page number. */
  private pageSeq = 0;

  constructor(
    private readonly type: ConnectorTypeManifest,
    private readonly binding: ConnectorBindingRef,
    deps: AdapterDeps,
  ) {
    this.typeId = type.id;
    this.src = type.source as unknown as ScriptSource;
    this.observations = isObservationNormalize(type.normalize);
    if (!deps.scriptRunner || !deps.projectId) {
      throw new Error("the 'script' driver requires a script runner + project id");
    }
    this.runner = deps.scriptRunner;
    this.projectId = deps.projectId;
  }

  async ensureAuth(): Promise<void> {
    // Nothing to connect: the fetch script resolves its credential parent-side.
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(_scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    // Connector credentials are keyed per binding, while ScriptRunner requires
    // capability declarations to be literal. Substitute the public credential
    // name before the static meta parser runs; the secret value stays outside
    // the sandbox in the credential registry.
    const inlineSource = this.src.inlineFetch?.replaceAll(
      '$credential',
      connectorCredentialName(this.binding.type, this.binding.id),
    );
    const run = await this.runner.run({
      projectId: this.projectId,
      scriptName: this.src.fetch ?? `connector-fetch-${this.type.id}`,
      ...(inlineSource ? { inlineSource } : {}),
      scope: this.src.scope ?? 'project',
      inputs: { cursor: cursor ?? null, config: this.binding.config ?? {} },
      trigger: { kind: 'connector', typeId: this.type.id, bindingId: this.binding.id },
    });
    if (run.status !== 'ok') throw new Error(run.error ?? 'connector fetch script failed');
    const out = (run.output ?? {}) as {
      records?: unknown[];
      cursor?: unknown;
      rateLimited?: unknown;
      partial?: unknown;
    };
    const items = out.records ?? [];
    if (this.observations) {
      // One ref per PAGE. The engine's backfill cap counts refs, so mapping a
      // 10,000-row page to 10,000 refs would silently window most of it away.
      const pageIndex = typeof out.cursor === 'number' ? out.cursor : (this.pageSeq += 1);
      return {
        records: items.length > 0 ? [observationPageRef(items, pageIndex)] : [],
        cursor: out.cursor,
        ...(out.rateLimited === true ? { rateLimited: true } : {}),
        ...(out.partial === true ? { partial: true } : {}),
      };
    }
    const idPath = this.src.idPath ?? '$.id';
    const records: RecordRef[] = items.map((r, i) => {
      const ts = this.src.tsPath ? jget(r, this.src.tsPath) : undefined;
      return {
        id: String(jget(r, idPath) ?? i),
        raw: r,
        ...(typeof ts === 'string' ? { ts } : {}),
        ...ordinalKeyFromTs(ts),
      };
    });
    // Pass the script's throttle/continuation signals through so the sync
    // engine's backoff ladder and partial-continuation rounds work for
    // script sources exactly as they do for natives. A script that sees a
    // 429 should return its last clean cursor + `rateLimited: true` instead
    // of throwing (a throw voids the whole batch and re-fetches from the
    // stale cursor next pass — the failure mode that burns rate-limited
    // APIs hardest).
    return {
      records,
      cursor: out.cursor,
      ...(out.rateLimited === true ? { rateLimited: true } : {}),
      ...(out.partial === true ? { partial: true } : {}),
    };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<ConnectorRecord | NormalizedRecord> {
    if (this.observations) {
      return {
        kind: 'observations',
        batches: toObservationBatches(ref.raw, this.src as ObservationSourceSpec, this.type.id),
      };
    }
    return applyNormalize(this.type.normalize as NormalizeSpec, ref.raw, {
      namespace: this.type.id,
      runScript: async (scriptName, raw) => {
        const run = await this.runner.run({
          projectId: this.projectId,
          scriptName,
          scope: 'project',
          inputs: { record: raw },
          trigger: { kind: 'connector', typeId: this.type.id, bindingId: this.binding.id },
        });
        if (run.status !== 'ok') throw new Error(run.error ?? 'normalize script failed');
        return (run.output ?? {}) as Record<string, unknown>;
      },
    });
  }

  async close(): Promise<void> {}
}
