/**
 * `spectral` driver — runs an Apache-2.0 Prismatic component's read action
 * off-platform (hosted via the connectors-spectral sandbox) and normalizes the
 * raw `{ data }` with OUR normalize spectrum. The connection is populated from
 * the binding's SecretStore credential; the component sees only that.
 *
 * Manifest `source`: { component, action, connectionKey, connectionInput,
 *   inputs?: {<key>: "$config.<x>" | literal}, itemsPath, cursor?: {argInput?, fromPath?} }
 */

import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { type NormalizeSpec, applyNormalize, jget, ordinalKeyFromTs } from '../normalize.js';
import { connectorSecretKey } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { runSpectralAction } from './spectral-host.js';

interface SpectralSource {
  component: string;
  action: string;
  connectionKey: string;
  connectionInput: string;
  inputs?: Record<string, string>;
  itemsPath: string;
  /** Path to a record timestamp — drives newest-first ordering under the cap. */
  tsPath?: string;
  cursor?: { argInput?: string; fromPath?: string };
}

/**
 * SecretStore blob → spectral `Connection` (mirrors connectors-spectral/connection).
 * The blob is either a JSON object (OAuth credential `{accessToken,…}`, or a
 * pre-shaped `{apiKey,…}`) or — for an apikey/PAT bound through the UI — a BARE
 * secret string. A bare string is wrapped into `fields.<apiKeyField>` (the field
 * the component's `client.ts` reads, e.g. Airtable's `fields.apiKey`).
 */
function buildConnection(blob: string, key: string, apiKeyField: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    parsed = blob;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    const accessToken = p.accessToken ?? p.access_token;
    return accessToken !== undefined
      ? { key, token: { access_token: String(accessToken) }, fields: p }
      : { key, fields: p };
  }
  return { key, fields: { [apiKeyField]: String(parsed) } };
}

function resolveInputs(
  inputs: Record<string, string> | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs ?? {})) {
    out[k] =
      typeof v === 'string' && v.startsWith('$config.') ? config[v.slice('$config.'.length)] : v;
  }
  return out;
}

export class SpectralConnectorAdapter implements ConnectorAdapter {
  readonly typeId: string;
  private readonly src: SpectralSource;
  private conn: unknown = null;

  constructor(
    private readonly type: ConnectorTypeManifest,
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
  ) {
    this.typeId = type.id;
    this.src = type.source as unknown as SpectralSource;
  }

  async ensureAuth(): Promise<void> {
    const blob = await this.deps.secrets.get(
      connectorSecretKey(this.binding.type, this.binding.id),
    );
    if (!blob) throw new Error(`no stored credential for spectral connector ${this.binding.id}`);
    const shape = (this.type.secretShape ?? {}) as { field?: string; fields?: string[] };
    const apiKeyField = shape.field ?? shape.fields?.[0] ?? 'apiKey';
    this.conn = buildConnection(blob, this.src.connectionKey, apiKeyField);
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(_scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    const inputs = {
      ...resolveInputs(this.src.inputs, this.binding.config ?? {}),
      ...(this.src.cursor?.argInput && cursor != null
        ? { [this.src.cursor.argInput]: cursor }
        : {}),
    };
    const { data } = await runSpectralAction({
      component: this.src.component,
      action: this.src.action,
      connectionInput: this.src.connectionInput,
      connection: this.conn,
      inputs,
    });
    const items = (jget({ data }, this.src.itemsPath) as unknown[]) ?? [];
    const records: RecordRef[] = items.map((r, i) => {
      const ts = this.src.tsPath ? jget(r, this.src.tsPath) : undefined;
      return {
        id: String((r as { id?: unknown })?.id ?? i),
        raw: r,
        ...(typeof ts === 'string' ? { ts } : {}),
        ...ordinalKeyFromTs(ts),
      };
    });
    const next = this.src.cursor?.fromPath ? jget({ data }, this.src.cursor.fromPath) : undefined;
    // A cursor-less source re-lists everything each pass (the Airtable model),
    // so the batch is the complete current state — mirror types may prune.
    return { records, cursor: next, ...(this.src.cursor ? {} : { enumeratedAll: true }) };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    return applyNormalize(this.type.normalize as NormalizeSpec, ref.raw, {
      namespace: this.type.id,
    });
  }

  async close(): Promise<void> {}
}
