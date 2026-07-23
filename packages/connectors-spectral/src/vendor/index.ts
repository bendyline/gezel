import { listRecords as airtableListRecords } from '../../vendor/airtable/list-records.js';
import { list as echoList } from './echo.js';

/** The one method the host calls on a vendored spectral action. */
export interface ActionLike {
  perform: (context: unknown, params: Record<string, unknown>) => Promise<{ data?: unknown }>;
}

/**
 * Registry of vendored component actions, keyed `<component>/<action>`. Static
 * so tsup bundles them (no dynamic-path imports). Add a vendored component's
 * action (under `vendor/`) here to make it runnable — each one gated by a
 * conformance test (see `*.conformance.test.ts`).
 */
export const VENDORED: Record<string, ActionLike> = {
  'echo/list': echoList as unknown as ActionLike,
  'airtable/listRecords': airtableListRecords as unknown as ActionLike,
};
