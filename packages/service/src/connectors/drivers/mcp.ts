/**
 * `mcp` driver — drives an MCP server as an ingest source over a BARE
 * `McpBridge` (the sync host, not the model, calls tools deterministically).
 * This is the ingest-bound posture: the server is bound to this adapter only and
 * never touches the model's tool surface, and its credential goes into the
 * bridge's own spec (`$secret` sentinels), never the model's context.
 *
 * Manifest `source`:
 *   { server: {command,args,envFromSecret} | {kind:'http',transport,url,headersFromSecret},
 *     list: {tool, args?, cursorArg?, cursorFrom?, itemsPath, idPath?, tsPath?},
 *     fetch?: {tool, idArg} }   // omit fetch ⇒ list items ARE the records
 */

import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { McpBridge, type McpServerSpec } from '../../providers/mcp-bridge.js';
import { type NormalizeSpec, applyNormalize, jget } from '../normalize.js';
import { connectorSecretKey } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedRecord,
  RecordRef,
} from '../types.js';

/** Full tool output for ingest (past the 80k model-safety cap). */
const INGEST_BUDGET = 5_000_000;

interface McpSource {
  server:
    | { command: string; args?: string[]; envFromSecret?: Record<string, string> }
    | {
        kind: 'http';
        transport?: 'streamable-http' | 'sse';
        url: string;
        headersFromSecret?: Record<string, string>;
      };
  list: {
    tool: string;
    args?: Record<string, unknown>;
    cursorArg?: string;
    cursorFrom?: string;
    itemsPath: string;
    idPath?: string;
    tsPath?: string;
  };
  fetch?: { tool: string; idArg: string };
  /** Write-back actions (Phase 7); invoked by the outbox at commit, never by the model. */
  actions?: Record<string, { tool: string }>;
}

function fillSecrets(
  template: Record<string, string> | undefined,
  secret: string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(template ?? {}).map(([k, v]) => [k, v.replace('$secret', secret ?? '')]),
  );
}

function buildSpec(server: McpSource['server'], secret: string | undefined): McpServerSpec {
  if ('kind' in server && server.kind === 'http') {
    return {
      kind: 'http',
      transport: server.transport ?? 'streamable-http',
      url: server.url,
      headers: fillSecrets(server.headersFromSecret, secret),
    };
  }
  const stdio = server as {
    command: string;
    args?: string[];
    envFromSecret?: Record<string, string>;
  };
  return {
    command: stdio.command,
    args: stdio.args ?? [],
    env: fillSecrets(stdio.envFromSecret, secret),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** Newest record timestamp — a rolling-window cursor when the source has none. */
function deriveWindowCursor(records: RecordRef[]): string | undefined {
  const times = records.map((r) => r.ts).filter((t): t is string => typeof t === 'string');
  return times.length ? times.sort().at(-1) : undefined;
}

export class McpConnectorAdapter implements ConnectorAdapter {
  readonly typeId: string;
  private readonly bridge = new McpBridge();
  private readonly src: McpSource;

  constructor(
    private readonly type: ConnectorTypeManifest,
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
  ) {
    this.typeId = type.id;
    this.src = type.source as unknown as McpSource;
  }

  async ensureAuth(): Promise<void> {
    const secret = await this.deps.secrets.get(
      connectorSecretKey(this.binding.type, this.binding.id),
    );
    await this.bridge.start(buildSpec(this.src.server, secret ?? undefined));
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(_scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    const list = this.src.list;
    const args = {
      ...(list.args ?? {}),
      ...(list.cursorArg && cursor != null ? { [list.cursorArg]: cursor } : {}),
    };
    const json = safeParse(
      await this.bridge.callTool(list.tool, args, { budgetChars: INGEST_BUDGET }),
    );
    const items = (jget(json, list.itemsPath) as unknown[]) ?? [];
    const records: RecordRef[] = items.map((it, i) => {
      const ts = list.tsPath ? jget(it, list.tsPath) : undefined;
      return {
        id: String(list.idPath ? (jget(it, list.idPath) ?? i) : i),
        raw: it,
        ...(typeof ts === 'string' ? { ts } : {}),
      };
    });
    const next = list.cursorFrom ? jget(json, list.cursorFrom) : deriveWindowCursor(records);
    return { records, cursor: next };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const raw = this.src.fetch
      ? safeParse(
          await this.bridge.callTool(
            this.src.fetch.tool,
            { [this.src.fetch.idArg]: ref.id },
            { budgetChars: INGEST_BUDGET },
          ),
        )
      : ref.raw;
    return applyNormalize(this.type.normalize as NormalizeSpec, raw, { namespace: this.type.id });
  }

  /** Write-back at commit time (outbox-invoked). Calls the declared MCP tool. */
  async runAction(action: string, input: unknown): Promise<unknown> {
    const spec = this.src.actions?.[action];
    if (!spec) throw new Error(`no action '${action}' on ${this.typeId}`);
    return safeParse(
      await this.bridge.callTool(spec.tool, (input ?? {}) as Record<string, unknown>, {
        budgetChars: INGEST_BUDGET,
      }),
    );
  }

  async close(): Promise<void> {
    await this.bridge.stop();
  }
}
