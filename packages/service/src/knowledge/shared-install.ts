/**
 * The user daemon's side of shared knowledge placement: ask the machine
 * broker to ensure a trusted coordinate in the machine-shared asset store,
 * streaming its progress back through the bridge. The request is the bare
 * coordinate — never a URL, path, or anything about this user — exactly as
 * docs/service-boundaries.md requires. Any outcome other than success or a
 * digest mismatch is "unavailable": the caller installs privately instead.
 */

import type { KnowledgeInstallEvent, TrustedKnowledgeCoordinate } from '@bendyline/gezel';
import { KnowledgeInstallEventSchema, createLogger } from '@bendyline/gezel';
import { SseResponseError, consumeSseJson } from '@bendyline/gezel-client';
import type { MachineEngineBridge } from '../machine-engine/bridge.js';

const log = createLogger('knowledge');

const SOURCE_PREFIX = '/api/knowledge-shared';
const TARGET_PREFIX = '/v1/remote/manage/knowledge';
/** Matches the model downloader's stall policy: the broker pings while a download runs. */
const STREAM_STALL_TIMEOUT_MS = 40 * 60_000;

export type SharedEnsureResult =
  | { status: 'ready' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; mismatch: { expected: string; actual: string } };

export interface SharedKnowledgeInstaller {
  available(): boolean;
  ensure(
    coordinate: TrustedKnowledgeCoordinate,
    onEvent: (event: KnowledgeInstallEvent) => void,
    signal?: AbortSignal,
  ): Promise<SharedEnsureResult>;
  cancel(coordinate: TrustedKnowledgeCoordinate): Promise<boolean>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSharedKnowledgeInstaller(
  bridge: MachineEngineBridge,
): SharedKnowledgeInstaller {
  const proxyFetch: typeof fetch = (input, init) =>
    bridge.proxy(new Request(input, init), SOURCE_PREFIX, TARGET_PREFIX);
  const jsonBody = (coordinate: TrustedKnowledgeCoordinate) => JSON.stringify({ coordinate });

  return {
    available: () => bridge.isConnected(),

    async ensure(coordinate, onEvent, signal) {
      if (!bridge.isConnected()) {
        return { status: 'unavailable', reason: 'the machine engine is not connected' };
      }
      let terminal: KnowledgeInstallEvent | null = null;
      try {
        await consumeSseJson({
          url: `http://gezel.local${SOURCE_PREFIX}/ensure-stream`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonBody(coordinate),
          fetch: proxyFetch,
          ...(signal ? { signal } : {}),
          keepaliveTimeoutMs: STREAM_STALL_TIMEOUT_MS,
          schema: KnowledgeInstallEventSchema,
          onEvent: (event) => {
            if (event.type === 'done' || event.type === 'error') terminal = event;
            else onEvent(event);
          },
          isTerminal: (event) => event.type === 'done' || event.type === 'error',
          label: `Shared knowledge install ${coordinate.catalogId}@${coordinate.version}`,
        });
      } catch (err) {
        if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
        const reason =
          err instanceof SseResponseError
            ? `the machine broker answered ${err.status}`
            : describe(err);
        log.info(`shared knowledge install unavailable for ${coordinate.catalogId}: ${reason}`);
        return { status: 'unavailable', reason };
      }
      const result = terminal as KnowledgeInstallEvent | null;
      if (!result) {
        return { status: 'unavailable', reason: 'the broker ended the stream without a result' };
      }
      if (result.type === 'done') return { status: 'ready' };
      if (result.type === 'error' && result.mismatch) {
        return { status: 'failed', error: result.error, mismatch: result.mismatch };
      }
      return {
        status: 'unavailable',
        reason: result.type === 'error' ? result.error : 'unexpected terminal event',
      };
    },

    async cancel(coordinate) {
      try {
        const res = await bridge.proxy(
          new Request(`http://gezel.local${SOURCE_PREFIX}/cancel`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonBody(coordinate),
          }),
          SOURCE_PREFIX,
          TARGET_PREFIX,
        );
        if (!res.ok) return false;
        const body = (await res.json().catch(() => null)) as { aborted?: boolean } | null;
        return body?.aborted === true;
      } catch {
        return false;
      }
    },
  };
}
