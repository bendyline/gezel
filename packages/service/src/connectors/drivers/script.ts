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
import { type NormalizeSpec, applyNormalize, jget, ordinalKeyFromTs } from '../normalize.js';
import { connectorCredentialName } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
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
}

export class ScriptConnectorAdapter implements ConnectorAdapter {
  readonly typeId: string;
  private readonly src: ScriptSource;
  private readonly runner: ScriptRunner;
  private readonly projectId: string;

  constructor(
    private readonly type: ConnectorTypeManifest,
    private readonly binding: ConnectorBindingRef,
    deps: AdapterDeps,
  ) {
    this.typeId = type.id;
    this.src = type.source as unknown as ScriptSource;
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
    const out = (run.output ?? {}) as { records?: unknown[]; cursor?: unknown };
    const idPath = this.src.idPath ?? '$.id';
    const records: RecordRef[] = (out.records ?? []).map((r, i) => {
      const ts = this.src.tsPath ? jget(r, this.src.tsPath) : undefined;
      return {
        id: String(jget(r, idPath) ?? i),
        raw: r,
        ...(typeof ts === 'string' ? { ts } : {}),
        ...ordinalKeyFromTs(ts),
      };
    });
    return { records, cursor: out.cursor };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
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
